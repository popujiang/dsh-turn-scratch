# dsh-turn-scratch

DSH 插件:每个 turn 结束时,把该 turn 产生的**临时产物**移进工作区回收站
`.dsh-scratch-trash/`,而不是删除。回收站带 `manifest.json`,可随时还原。

## 核心原则:删除权不交给任何概率性判断

判定"哪个文件是垃圾"只能靠启发式或模型,两者都会错。所以本插件**从不存在删除路径** ——
只有"移进回收站"和"移回原处"两个动作。任何一层的失误,结果都是"少省一点空间",
而不是"用户丢了文件"。

三层判定,从强到弱:

| 层 | 信号 | 成本 | 失误后果 |
| --- | --- | --- | --- |
| 1 | `scratch_mark` 工具:agent 自报哪些是脚手架 | 零 | agent 误报 -> 进回收站,可还原 |
| 2 | 启发式:本轮新建 + 临时命名 + 目录 mtime | 零 | 误收 -> 进回收站,可还原 |
| 3 | AI 复核:**只有还原权** | 事件驱动 | 误判 -> 少还原一个,无害 |

### 第 3 层为什么是"只还原"

模型判断错了会怎样,取决于你给它什么权力:

- 给它**删除权** -> 误判 = 用户数据永久消失
- 给它**还原权** -> 误判 = 一个本该隔离的文件留了下来

同样的判断力,风险方向完全反过来。所以复核员拿到的指令里明确写着它没有删除权,
越权的 `delete` 动作会被直接忽略(有测试覆盖)。

### 第 3 层为什么不是"每轮"

复核只在**回收站真的收到东西时**才触发。绝大多数轮次什么都没创建,那些轮次是**零 LLM 调用**。
按轮触发等于为"什么都没发生"持续付费。

### 两条硬约束在问模型之前就定案

"读不到内容 -> 还原"和"孤儿库 -> 保持隔离"这两条,**由代码先判,根本不送去问模型**:

- 模型对这两类条目本就没有裁量权,问它纯属浪费;
- 更关键的是:**一个守规矩的模型会给出相同答案,于是它的回答会掩盖"约束到底有没有执行"**。
  在模型之前定案,每条约束的结果都独立记进 `preResolved`,确定且可单独追溯。

模型只处理剩下那部分 —— **能读到内容、且不属显式配置**的条目。这类条目才是它真正有资格判断的。

如果全部条目都被硬约束定案了,**一次模型调用都不会发生**(日志会写 `复核(硬约束定案)`)。

## 硬约束(任何一层都不能突破)

- 只处理 resolve 后确实落在工作区**内部**的路径;
- 本轮仅被 `edit` 的既有文件永不入内;
- 用户当轮 prompt 里点名过的路径/文件名一律豁免(包括被 `scratch_mark` 标记的);
- `.git/`、`node_modules/`、`.dsh-scratch-trash/` 永不入内;
- **用户显式配置的东西(`orphanStores`)复核无权推翻** —— 显式人类配置高于 AI 判断;
- **读不到内容的条目一律还原** —— 二进制/超大/不可读的条目没有内容证据,
  而"没有证据"不足以支撑"维持隔离"。

## 复核的两道紧箍咒

第一条写在提示词里(编号、声明违反即失败),第二条直接写在代码里。
**提示词会被忽略,代码不会** —— 所以真正兜底的永远是第二道:

```
提示词层:1. 你没有删除权  2. 无法从内容确认是临时产物就必须 restore
          3. 看不到内容的条目一律 restore  4. orphan-store 一律 keep
代码层:  respectExplicitConfig   —— orphan-store 的 restore 决定被丢弃并记录原因
         restoreWhenUninspectable —— binary/large/unreadable 的 keep 决定被翻转为 restore
```

越权的 `delete` 动作没有落点 —— 代码里根本不存在那个分支。

## scratch_mark 工具

启发式只能认出"名字像临时的"文件。真正的一次性脚手架可能叫 `helper_final_v2.py`,
规则永远猜不到。所以 agent 可以在创建时直接声明:

```
scratch_mark({ paths: ["helper_final_v2.py", "_scratch/calc.py"], reason: "一次性计算脚本" })
```

标记不要求匹配任何命名规则,但**不能突破**用户点名豁免和硬保护。
未被消费的标记默认 6 小时后过期(`markTtlMs`)。

