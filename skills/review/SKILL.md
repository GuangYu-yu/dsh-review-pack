---
name: review
description: 审一切待交付的东西时用本件：补丁与 diff、一份实现、结构与依赖、某语言的写法（有清单的照清单，没有的现场推）、失败路径、正确性对抗、验证本身、运维面、文档与配置、方案取舍、已有结论。拿不准该查什么也用它——本件会按对象把活分派给对应的分册，并给出每条结论都必须交代的依据与最强反方。只要在问"这些改动能不能合""这段代码有什么问题""这里会不会被搞坏""失败之后会怎样""帮我验证一下""这个方案值不值得上"，都加载本件。**性能与安全**的问题、以及**移植 / 重写 / 换语言**（"这么换会丢掉什么保证"）也走本件。**改代码、交付前自检**时也用它（对象件之外再加这一册）：先按 `references/discipline.md` 走一遍。它不做的事：不写新功能、不做逐字翻译与格式整理、不讨论评审流程本身。
metadata:
  category: review
  axis: entry
  value: dispatch
---

# 评审入口

**分册在哪**：与本文件同目录的 `references/`（按栈与按外观规格的清单在 `references/lang/` 与 `references/theme/`）。读完本节，只去读命中的那几份，**不要通读 `references/`**。

## 一、每次评审读哪几份

一次评审 = **2 个必读件 + 1 个对象件 + 那个对象件自己声明必载的册 + 可选 1 个阶段件**：

1. **`references/contract.md`——每次都读。** 每条结论怎么交代来源、怎么让人看出后果、怎么举证，细则全在里面。**报告要含什么**在 `references/contract/report.md`（写报告前读）；**派活、回收、冷读**在 `references/contract/process.md`（**决定要不要分路之前先读第一节**；分过路或跨轮，整份都读）。
2. **`references/format.md`——每次都读。** 它只说交付物是什么、报告必须让人拿到什么（发现、决策点、停止依据），以及哪些话不替读者说；**外形——段落、标题、表格、篇幅——由你按读者定**。
3. **对象件——按"被审的是什么"选一个**，见第二节的分发表。
4. **阶段件——可选，不默认加载**，见第二节末尾。

**两条不可协商**（细则在 `references/contract.md` 与它下辖的两份分册）：

1. **每条结论要说清它从哪来**——读到的代码、跑过的命令、引的一手原文，还是推出来的——并给出**什么会推翻它**。
2. **不替读者宣布"通过"**：结论只能说到范围、仪器与"在覆盖范围内未发现"，不写"可以放行""没问题"。

**交报告时把三组内容讲清**：发现的问题 / 决策点 / 停止审查的依据（怎么分节、按什么顺序，自定）；不交报告就整组不用。产出是状态地图时按 `references/state-space.md` 的七节交付。

**交付物，以及报告必须含什么**见 `references/format.md`——它是上面第 2 个必读件；外形不归它管。

**本件不做的事**：不写新功能、不做逐字翻译与格式整理、不讨论评审流程本身。被问**本件自身的口径**（依据怎么算、怎么写评审规范、评审流程）时，读完本件直接回答，**不要再读分册**——分册是拿来看对象的，不是本件的说明书。

## 二、选件：按对象分发

