/**
 * dsh-turn-scratch - turn-scoped scratch quarantine.
 *
 * 每个 turn 结束时,把该 turn 产生的临时产物移进工作区回收站
 * .dsh-scratch-trash/ ,而不是直接删除。回收站带 manifest,可随时还原。
 *
 * 三层判定,从强到弱:
 *   1. agent 显式标记 (scratch_mark 工具) —— 确定性信号,免费;
 *   2. 启发式(本轮新建 + 临时命名规则 + 目录 mtime)—— 确定性,免费;
 *   3. AI 复核 —— 事件驱动,只在回收站非空时触发,而且**只有还原权,没有删除权**。
 *
 * 第 3 层的风险方向是刻意反过来的:AI 判断错了,结果是"少省一点空间";
 * 而不是"用户丢了文件"。删除权从不交给任何概率性判断。
 *
 * 硬约束(任何一层都不能突破):
 *   - 只处理 resolve 后确实落在工作区内的路径;
 *   - 本轮仅被 edit 的既有文件永不入内;
 *   - 用户当轮 prompt 里点名过的一律豁免;
 *   - .git / node_modules / 回收站自身永不入内。
 *
 * @module dsh-turn-scratch
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** Plugin identity, used in log lines. */
const NAME = "dsh-turn-scratch";

/** Workspace-relative trash directory owned by this plugin. */
const TRASH_DIR = ".dsh-scratch-trash";

/** Built-in tool names whose successful call produces a file. */
const MUTATION_TOOLS = new Set(["write", "edit", "str_replace_editor"]);

/** Paths that are never quarantined, regardless of configuration. */
const ALWAYS_PROTECTED = [
	"**/.git/**",
	"**/node_modules/**",
	"**/" + TRASH_DIR + "/**"
];

/** Characters carrying regex meaning when a glob is compiled. */
const REGEX_SPECIALS = ".+^$()[]{}|*?";

/** Reviewer instructions. Encodes one hard-won lesson: the name lies. */
const REVIEW_SYSTEM = [
	"你是文件隔离复核员。上游规则刚把一批文件移进了工作区回收站,理由是它们的名字或路径像临时产物。",
	"",
	"你的唯一职责:找出其中被误判的文件 —— 那些其实是用户的交付物或重要文件,只是名字碰巧像临时的。",
	"",
	"不可协商的硬规则(违反任意一条即视为复核失败):",
	"1. 你没有删除权。你只能在 keep 和 restore 之间选,不要输出任何删除建议或第三种动作。",
	"2. 只要你无法从内容上确认它是临时产物,就必须选 restore。默认方向永远是还原,举证责任在 keep 一方。",
	"3. 条目 kind 为 binary / large / unreadable 时你根本看不到内容 —— 这类条目一律 restore。",
	"4. 条目 flaggedBecause 为 orphan-store 时,那是用户自己显式配置要收的,你不许推翻,一律 keep。",
	"",
	"判据(仅在能读到内容时才有意义):",
	"- 看内容,不要只看文件名。名为 tmp.docx 的文件可能是一份正式报告,名为 _build 的目录可能装着唯一副本。",
	"- 有实质内容的文档、论文、代码、数据、图纸、设计文件 = restore。",
	"- 真正的一次性脚手架、构建中间目录、编辑器备份 = 可以 keep。",
	"- 上面两条都套不上 = restore。",
	"",
	"严格只输出 JSON,不要任何其它文字:",
	'{"decisions":[{"path":"<原路径>","action":"keep","reason":"<一句话>"}]}'
].join("\n");

/** Resolved defaults; the profile patch row's config overrides them. */
const DEFAULTS = {
	enabled: true,
	/** When true, only report what would move. */
	dryRun: false,
	patterns: [
		"**/_build/**",
		"**/build_tmp/**",
		"**/.tmp/**",
		"**/tmp/**",
		"**/temp/**",
		"**/scratch/**",
		"**/*.tmp",
		"**/*.temp",
		"**/*.bak",
		"**/*.orig",
		"**/*.rej",
		"**/*.old",
		"**/*.crdownload",
		"**/~$*",
		"**/*~",
		"**/tmp_*",
		"**/_tmp_*",
		"**/.DS_Store",
		"**/Thumbs.db"
	],
	protect: [],
	/** Sweep directories whose name matches a pattern and that changed this turn. */
	scanScratchDirs: true,
	maxScanDepth: 6,
	maxScanDirs: 4000,
	maxQuarantinePerTurn: 200,
	/** Register the scratch_mark tool so the agent can declare its own scratch. */
	markTool: true,
	/** How long an unconsumed mark stays valid. */
	markTtlMs: 21600000,
	/**
	 * 孤儿库 (orphan stores): workspace-root files that belong to tooling no
	 * longer installed. Each is quarantined once its mtime is older than
	 * orphanStoreMinAgeMinutes, so a live store (rewritten every turn) is never
	 * touched.
	 *
	 * Empty by default on purpose: which stores are orphaned depends on what a
	 * given machine happens to have installed. Configure your own, e.g.
	 * `.dsh-edit-review.json` and `.dsh-edit-review-archive.json`.
	 */
	orphanStores: [],
	orphanStoreMinAgeMinutes: 60,
	/**
	 * What to do when a pre-resolved decision disagrees with the final outcome.
	 * `fatal` logs at error level and REFUSES to persist the reviewed manifest,
	 * because that record would claim an action the plugin did not perform.
	 * `throw` raises instead, so a test fails loudly rather than passing on a
	 * silently inconsistent record.
	 */
	consistencyMode: "fatal",
	/**
	 * TEST-ONLY fault injection. Each listed fault forces one step to fail so the
	 * consistency assertion can be exercised deterministically. An empty list
	 * disables it entirely; never set this in a real profile.
	 */
	__faults: [],
	/**
	 * 工作暂存区:agent 把本轮的中间产物直接写在这里,工作区从第一秒就是干净的。
	 * 回合结束时其内容会被搬进本轮桶 —— 审计模型(manifest / 还原 / 复核)完整保留,
	 * 而暂存区被清空,下一轮拿到一个干净的工作目录。
	 *
	 * 相对工作区解析;默认落在回收站内部,因而天然落在 ALWAYS_PROTECTED 的保护伞下,
	 * 不会被普通候选路径(标记/启发式/目录mtime)重复收一遍 —— 只由归档步骤处理。
	 * 设为空串可关闭该功能。
	 */
	workDir: ".dsh-scratch-trash/work",
	/**
	 * 归档暂存区内容时是否照常送去复核。默认 true:暂存区是 agent 主动声明的,
	 * 但万一它把交付物误放进去,复核是最后一道网。
	 */
	workDirReview: true,
	/** Event-driven, restore-only AI review of what actually got quarantined. */
	aiReview: {
		enabled: true,
		/** Empty provider/model falls back to the settings' agent-default-model. */
		provider: "",
		model: "",
		reasoningEffort: "",
		maxItems: 25,
		previewBytes: 1200,
		maxTokens: 1500,
		timeoutMs: 60000,
		/**
		 * Hard constraint: an item quarantined because the USER explicitly configured
		 * it (orphanStores) is never overruled by the model. Explicit human
		 * configuration outranks AI judgment.
		 */
		respectExplicitConfig: true,
		/**
		 * Hard constraint: an item the reviewer could not read (binary, oversized,
		 * unreadable) carries no content evidence, so the model is not allowed to
		 * keep it. No evidence means restore.
		 */
		restoreWhenUninspectable: true
	},
	debug: false
};

