# dsh-turn-scratch

一款专门用于清理 dsh 每轮产生的多余临时文件的插件。

**它不是直接删文件！！**

每轮结束，临时文件先被挪进一个回收文件夹，逐个判断：
能确定的，代码直接决定去留。
拿不准的，才交给 agent 建议。
真正的删除，只在你手动清空时发生。

**所以最坏的情况是文件被暂扣，而不是被误删！！！*

## 安装

dsh plugin --profile desktop add github:popujiang/dsh-turn-scratch

## 使用

| 工具 | 作用 |
|---|---|
| scratch_status | 看现在扣着什么、已还原什么 |
| scratch_restore | 手动把一个文件捞回工作区 |
| scratch_purge | 清空隔离区（真删） |
| scratch_mark | 标记某个文件不要动 |

## 安全

- 默认只隔离，不删除
- 拿不准的文件会留着，不会误杀
- agent 只能建议还原，不能替你删除