## 人工裁决(最高权限在你这边)

AI 只有还原权,人有全部权限。三个工具:

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `scratch_status` | 只读:列出每个桶,并按 **待决 / 已还原** 两组分开报数(读数口径见下方「可信度边界」) | 无 |
| `scratch_restore` | 把条目移回原路径。可按 `paths` / `session` / `turn` 过滤,省略则全还原 | 无(只是放回去) |
| `scratch_purge` | **永久删除**隔离条目 | 不可逆 |

`scratch_purge` 有两道守卫:**框架的 schema 校验**要求显式传 `confirm: true`,
插件的运行时守卫还要求必须用 `all: true` 或 `session`/`turn` **收窄范围** ——
裸调用一律拒绝。它的工具描述里也写明了只能由人直接下令,agent 不得自行发起。

直接说"把隔离区里那个 X 还原"或"清空隔离区"即可,不需要手敲命令。

## 可信度边界(取舍,不是 bug)

下面两条是本设计的**代价**。写在这里,以免将来被误当成缺陷去"修"。

### 1. `restoredTotal` 是**当前桶内**的计数,不是历史统计

`scratch_status` 的 `restoredTotal` 统计的是"**现存**桶里盖了 `restoredAt` 的条目数"。
而 `scratch_purge` 的语义就是**彻底清理** —— 它会把整个桶连同 `manifest.json` 一起删除。
所以 purge 之后,那些已还原条目和它们的计数**一并归零**。

把 `restoredTotal` 当长期审计数字用,会在 purge 后落空。需要长期留痕的话,
请在 purge **之前**把 `manifest.json` 另存一份。

### 2. `status` 反映的是 manifest 记录,**不校验文件系统**

`scratch_status` 不碰 IO,只读 manifest —— 这是"盖戳而不是探测"的直接结果,
换来的是没有竞态、也没有额外磁盘扫描。

代价是它的可信度依赖一个前提:**对隔离区的所有改动都经过本插件**。
如果有人在插件之外手动删除或移走了桶里的文件,`status` 仍会照 manifest 报 `present`,
与磁盘实际不符。

所以 `present` 的准确含义是"**插件记录里仍待决**",而不是"文件此刻确实在磁盘上"。
需要以磁盘为准时,直接查看桶目录本身。

同理,`restoreItem` 的成功判定用的仍是 `existsSync`(它必须确认源在、目标不冲突才能移动)——
"不探文件系统"约束的是**读数路径**,不是写入路径。

## 配置

在 profile 的 `cordis.patch.yml` 里给这一行加 `config`:

```yaml
- id: turn-scratch
  config:
    dryRun: true
    # 孤儿库:属于"已经不在机器上的工具"的工作区根文件
    # (默认空 —— 哪些算孤儿取决于你机器上装过什么)
    orphanStores:
      - .dsh-edit-review.json
      - .dsh-edit-review-archive.json
    aiReview:
      enabled: true
      # 留空则回退到 settings 的 agent-default-model
      provider: deepseek-official
      model: deepseek-v4-flash
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `dryRun` | `false` | 只把"本会隔离什么"打进日志 |
| `patterns` | 见源码 `DEFAULTS` | 临时产物 glob |
| `protect` | `[]` | 额外豁免 glob |
| `scanScratchDirs` | `true` | 扫描本轮变动的临时命名目录 |
| `maxScanDepth` / `maxScanDirs` | `6` / `4000` | 扫描边界 |
| `maxQuarantinePerTurn` | `200` | 单轮隔离上限 |
| `markTool` | `true` | 注册 `scratch_mark` |
| `markTtlMs` | `21600000` | 未被消费的标记存活时长 |
| `orphanStores` | `[]` | **孤儿库** —— 属于"已经不在机器上的工具"的工作区根文件(典型例子:某个已卸载插件留下的 `.dsh-edit-review.json`)。**默认空是刻意的**:哪些文件算孤儿取决于具体机器装过什么,不该由插件替所有人假设 |
| `orphanStoreMinAgeMinutes` | `60` | 孤儿库的 mtime 阈值:还活着的库每轮都会被改写,mtime 不会老,所以只有老 mtime 才收 |
| `aiReview.enabled` | `true` | 复核开关 |
| `aiReview.provider` / `.model` | `""` | 留空则回退到 settings 的 `agent-default-model` |
| `aiReview.reasoningEffort` | `""` | 透传给适配器;留空用适配器默认值 |
| `aiReview.maxItems` | `25` | 单次复核条目上限 |
| `aiReview.previewBytes` | `1200` | 每条内容预览上限 |
| `aiReview.timeoutMs` | `60000` | 超时;超时/报错/输出无法解析一律保持隔离 |
| `aiReview.respectExplicitConfig` | `true` | 复核不得推翻孤儿库的显式配置 |
| `aiReview.restoreWhenUninspectable` | `true` | 读不到内容的条目强制还原 |
| `consistencyMode` | `"fatal"` | 前置决定与最终结果不一致时的处理:`fatal` 记 error 并**拒绝写盘**;`throw` 直接抛错(供测试用) |
| `__faults` | `[]` | **仅测试**的故障注入,用来确定性地触发上面那条断言。真实 profile 绝不要设置 |
| `debug` | `false` | 打印"本轮无可收"等细节 |

## 还原

```
<workspace>/.dsh-scratch-trash/<sessionId>/turn-<n>/
  manifest.json          # 每条含 path / storedAt / kind;还原后追加 restoredAt、restoredBy
                         # 以及 review 段的复核结论
  <按原相对路径存放的文件>
