#!/usr/bin/env node
/**
 * verify-manifest.mjs - schema-lite + asymmetric regression check for manifest.json.
 *
 * WHY ASYMMETRIC
 * The manifest is expected to GROW. A new optional field is a feature; a missing
 * field, a changed value, or a value outside its enum is a regression. Treating
 * additions as failures would make every improvement look like breakage, so:
 *
 *   added    -> reported, ALLOWED (does not fail the run)
 *   missing  -> FAIL
 *   changed  -> FAIL
 *   invalid  -> FAIL
 *
 * WHY NO WHITELIST
 * The allowed shape is declared once, below, as a schema. A new field is allowed
 * because the schema says it MAY exist — not because a list happens to name it.
 * A whitelist of specific "expected additions" has to be edited for every new
 * optional field, and an out-of-date whitelist silently turns a regression into
 * a pass. The schema cannot drift that way: anything undeclared is rejected.
 *
 * Usage:
 *   node verify-manifest.mjs <manifest.json> [baseline.json]
 *   (baseline defaults to ./fixtures/manifest-baseline.json next to this script)
 *
 * Exit codes:
 *   0 = no findings outside the allowed additions
 *   1 = missing / changed / invalid found; every finding is printed
 *   2 = usage error (missing file, unreadable JSON)
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Allowed value sets, referenced from the schema as "enum:<name>". */
const ENUMS = {
	itemKind: ["agent-marked", "created-this-turn", "scratch-dir-changed", "orphan-store", "workdir"],
	outcome: ["completed", "skipped-no-route", "failed", "unparsed", "disabled"],
	action: ["keep", "restore"],
	restoredBy: ["review", "tool"],
	/**
	 * What `path` is relative to, and therefore where a restore puts the item
	 * back. Absent means "workspace", which is what every legacy item is.
	 */
	itemOrigin: ["workspace", "store"],
	/** How the item physically moved. Absent means the atomic-rename fast path. */
	itemMoved: ["copy"]
};

/**
 * Fields whose VALUE legitimately differs between runs. Presence and type are
 * still enforced; only the equality check against the baseline is skipped.
 * This makes the script a FORMAT regression harness, not a run-equality check.
 */
const VOLATILE = new Set(["session", "turn", "at", "restoredAt"]);

/** Fields compared after normalizing a run-specific segment. */
const NORMALIZE = {
	storedAt: (value) => String(value).replace(/turn-\d+/, "turn-N")
};

/**
 * The allowed shape, declared once.
 *   "string" | "integer" | "boolean" | "array" | "strings" | "iso"
 *   "enum:<name>"                      one of ENUMS[name]
 *   "@<node>"                          object conforming to SCHEMA[node]
 *   { of: "@<node>", key: "<field>" }  array of such objects, matched by key
 */
const SCHEMA = {
	manifest: {
		required: {
			plugin: "string",
			session: "string",
			turn: "integer",
			at: "iso",
			workspace: "string",
			restoreHint: "string",
			items: { of: "@item", key: "path" }
		},
		optional: {
			review: "@review",
			/** Absolute store root. Absent in manifests written before it could move. */
			store: "string"
		}
	},
	item: {
		required: { path: "string", kind: "enum:itemKind", storedAt: "string" },
		optional: {
			restoredAt: "iso",
			restoredBy: "enum:restoredBy",
			origin: "enum:itemOrigin",
			moved: "enum:itemMoved"
		}
	},
	review: {
		required: {
			at: "iso",
			outcome: "enum:outcome",
			reviewed: "integer",
			restored: "strings",
			kept: { of: "@keptEntry", key: "path" },
			problems: "strings",
			preResolved: { of: "@preResolvedEntry", key: "path" },
			modelConsulted: "boolean"
		},
		optional: {
			provider: "string",
			model: "string",
			decisions: "array",
			raw: "string"
		}
	},
	keptEntry: {
		required: { path: "string", reason: "string" }
	},
	preResolvedEntry: {
		required: { path: "string", action: "enum:action", reason: "string" }
	}
};

const findings = { added: [], missing: [], changed: [], invalid: [] };

const kindOf = (value) => {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
};

/** Trailing field name of a JSON path, for volatile/normalizer lookup. */
const fieldOf = (path) => path.slice(path.lastIndexOf(".") + 1);

/** Validate one leaf spec. Returns true when the value conforms. */
function checkLeaf(spec, value, path) {
	if (spec === "string" || spec === "iso") {
		if (typeof value !== "string") {
			findings.invalid.push(path + ": 期望 string,得到 " + kindOf(value));
			return false;
		}
		if (spec === "iso" && Number.isNaN(Date.parse(value))) {
			findings.invalid.push(path + ": 不是合法 ISO 时间戳 -> " + JSON.stringify(value));
			return false;
		}
		return true;
	}
	if (spec === "integer") {
		if (!Number.isInteger(value)) {
			findings.invalid.push(path + ": 期望 integer,得到 " + kindOf(value));
			return false;
		}
		return true;
	}
	if (spec === "boolean") {
		if (typeof value !== "boolean") {
			findings.invalid.push(path + ": 期望 boolean,得到 " + kindOf(value));
			return false;
		}
		return true;
	}
	if (spec === "array") {
		if (!Array.isArray(value)) {
			findings.invalid.push(path + ": 期望 array,得到 " + kindOf(value));
			return false;
		}
		return true;
	}
	if (spec === "strings") {
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
			findings.invalid.push(path + ": 期望 string[]");
			return false;
		}
		return true;
	}
	if (spec.startsWith("enum:")) {
		const allowed = ENUMS[spec.slice(5)] ?? [];
		if (typeof value !== "string" || !allowed.includes(value)) {
			findings.invalid.push(path + ": 非法枚举值 " + JSON.stringify(value) + ",允许 " + allowed.join(" | "));
			return false;
		}
		return true;
	}
	return true;
}

