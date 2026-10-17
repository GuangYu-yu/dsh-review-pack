只列 C 的语言语义会直接产生的问题。每条都能指到具体代码位置，不需要判断口味。

**状态**：候选池——**覆盖不保证**，当检索线索用，每条的成立仍要按位置核实。

## 先跑工具链，工具链报的不写进本件

`-Wall -Wextra -Werror` 覆盖：未使用变量、隐式函数声明、格式串不匹配、返回类型缺失、有符号/无符号比较、返回局部变量地址。

`-fsanitize=address,undefined`（ASan+UBSan）覆盖**跑到路径上**的：数组越界、use-after-free、双重释放、有符号整数溢出、移位量过大、空指针解引用、对齐。

`-fsanitize=memory`（MSan）覆盖跑到路径上的未初始化读取。

`-fsanitize=thread`（TSan）覆盖跑到路径上的数据竞争。

`clang-tidy` 是这一族里最接近"全量风格与陷阱检查器"的（别的语言里 clippy 的位置）——**但它默认几乎什么都不报，必须显式给 `-checks=`**：常用的是 `clang-analyzer-*`、`bugprone-*`、`cert-*`、`performance-*`（名单以你那版的规则集为准）。`cppcheck` / MSVC `/analyze` 覆盖部分资源泄漏、宏误用、死代码。

`-Weverything`（clang）是把警告开到最全的现成档；`gcc -fanalyzer` 是编译器内置的一次静态分析（双重释放、use-after-free、泄漏、未初始化、空指针）。

`-fsanitize=undefined` **不含**整数那一组：无符号回绕、隐式截断与符号转换要另加 `-fsanitize=integer,implicit-conversion`。未初始化读取在 MSan 跑不起来的平台上，可用 `-ftrivial-auto-var-init=pattern` 兜。

前提是它真的跑过：CI 里没有这一步时，先自己跑一遍。

## 先划界

本册只问 C 语言机制本身让缺陷怎么发生。以下条目同时也是别的册在问的，报一处，说清按哪条判：

- 线程生命周期、join/detach 时机——`references/robustness.md`
- 资源清理失败路径——`references/robustness.md`
- 结构与模块边界——`references/architecture.md`
- 基本类型承载业务概念、布尔参数——`references/code.md`

## 指针与数组

- 指针算术越过数组末尾后再解引用：跨对象场景 ASan 不总报。不报：单元素数组取尾后指针仅用于比较
- 数组作参数退化为指针，`sizeof` 拿到指针大小而非数组大小。不报：已显式传入长度参数
- `memcpy` 源与目标重叠（应使用 `memmove`）。不报：源与目标已证明不重叠
- 变长数组（VLA）在栈上分配，大小来自不可信输入。不报：大小已受编译期或调用方契约约束
- 严格别名：对象具有已声明类型，却以不相关类型的左值访问。不报：经 `char*`/`unsigned char*` 访问任意对象
- 有效类型：`malloc` 得到的无声明类型存储，以不相关类型读取（C11 6.5p6）。不报：读取类型与该存储最后一次写入的类型一致，或经字符类型访问
- 对 `union` 的成员写入后读另一个成员，类型双关语义实现定义。不报：已用 `memcpy` 做双关
- 空指针解引用（UBSan 只覆盖跑到路径）。不报：指针已文档声明非空
- 数组越界访问（ASan 只覆盖跑到路径）。不报：下标已受约束

## 内存与生命周期

- use-after-free：指针所指对象已释放或生命周期已结束，仍被解引用（ASan 只覆盖跑到路径）。不报：释放后立即置 NULL，且此后再无解引用
- 同一指针被 `free` 两次（ASan 只覆盖跑到路径）。不报：释放后立即置 NULL，`free(NULL)` 是合法空操作
- 未初始化变量读取（`-Wall` 只覆盖一部分，MSan 需单独构建）。不报：变量在读取前必然已赋值
- 对齐违规：以不满足目标类型要求的地址解引用（UBSan 只覆盖跑到路径）。不报：已用 `_Alignas`/`alignas` 或 `memcpy` 规避
- `realloc` 失败时原指针被覆盖，旧内存泄漏。不报：`realloc` 失败后立即终止
- 结构体填充与端序：把结构体 `memcpy` 到盘上/线上，padding 内容不确定、字段顺序与端序无契约。不报：仅本进程内 `memcpy` 回去，不经盘/网

## 整数与转换

- 有符号整数溢出（UBSan 只覆盖跑到路径）。不报：编译期已证明值域
- 移位量 ≥ 类型宽度，或对负数左移。不报：移位量已受约束
- `int` 与 `size_t`/`unsigned` 隐式转换发生在赋值、返回、作为数组下标处（`-Wsign-compare` 只覆盖比较）。不报：转换点在源码里显式写了 `static_cast`/强制转换，或两侧已声明为同一种符号性
- `int64_t` → `int32_t` 窄化截断，`-Wconversion` 不总报。不报：目标变量在源码里声明为宽类型，或转换点有强制转换加范围检查
- `char` 的符号性平台依赖，用于索引或比较。不报：显式使用 `signed char`/`unsigned char`
- 枚举值隐式转换到整数后丢失符号。不报：枚举已声明底层类型
- 位域赋超出范围的值，实现定义。不报：值域已声明

