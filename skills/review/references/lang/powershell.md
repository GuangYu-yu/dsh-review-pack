只列 PowerShell 的语言语义会直接产生的问题。每条都能指到具体代码位置，不需要判断口味。

**状态**：候选池——**覆盖不保证**，当检索线索用，每条的成立仍要按位置核实。

## 先跑工具链，工具链报的不写进本件

`PSScriptAnalyzer`（`Invoke-ScriptAnalyzer`）默认跑它当前的规则集——**有哪些规则用 `Get-ScriptAnalyzerRule` 查**（规则名随版本增删，不在这里固化）。与本册边界相关的是习惯与陷阱那几类：别名与位置参数、`Invoke-Expression`、`Write-Host`、赋值到自动变量、`UseApprovedVerbs` / `UseSingularNouns`、状态改变函数的 `ShouldProcess`。

`Set-StrictMode -Version Latest` 覆盖（在本机 PowerShell 7.6.3 上逐条跑过）：引用未初始化的变量、访问不存在的属性。**另：`Test-MyFn(1,2)` 报的 `called as if it were a method` 不归它管**——那是参数绑定层的错误，不设 StrictMode 也照抛（单参数 `Test-MyFn(1)` 不报）。**它不覆盖"多给位置参数"**——`Test-MyFn 1 2` 静默通过，这一条别指望它。

前提是它真的跑过：CI 里没有这一步时，先自己跑一遍。

## 先划界

本册只问 PowerShell 语言机制本身让缺陷怎么发生。以下条目同时也是别的册在问的，报一处，说清按哪条判：

- 脚本失败重试、超时、降级——`references/robustness.md`
- 模块划分、依赖方向——`references/architecture.md`
- 用 `string` 承载业务概念、布尔参数——`references/code.md`
- 数组随规模增长的代价（`+=` 在循环里）——`references/performance.md`
- 动态执行里的输入信任边界——`references/security.md`

## 错误处理

- `$ErrorActionPreference = 'Stop'` 只对 cmdlet 错误生效，对原生命令（`git`、`curl`、`pwsh` 等）的退出码无效；调用后未检查 `$LASTEXITCODE`，失败被静默忽略。不报：调用后立即检查 `$LASTEXITCODE` 或使用 `if (-not $?)`
- 非终止错误（non-terminating error）被 `$ErrorActionPreference = 'Continue'` 静默吞掉，调用方以为成功。不报：错误已记录到 `$Error` 并显式检查，或调用点使用 `-ErrorAction Stop`
- `try` 块内 `return` 导致 `finally` 中清理语句在返回前执行，但 `$?` 反映的是 `finally` 最后一条命令的状态，调用方拿到的成功/失败信号被覆盖。不报：`finally` 中不执行可能改变 `$?` 的命令，或清理在 `try` 之外进行
- `catch` 块中只 `Write-Output` 而不重新抛出，调用方无法区分成功与捕获到的错误。不报：错误已转换为调用方可匹配的异常或错误记录
- 自定义函数未声明 `[CmdletBinding()]`，`-ErrorAction` 和 `-ErrorVariable` 通用参数不可用，调用方无法控制错误行为。不报：函数明确设计为不依赖通用参数

## 动态执行

- `Invoke-Expression` 用于执行动态构造的字符串，输入中含用户可控内容时构成命令注入。不报：字符串完全来自脚本内常量，无外部输入
- `Add-Type` 或 `New-Object` 编译/执行动态代码，来源不可信时绕过执行策略。不报：代码来源已通过签名或哈希校验，且校验结果被显式检查
- 拼接命令字符串后交给 `cmd.exe /c` 或 `Start-Process`，未对参数做引号转义。不报：参数已通过 `-ArgumentList` 数组传递而非字符串拼接

## 管道与对象流

- 管道中 `Write-Host` 写入显示流而非输出流，下游 `ForEach-Object` 或变量赋值拿不到该值。不报：`Write-Host` 仅用于用户可见的进度提示，且该值不期望被下游消费
- 管道中混合 `Write-Output` 和 `Write-Host`，输出顺序不确定，调用方看到的流被交错。不报：已统一使用 `Write-Output` 或 `Write-Information`
- `Tee-Object` 未收到成功输出时，目标变量的**前一个值**保持不变，调用方可能读到过期的旧值。不报：使用前已显式清空目标变量，或 `Tee-Object` 前已确认有输出
- `Select-Object -Last N` 或 `Sort-Object` 是阻塞命令，会先收集全部管道项再输出；在它们之前的 `PipelineVariable` 始终包含最后一个管道项，而非逐个迭代。不报：阻塞命令后不使用 `PipelineVariable` 做逐项处理
- 管道中调用 CIM cmdlet 或 CDXML 命令时，对象在管道中间被意外累积，打破逐项处理语义。不报：管道中不混用 CIM 命令与逐项处理命令