/** Compare baseline against target for one declared value. */
function compare(spec, base, target, path, hasBase) {
	if (typeof spec === "object" && spec !== null) {
		if (!Array.isArray(target)) {
			findings.invalid.push(path + ": 期望数组,得到 " + kindOf(target));
			return;
		}
		const childType = spec.of.slice(1);
		const byKey = new Map();
		if (hasBase && Array.isArray(base)) {
			for (const element of base) {
				if (element !== null && typeof element === "object") byKey.set(String(element[spec.key]), element);
			}
		}
		const seen = new Set();
		for (const element of target) {
			if (element === null || typeof element !== "object" || Array.isArray(element)) {
				findings.invalid.push(path + ": 元素不是对象");
				continue;
			}
			const id = String(element[spec.key]);
			seen.add(id);
			walk(childType, byKey.get(id), element, path + "[" + id + "]", byKey.has(id));
		}
		if (hasBase) {
			for (const id of byKey.keys()) {
				if (!seen.has(id)) findings.missing.push(path + "[" + id + "]: 基线里有、目标里没有");
			}
		}
		return;
	}
	if (typeof spec === "string" && spec.startsWith("@")) {
		walk(spec.slice(1), base, target, path, hasBase);
		return;
	}
	if (!checkLeaf(spec, target, path)) return;
	if (!hasBase) return;
	const field = fieldOf(path);
	if (VOLATILE.has(field)) return;
	const normalize = NORMALIZE[field];
	const before = normalize ? normalize(base) : base;
	const after = normalize ? normalize(target) : target;
	if (JSON.stringify(before) !== JSON.stringify(after)) {
		findings.changed.push(path + ": 基线 " + JSON.stringify(before) + " -> 目标 " + JSON.stringify(after));
	}
}

/** Walk one schema node: enforce shape, then diff against the baseline. */
function walk(nodeType, base, target, path, hasBase) {
	const schema = SCHEMA[nodeType];
	if (schema === undefined) {
		findings.invalid.push(path + ": 未知 schema 节点 " + nodeType);
		return;
	}
	if (target === null || typeof target !== "object" || Array.isArray(target)) {
		findings.invalid.push(path + ": 期望对象,得到 " + kindOf(target));
		return;
	}
	const required = schema.required ?? {};
	const optional = schema.optional ?? {};
	for (const key of Object.keys(target)) {
		if (!(key in required) && !(key in optional)) findings.invalid.push(path + "." + key + ": schema 未声明的字段");
	}
	const baseObject = hasBase && base !== null && typeof base === "object" && !Array.isArray(base) ? base : undefined;
	for (const key of Object.keys(required)) {
		if (!(key in target)) {
			findings.missing.push(path + "." + key + ": 必填字段缺失");
			continue;
		}
		const had = baseObject !== undefined && Object.prototype.hasOwnProperty.call(baseObject, key);
		compare(required[key], had ? baseObject[key] : undefined, target[key], path + "." + key, had);
	}
	for (const key of Object.keys(optional)) {
		if (!(key in target)) continue;
		const had = baseObject !== undefined && Object.prototype.hasOwnProperty.call(baseObject, key);
		if (!had) findings.added.push(path + "." + key + ": 新增(放行)");
		compare(optional[key], had ? baseObject[key] : undefined, target[key], path + "." + key, had);
	}
}

// ── main ────────────────────────────────────────────────────────────────
const targetArg = process.argv[2];
const baselineArg = process.argv[3];
if (targetArg === undefined) {
	console.error("用法: node verify-manifest.mjs <manifest.json> [baseline.json]");
	process.exit(2);
}
const baselinePath = resolve(baselineArg ?? join(HERE, "fixtures", "manifest-baseline.json"));
const targetPath = resolve(targetArg);
for (const candidate of [baselinePath, targetPath]) {
	if (!existsSync(candidate)) {
		console.error("找不到文件: " + candidate);
		process.exit(2);
	}
}
let baseline;
let target;
try {
	baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
	target = JSON.parse(readFileSync(targetPath, "utf8"));
} catch (error) {
	console.error("JSON 解析失败: " + String(error && error.message ? error.message : error));
	process.exit(2);
}

console.log("基线: " + baselinePath);
console.log("目标: " + targetPath);
console.log("");

walk("manifest", baseline, target, "$", true);

const failures = findings.missing.length + findings.changed.length + findings.invalid.length;
const section = (title, marker, lines) => {
	if (lines.length === 0) return;
	console.log(title + " (" + lines.length + " 处)");
	for (const line of lines) console.log("  " + marker + " " + line);
	console.log("");
};
section("新增 - 放行", "+", findings.added);
section("缺失 - 失败", "-", findings.missing);
section("值变 - 失败", "~", findings.changed);
section("非法 - 失败", "!", findings.invalid);

if (failures === 0) {
	console.log("PASS  无非放行差异" + (findings.added.length > 0 ? "(新增 " + findings.added.length + " 处已放行)" : ""));
	process.exit(0);
}
console.log("FAIL  缺失 " + findings.missing.length + " / 值变 " + findings.changed.length + " / 非法 " + findings.invalid.length);
process.exit(1);