```

**`restoredAt` 是"这条还在不在隔离区"的唯一依据。** 它是 `restoreItem` 还原成功时盖的戳,
写进 manifest 本身 —— 所以 `scratch_status` 是**纯读 manifest**,不探文件系统:
没有竞态,也没有额外 IO。任何调用方都不可能"还原了文件却忘了记录",因为盖戳在
`restoreItem` 内部,而不在各个调用点。

| 条目字段 | 含义 |
| --- | --- |
| `storedAt` | 在回收站内的相对路径 |
| `restoredAt` | **有值 = 已还原**;无此字段 = 仍待决 |
| `restoredBy` | `review`(复核自动还原)或 `tool`(人工经 `scratch_restore` 还原) |

`review` 段的关键字段:

| 字段 | 含义 |
| --- | --- |
| `outcome` | `completed` / `skipped-no-route` / `failed` / `unparsed` / `disabled` —— **无论哪种都会落盘**,不存在静默 |
| `modelConsulted` | `false` 表示全部条目由硬约束定案,一次模型调用都没发生 |
| `preResolved` | 被硬约束定案的条目及理由(`显式用户配置` / `读不到内容,无证据支持隔离`) |
| `kept` / `restored` | 最终结果,含理由 |
| `decisions` | 模型原始判断(仅 `modelConsulted: true` 时存在) |
| `problems` | 任何静默降级的原因 |

手动还原某个文件:

```bash
cd <workspace>/.dsh-scratch-trash/<sessionId>/turn-<n>
mv "原/相对/路径" "<workspace>/原/相对/路径"
```

## 决策一致性断言(写盘前)

`preResolved` 记录的是**决定**,最终结果记录的是**实际发生的事**。两者必须一致。

不一致意味着这份 manifest 会声称一个插件其实没做的动作 —— 比如"已还原",但文件还躺在隔离区里。
这是最危险的一类假记录,所以它在落盘前被拦下:

| 模式 | 行为 |
| --- | --- |
| `fatal`(生产默认) | 以 **error** 级别记录,并**拒绝写入这份 manifest** |
| `throw`(测试用) | 直接抛错,让它成为 unhandledRejection,测试进程据此失败 |

**拒写盘不会造成孤儿**:items 记录在上一步已经写过一次,隔离的文件始终有清单可查;
被拒绝的只是那份自相矛盾的 review 记录。

断言在任何一侧发现不一致都会触发:

- `preResolved` 声明"还原",但 `restored` 里没有它(决定没有落地)
- `preResolved` 声明"维持隔离",但 `restored` 里有它(决定被反向执行)
- 同一个 path 同时出现在 `kept` 和 `restored` 里

覆盖见 `test-behavior.mjs` 的 `[14]`:throw 模式、fatal 模式,以及**无故障时不得误报**。

## 日志

插件走的是**宿主的 cordis logger**(\`ctx.logger\`),不是 \`console\`。

这一点很关键:DSH Desktop 的日志文件
(\`%APPDATA%/DSH Desktop/logs/dsh-<date>.log\`)只捕获结构化 logger 的输出,
\`console.log\` 在那里**完全不可见** —— 早期版本用 console,等于把日志丢进黑洞,
用户根本不知道插件有没有在工作。

查看方式:

\`\`\`bash
grep dsh-turn-scratch "%APPDATA%/DSH Desktop/logs/dsh-$(date +%F).log"
\`\`\`

| 级别 | 内容 |
| --- | --- |
| \`info\` | 加载、每轮终态(隔离了什么/什么都没收到)、复核结论 |
| \`warn\` | 隔离失败、复核失败、拿不到模型 —— **任何静默降级都会在这里出现** |

\`debug: true\` 时,"什么都没收到"这类细节按 **info 级别**输出,而不是 debug 级别 ——
因为宿主的文件导出器可能把 debug 级别整个过滤掉,那样用户开了开关也看不到东西。

## 安装 / 卸载

```bash
dsh plugin --profile desktop add <本目录的绝对路径>
```

本机因 profile 里有个拉不动的远程依赖(`dsh-cad-studio` 的 `latest/download` URL),
`pnpm add` 会被卡死,所以改为手工接线。共四处,卸载即逆操作:

1. profile `package.json` 的 deps 加 `"dsh-turn-scratch": "link:../../plugin-src/dsh-turn-scratch"`;
2. 同文件 `dsh.profile.bundles` 追加 `"dsh-turn-scratch"`;
3. `profiles/desktop/node_modules/dsh-turn-scratch` 建指向本目录的 junction;
4. 本目录内的 `node_modules/@deepseek-ai` 建指向 `profiles/node_modules/@deepseek-ai` 的 junction
   —— **这一步不能省**:Node 的 ESM 会解析 symlink 的真实路径,没有它插件在真实运行时
   解析不到 `@deepseek-ai/dsh-tools` 和 `@deepseek-ai/dsh-llm`。

改完后**重启 DSH Desktop** 才会激活。退路:`profiles/desktop/package.json.dsh-turn-scratch.bak`。

## 测试

```bash
node test-glob.mjs            # glob 匹配 / 路径包含 / mutation 识别 / 复核输出解析,29 项
node test-behavior.mjs        # 桩 ctx + 假 LLM 驱动真实 apply(),55 项
node test-verify-manifest.mjs # manifest 回归脚本自测,4 种情况 / 17 项断言
```

`test-behavior.mjs` 用假 LLM 覆盖了复核的危险分支:还原误判、越权删除被忽略、
LLM 挂掉/输出垃圾时的 fail-safe、两条硬约束的实际拦截、三个工具的守卫,
以及**日志确实走了 `ctx.logger` 而不是 `console`**。
两个测试都直接加载 `lib/index.js` 本体,不复制实现。

### manifest 结构回归检查

```bash
node verify-manifest.mjs <manifest.json> [baseline.json]
# baseline 缺省为 ./fixtures/manifest-baseline.json
```

夹具放在独立的 `fixtures/` 目录里,与可随时重建的脚本**物理分开** —— 基线是长期资产,
不该混在一次性脚本中间,免得哪天被连着一起清掉。

拿真实 manifest 跟一份基线比,**非对称**判定:

| 差异 | 处理 | 理由 |
| --- | --- | --- |
| **新增** | **放行**(仍会报出) | manifest 本来就该长新字段,把新增当失败会让每次改进都像回归 |
| **缺失** | 失败 | 必填字段没了就是回归 |
| **值变** | 失败 | 同一路径的值变了 |
| **非法** | 失败 | 类型不符,或取值不在枚举内 |

失败时**打印每一处差异并退出 1**;用法错误(文件缺失 / JSON 无法解析)退出 **2**。

**这里没有白名单。** 允许的形状在脚本顶部用一份 schema 声明一次
(`required` / `optional` / `enum`),新字段之所以被放行,是因为 schema 说它**可以存在**,
而不是因为某张清单恰好列了它。白名单要为新字段手工维护,而**过期的白名单会把回归静默地变成通过**;
schema 不会这样漂移 —— 没声明的字段一律按非法拒绝。

`VOLATILE`(值合法地逐次不同,只校验存在与类型、不比对基线):`session`、`turn`、`at`、`restoredAt`;
`storedAt` 则先归一化 `turn-<n>` 再比。因此它是**格式回归夹具**,不是逐次运行等值检查。
