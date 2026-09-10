import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "lib", "index.js");
const { apply } = await import(pathToFileURL(PLUGIN).href);
const ROOTS = [];

// 捕获插件日志用于确定性等待。固定 sleep 会在机器繁忙时产生竞态 —— 实测出现过
// 同一份代码两次运行结果相反的情况,所以改为轮询插件的终态日志行。
const LOGS = [];
const realLog = console.log.bind(console);
console.log = (...args) => { LOGS.push(args.map(String).join(" ")); realLog(...args); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasTurn = (line, n) => line.includes("turn " + n + ":") || line.includes("turn " + n + " ");
const isPlugin = (line) => line.includes("[dsh-turn-scratch]");
const waitForTurn = async (turnNo) => {
  const deadline = Date.now() + 10000;
  const core = () => LOGS.find((l) => isPlugin(l) && hasTurn(l, turnNo) && (l.includes("quarantined") || l.includes("nothing to quarantine") || l.includes("dryRun")));
  while (Date.now() < deadline && core() === undefined) await sleep(20);
  const line = core();
  if (line === undefined || !line.includes("quarantined")) return;
  const reviewDeadline = Date.now() + 10000;
  while (Date.now() < reviewDeadline && !LOGS.some((l) => isPlugin(l) && l.includes("AI 复核") && hasTurn(l, turnNo))) await sleep(20);
};

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log("  PASS  " + l); };
const bad = (l, why) => { fail++; console.log("  FAIL  " + l + "  -- " + why); };
const present = (root, rel, l) => existsSync(join(root, rel)) ? ok(l) : bad(l, rel + " 不见了");
const gone = (root, rel, l) => existsSync(join(root, rel)) ? bad(l, rel + " 还在原地") : ok(l);
const put = async (root, rel, body) => { await mkdir(dirname(join(root, rel)), { recursive: true }); await writeFile(join(root, rel), body, "utf8"); };