/**
 * Compile a glob to an anchored RegExp over posix-separated relative paths.
 * Supports ** (crosses separators), * and ? (do not).
 * @param glob - the glob source.
 * @returns the compiled matcher.
 */
function globToRegExp(glob) {
	let out = "";
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				index += 1;
				if (glob[index + 1] === "/") {
					index += 1;
					out += "(?:.*/)?";
				} else out += ".*";
			} else out += "[^/]*";
		} else if (char === "?") out += "[^/]";
		else if (REGEX_SPECIALS.includes(char)) out += "\\" + char;
		else out += char;
	}
	return new RegExp("^" + out + "$");
}

/** Normalize a path to forward slashes for glob matching. */
function toPosix(value) {
	return value.split(sep).join("/");
}

/**
 * Whether child resolves strictly inside root. Both are absolute.
 * @param root - the containment root.
 * @param child - the candidate path.
 * @returns true when the candidate is strictly inside the root.
 */
function isInside(root, child) {
	const rel = relative(root, child);
	return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}

/**
 * Extract a file path from one mutation tool call, mirroring the platform's own
 * produced-file vocabulary: only successful first-party writes count.
 * @param name - the wire tool name.
 * @param args - parsed tool arguments.
 * @returns the requested path plus whether the call can only create a new file, or null.
 */
function mutationOf(name, args) {
	if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
	const pick = (value) => (typeof value === "string" && value.trim().length > 0 ? value : null);
	if (name === "write") {
		const path = pick(args.file_path);
		if (path === null || typeof args.content !== "string") return null;
		return { path, createsOnly: true };
	}
	if (name === "edit") {
		const path = pick(args.file_path);
		return path === null ? null : { path, createsOnly: false };
	}
	if (name === "str_replace_editor") {
		const path = pick(args.path);
		if (path === null) return null;
		return { path, createsOnly: args.command === "create" };
	}
	return null;
}

/**
 * Collect every string found under a value. Reads the user prompt out of
 * whatever shape the session event happens to carry.
 * @param value - any JSON value.
 * @param sink - collected strings.
 * @param depth - recursion guard.
 */
function collectStrings(value, sink, depth = 0) {
	if (depth > 6 || value === null || value === undefined) return;
	if (typeof value === "string") {
		sink.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, sink, depth + 1);
		return;
	}
	if (typeof value === "object") {
		for (const item of Object.values(value)) collectStrings(item, sink, depth + 1);
	}
}

/**
 * Bounded breadth-first scan for directories that look like scratch output.
 * @param root - absolute workspace root.
 * @param options - resolved config.
 * @param matcher - predicate over a workspace-relative posix path.
 * @returns absolute paths of matching directories.
 */
async function findScratchDirs(root, options, matcher) {
	const found = [];
	const queue = [{ dir: root, depth: 0 }];
	let visited = 0;
	while (queue.length > 0 && visited < options.maxScanDirs) {
		const current = queue.shift();
		visited += 1;
		let entries;
		try {
			entries = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const absolute = join(current.dir, entry.name);
			const rel = toPosix(relative(root, absolute));
			if (ALWAYS_PROTECTED.some((glob) => globToRegExp(glob).test(rel + "/"))) continue;
			if (matcher(rel + "/")) found.push(absolute);
			if (current.depth + 1 < options.maxScanDepth) queue.push({ dir: absolute, depth: current.depth + 1 });
		}
	}
	return found;
}

/**
 * Move one path into the trash, preserving its workspace-relative position.
 * @param root - absolute workspace root.
 * @param source - absolute path being quarantined.
 * @param bucket - absolute trash bucket directory.
 * @param kind - manifest reason tag.
 * @returns the manifest record.
 */
async function quarantine(root, source, bucket, kind) {
	const rel = toPosix(relative(root, source));
	let target = join(bucket, rel);
	let suffix = 0;
	while (existsSync(target)) {
		suffix += 1;
		target = join(bucket, rel + "." + suffix);
	}
	await mkdir(dirname(target), { recursive: true });
	await rename(source, target);
	return { path: rel, kind, storedAt: toPosix(relative(root, target)) };
}

/**
 * Move one quarantined item back to its original workspace path.
 *
 * On success the item record itself is stamped, because that stamp — not a
 * later filesystem probe — is the durable answer to "is this still held?".
 * Stamping here rather than at each call site makes the invariant automatic:
 * no caller can restore a file and forget to record it.
 * @param root - absolute workspace root.
 * @param item - the manifest record to undo; stamped in place on success.
 * @param by - who performed the restore ("review" or "tool").
 * @returns true when the item was restored.
 */
async function restoreItem(root, item, by) {
	const source = join(root, item.storedAt);
	const target = join(root, item.path);
	if (!existsSync(source)) return false;
	if (existsSync(target)) return false;
	await mkdir(dirname(target), { recursive: true });
	await rename(source, target);
	item.restoredAt = new Date().toISOString();
	if (typeof by === "string" && by.length > 0) item.restoredBy = by;
	return true;
}

/**
 * Bounded content preview of one quarantined item, for the reviewer.
 * @param absolute - absolute path inside the trash bucket.
 * @param maxBytes - preview cap.
 * @returns a shape the reviewer can reason about.
 */
async function previewOf(absolute, maxBytes) {
	let info;
	try {
		info = await stat(absolute);
	} catch {
		return { kind: "unreadable", size: null, text: null };
	}
	if (info.isDirectory()) {
		let names = [];
		try {
			names = (await readdir(absolute)).slice(0, 40);
		} catch {
			names = [];
		}
		return { kind: "directory", size: null, text: names.join(", ") };
	}
	if (info.size > maxBytes * 64) return { kind: "large", size: info.size, text: null };
	let buffer;
	try {
		buffer = await readFile(absolute);
	} catch {
		return { kind: "unreadable", size: info.size, text: null };
	}
	if (buffer.includes(0)) return { kind: "binary", size: info.size, text: null };
	return {
		kind: "text",
		size: info.size,
		text: buffer.subarray(0, maxBytes).toString("utf8"),
		truncated: buffer.length > maxBytes
	};
}