## 数组与集合

- 变量为 `$null` 时访问索引抛 `Cannot index into a null array`；**空数组不抛**（`@()[0]` 返回 `$null`）——判空要看的是变量本身。不报：访问前已检查 `$null -ne $array`（或 `$array -and $array.Count -gt 0`）
- 函数返回空数组 `@()` 时，管道自动解包为零个对象，调用方收到 `$null` 而非空数组。不报：使用 `Write-Output -NoEnumerate @()` 或调用方已文档声明可接受 `$null`
- `$array += $item` 在循环中每次创建新数组，O(n²) 复杂度；大数组场景应使用 `[System.Collections.ArrayList]` 或 `List[T]`。不报：循环上界来自脚本里的常量，且元素数在数百以内

## 类型与转换

- 隐式类型转换在严格类型语言背景的调用方看来不可预期（如 `'5' -eq 5` 为 `$true`）。不报：比较双方类型已显式声明或强制转换
- `[X] $expr` 强制转换可能意外调用类型的字符串构造函数，产生与预期不同的对象。不报：目标类型的构造函数已文档声明该行为
- PowerShell 不遵循 .NET 类型自身的 `true`/`false` 运算符重载，布尔转换结果与 .NET 语义不一致。不报：不使用自定义类型的布尔上下文转换
- 未指定精确类型时，PowerShell 可能选择错误的方法重载；未来 .NET 版本新增重载可能破坏现有代码。不报：方法调用参数已显式转换为精确类型

## 作用域

- 子作用域中赋值同名变量创建新变量并遮蔽父作用域变量，父作用域读取到的仍是旧值。不报：已使用 `$script:` 或 `$global:` 作用域修饰符显式指定目标作用域
- 函数中修改全局变量（`$global:var = ...`），其他脚本或函数可能依赖该变量，行为不可预期。不报：全局变量已文档声明为模块级配置，且修改点唯一
- `$using:` 作用域在 `ForEach-Object -Parallel` 中不支持跨 runspace 序列化的类型（`scriptblock` 等）会失败。不报：`-Parallel` 块中不使用 `$using:` 传递无法序列化的值

## 并行与异步

- `ForEach-Object -Parallel` 中调用方函数不可见，并行脚本块在独立 runspace 中运行。不报：并行块中只使用内置 cmdlet 和已导入模块的函数
- 并行执行的输出和错误顺序不保证，日志交错难以追踪。不报：输出已收集到并发安全集合或按项标识关联

## 官方契约的常咬点（不保证覆盖）

语言与内建 cmdlet **契约**层面的咬人处——形态见 `references/lang/method.md` 的「官方契约那一层」。**每条都是 PowerShell 7.6.3 本机实测**（`$PSVersionTable` 复查）；这里没写的当场查原文。

- **比较运算符默认不区分大小写**（实测：`"A" -eq "a"` 是 `True`，`-ceq` 才是 `False`；`-like` 与 `-clike` 同理）——按名字、路径、标识符比对时会**多匹配**。要区分就显式用 `-c*` 系列。不报：比对的确实是大小写无关的量（如枚举字面量）
- **两侧类型不同时，比较按左侧的类型来**（实测：`"10" -lt "9"` 是 `True`、`"10" -lt 9` **也是** `True`，而 `10 -lt 9` 是 `False`）——从 JSON 或参数里读来的数字是**字符串**，于是"10 小于 9"成立。不报：比较前已显式转了类型
- **`/` 总返回 `Double`，`[int]` 转换是舍入不是截断**（实测：`7 / 2` 是 `3.5`、类型 `Double`；`[int](7 / 2)` 是 **`4`**，不是 `3`）——整除要显式 `[math]::Truncate` 或 `[math]::Floor`；分页、分片、取中位都会偏。不报：该处本就按浮点处理
- **`$null` 必须放在比较的左边**（实测：`$null -eq $arr` 是 `False`，是标量比较；写成 `$arr -eq $null` 返回的是**过滤后的集合**而不是布尔——空集合与 `$false` 长得不一样）。不报：被比较的确定不是集合
- **`ConvertTo-Json` 默认 `-Depth 2`，超出的层级被替换成类型名**（实测：三层就输出 `{"a":{"b":{"c":"System.Collections.Hashtable"}}}`，本机另给一条告警）——**数据没报错，只是没了**。不报：结构确定不超两层，或已显式传 `-Depth`
- **`$null` 元素进管道会被丢弃**（实测：`@(1,$null,2).Count` 是 `3`，而 `@(1,$null,2) | Measure-Object` 的计数是 `2`）——按数组长度与按管道计数会得到两个不同的数。不报：集合内本就不含 `$null`

## 报告

本件只给清单，不含报告契约——**依据与报告形态以 `references/contract.md` 为准**。本件条目多且机械，**命中多不等于分量重**。