let seq = 0;
function harness(config, label, opts) {
  seq += 1;
  const o = opts || {};
  const root = join(tmpdir(), "dsh-turn-scratch-test-" + seq);
  ROOTS.push(root);
  const st = { handler: undefined, tools: [], lastCall: undefined, reply: "", boom: false };
  const llm = {
    stream(params) {
      st.lastCall = params;
      const boom = st.boom, reply = st.reply;
      return (async function* () {
        if (boom) throw new Error("simulated llm outage");
        yield { type: "text-delta", index: 0, text: reply };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    }
  };
  const ctx = {
    on(name, fn) { if (name === "session/event") st.handler = fn; },
    get(name) {
      if (name === "llm") return o.noLlm ? undefined : llm;
      if (name === "settings") return o.noSettings ? undefined : { get: () => ({ provider: "fake", model: "fake-reviewer" }) };
      return undefined;
    },
    inject(_deps, cb) { cb({ tools: { register(def) { st.tools.push(def); } } }); },
    ...(o.logger ? { logger: o.logger } : {})
  };
  apply(ctx, { debug: true, ...config });
  if (typeof st.handler !== "function") { bad(label + " 订阅", "never subscribed"); }
  const session = { id: "s" + seq, header: { cwd: root } };
  return {
    root, st, session, label,
    emit: (type, data) => st.handler(session, { type, data, seq: 1 }),
    settle: (turnNo) => waitForTurn(turnNo)
  };
}

let callSeq = 0;
const writeVia = (h, rel, body) => {
  const callId = "c" + (++callSeq);
  h.emit("tool/call", { callId, name: "write", arguments: JSON.stringify({ file_path: rel, content: body }) });
  return callId;
};
const editVia = (h, rel) => {
  const callId = "c" + (++callSeq);
  h.emit("tool/call", { callId, name: "edit", arguments: JSON.stringify({ file_path: rel, old_string: "a", new_string: "b" }) });
  return callId;
};
const okResult = (h, callId) => h.emit("tool/result", { message: { content: [{ isError: false }], source: { callId } } });
const turn = async (h, n, prompt, body) => {
  LOGS.length = 0;
  h.emit("turn/start", { turn: n });
  h.emit("user/message", { message: { content: prompt } });
  await body();
  h.emit("turn/end", { turn: n });
  await h.settle(n);
};
const markTool = (h) => h.st.tools.find((d) => d.name === "scratch_mark");

// ─────────────────────────────────────────────────────────────
console.log("\n[1] 启发式:新建临时命名 vs 普通交付物 vs 用户点名(复核关闭)");
{
  const h = harness({ aiReview: { enabled: false } }, "h1");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  await turn(h, 1, "把 报告.md 更新一下", async () => {
    okResult(h, writeVia(h, "tmp_helper.mjs", "x")); await put(h.root, "tmp_helper.mjs", "x");
    okResult(h, writeVia(h, "report.md", "y")); await put(h.root, "report.md", "y");
    okResult(h, writeVia(h, "报告.md", "z")); await put(h.root, "报告.md", "z");
  });
  gone(h.root, "tmp_helper.mjs", "临时脚本被隔离");
  present(h.root, "report.md", "普通交付物保留");
  present(h.root, "报告.md", "用户点名文件豁免");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[2] scratch_mark:任意命名都能被确定性收走(启发式认不出的名字)");
{
  const h = harness({ aiReview: { enabled: false } }, "h2");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  const tool = markTool(h);
  tool === undefined ? bad("scratch_mark 注册", "tool not registered") : ok("scratch_mark 已注册");
  await turn(h, 1, "帮我算一下", async () => {
    okResult(h, writeVia(h, "helper_final_v2.py", "print(1)")); await put(h.root, "helper_final_v2.py", "print(1)");
    const r = await tool.execute({ paths: ["helper_final_v2.py"], reason: "one-off calc" });
    r.marked.length === 1 ? ok("标记被记录") : bad("标记记录", JSON.stringify(r));
  });
  gone(h.root, "helper_final_v2.py", "不匹配任何规则的名字被标记后收走");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[3] scratch_mark 不能突破用户点名豁免");
{
  const h = harness({ aiReview: { enabled: false } }, "h3");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  await turn(h, 1, "请生成 deliverable.py 给我", async () => {
    okResult(h, writeVia(h, "deliverable.py", "x")); await put(h.root, "deliverable.py", "x");
    await markTool(h).execute({ paths: ["deliverable.py"] });
  });
  present(h.root, "deliverable.py", "用户点名的文件即使被标记也不收");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[4] AI 复核:还原误判(核心理念 —— AI 有还原权)");
{
  const h = harness({ aiReview: { enabled: true } }, "h4");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  h.st.reply = JSON.stringify({ decisions: [{ path: "tmp_important.docx", action: "restore", reason: "内容是一份正式报告,名字有误导性" }] });
  await turn(h, 1, "写点东西", async () => {
    okResult(h, writeVia(h, "tmp_important.docx", "这是一份 31 页的课程设计报告正文")); await put(h.root, "tmp_important.docx", "这是一份 31 页的课程设计报告正文");
  });
  present(h.root, "tmp_important.docx", "AI 判定误判 -> 文件被还原");
  const m = JSON.parse(await readFile(join(h.root, ".dsh-scratch-trash", h.session.id, "turn-1", "manifest.json"), "utf8"));
  (m.review && m.review.restored.includes("tmp_important.docx")) ? ok("manifest 记录了还原") : bad("manifest.review", JSON.stringify(m.review));
}

// ─────────────────────────────────────────────────────────────
console.log("\n[5] AI 复核:维持隔离 + 越权动作被忽略");
{
  const h = harness({ aiReview: { enabled: true } }, "h5");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  h.st.reply = JSON.stringify({ decisions: [
    { path: "tmp_helper.mjs", action: "keep", reason: "确实是一次性脚手架" },
    { path: "tmp_helper.mjs", action: "delete", reason: "我建议永久删除" }
  ] });
  await turn(h, 1, "干活", async () => {
    okResult(h, writeVia(h, "tmp_helper.mjs", "x")); await put(h.root, "tmp_helper.mjs", "x");
  });
  gone(h.root, "tmp_helper.mjs", "AI 说 keep -> 保持隔离");
  existsSync(join(h.root, ".dsh-scratch-trash", h.session.id, "turn-1", "tmp_helper.mjs"))
    ? ok("AI 的 delete 越权请求被忽略,文件仍在回收站(未被销毁)")
    : bad("越权防护", "文件被 AI 的 delete 动作销毁了");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[6] fail-safe:LLM 挂掉时必须保持全部隔离,绝不能反向丢东西");
{
  const h = harness({ aiReview: { enabled: true } }, "h6");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  h.st.boom = true;
  await turn(h, 1, "干活", async () => {
    okResult(h, writeVia(h, "tmp_x.mjs", "x")); await put(h.root, "tmp_x.mjs", "x");
  });
  existsSync(join(h.root, ".dsh-scratch-trash", h.session.id, "turn-1", "tmp_x.mjs"))
    ? ok("LLM 抛错 -> 条目安全留在回收站")
    : bad("fail-safe", "LLM 挂掉后条目丢失");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[7] fail-safe:AI 输出无法解析时同样保持隔离");
{
  const h = harness({ aiReview: { enabled: true } }, "h7");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  h.st.reply = "我觉得这些都该留着,但我忘了输出 JSON";
  await turn(h, 1, "干活", async () => {
    okResult(h, writeVia(h, "tmp_y.mjs", "y")); await put(h.root, "tmp_y.mjs", "y");
  });
  existsSync(join(h.root, ".dsh-scratch-trash", h.session.id, "turn-1", "tmp_y.mjs"))
    ? ok("垃圾输出 -> 条目安全留在回收站")
    : bad("解析失败兜底", "条目丢失");
}

// ─────────────────────────────────────────────────────────────
console.log("\n[8] 复核只在真有东西进回收站时才触发(事件驱动,不是每轮)");
{
  const h = harness({ aiReview: { enabled: true } }, "h8");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  await turn(h, 1, "只是聊聊天", async () => {});
  h.st.lastCall === undefined ? ok("什么都没创建 -> 零 LLM 调用") : bad("事件驱动", "空轮次也调了 LLM");
  await rm(h.root, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────
const toolOf = (h, name) => h.st.tools.find((d) => d.name === name);
const readManifest = async (h, turn) =>
  JSON.parse(await readFile(join(h.root, ".dsh-scratch-trash", h.session.id, "turn-" + turn, "manifest.json"), "utf8"));

console.log("\n[9] 复核结果必须永远写进 manifest —— 不允许静默");
{
  const h = harness({ aiReview: { enabled: true } }, "h9a", { noSettings: true });
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  await turn(h, 1, "干活", async () => {
    okResult(h, writeVia(h, "tmp_a.mjs", "x")); await put(h.root, "tmp_a.mjs", "x");
  });
  const m = await readManifest(h, 1);
  m.review && m.review.outcome === "skipped-no-route"
    ? ok("拿不到模型 -> outcome=skipped-no-route 已记录")
    : bad("no-route 记录", JSON.stringify(m.review));

  const h2 = harness({ aiReview: { enabled: true } }, "h9b");
  await rm(h2.root, { recursive: true, force: true }); await mkdir(h2.root, { recursive: true });
  h2.st.reply = "我忘了输出 JSON";
  await turn(h2, 1, "干活", async () => {
    okResult(h2, writeVia(h2, "tmp_b.mjs", "x")); await put(h2.root, "tmp_b.mjs", "x");
  });
  const m2 = await readManifest(h2, 1);
  m2.review && m2.review.outcome === "unparsed" && typeof m2.review.raw === "string"
    ? ok("输出不可解析 -> outcome=unparsed 且留下原文")
    : bad("unparsed 记录", JSON.stringify(m2.review));

  const h3 = harness({ aiReview: { enabled: true } }, "h9c");
  await rm(h3.root, { recursive: true, force: true }); await mkdir(h3.root, { recursive: true });
  h3.st.boom = true;
  await turn(h3, 1, "干活", async () => {
    okResult(h3, writeVia(h3, "tmp_c.mjs", "x")); await put(h3.root, "tmp_c.mjs", "x");
  });
  const m3 = await readManifest(h3, 1);
  m3.review && m3.review.outcome === "failed" && m3.review.problems.length > 0
    ? ok("模型挂掉 -> outcome=failed 且带原因")
    : bad("failed 记录", JSON.stringify(m3.review));

  const h4 = harness({ aiReview: { enabled: false } }, "h9d");
  await rm(h4.root, { recursive: true, force: true }); await mkdir(h4.root, { recursive: true });
  await turn(h4, 1, "干活", async () => {
    okResult(h4, writeVia(h4, "tmp_d.mjs", "x")); await put(h4.root, "tmp_d.mjs", "x");
  });
  const m4 = await readManifest(h4, 1);
  m4.review && m4.review.outcome === "disabled"
    ? ok("复核关闭 -> outcome=disabled 已记录")
    : bad("disabled 记录", JSON.stringify(m4.review));
}

console.log("\n[10] 硬约束一:孤儿库是用户显式配置,代码定案,模型无权参与");
{
  const h = harness({ aiReview: { enabled: true }, orphanStores: ["data.store"], orphanStoreMinAgeMinutes: 0 }, "h10");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  await put(h.root, "data.store", '{"tool":"gone"}');
  // 故意准备一个"还原"的回答:硬约束若失效,它就会被执行
  h.st.reply = JSON.stringify({ decisions: [{ path: "data.store", action: "restore", reason: "看着像有用数据" }] });
  await turn(h, 1, "干活", async () => {});
  gone(h.root, "data.store", "文件没被放回工作区");
  existsSync(join(h.root, ".dsh-scratch-trash", h.session.id, "turn-1", "data.store"))
    ? ok("条目仍安全留在回收站")
    : bad("硬约束", "孤儿库条目被放走了");
  h.st.lastCall === undefined
    ? ok("模型根本没被咨询(该条目模型无裁量权)")
    : bad("越权咨询", "不该把孤儿库条目送去问模型");
  const m = await readManifest(h, 1);
  m.review.modelConsulted === false
    ? ok("manifest 记录 modelConsulted=false")
    : bad("modelConsulted", JSON.stringify(m.review.modelConsulted));
  m.review.preResolved.some((p) => p.path === "data.store" && p.action === "keep")
    ? ok("preResolved 记录了该条由约束定案")
    : bad("preResolved", JSON.stringify(m.review.preResolved));
  m.review.kept.some((k) => k.reason.includes("孤儿库"))
    ? ok("kept.reason 含「孤儿库」文案")
    : bad("孤儿库文案", JSON.stringify(m.review.kept));
}

console.log("\n[11] 硬约束二:读不到内容 -> 代码定案还原,模型无权参与");
{
  const h = harness({ aiReview: { enabled: true } }, "h11");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  h.st.reply = JSON.stringify({ decisions: [{ path: "tmp_blind.bin", action: "keep", reason: "我觉得是垃圾" }] });
  await turn(h, 1, "干活", async () => {
    const cid = writeVia(h, "tmp_blind.bin", "x");
    await writeFile(join(h.root, "tmp_blind.bin"), Buffer.from([0x41, 0x00, 0x42, 0x00]));
    okResult(h, cid);
  });
  present(h.root, "tmp_blind.bin", "二进制文件被还原回工作区");
  h.st.lastCall === undefined
    ? ok("模型根本没被咨询(读不到内容,问它也没意义)")
    : bad("越权咨询", "不该把盲区条目送去问模型");
  const m = await readManifest(h, 1);
  m.review.preResolved.some((p) => p.path === "tmp_blind.bin" && p.action === "restore" && p.reason.includes("读不到内容"))
    ? ok("preResolved 记下了兜底理由「读不到内容,无证据支持隔离」")
    : bad("兜底理由", JSON.stringify(m.review.preResolved));
  m.review.modelConsulted === false
    ? ok("manifest 记录 modelConsulted=false")
    : bad("modelConsulted", JSON.stringify(m.review.modelConsulted));
  m.review.restored.includes("tmp_blind.bin")
    ? ok("restored 列表包含该项")
    : bad("restored", JSON.stringify(m.review.restored));
}

console.log("\n[12] 人工裁决工具");
{
  const h = harness({ aiReview: { enabled: false } }, "h12");
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  await turn(h, 1, "干活", async () => {
    okResult(h, writeVia(h, "tmp_one.mjs", "1")); await put(h.root, "tmp_one.mjs", "1");
    okResult(h, writeVia(h, "tmp_two.mjs", "2")); await put(h.root, "tmp_two.mjs", "2");
  });

  const statusTool = toolOf(h, "scratch_status");
  const restoreTool = toolOf(h, "scratch_restore");
  const purgeTool = toolOf(h, "scratch_purge");
  [statusTool, restoreTool, purgeTool].every((t) => t !== undefined)
    ? ok("三个工具都已注册")
    : bad("工具注册", [statusTool, restoreTool, purgeTool].map((t) => !!t).join(","));

  const st = await statusTool.execute({ workspace: h.root }, {});
  st.total === 2 && st.buckets.length === 1
    ? ok("scratch_status 列出 2 项待决")
    : bad("scratch_status", JSON.stringify(st));

  const r1 = await restoreTool.execute({ workspace: h.root, paths: ["tmp_one.mjs"] }, {});
  r1.restored.length === 1 ? ok("scratch_restore 按路径还原 1 项") : bad("restore", JSON.stringify(r1));
  present(h.root, "tmp_one.mjs", "  -> tmp_one.mjs 回到原处");

  // 这一组覆盖被修掉的 bug:还原之后 status 必须不再把它算作待决
  const st2 = await statusTool.execute({ workspace: h.root }, {});
  st2.total === 1
    ? ok("还原一项后 status 待决数从 2 降为 1")
    : bad("待决数", "total=" + st2.total + " 期望 1");
  st2.restoredTotal === 1
    ? ok("status 单独报告已还原数 restoredTotal=1")
    : bad("restoredTotal", String(st2.restoredTotal));
  st2.buckets[0].present.includes("tmp_two.mjs") && st2.buckets[0].restored.includes("tmp_one.mjs")
    ? ok("按 present / restored 正确分组")
    : bad("分组", JSON.stringify(st2.buckets[0]));
  const readBack = await readManifest(h, 1);
  const stamped = readBack.items.find((i) => i.path === "tmp_one.mjs");
  stamped !== undefined && typeof stamped.restoredAt === "string" && stamped.restoredBy === "tool"
    ? ok("restoredAt/restoredBy 已回写 manifest(不只是内存里的戳)")
    : bad("回写 manifest", JSON.stringify(stamped));

  const r2 = await restoreTool.execute({ workspace: h.root }, {});
  r2.restored.length === 1 ? ok("scratch_restore 无过滤时还原其余全部") : bad("restore all", JSON.stringify(r2));
  present(h.root, "tmp_two.mjs", "  -> tmp_two.mjs 回到原处");

  // 第一道防线:框架的 schema 校验,缺 confirm 直接抛 ToolArgsError
  let schemaRejected = false;
  try { await purgeTool.execute({ workspace: h.root, all: true }, {}); } catch (error) { schemaRejected = error && error.code === "INVALID_ARGS"; }
  schemaRejected ? ok("缺 confirm 被框架 schema 直接拒绝(第一道防线)") : bad("purge schema 守卫", "框架没有拒绝");

  // 第二道防线:插件自己的运行时守卫
  const p1 = await purgeTool.execute({ workspace: h.root, confirm: false, all: true }, {});
  p1.refused !== undefined ? ok("confirm=false 时被插件运行时拒绝(第二道防线)") : bad("purge 运行时守卫", JSON.stringify(p1));
  const p2 = await purgeTool.execute({ workspace: h.root, confirm: true }, {});
  p2.refused !== undefined ? ok("未收窄范围时拒绝") : bad("purge 范围守卫", JSON.stringify(p2));
  const p3 = await purgeTool.execute({ workspace: h.root, confirm: true, all: true }, {});
  p3.removed.length === 1 ? ok("scratch_purge 显式确认后清空 1 个桶") : bad("purge", JSON.stringify(p3));
  !existsSync(join(h.root, ".dsh-scratch-trash"))
    ? ok("purge 后不留空壳(桶 + 空父目录 + 空回收站根一并清理)")
    : bad("空目录残留", "purge 后 .dsh-scratch-trash 仍存在");
}

console.log("\n[13] 日志必须走宿主 ctx.logger(console 在 DSH Desktop 里无人可见)");
{
  const calls = [];
  const echo = (level, message) => {
    calls.push([level, String(message)]);
    // 同时回显到 console,让 waitForTurn 的日志等待逻辑仍然可用
    console.log("[dsh-turn-scratch] " + message);
  };
  const named = {
    info: (m) => echo("info", m),
    warn: (m) => echo("warn", m),
    debug: (m) => echo("debug", m)
  };
  const logger = (name) => { calls.push(["named", String(name)]); return named; };
  const h = harness({ aiReview: { enabled: false } }, "h13", { logger });
  await rm(h.root, { recursive: true, force: true }); await mkdir(h.root, { recursive: true });
  await turn(h, 1, "干活", async () => {
    okResult(h, writeVia(h, "tmp_log.mjs", "x")); await put(h.root, "tmp_log.mjs", "x");
  });
  calls.some((c) => c[0] === "named" && c[1] === "dsh-turn-scratch")
    ? ok("用了命名 logger ctx.logger(NAME)")
    : bad("命名 logger", JSON.stringify(calls.slice(0, 4)));
  calls.some((c) => c[0] === "info" && c[1].includes("quarantined"))
    ? ok("隔离事件走 logger.info")
    : bad("logger 路由", JSON.stringify(calls));
  calls.some((c) => c[0] === "info" && c[1].includes("loaded"))
    ? ok("加载事件走 logger.info")
    : bad("加载日志路由", JSON.stringify(calls));
}


console.log("\n[14] 决策一致性断言:preResolved 与最终结果必须一致");
{
  // 故障注入让盲区条目的还原必然失败 -> preResolved 声明 restore,但 restored 里没有它
  const blindTurn = async (h) => {
    LOGS.length = 0;
    h.emit("turn/start", { turn: 1 });
    h.emit("user/message", { message: { content: "干活" } });
    const cid = writeVia(h, "tmp_fault.bin", "x");
    await writeFile(join(h.root, "tmp_fault.bin"), Buffer.from([0x41, 0x00, 0x42]));
    okResult(h, cid);
    h.emit("turn/end", { turn: 1 });
  };
  const manifestPathOf = (h) => join(h.root, ".dsh-scratch-trash", h.session.id, "turn-1", "manifest.json");

  // ── A. throw 模式:断言必须抛出去,不能被吞成一条 warn ──
  const rejections = [];
  const onRejection = (reason) => rejections.push(String(reason && reason.message ? reason.message : reason));
  process.on("unhandledRejection", onRejection);
  const ha = harness({ aiReview: { enabled: true }, consistencyMode: "throw", __faults: ["restore-pre-resolved"] }, "h14a");
  await rm(ha.root, { recursive: true, force: true }); await mkdir(ha.root, { recursive: true });
  await blindTurn(ha);
  const deadlineA = Date.now() + 4000;
  while (Date.now() < deadlineA && rejections.length === 0) await sleep(20);
  process.off("unhandledRejection", onRejection);
  rejections.some((r) => r.includes("决策一致性断言失败"))
    ? ok("throw 模式:断言抛出且消息可见")
    : bad("throw 模式", JSON.stringify(rejections));
  rejections.some((r) => r.includes("决定没有落地"))
    ? ok("异常消息指明是「决定没有落地」")
    : bad("异常消息", JSON.stringify(rejections));

  // ── B. fatal 模式(生产默认):记 error 且拒写盘 ──
  const calls14 = [];
  const logger14 = () => ({
    info: () => {},
    warn: () => {},
    error: (m) => calls14.push(String(m)),
    debug: () => {}
  });
  const hb = harness({ aiReview: { enabled: true }, __faults: ["restore-pre-resolved"] }, "h14b", { logger: logger14 });
  await rm(hb.root, { recursive: true, force: true }); await mkdir(hb.root, { recursive: true });
  await blindTurn(hb);
  const deadlineB = Date.now() + 4000;
  while (Date.now() < deadlineB && calls14.length === 0) await sleep(20);
  calls14.some((m) => m.includes("决策一致性断言失败"))
    ? ok("fatal 模式:以 error 级别记录了断言失败")
    : bad("fatal 日志", JSON.stringify(calls14));
  calls14.some((m) => m.includes("拒绝写入"))
    ? ok("fatal 日志明确写出「拒绝写入」")
    : bad("拒写盘声明", JSON.stringify(calls14));
  existsSync(manifestPathOf(hb))
    ? ok("items-only manifest 仍在(隔离的文件没变成无清单孤儿)")
    : bad("孤儿风险", "连 items 记录都没写,隔离的文件失去清单");
  const mb = await readManifest(hb, 1);
  mb.review === undefined
    ? ok("拒写盘生效:manifest 里没有 review 段")
    : bad("拒写盘", "review 段竟然写进去了: " + JSON.stringify(mb.review));
  // ── C. 无故障时断言不得误报(否则它就是个假警报制造机) ──
  const callsC = [];
  const loggerC = () => ({ info: () => {}, warn: () => {}, error: (m) => callsC.push(String(m)), debug: () => {} });
  const hc = harness({ aiReview: { enabled: true } }, "h14c", { logger: loggerC });
  await rm(hc.root, { recursive: true, force: true }); await mkdir(hc.root, { recursive: true });
  await blindTurn(hc);
  const deadlineC = Date.now() + 4000;
  while (Date.now() < deadlineC && !existsSync(manifestPathOf(hc))) await sleep(20);
  await sleep(200);
  callsC.length === 0
    ? ok("无故障时不误报:没有产生任何 error 级日志")
    : bad("误报", JSON.stringify(callsC));
  const mc = await readManifest(hc, 1);
  mc.review !== undefined && mc.review.preResolved.length === 1 && mc.review.restored.includes("tmp_fault.bin")
    ? ok("无故障时正常落盘,preResolved 与 restored 自洽")
    : bad("正常落盘", JSON.stringify(mc.review));
}

for (const root of ROOTS) await rm(root, { recursive: true, force: true });

console.log("\n" + (fail === 0 ? "ALL PASS (" + pass + ")" : pass + " passed, " + fail + " FAILED"));
process.exit(fail === 0 ? 0 : 1);
