#!/usr/bin/env node
/**
 * test-verify-manifest.mjs - self-test for verify-manifest.mjs.
 *
 * Four cases, one per diff category the script claims to handle:
 *   1. 一致       baseline vs itself            -> PASS (exit 0)
 *   2. 新增放行   add optional fields           -> PASS (exit 0), additions reported
 *   3. 缺失       drop a required field         -> FAIL (exit 1), missing reported
 *   4. 值变+非法  change a value, break an enum -> FAIL (exit 1), both reported
 *
 * Fixtures are generated into a temp dir and removed afterwards; nothing is
 * written next to the manifests under test.
 */

import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "verify-manifest.mjs");
const BASELINE = join(HERE, "fixtures", "manifest-baseline.json");
const WORK = join(tmpdir(), "verify-manifest-selftest");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
const clone = () => JSON.parse(JSON.stringify(baseline));
const writeFixture = (name, value) => {
	const path = join(WORK, name);
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
	return path;
};

/** Run the script; never throws. Returns exit code plus captured stdout. */
const run = (target) => {
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT, target, BASELINE], { encoding: "utf8" });
		return { code: 0, out: stdout };
	} catch (error) {
		return { code: typeof error.status === "number" ? error.status : -1, out: String(error.stdout ?? "") };
	}
};

let pass = 0;
let fail = 0;
const check = (label, condition, detail) => {
	if (condition) {
		pass += 1;
		console.log("  PASS  " + label);
		return;
	}
	fail += 1;
	console.log("  FAIL  " + label + (detail === undefined ? "" : "  -- " + detail));
};

console.log("");
console.log("[1] 一致:基线 vs 自身 -> 应 PASS 且零差异");
{
	const r = run(writeFixture("case1-identical.json", clone()));
	check("exit=0", r.code === 0, "实际 exit=" + r.code);
	const clean = !r.out.includes("缺失") && !r.out.includes("值变") && !r.out.includes("非法") && !r.out.includes("新增");
	check("无任何差异分组", clean, r.out.split("\n").filter((l) => l.includes("-") || l.includes("~") || l.includes("!")).join(" | "));
	check("报告 PASS", r.out.includes("PASS"), r.out.trim().split("\n").pop());
}

console.log("");
console.log("[2] 新增放行:给 item 加 optional 字段 -> 应 PASS,新增被报出但不失败");
{
	const fixture = clone();
	fixture.items[0].restoredAt = "2026-09-11T00:23:06.255Z";
	fixture.items[0].restoredBy = "review";
	const r = run(writeFixture("case2-addition.json", fixture));
	check("exit=0(新增不导致失败)", r.code === 0, "实际 exit=" + r.code);
	check("报出 2 处新增", (r.out.match(/\+ /g) ?? []).length === 2, r.out.split("\n").filter((l) => l.trim().startsWith("+ ")).join(" | "));
	check("明确标注放行", r.out.includes("放行"), "");
	check("报告 PASS", r.out.includes("PASS"), r.out.trim().split("\n").pop());
}

console.log("");
console.log("[3] 缺失:删掉必填字段 restoreHint -> 应 FAIL(exit 1) 且指名该字段");
{
	const fixture = clone();
	delete fixture.restoreHint;
	const r = run(writeFixture("case3-missing.json", fixture));
	check("exit=1", r.code === 1, "实际 exit=" + r.code);
	check("报出缺失", r.out.includes("缺失"), "");
	check("指名 restoreHint", r.out.includes("restoreHint"), r.out.split("\n").filter((l) => l.trim().startsWith("- ")).join(" | "));
	check("报告 FAIL", r.out.includes("FAIL"), r.out.trim().split("\n").pop());
}

console.log("");
console.log("[4] 值变 + 非法:reviewed 2->3(合法类型值变) 且 outcome 改成非法枚举");
{
	const fixture = clone();
	fixture.review.reviewed = 3;
	fixture.review.outcome = "totally-bogus";
	const r = run(writeFixture("case4-changed-invalid.json", fixture));
	check("exit=1", r.code === 1, "实际 exit=" + r.code);
	check("报出值变", r.out.includes("值变"), "");
	check("值变指名 reviewed", r.out.includes("reviewed"), r.out.split("\n").filter((l) => l.trim().startsWith("~ ")).join(" | "));
	check("报出非法", r.out.includes("非法"), "");
	check("非法指名允许值集合", r.out.includes("允许 completed"), r.out.split("\n").filter((l) => l.trim().startsWith("! ")).join(" | "));
	check("报告 FAIL 且分项计数正确", r.out.includes("FAIL  缺失 0 / 值变 1 / 非法 1"), r.out.trim().split("\n").pop());
}

rmSync(WORK, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? "自测全部通过 (" + pass + " 项断言)" : pass + " 通过, " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
