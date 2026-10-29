# 这里的自检脚本

都只判能机械判真假的事；都不判断一条发现对不对，也不读被审对象。

| 脚本 | 查什么 | 用法 |
|---|---|---|
| `verify-report.mjs` | 报告：表与列、同号同条数、账本减法、依据与级别用词、标「严重」有没有独立依据、未填槽位 | `node scripts/verify-report.mjs <报告.md> [<报告.md> ...]` |
| `verify-quotes.mjs` | 每处 `〈文件〉:〈行〉` 与反引号引文，与源文件逐条对 | `node scripts/verify-quotes.mjs <文件.md> [...] [--root <目录>] [--window 3] [--strict]` |
| `ledger.mjs check` | 账本：八列、编号、每段表头 | `node scripts/ledger.mjs check <账本.md> [...]` |
| `ledger.mjs merge` | 分路各写的账本合并成一份 | `node scripts/ledger.mjs merge <输出.md> <账本.md> [...]` |
| `review-check.mjs` | 产出目录：只剩该留的文件、分路清单与实际产物对得上 | `node scripts/review-check.mjs <目录> [--root <对象根>] [--lanes <lanes.json>]` |
| `check-claims.mjs` | 自由形态的交付物：未填槽位、审批词与完整性命题、依据是否四词之一、标「严重」处有没有硬依据 | `node scripts/check-claims.mjs <文件.md> [...]` |

退出码非 0 表示有失败项。**提示不是失败**：引文对不上、排序不当、表头缺列这类只提示；原样留着读一遍，不等于通过。