| 被审的是什么 | 读哪个分册 |
| --- | --- |
| 补丁 / diff / PR / 变更集 | `references/diff.md` |
| 一份实现（文件、模块）的质量 | `references/code.md` |
| 结构与边界：模块划分、依赖方向 | `references/architecture.md` |
| 某语言或某个界面栈的语义：机制与陷阱 | `references/lang/〈栈名〉.md`（如 Rust 是 rust.md、C++ 是 cpp.md、Web 界面是 web.md。**先把叫法归一**：js→javascript、ts→typescript、node→javascript、golang→go、sh／shell→bash、py→python、rs→rust、ps1／powershell／pwsh／ps→powershell、react／vue／css→web；归一后读不到，才走下一行） |
| 为一个还没有清单的栈现场推导清单 | `references/lang/method.md` |
| 失败路径的设计：重试、超时、恢复、回滚 | `references/robustness.md` |
| 性能：代价随规模放大、往返、争用 | `references/performance.md` |
| 安全：判定权、越权、被信任的边界、秘密 | `references/security.md` |
| 正确性对抗推理：中断、中间态、外来输入 | `references/adversarial.md` |
| 跨语言转换 / 移植：哪些保证会丢 | `references/translation.md` |
| 验证本身与判定成败的脚本：三份清单、破坏性验证、降级标准、CI、门禁、发布检查 | `references/verification.md` |
| 运维面：可观测性、告警、回退、权限 | `references/operability.md` |
| 文档 / 配置 / 契约 / 数据 / 依赖的事实与一致性 | `references/docs-config.md` |
| 方案与意见的取舍裁决 | `references/style.md` |
| 对象或用户指定了某套外观规格（主题、设计规范）：代码有没有绕开它 | `references/theme/〈规格名〉.md`（「声明」指项目文件里写明了这套规格的名字或版本，不是你的印象；**拿不准就先读 `references/theme/method.md` 的探测顺序**，它判完再决定加载哪一份；没有声明就不读） |
| 已有结论的溯源与证伪 | `references/reasoning.md` |

阶段件（可选一个，不默认加载）：

| 阶段 | 读哪个分册 |
| --- | --- |
| 评审开场：先冻结问题边界，再推该审什么 | `references/derive.md` |
| 写代码 / 改代码 / 交付前 | `references/discipline.md` |
| 没有现成的改动可审，要自己取输入 | `references/intake.md` |
| 要一张状态地图（哪些组合可构造但语义不成立、该收敛哪几个维度），而不是发现清单 | `references/state-space.md` |

选件顺序：先按对象选一个。对象不明确时默认 `references/code.md`。**给了目标、没给对象**（"帮我审这个项目""这段代码有没有问题"）就按默认走 `references/code.md`，不要先读 `references/derive.md`；**对象与目标都没有**（"审点什么吧"）才进 `references/intake.md`，先问出对象与范围。**"没有改动可审"这一种情形，按手上已经有什么来定，不按措辞猜：**

- **手上没有任何可看的东西**（没给对象、没给 diff、文件也取不到）→ `references/intake.md`，先把要审的东西取到或问出来。
- **手上有东西，范围没定**（给了仓库或几个文件，没说是哪次改动、该看哪些）→ `references/derive.md`，先冻结边界再推该审什么。
- **手上有东西、范围也清楚**，只是对方在说"我改好了"这类自述 → `references/discipline.md`。

三条互斥，按"手上有没有可看的东西 → 范围定了没有"的顺序问一遍；两问都答不上来就停在 `references/intake.md`。

**分册会自己带路。** 命中的那一册在自己的头部声明它还要带谁（例如代码与变更集对象要求 `references/adversarial.md` 必载，动了不可逆状态就再叠 `references/verification.md`），照它说的叠。**入口只管第一次分发**，所以加规则时加到需要它的那一册里，由那一册自己声明——入口不必再动。

**按后果升级（条件规则）。** 先问一句：这个对象会不会改动**不可逆状态**——磁盘 / 分区表 / 文件系统 / 数据库 / 资金 / 已发布的数据或接口？会，则 `references/adversarial.md` 与 `references/verification.md` 不是可选项：前者列出可能被搞坏的点，后者按三份清单与降级标准**实测**。报告里"失败路径不破坏"这一条必须带依据；只有静态推断时，就写"静态未发现破坏路径，动态未验"，不许写成结论。反过来，只读、可重跑、丢了也无所谓的对象不必升级——**升级要有理由，不是默认动作**。

升级是**叠加**：只多加对抗与验证两册，不替换对象件与阶段件；"准备宣称完成"仍走 `references/discipline.md`。

**拿不准选哪册**，以及**没有对应分册的对象**，见 `references/derive.md` 的「选件与覆盖边界」。