## 求值顺序

- 在 sequenced-before 关系之间多次修改同一变量。不报：不涉及共享可写状态

## 错误处理

- `errno` 在错误发生与检查之间被其他库调用覆盖。不报：中间无其他库调用
- `setjmp`/`longjmp` 跳过已获取资源的清理。不报：跳转目标不持有资源
- 有界字符串：`strncpy` 不保证终止；`snprintf` 截断只看返回值。不报：缓冲区已保证足够且输入已校验
- `atoi`/`strtol` 转换失败：不检查 `errno`/`endptr`，错误值当合法值用。不报：输入已在上游校验过且值域受限

## 预处理

- 宏参数有副作用时被多次求值。不报：参数确实无副作用
- `#define` 覆盖关键字或标准库符号，调用方无法预期。不报：宏生命周期限于单一文件且已用后 `#undef`
- 同一 `inline` 函数在多个翻译单元里定义不一致（C99 inline 语义），链接期行为取决于优化与 `extern` 声明。不报：`inline` 定义在头文件且完全一致

## 构建开关与校验

- `assert` 在 `-DNDEBUG`（多数发布构建）下被预处理掉：校验消失，而且**断言里的副作用表达式根本不执行**（`assert(open_it())` 里的那次调用没了）。不报：该断言只做开发期检查，且表达式无副作用

## 跨平台与二进制布局

- 用 `memcpy`/`fwrite` 把结构体整块写进文件或网络：字段顺序之外，**填充与字节序**都由平台决定，换架构读出来的值对不上。不报：已逐字段序列化（显式宽度 + 显式字节序转换），或格式只在本进程、同机同架构内使用
- 跨主机交换的整数未做字节序转换（`htons`/`htonl`/`be32toh` 一族）：大端机上读成另一个数，而**测试通常只在小端机上跑**。不报：协议规定小端且实现已显式断言主机字节序，或数据不跨主机
- 假定 `char` 有符号、`int` 是 32 位、`long` 与指针同宽：换编译器或架构后判定翻转。不报：已用 `stdint.h` 的定宽类型与显式的 `(un)signed char`

## 并发

- 条件变量等待未包裹在 `while` 循环中，虚假唤醒后读到未就绪状态。不报：等待条件确实单调、不会回退
- `volatile` 当同步原语——它不提供原子性和内存序。不报：仅用于 MMIO 或 `sig_atomic_t` 信号处理
- `memory_order_consume` 的依赖关系被误用：编译器可将其提升为 `acquire` 或降级为 `relaxed`，语义不可靠。不报：已替换为 `acquire`
- 两个 `atomic` 之间用 `relaxed` 建立同步：只保证原子性，不保证可见性顺序。不报：已文档声明仅需原子性

## 官方契约的常咬点（不保证覆盖）

整数运算**规范定死的边界**——形态见 `references/lang/method.md` 的「官方契约那一层」。**出处是 cppreference 的 C 算术运算符页**（它逐段标注了对应的 C 标准条款号，本册条目引用的是 C17 的 6.5.5 / 6.5.6 / 6.5.7）；**编译器版本与旗标以你机器上那版为准**。这里没写的当场查原文。

- **整数除法向零截断，`%` 的符号跟随被除数**（规范原文：C99 起 "truncated towards zero"；余数满足 "`(a / b) * b + a % b == a`"）——所以 `-7 / 2` 是 `-3`、`-7 % 2` 是 `-1`。**向下取整**要自己写（`(a % b + b) % b` 一类），取模分桶在负数上会落到负下标。不报：操作数已证非负
- **除数为零是未定义行为**，而 `INT_MIN % -1` **也是**（规范原文：商不可表示时 "the behavior of both a/b and a%b is undefined"，并直接点名 "INT_MIN % -1 is undefined on 2's complement systems"）——这一处最容易在"取模一定安全"的假设下漏掉。不报：除数已证非零且不是 `-1`
- **`-INT_MIN` 是未定义行为**（规范原文："The unary minus invokes undefined behavior due to signed integer overflow when applied to INT_MIN, LONG_MIN, or LLONG_MIN"）——求绝对值的惯用写法（`x < 0 ? -x : x`）在最小值上就是 UB，而它恰好在很多真实输入里出现。不报：入参值域已排除各类型最小值
- **有符号右移负数是实现定义，不是"算术右移"**（规范原文："For negative LHS, the value of LHS >> RHS is **implementation-defined**"）——用它做"除以 2 的幂"在换编译器后可能换了结果；无符号右移才是良定义的。不报：左操作数已证非负，或已改用除法
- **有符号左移溢出是未定义行为，无符号左移是模 2ⁿ**（规范原文：signed 且结果不可表示时 "the behavior is undefined"；unsigned 则是 "reduced modulo maximum value of the return type plus 1"）——同一句 `x << n` 在 `int` 与 `unsigned` 上是两种保证。不报：移位量与值域已受约束

## 报告

本件只给清单，不含报告契约——**依据与报告形态以 `references/contract.md` 为准**。本件条目多且机械，**命中多不等于分量重**。
