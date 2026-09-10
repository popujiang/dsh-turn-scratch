import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "lib", "index.js");
const PROBE = join(HERE, ".probe.mjs");

// 从真实源码派生可测模块:去掉 export 前缀,补导内部函数,避免实现漂移。
// 探针落在包目录内,插件的 @deepseek-ai/* 依赖经本地 node_modules 解析。
const source = readFileSync(SRC, "utf8").replace("export function apply", "function apply");
writeFileSync(PROBE, source + "\nexport { globToRegExp, isInside, mutationOf, parseDecisions, toPosix };\n");

const mod = await import(pathToFileURL(PROBE).href);
rmSync(PROBE, { force: true });

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else { fail++; console.log("FAIL  " + label + "  got=" + JSON.stringify(actual) + " want=" + JSON.stringify(expected)); }
};
const G = (glob, path) => mod.globToRegExp(glob).test(path);

check("scratch dir root", G("**/_build/**", "_build/"), true);
check("scratch dir nested", G("**/_build/**", "a/b/_build/"), true);
check("scratch dir child", G("**/_build/**", "_build/content.mjs"), true);
check("near-miss _builder", G("**/_build/**", "src/_builder/"), false);
check("bak nested", G("**/*.bak", "a/b/x.bak"), true);
check("bak root", G("**/*.bak", "x.bak"), true);
check("bak near-miss", G("**/*.bak", "a/x.baky"), false);
check("prefix tmp_", G("**/tmp_*", "tmp_a"), true);
check("git protect", G("**/.git/**", ".git/"), true);
check("git protect nested", G("**/.git/**", "sub/.git/"), true);
check("node_modules protect", G("**/node_modules/**", "node_modules/"), true);
check("trash protect", G("**/.dsh-scratch-trash/**", ".dsh-scratch-trash/"), true);
check("tilde backup", G("**/*~", "notes.md~"), true);

const R = "D:\\share";
check("inside direct", mod.isInside(R, "D:\\share\\a.txt"), true);
check("inside nested", mod.isInside(R, "D:\\share\\x\\y.txt"), true);
check("outside sibling", mod.isInside(R, "D:\\share2\\a.txt"), false);
check("outside parent", mod.isInside(R, "D:\\other\\a.txt"), false);
check("root itself", mod.isInside(R, "D:\\share"), false);

check("write creates", mod.mutationOf("write", { file_path: "a.mjs", content: "x" }), { path: "a.mjs", createsOnly: true });
check("write non-string content", mod.mutationOf("write", { file_path: "a", content: 5 }), null);
check("edit never creates", mod.mutationOf("edit", { file_path: "a.mjs", old_string: "a", new_string: "b" }), { path: "a.mjs", createsOnly: false });
check("editor create", mod.mutationOf("str_replace_editor", { command: "create", path: "a.mjs" }), { path: "a.mjs", createsOnly: true });
check("editor str_replace", mod.mutationOf("str_replace_editor", { command: "str_replace", path: "a.mjs" }), { path: "a.mjs", createsOnly: false });
check("bash ignored", mod.mutationOf("bash", { command: "rm -rf /" }), null);
check("write blank path", mod.mutationOf("write", { file_path: "   ", content: "x" }), null);

check("parse plain json", mod.parseDecisions('{"decisions":[{"path":"a","action":"restore"}]}').length, 1);
check("parse fenced json", mod.parseDecisions('好的:\n\u0060\u0060\u0060json\n{"decisions":[{"path":"b","action":"keep"}]}\n\u0060\u0060\u0060\n以上').length, 1);
check("parse garbage", mod.parseDecisions("我觉得都该留着"), null);
check("parse broken json", mod.parseDecisions('{"decisions":['), null);

console.log(fail === 0 ? "ALL PASS (" + pass + ")" : pass + " passed, " + fail + " FAILED");
process.exit(fail === 0 ? 0 : 1);