/**
 * Enumerate quarantine buckets under a workspace.
 * @param root - absolute workspace root.
 * @returns bucket descriptors, each with its parsed manifest when readable.
 */
async function listBuckets(root) {
	const trash = join(root, TRASH_DIR);
	if (!existsSync(trash)) return [];
	const buckets = [];
	let sessions;
	try {
		sessions = await readdir(trash, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const sessionEntry of sessions) {
		if (!sessionEntry.isDirectory()) continue;
		const sessionDir = join(trash, sessionEntry.name);
		let turns;
		try {
			turns = await readdir(sessionDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const turnEntry of turns) {
			if (!turnEntry.isDirectory()) continue;
			const dir = join(sessionDir, turnEntry.name);
			let manifest = null;
			try {
				manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
			} catch {
				manifest = null;
			}
			buckets.push({ session: sessionEntry.name, turn: turnEntry.name, dir, manifest });
		}
	}
	return buckets;
}

/**
 * Remove now-empty directories from `dir` upward, inclusive of `stopAt`.
 * Purging a bucket otherwise leaves its session directory (and an empty trash
 * root) behind — residue that this plugin exists to avoid.
 * @param dir - the deepest directory to consider.
 * @param stopAt - the highest directory that may be removed, inclusive.
 * @returns the number of directories removed.
 */
async function pruneEmptyDirs(dir, stopAt) {
	let removed = 0;
	let current = dir;
	for (;;) {
		let entries;
		try {
			entries = await readdir(current);
		} catch {
			return removed;
		}
		if (entries.length > 0) return removed;
		try {
			await rmdir(current);
		} catch {
			return removed;
		}
		removed += 1;
		if (current === stopAt) return removed;
		const parent = dirname(current);
		if (parent !== stopAt && !isInside(stopAt, parent)) return removed;
		current = parent;
	}
}

/**
 * Human-readable summary of a scratch_status result.
 *
 * Reports the two groups separately, because collapsing them is exactly how a
 * restored file keeps looking "still held" to the person reading the output.
 * @param value - the tool result.
 * @returns the rendered text.
 */
function scratchStatusText(value) {
	const restoredNote = value.restoredTotal > 0 ? ",已还原 " + value.restoredTotal + " 项" : "";
	if (value.total === 0 && value.restoredTotal === 0) {
		return "scratch_status: 隔离区为空 (" + value.workspace + ")";
	}
	if (value.total === 0) {
		return "scratch_status: 无待决项,历史已还原 " + value.restoredTotal + " 项 (" + value.workspace + ")";
	}
	const body = value.buckets
		.filter((bucket) => bucket.present.length > 0 || bucket.restored.length > 0)
		.map((bucket) => {
			const lines = ["  " + bucket.session + "/" + bucket.turn + "  复核:" + bucket.review];
			for (const path of bucket.present) lines.push("    [待决] " + path);
			for (const path of bucket.restored) lines.push("    [已还原] " + path);
			return lines.join("\n");
		})
		.join("\n");
	return "scratch_status: " + value.total + " 项待决" + restoredNote + " (" + value.workspace + ")\n" + body;
}

/**
 * Resolve the workspace a human tool should act on.
 * @param explicit - the tool argument, when supplied.
 * @param exec - the tool execution context.
 * @param fallback - last workspace a sweep ran in.
 * @returns an absolute path, or undefined when nothing is known.
 */
function resolveWorkspaceArg(explicit, exec, fallback) {
	if (typeof explicit === "string" && explicit.trim().length > 0) return resolve(explicit.trim());
	const agent = exec !== undefined && exec !== null ? exec.agent : undefined;
	const session = agent !== undefined && agent !== null ? agent.session : undefined;
	const cwd = session !== undefined && session !== null && session.header ? session.header.cwd : undefined;
	if (typeof cwd === "string" && cwd.length > 0) return resolve(cwd);
	return fallback;
}

/**
 * Pull the first JSON object out of a model reply.
 * @param raw - the raw model text.
 * @returns the parsed decisions array, or null when unusable.
 */
function parseDecisions(raw) {
	if (typeof raw !== "string") return null;
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const parsed = JSON.parse(raw.slice(start, end + 1));
		return Array.isArray(parsed.decisions) ? parsed.decisions : null;
	} catch {
		return null;
	}
}

/**
 * Verify that every pre-resolved decision is reflected in the final outcome.
 *
 * This guards the one failure mode that would make the manifest a lie: a record
 * claiming an action the plugin did not actually perform. A pre-resolved
 * "restore" whose file is still in quarantine, or a pre-resolved "keep" that
 * ended up restored, must never be persisted as if it had succeeded.
 * @param review - the review record about to be persisted.
 * @returns a human-readable violation, or null when consistent.
 */
function consistencyViolation(review) {
	if (review === null || review === undefined) return null;
	const resolved = Array.isArray(review.preResolved) ? review.preResolved : [];
	if (resolved.length === 0) return null;
	const restored = new Set(Array.isArray(review.restored) ? review.restored : []);
	const kept = new Set((Array.isArray(review.kept) ? review.kept : []).map((entry) => entry.path));
	for (const entry of resolved) {
		if (entry === null || typeof entry !== "object") continue;
		const wantsRestore = entry.action === "restore";
		const wanted = wantsRestore ? restored : kept;
		const other = wantsRestore ? kept : restored;
		const label = wantsRestore ? "还原" : "维持隔离";
		if (other.has(entry.path)) {
			return "preResolved 声明「" + label + "」,但 " + entry.path + " 出现在相反的结果里";
		}
		if (!wanted.has(entry.path)) {
			return "preResolved 声明「" + label + "」,但最终结果里没有 " + entry.path + "(决定没有落地)";
		}
	}
	return null;
}

/**
 * Build the plugin.
 * @param ctx - the Cordis plugin context.
 * @param rawConfig - the profile patch row's config.
 */
export function apply(ctx, rawConfig) {
	const supplied = rawConfig ?? {};
	const options = { ...DEFAULTS, ...supplied };
	options.aiReview = {
		...DEFAULTS.aiReview,
		...((supplied.aiReview && typeof supplied.aiReview === "object") ? supplied.aiReview : {})
	};
	// 走宿主的 cordis logger(ctx.logger),不要用 console:DSH Desktop 的日志文件
	// (Roaming/DSH Desktop/logs/dsh-<date>.log)只捕获结构化 logger 的输出,
	// console.log 在这里无处可见 —— 用 console 等于把日志丢进黑洞。
	// 服务缺失时退回 console,保证插件本身不会因为日志而失效。
	let emitInfo = (message) => console.log("[" + NAME + "] " + message);
	let emitWarn = (message) => console.warn("[" + NAME + "] " + message);
	let emitError = (message) => console.error("[" + NAME + "] " + message);
	let emitDebug = () => {};
	try {
		const base = typeof ctx.logger === "function" ? ctx.logger(NAME) : ctx.logger;
		if (base !== undefined && base !== null && typeof base.info === "function") {
			emitInfo = (message) => base.info(message);
			emitWarn = (message) => base.warn(message);
			emitError = (message) => base.error(message);
			emitDebug = (message) => base.debug(message);
		}
	} catch {
		// 保持 console 兜底
	}
	/** Ordinary progress. */
	const log = (message) => emitInfo(message);
	/** Failures and anything that silently degraded. */
	const warn = (error) => emitWarn(String(error && error.stack ? error.stack : error));
	/**
	 * An invariant broke. Reserved for conditions where continuing would persist
	 * a record the plugin knows to be false, so it must never be downgraded to a
	 * warning that scrolls past unnoticed.
	 */
	const fatal = (message) => emitError(message);
	/**
	 * Detail that only matters while tuning. When the user explicitly turns
	 * `debug` on they want to SEE it, so it is emitted at info level — the
	 * host's file exporter may filter the debug level out entirely.
	 */
	const debug = (message) => {
		if (!options.debug) return;
		emitInfo(message);
	};
	if (options.enabled === false) {
		log("disabled by config");
		return;
	}

	const compiled = options.patterns.map(globToRegExp);
	/** Absolute scratch work area, or null when disabled. */
	const workRoot = typeof options.workDir === "string" && options.workDir.trim().length > 0 ? options.workDir.trim() : null;
	// The work area is handled by its own archive step, never by the generic
	// candidate paths — otherwise a busy work dir would be collected twice, or
	// its subdirectories would trip the scratch-directory scan.
	const workGuard = workRoot === null ? [] : [toPosix(workRoot).replace(/\/+$/, "") + "/**", toPosix(workRoot).replace(/\/+$/, "")];
	const protectedGlobs = [...ALWAYS_PROTECTED, ...options.protect, ...workGuard].map(globToRegExp);
	const matchesScratch = (rel) => compiled.some((re) => re.test(rel));
	const isProtected = (rel) => protectedGlobs.some((re) => re.test(rel));

	/** Live per-session turn state. */
	const sessions = new Map();
	/** Serializes sweeps so a new turn never races the previous one. */
	const queue = new Map();
	/** Agent-declared scratch: absolute-or-relative path text to a mark record. */
	const marks = new Map();
	/** Last workspace a sweep ran in, so the human tools can default to it. */
	let lastWorkspace;
	let warnedNoRoute = false;

	/**
	 * Decide which provider/model performs the review, preferring explicit
	 * config and falling back to the harness default model.
	 * @returns the route, or null when unavailable.
	 */
	function resolveReviewRoute() {
		const cfg = options.aiReview;
		if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model };
		const settings = ctx.get("settings");
		const section = settings !== undefined && typeof settings.get === "function"
			? settings.get("agent-default-model")
			: undefined;
		if (section !== undefined && section !== null && section.provider && section.model) {
			return { provider: section.provider, model: section.model };
		}
		return null;
	}

	/**
	 * One bounded, non-streaming text completion.
	 * @param route - resolved provider and model.
	 * @param system - system prompt.
	 * @param userText - user prompt.
	 * @param sessionId - owning session, for cost attribution.
	 * @returns the model text.
	 */
	async function complete(route, system, userText, sessionId) {
		const llm = ctx.get("llm");
		if (llm === undefined) throw new Error("llm service unavailable");
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.aiReview.timeoutMs);
		try {
			const params = {
				provider: route.provider,
				model: route.model,
				messages: [createUserMessage({
					content: [{ type: "text", text: userText }],
					source: { kind: "plugin", plugin: NAME }
				})],
				system,
				maxTokens: options.aiReview.maxTokens,
				sessionId,
				signal: controller.signal
			};
			if (options.aiReview.reasoningEffort) params.reasoningEffort = options.aiReview.reasoningEffort;
			let text = "";
			let clean = false;
			for await (const chunk of llm.stream(params)) {
				if (chunk.type === "text-delta") text += chunk.text;
				else if (chunk.type === "finish") clean = chunk.reason !== undefined && chunk.reason.kind === "stop";
			}
			if (!clean) throw new Error("model did not finish cleanly");
			return text;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Restore-only review of one bucket. Never deletes, never escalates.
	 * @param session - owning session.
	 * @param state - the finished turn state.
	 * @param root - absolute workspace root.
	 * @param manifest - the just-written manifest.
	 */
	async function review(session, state, root, manifest) {
		// Every path below RETURNS a record. The caller always persists it, so a
		// skip or a failure can never be invisible to the human.
		const record = {
			at: new Date().toISOString(),
			outcome: "unknown",
			reviewed: 0,
			restored: [],
			kept: [],
			problems: [],
			preResolved: [],
			modelConsulted: false
		};

		/** 显式人类配置高于一切,包括模型。 */
		const lockedByUserConfig = (item) => options.aiReview.respectExplicitConfig !== false && item.kind === "orphan-store";
		/** 读不到内容就没有证据,而没有证据不足以支撑"维持隔离"。 */
		const blindKind = (info) => info === undefined || info.kind === "binary" || info.kind === "large" || info.kind === "unreadable";

		const items = manifest.items.slice(0, options.aiReview.maxItems);
		record.reviewed = items.length;

		// ── 硬约束先在代码里定案,不问模型 ──────────────────────────────
		// 放在模型调用之前而不是之后,有两个原因:
		//   1. 一个守规矩的模型对这两类条目会给出相同答案,于是模型的回答会
		//      掩盖"约束到底有没有执行"。在这里定案,每条约束的结果都独立
		//      记进 preResolved,确定且可单独追溯。
		//   2. 模型对这两类条目本就没有裁量权,送去问纯属浪费。
		const pending = [];
		const described = [];
		for (const item of items) {
			const info = await previewOf(join(root, item.storedAt), options.aiReview.previewBytes);
			if (lockedByUserConfig(item)) {
				record.kept.push({ path: item.path, reason: "孤儿库(orphanStores)是用户显式配置,复核无权推翻" });
				record.preResolved.push({ path: item.path, action: "keep", reason: "显式用户配置" });
				continue;
			}
			if (options.aiReview.restoreWhenUninspectable !== false && blindKind(info)) {
				let done = false;
				if (Array.isArray(options.__faults) && options.__faults.includes("restore-pre-resolved")) {
					record.problems.push("注入故障:还原被强制失败(仅测试)");
				} else {
					try {
						done = await restoreItem(root, item, "review");
					} catch (error) {
						record.problems.push("还原失败 " + item.path + ": " + String(error && error.message ? error.message : error));
					}
				}
				if (done) record.restored.push(item.path);
				else record.problems.push("还原未生效(目标已存在或源缺失): " + item.path);
				// The DECISION is recorded as restore whether or not it took effect.
				// If it did not, the path never reaches record.restored and the
				// consistency assertion fires — deliberately: a manifest claiming a
				// restore it never performed is exactly what must not ship.
				record.preResolved.push({ path: item.path, action: "restore", reason: "读不到内容,无证据支持隔离" });
				continue;
			}
			pending.push(item);
			described.push(JSON.stringify({
				path: item.path,
				flaggedBecause: item.kind,
				kind: info.kind,
				size: info.size,
				preview: info.text
			}));
		}

		if (pending.length === 0) {
			// 每一条都被硬约束定案了 —— 不需要模型,也就一次都不调。
			record.outcome = "completed";
			return record;
		}

		let route;
		try {
			route = resolveReviewRoute();
		} catch (error) {
			route = null;
			record.problems.push("解析 provider/model 时抛错: " + String(error && error.message ? error.message : error));
		}
		if (route === undefined || route === null) {
			record.outcome = "skipped-no-route";
			record.problems.push("拿不到 provider/model:settings 无 agent-default-model,配置里也没指定");
			if (!warnedNoRoute) {
				warnedNoRoute = true;
				warn(record.problems[record.problems.length - 1]);
			}
			return record;
		}
		record.provider = route.provider;
		record.model = route.model;
		record.modelConsulted = true;

		const userText = [
			"工作区: " + toPosix(root),
			"本轮用户原话: " + (state.promptText.slice(0, 800) || "(未捕获)"),
			"",
			"刚被隔离的条目:",
			...described
		].join("\n");

		let raw;
		try {
			raw = await complete(route, REVIEW_SYSTEM, userText, session.id);
		} catch (error) {
			record.outcome = "failed";
			record.problems.push("模型调用失败: " + String(error && error.message ? error.message : error));
			return record;
		}
		const decisions = parseDecisions(raw);
		if (decisions === null) {
			record.outcome = "unparsed";
			record.raw = String(raw).slice(0, 800);
			record.problems.push("模型输出不是可解析的 JSON,全部维持隔离(原文已存进 raw)");
			return record;
		}
		record.outcome = "completed";
		record.decisions = decisions;

		// 只有"能读到内容、且不属显式配置"的条目会走到这里。
		for (const item of pending) {
			const decision = decisions.find((candidate) => candidate !== null && typeof candidate === "object" && candidate.path === item.path);
			const action = decision !== undefined && decision.action === "restore" ? "restore" : "keep";
			const why = decision !== undefined && typeof decision.reason === "string" ? decision.reason : "模型未给出该条决定";
			if (action === "restore") {
				try {
					if (await restoreItem(root, item, "review")) record.restored.push(item.path);
					else record.problems.push("还原未生效(目标已存在或源缺失): " + item.path);
				} catch (error) {
					record.problems.push("还原失败 " + item.path + ": " + String(error && error.message ? error.message : error));
				}
			} else {
				record.kept.push({ path: item.path, reason: why });
			}
		}
		return record;
	}

	/**
	 * Quarantine-policy decision for one heuristic candidate.
	 * @param rel - workspace-relative posix path.
	 * @param promptText - the turn's user prompt, for the named-by-user exemption.
	 * @returns true when the candidate is eligible to move.
	 */
	function eligible(rel, promptText) {
		if (isProtected(rel)) return false;
		if (!matchesScratch(rel)) return false;
		if (promptText.length > 0) {
			const parts = rel.split("/");
			const leaf = parts[parts.length - 1];
			if (promptText.includes(rel)) return false;
			if (leaf !== undefined && leaf.length > 3 && promptText.includes(leaf)) return false;
		}
		return true;
	}

	/**
	 * Run one turn's sweep. Never throws into the event handler.
	 * @param session - the session the turn belongs to.
	 * @param state - the turn state captured from events.
	 */
	async function sweep(session, state) {
		const root = session && session.header ? session.header.cwd : undefined;
		if (typeof root !== "string" || root.length === 0) return;
		const absoluteRoot = resolve(root);
		if (!existsSync(absoluteRoot)) return;
		lastWorkspace = absoluteRoot;

		const bucket = join(absoluteRoot, TRASH_DIR, session.id, "turn-" + state.turn);
		const records = [];
		const seen = new Set();

		const add = (absolute, rel, kind) => {
			if (records.length >= options.maxQuarantinePerTurn) return;
			if (!isInside(absoluteRoot, absolute)) return;
			if (seen.has(rel)) return;
			seen.add(rel);
			records.push({ absolute, rel, kind });
		};

		// (0) Agent-declared scratch: deterministic, and exempt from the pattern list.
		const now = Date.now();
		for (const [key, mark] of [...marks]) {
			if (now - mark.at > options.markTtlMs) {
				marks.delete(key);
				continue;
			}
			const absolute = isAbsolute(key) ? key : resolve(absoluteRoot, key);
			if (!existsSync(absolute)) continue;
			if (!isInside(absoluteRoot, absolute)) continue;
			const rel = toPosix(relative(absoluteRoot, absolute));
			if (isProtected(rel)) continue;
			if (state.promptText.length > 0 && state.promptText.includes(rel)) continue;
			add(absolute, rel, "agent-marked");
			marks.delete(key);
		}

		// (1) Files this turn newly created through a first-party mutation call.
		for (const produced of state.produced) {
			if (!produced.createsOnly) continue;
			const absolute = resolve(absoluteRoot, produced.path);
			if (!existsSync(absolute)) continue;
			const rel = toPosix(relative(absoluteRoot, absolute));
			if (eligible(rel, state.promptText)) add(absolute, rel, "created-this-turn");
		}

		// (2) Scratch-named directories that changed during this turn.
		if (options.scanScratchDirs) {
			for (const dir of await findScratchDirs(absoluteRoot, options, matchesScratch)) {
				const rel = toPosix(relative(absoluteRoot, dir));
				if (isProtected(rel + "/")) continue;
				if (state.promptText.includes(rel) || state.promptText.includes(basename(dir))) continue;
				let info;
				try {
					info = await stat(dir);
				} catch {
					continue;
				}
				if (info.mtimeMs < state.startedAt) continue;
				add(dir, rel, "scratch-dir-changed");
			}
		}

		// (3) 孤儿库: orphaned tooling stores at the workspace root.
		for (const name of options.orphanStores) {
			const absolute = join(absoluteRoot, name);
			if (!existsSync(absolute)) continue;
			let info;
			try {
				info = await stat(absolute);
			} catch {
				continue;
			}
			// Clamp at zero: a filesystem timestamp can land a fraction of a
			// millisecond ahead of Date.now(), and a future mtime means "just
			// created", not "negative age" -- otherwise a threshold of 0 would
			// wrongly skip it.
			const ageMinutes = Math.max(0, (Date.now() - info.mtimeMs) / 60000);
			if (ageMinutes < options.orphanStoreMinAgeMinutes) continue;
			add(absolute, name, "orphan-store");
		}

		// (4) 工作暂存区:把 agent 本轮停在这里的东西整体归档进桶。
		// 不走 eligible():agent 是主动把它放进暂存区的,不需要再按命名规则猜一遍。
		// 硬保护(工作区包含、.git/node_modules)仍然由 add() 把关。
		if (workRoot !== null) {
			const workAbsolute = resolve(absoluteRoot, workRoot);
			let workEntries = [];
			try {
				workEntries = await readdir(workAbsolute);
			} catch {
				workEntries = [];
			}
			for (const name of workEntries) {
				const absolute = join(workAbsolute, name);
				const rel = toPosix(relative(absoluteRoot, absolute));
				add(absolute, rel, "workdir");
			}
		}

		if (records.length === 0) {
			debug("turn " + state.turn + ": nothing to quarantine");
			return;
		}
		if (options.dryRun) {
			log("dryRun turn " + state.turn + ": would quarantine " + records.length + " item(s): " + records.map((r) => r.rel).join(", "));
			return;
		}

		const manifest = {
			plugin: NAME,
			session: session.id,
			turn: state.turn,
			at: new Date().toISOString(),
			workspace: toPosix(absoluteRoot),
			restoreHint: "把这些文件移回 workspace 下的原路径即可还原(path 字段)。",
			items: []
		};
		for (const record of records) {
			try {
				manifest.items.push(await quarantine(absoluteRoot, record.absolute, bucket, record.kind));
			} catch (error) {
				warn("quarantine failed for " + record.rel + ": " + String(error && error.message ? error.message : error));
			}
		}
		if (manifest.items.length === 0) return;
		const manifestPath = join(bucket, "manifest.json");
		const persist = async () => {
			try {
				await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
			} catch (error) {
				warn("manifest write failed: " + String(error && error.message ? error.message : error));
			}
		};
		await persist();
		log("turn " + state.turn + ": quarantined " + manifest.items.length + " item(s) -> " + toPosix(relative(absoluteRoot, bucket)));

		// Restore-only review, event-driven: it exists only because something moved.
		// Its outcome is ALWAYS persisted, so a silent skip can never hide.
		if (options.aiReview.enabled === false) {
			manifest.review = { at: new Date().toISOString(), outcome: "disabled" };
		} else {
			try {
				manifest.review = await review(session, state, absoluteRoot, manifest);
			} catch (error) {
				manifest.review = {
					at: new Date().toISOString(),
					outcome: "failed",
					reviewed: 0,
					restored: [],
					kept: [],
					preResolved: [],
					modelConsulted: false,
					problems: ["复核抛出未捕获异常: " + String(error && error.message ? error.message : error)]
				};
				warn("aiReview 失败(fail-safe:全部保持隔离): " + manifest.review.problems[0]);
			}
		}
		// ── Invariant gate, before the reviewed record reaches disk ──────────
		// A pre-resolved decision that disagrees with the final outcome means the
		// manifest would assert an action the plugin never performed. Refusing to
		// persist is the point: the items-only record written above already keeps
		// every quarantined file accounted for, so nothing is orphaned by this.
		const violation = consistencyViolation(manifest.review);
		if (violation !== null) {
			const message = "决策一致性断言失败: " + violation;
			if (options.consistencyMode === "throw") throw new Error("[" + NAME + "] " + message);
			fatal(message + " —— 拒绝写入这份自相矛盾的 manifest");
			return;
		}
		await persist();
		const outcome = manifest.review;
		if (outcome.outcome === "completed") {
			// Report WHO decided: the model, or the hard constraints alone.
			// Printing a model name when the model was never consulted is both
			// wrong and misleading.
			const decider = outcome.modelConsulted === false ? "硬约束定案" : "AI " + String(outcome.model);
			log("turn " + state.turn + " 复核(" + decider + "):复核 " + outcome.reviewed + " 项,还原 " + outcome.restored.length + " 项" + (outcome.restored.length > 0 ? " -> " + outcome.restored.join(", ") : "") + ",维持隔离 " + outcome.kept.length + " 项");
		} else {
			log("turn " + state.turn + " AI 复核未完成 outcome=" + outcome.outcome + (outcome.problems && outcome.problems.length > 0 ? " -- " + outcome.problems[0] : ""));
		}
	}

	/**
	 * Serialize sweeps per session.
	 * @param session - owning session.
	 * @param state - the finished turn state.
	 */
	function enqueue(session, state) {
		const previous = queue.get(session.id) ?? Promise.resolve();
		const next = previous.then(() => sweep(session, state)).catch((error) => {
			if (options.consistencyMode === "throw") {
				// 测试模式:队列必须继续推进,但断言失败绝不能被吞掉。
				// 把它抛进一个**没有任何 handler** 的 promise,成为 unhandledRejection,
				// 让测试进程据此失败 —— 而不是让一条 warn 从日志里悄悄划过去。
				// (注意:直接 void 掉 next 本身没用,挂 .catch 的那一刻它就已经被"处理"了。)
				void Promise.reject(error);
				return;
			}
			warn(error);
		});
		queue.set(session.id, next);
		next.then(() => {
			if (queue.get(session.id) === next) queue.delete(session.id);
		});
	}

	/**
	 * Fold one session event into the current turn state.
	 * @param session - the emitting session.
	 * @param event - the session event.
	 */
	function handle(session, event) {
		if (session === undefined || event === undefined) return;
		if (event.type === "turn/start") {
			// Capture the workspace at turn START, not only at turn end: tools like
			// scratch_workdir are called mid-turn, and the agent should not have to
			// wait for a sweep before it can resolve a path.
			if (session.header !== undefined && session.header !== null && typeof session.header.cwd === "string" && session.header.cwd.length > 0) {
				lastWorkspace = resolve(session.header.cwd);
			}
			sessions.set(session.id, {
				turn: event.data.turn,
				startedAt: Date.now(),
				promptText: "",
				calls: new Map(),
				produced: []
			});
			return;
		}
		const state = sessions.get(session.id);
		if (state === undefined) return;
		if (event.type === "user/message") {
			const sink = [];
			collectStrings(event.data, sink);
			state.promptText = sink.join("\n");
			return;
		}
		if (event.type === "tool/call") {
			if (!MUTATION_TOOLS.has(event.data.name)) return;
			let args;
			try {
				args = JSON.parse(event.data.arguments);
			} catch {
				return;
			}
			const mutation = mutationOf(event.data.name, args);
			if (mutation === null) return;
			const root = session.header && session.header.cwd ? resolve(session.header.cwd) : undefined;
			const createsOnly = mutation.createsOnly && root !== undefined && !existsSync(resolve(root, mutation.path));
			state.calls.set(String(event.data.callId), { path: mutation.path, createsOnly });
			return;
		}
		if (event.type === "tool/result") {
			const content = event.data && event.data.message ? event.data.message.content : undefined;
			if (Array.isArray(content) && content[0] && content[0].isError === true) return;
			const source = event.data && event.data.message ? event.data.message.source : undefined;
			if (source === undefined || source.callId === undefined) return;
			const call = state.calls.get(String(source.callId));
			if (call === undefined) return;
			state.produced.push(call);
			return;
		}
		if (event.type === "turn/end") {
			sessions.delete(session.id);
			enqueue(session, state);
		}
	}

	try {
		ctx.on("session/event", handle, { global: true });
	} catch {
		ctx.on("session/event", handle);
	}

	if (options.markTool !== false) {
		ctx.inject(["tools"], (toolCtx) => {
			toolCtx.tools.register(defineTool({
				name: "scratch_mark",
				description: "Declare files you created only as disposable scaffolding for this task, so they are quarantined (not deleted, restorable) when this turn ends. Use it for throwaway helper scripts, one-off code files, and build byproducts you will not need again. Do NOT mark a file the user asked for, any deliverable, or anything you edited rather than created.",
				parameters: {
					paths: {
						type: "array",
						required: true,
						items: { type: "string" },
						description: "Paths of the disposable files, workspace-relative or absolute."
					},
					reason: {
						type: "string",
						description: "One short line on why these are disposable."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							marked: { type: "array", required: true, items: { type: "string" } },
							skipped: { type: "array", required: true, items: { type: "string" } }
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.marked.length === 0
							? "scratch_mark: nothing recorded (" + value.skipped.join(", ") + ")"
							: "scratch_mark: " + value.marked.length + " path(s) will be quarantined at turn end: " + value.marked.join(", ")
					}]
				},
				isConcurrencySafe: () => true,
				execute(args) {
					const list = Array.isArray(args.paths) ? args.paths : [];
					const marked = [];
					const skipped = [];
					const at = Date.now();
					for (const entry of list) {
						if (typeof entry !== "string" || entry.trim().length === 0) {
							skipped.push(String(entry));
							continue;
						}
						marks.set(entry.trim(), { at, reason: typeof args.reason === "string" ? args.reason : "" });
						marked.push(entry.trim());
					}
					return Promise.resolve({ marked, skipped });
				}
			}));

			toolCtx.tools.register(defineTool({
				name: "scratch_workdir",
				description: "Return the absolute path of this workspace's scratch work area, creating it if needed. Write intermediate files there instead of the workspace root: the workspace then stays clean from the first second, and at turn end the plugin archives whatever is left into the quarantine bucket, where it is manifest-tracked, restorable, and reviewed. Use it for helper scripts, build byproducts, and one-off outputs. Do NOT put deliverables or anything the user asked for there.",
				parameters: {
					workspace: {
						type: "string",
						description: "Workspace root. Defaults to the current session's workspace."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							enabled: { type: "boolean", required: true },
							path: { type: "string", required: true },
							relative: { type: "string", required: true }
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.enabled
							? "scratch_workdir: " + value.path + "\n(回合结束时这里剩下的东西会被归档进隔离区;交付物别放这儿)"
							: "scratch_workdir: 未启用(配置里 workDir 为空,或定位不到工作区)"
					}]
				},
				isConcurrencySafe: () => true,
				async execute(args, exec) {
					const workspace = resolveWorkspaceArg(args.workspace, exec, lastWorkspace);
					if (workspace === undefined || workRoot === null) return { enabled: false, path: "", relative: "" };
					const absolute = resolve(workspace, workRoot);
					try {
						await mkdir(absolute, { recursive: true });
					} catch (error) {
						warn("创建暂存区失败 " + absolute + ": " + String(error && error.message ? error.message : error));
						return { enabled: false, path: "", relative: "" };
					}
					return { enabled: true, path: toPosix(absolute), relative: toPosix(workRoot) };
				}
			}));

			// ── Human override surface ──────────────────────────────────────
			// These exist so the human keeps final say. The AI has no tool here:
			// it can only restore. Purge requires an explicit confirm flag and is
			// meant to run only on a direct human request.

			toolCtx.tools.register(defineTool({
				name: "scratch_status",
				description: "Read-only. List what the turn-scratch plugin has quarantined in this workspace: every bucket, its items, and what the AI review decided. Use it before restoring or purging, and whenever the user asks what was cleaned up.",
				parameters: {
					workspace: {
						type: "string",
						description: "Workspace root. Defaults to the current session's workspace."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							workspace: { type: "string", required: true },
							total: { type: "integer", required: true },
							restoredTotal: { type: "integer", required: true },
							buckets: {
								type: "array",
								required: true,
								items: {
									type: "object",
									additionalProperties: false,
									properties: {
										session: { type: "string", required: true },
										turn: { type: "string", required: true },
										present: { type: "array", required: true, items: { type: "string" } },
										restored: { type: "array", required: true, items: { type: "string" } },
										review: { type: "string", required: true }
									}
								}
							}
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: scratchStatusText(value)
					}]
				},
				isConcurrencySafe: () => true,
				async execute(args, exec) {
					const workspace = resolveWorkspaceArg(args.workspace, exec, lastWorkspace);
					if (workspace === undefined) return { workspace: "(unknown)", total: 0, restoredTotal: 0, buckets: [] };
					// Grouping comes from the manifest own record: an item is "restored"
					// once restoreItem stamped it, so this stays a pure read with no
					// filesystem probes and no race against a concurrent sweep.
					const buckets = [];
					let total = 0;
					let restoredTotal = 0;
					for (const bucket of await listBuckets(workspace)) {
						const all = bucket.manifest !== null && Array.isArray(bucket.manifest.items) ? bucket.manifest.items : [];
						const present = all.filter((item) => item.restoredAt === undefined).map((item) => item.path);
						const restored = all.filter((item) => item.restoredAt !== undefined).map((item) => item.path);
						total += present.length;
						restoredTotal += restored.length;
						const review = bucket.manifest !== null && bucket.manifest.review !== undefined && bucket.manifest.review !== null
							? String(bucket.manifest.review.outcome)
							: "无记录";
						buckets.push({ session: bucket.session, turn: bucket.turn, present, restored, review });
					}
					return { workspace: toPosix(workspace), total, restoredTotal, buckets };
				}
			}));

			toolCtx.tools.register(defineTool({
				name: "scratch_restore",
				description: "Move quarantined files back to their original workspace paths. Non-destructive: restoring only puts files back. Omit every filter to restore everything. Use when the user says something was cleaned up that they still need.",
				parameters: {
					workspace: {
						type: "string",
						description: "Workspace root. Defaults to the current session's workspace."
					},
					paths: {
						type: "array",
						items: { type: "string" },
						description: "Only restore these workspace-relative paths. Omit to restore all."
					},
					session: {
						type: "string",
						description: "Only restore from this session id."
					},
					turn: {
						type: "string",
						description: "Only restore from this bucket, e.g. turn-6."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							workspace: { type: "string", required: true },
							restored: { type: "array", required: true, items: { type: "string" } },
							failed: { type: "array", required: true, items: { type: "string" } }
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.restored.length === 0 && value.failed.length === 0
							? "scratch_restore: 没有匹配的条目"
							: "scratch_restore: 还原 " + value.restored.length + " 项" + (value.failed.length > 0 ? ",失败 " + value.failed.length + " 项: " + value.failed.join(", ") : "") + (value.restored.length > 0 ? "\n" + value.restored.map((p) => "  + " + p).join("\n") : "")
					}]
				},
				isConcurrencySafe: () => false,
				async execute(args, exec) {
					const workspace = resolveWorkspaceArg(args.workspace, exec, lastWorkspace);
					if (workspace === undefined) return { workspace: "(unknown)", restored: [], failed: [] };
					const only = Array.isArray(args.paths) ? args.paths.map((p) => toPosix(String(p))) : null;
					const restored = [];
					const failed = [];
					for (const bucket of await listBuckets(workspace)) {
						if (typeof args.session === "string" && args.session.length > 0 && bucket.session !== args.session) continue;
						if (typeof args.turn === "string" && args.turn.length > 0 && bucket.turn !== args.turn) continue;
						const items = bucket.manifest !== null && Array.isArray(bucket.manifest.items) ? bucket.manifest.items : [];
						let stamped = false;
						for (const item of items) {
							if (only !== null && !only.includes(toPosix(item.path))) continue;
							try {
								if (await restoreItem(workspace, item, "tool")) {
									restored.push(item.path);
									stamped = true;
								} else failed.push(item.path + " (目标已存在或源缺失)");
							} catch (error) {
								failed.push(item.path + " (" + String(error && error.message ? error.message : error) + ")");
							}
						}
						// Persist the stamps. Without this the restore is real but the record
						// still says "held", and status would report a stale number — the very
						// problem the stamps exist to remove.
						if (stamped && bucket.manifest !== null) {
							try {
								await writeFile(join(bucket.dir, "manifest.json"), JSON.stringify(bucket.manifest, null, 2) + "\n", "utf8");
							} catch (error) {
								failed.push(bucket.session + "/" + bucket.turn + " (已还原但 manifest 回写失败,status 会暂时显示为待决)");
								warn("回写 manifest 失败 " + bucket.dir + ": " + String(error && error.message ? error.message : error));
							}
						}
					}
					return { workspace: toPosix(workspace), restored, failed };
				}
			}));

			toolCtx.tools.register(defineTool({
				name: "scratch_purge",
				description: "PERMANENTLY delete quarantined files. This is the only irreversible operation in this plugin and it must only run on an explicit human request — never on your own initiative. Requires confirm: true. Prefer scratch_restore when in doubt.",
				parameters: {
					confirm: {
						type: "boolean",
						required: true,
						description: "Must be exactly true. Guards against accidental invocation."
					},
					workspace: {
						type: "string",
						description: "Workspace root. Defaults to the current session's workspace."
					},
					all: {
						type: "boolean",
						description: "Purge every bucket. Without this, session and/or turn must narrow the target."
					},
					session: {
						type: "string",
						description: "Only purge this session's buckets."
					},
					turn: {
						type: "string",
						description: "Only purge this bucket, e.g. turn-6."
					}
				},
				output: {
					schema: {
						type: "object",
						additionalProperties: false,
						properties: {
							workspace: { type: "string", required: true },
							removed: { type: "array", required: true, items: { type: "string" } },
							refused: { type: "string" }
						}
					},
					render: (_args, value) => [{
						type: "text",
						text: value.refused !== undefined
							? "scratch_purge 已拒绝: " + value.refused
							: "scratch_purge: 永久删除 " + value.removed.length + " 个桶" + (value.removed.length > 0 ? "\n" + value.removed.map((p) => "  - " + p).join("\n") : "")
					}]
				},
				isConcurrencySafe: () => false,
				async execute(args, exec) {
					const workspace = resolveWorkspaceArg(args.workspace, exec, lastWorkspace);
					if (workspace === undefined) return { workspace: "(unknown)", removed: [], refused: "定位不到工作区" };
					if (args.confirm !== true) return { workspace: toPosix(workspace), removed: [], refused: "confirm 必须显式传 true" };
					const narrowed = args.all === true || (typeof args.session === "string" && args.session.length > 0) || (typeof args.turn === "string" && args.turn.length > 0);
					if (!narrowed) return { workspace: toPosix(workspace), removed: [], refused: "必须指定 all: true,或至少给出 session / turn 来收窄范围" };
					const removed = [];
					for (const bucket of await listBuckets(workspace)) {
						if (typeof args.session === "string" && args.session.length > 0 && bucket.session !== args.session) continue;
						if (typeof args.turn === "string" && args.turn.length > 0 && bucket.turn !== args.turn) continue;
						const target = toPosix(relative(workspace, bucket.dir));
						try {
							await rm(bucket.dir, { recursive: true, force: true });
							await pruneEmptyDirs(dirname(bucket.dir), join(workspace, TRASH_DIR));
							removed.push(target);
						} catch (error) {
							warn("purge failed for " + target + ": " + String(error && error.message ? error.message : error));
						}
					}
					return { workspace: toPosix(workspace), removed };
				}
			}));

			debug("scratch tools registered (mark, workdir, status, restore, purge)");
		});
	}

	log("loaded (dryRun=" + String(options.dryRun) + ", markTool=" + String(options.markTool !== false) + ", aiReview=" + String(options.aiReview.enabled !== false) + ", trash=" + TRASH_DIR + ")");
}
