只列 Dart 的语言语义会直接产生的问题。每条都能指到具体代码位置，不需要判断口味。

**状态**：候选池——**覆盖不保证**，当检索线索用，每条的成立仍要按位置核实。

## 先跑工具链，工具链报的不写进本件

`dart analyze`（或 `flutter analyze`）配合 `analysis_options.yaml` 里的 lint 覆盖：未使用导入（`unused_import`）、未使用变量（`unused_local_variable`）、未等待的 Future（`unawaited_futures`、`discarded_futures`）、`StreamSubscription` 未取消（`cancel_subscriptions`）、`Sink` 未关闭（`close_sinks`）、`catch` 缺 `on` 子句（`avoid_catches_without_on_clauses`）、`dynamic` 调用（`avoid_dynamic_calls`）、`print`（`avoid_print`）、`BuildContext` 跨 await（`use_build_context_synchronously`）、`void async`（`avoid_void_async`）、`const` 构造（`prefer_const_constructors`）。

规则名以**你机器上那版** `dart analyze` 的 lint 集为准（lint 集会增删）。`dart format` 覆盖格式，`dart fix` 覆盖部分可自动修复项，空安全由编译器强制检查。

**本册每一条都在 Dart 3.12.2 上逐条跑过**（下文标实测结果）。

## 先划界

本册只问 Dart 语言机制本身让缺陷怎么发生。以下条目同时也是别的册在问的，报一处，说清按哪条判：

- 重试、超时、降级——`references/robustness.md`
- 模块划分、包组织——`references/architecture.md`
- 用字符串承载业务概念、布尔参数——`references/code.md`
- 代价随规模放大（循环里逐个 `await`）——`references/performance.md`

## 空值与类型提升

- `!` 强制解包 null 抛 `TypeError`，运行期才暴露。不报：空值性已由上游非空类型或显式 `is` 检查证明
- `late` **字段**在赋值前读取抛 `LateError`（消息里写明 `LateInitializationError`，3.12 实测）；`late final` 字段二次赋值同样抛。**局部变量上这不是运行期问题——编译器直接拒绝**（3.12 实测：`Late variable 'y' without initializer is definitely unassigned`）。不报：字段在构造函数初始化列表中必然已赋值
- 类型提升（type promotion）对可变变量、非 final 字段不生效：`if (x != null) x.foo()` 在 `x` 是实例字段且未用局部变量缓存时**编译错**。Dart 3.2 起私有 final 字段可被提升。不报：`x` 是局部变量或 final 字段，或已改用局部变量缓存
- 对 `dynamic` 的调用绕过静态类型检查，运行期才抛 `NoSuchMethodError`。不报：`dynamic` 处已用 `is`/`as` 收窄到具体类型
- `as` 转换失败抛 `TypeError`，`is` 返回 `false` 而不抛错；两者混用是两套失败语义。不报：已用 `is` 收窄后再调用

## 异步与 Future

- 未 `await` 也未 `unawaited()` 的 `Future`，其异常在当前 `Zone` 之外抛出，调用方拿不到。不报：已显式 `await`、`.catchError`，或 `unawaited()` 且已文档声明有意忽略
- `Future.wait` 默认 `eagerError: false`：一个 Future 失败后仍等全部完成再抛第一个错误，**其余错误被丢弃**。不报：已设 `eagerError: true`，或已用 `cleanUp` 处理资源
- `async` 函数体内同步抛出（在第一个 `await` 之前）时，返回值是**失败的 Future**——调用方不 `await` 就看不到。不报：调用点必然 `await`，或异常已在函数内捕获处理
- `try/finally` 中 `finally` 里的 `await` 在 `try` 的返回值确定之后执行；此时 `finally` 里再 `return` 会**覆盖**原返回值。不报：`finally` 中不写 `return`，或返回值已放进显式变量
- `for` 循环里逐个 `await` 把并发压成串行——单看代码像并发，实际是顺序执行。不报：有意串行，或已改用 `Future.wait` / `Stream`
- 在 `await` 之后访问 `BuildContext`（Flutter）时 widget 可能已卸载。不报：`await` 后已检查 `mounted`
- `Completer` 未调用 `complete`/`completeError`，等待方永久挂起。不报：完成路径已被 `try/finally` 覆盖

## Stream 与事件

- `StreamController` 未 `close`，订阅方等不到 done，资源泄漏。不报：controller 的生命周期已由作用域内 `close` 覆盖
- 单订阅 `Stream` 被第二次 `listen`，抛 `StateError: Stream has already been listened to`。不报：流已转为广播（`asBroadcastStream` 或 `StreamController.broadcast`）
- 广播 `Stream` 在事件发出时无订阅者，事件被丢弃——不像单订阅流有缓冲。不报：订阅者在事件发出前已就绪，且已文档声明
- `await for` 中 `break`/`return` 会取消订阅，从循环中逃出的异常同样取消。不报：有意在退出循环时取消订阅
- `StreamSubscription.cancel()` 返回 `Future`，未等待时上游清理未完成，与后续逻辑竞态。不报：`cancel` 之后的逻辑不依赖上游已清理
- 向已关闭的 `StreamController` `add` 抛 `StateError`（3.12 实测）。不报：`add` 前已检查 `isClosed`，或关闭路径已文档声明不再 `add`
- **没有订阅者时 `await controller.close()` 永不完成**——`done` 要等到有监听者才完成，于是清理/启动代码就挂在那里（3.12 实测：300ms 仍未完成）。不报：`close()` 不 `await`，或关闭前已确保有订阅者（含 `.listen` 过再取消的情形）

## 集合与可变性

- 迭代中修改集合（增删）抛 `ConcurrentModificationError`。不报：已先转为 `List` 快照再迭代，或迭代期间不修改集合
- `List.filled(n, obj)` 用同一个 `obj` 引用填充 n 个位置，改一个影响所有。不报：`obj` 是不可变类型，或已改用 `List.generate`
- `List`、`Map`、`Set` 都是引用类型：赋值、传参、`Map` 值共享同一对象。不报：已用 `List.from`、`Map.from` 等构造新集合
- 固定长度 `List`（`List.filled` 不带 `growable: true`）`add`/`remove` 抛 `UnsupportedError`（3.12 实测）。不报：集合已保证按索引写入，不做长度变更
- `List.unmodifiable`、`Map.unmodifiable` 返回的视图在写入时抛 `UnsupportedError`，但**嵌套元素仍可变**。不报：嵌套元素全部不可变

## 类与继承

- 覆写 `==` 未同时覆写 `hashCode`：对象放入 `Set`/`Map` 后去重与查找失效（作 `Map` 的 key 同理）。不报：类明确设计为按引用比较，或两者均基于同一组不可变字段
- `mixin` 的应用顺序决定方法解析：`with A, B` 与 `with B, A` 调用同名方法走不同实现。不报：mixin 之间无同名成员，或顺序已按语义文档声明
- 构造函数初始化列表里的字段初始化顺序与**声明顺序**一致，与列表书写顺序无关。不报：初始化表达式之间无相互依赖
- `super(...)` 必须位于初始化列表末尾，或使用 `super.field` 参数语法。不报：构造函数无初始化列表，或已用参数语法
- 子类构造函数在 `super()` 之前访问 `late` 字段——初始化顺序决定它那时还没被赋值。不报：`super()` 完成后才访问
- `factory` 构造函数可返回子类型实例、可缓存实例，调用方误以为返回新对象。不报：`factory` 已文档声明可能返回缓存或子类型
- `implements` 要求实现全部成员（含 `abstract` 成员），`extends` 可选择性覆写——同一个类换关键字，义务就变了。不报：使用意图与关键字一致
- `covariant` 放宽覆写时的参数类型约束，运行期类型不符仍抛 `TypeError`。不报：覆写方法内已对参数做运行期类型检查

## 泛型与类型系统

- 泛型在运行期被具体化（reified），`x is T` 对具体类型、泛型类、类型变量 `T` 都工作；但 `T` 为 `dynamic`/`Object?` 这类顶部类型时 `is T` **恒真**，不提供任何收窄。不报：`T` 的上界比 `Object?` 更具体
- 泛型容器的类型参数在运行期与静态视图可能不同：`List<int>` 被当成 `List<num>` 视图后写入 `double`，运行期抛 `TypeError`。不报：集合已保证只读，或已用 `List<Object>` 配合显式检查
- `Function` 与具体函数类型（`void Function(int)`）不互通，赋值时编译错。不报：函数类型已显式声明

## 错误处理

- `catch (e)` 连 `Error`（`AssertionError`、`TypeError`…）一起捕获，把编程错误当业务异常处理。不报：已用 `on SomeException` 收窄，或 `catch` 位于顶层边界
- `on` 子句顺序决定匹配：`on Exception` 在前会吞掉后面的具体类型。不报：`on` 子句按从具体到宽泛排序
- `rethrow` 保持原栈，`throw e` 重置栈——原始失败位置只在 `rethrow` 下保留。不报：已用 `rethrow`
- `Error` 与 `Exception` 的语义分界：前者是编程错误、不应被捕获，后者可恢复。抛 `Error` 当业务错误、或 `catch` 一并捕获两者，都破坏该分界。不报：`Error` 只在顶层边界处转为失败记录
- `assert` 只在 debug 模式生效，release 模式被移除。不报：`assert` 仅用于开发期断言，生产校验走显式分支

## Isolate 与并发

- 跨 Isolate 传递的对象必须可序列化（`SendPort.send` 的默认机制）：闭包、`Completer`、部分平台对象会抛或静默失败。不报：传的是基本类型、`List`/`Map`，或已标记可传递的对象
- `ReceivePort` 未 `close`，通信通道泄漏，宿主 Isolate 无法退出。不报：其生命周期已由作用域内 `close` 覆盖
- `Isolate.spawn` 返回的 `Isolate` 未 `kill` 且无自然退出路径，持续占用资源。不报：工作函数必然在有限步骤内返回
- Isolate 内未捕获的异常只在 `Isolate.addErrorListener` 上可见，宿主不监听时静默丢弃。不报：已注册错误监听，或 Isolate 内 `try/catch` 全覆盖

## 可变性与 const

- `final` 只锁引用、对象内容仍可变；`const` 是深度不可变且编译期求值。混用会造出"以为不可变"却能被改的字段。不报：`final` 指向的对象本身不可变
- 静态字段是**惰性**初始化：首次被读取时才求值，所以初始化表达式的求值时机取决于谁先读到。自引用（表达式读同一字段）抛 `LateInitializationError`。不报：初始化表达式之间无相互依赖
- `const` 构造要求所有字段 `final` 且为编译期常量；`const` 实例全局共享，运行期不可能被修改。不报：构造点已确认参数都是编译期常量

## 导入与库

- `show`/`hide`/`as` 在编译期解决命名冲突：被 `hide` 的声明在当前文件不存在，带前缀的只能按前缀访问。前缀重名、或 `show` 列表与实际使用的符号不一致，会报 `ambiguous_import` 或引用到非预期声明。不报：两侧命名空间无重叠，或已用 `show` 收窄到实际使用的符号
- `part`/`part of` 拆分的库共享私有作用域：同一库内的私有符号跨文件可见，模块边界失效。不报：`part` 只用于代码生成，手写逻辑不依赖跨文件私有符号
- `export` 把第三方库的公共 API 传递出去，下游经本库间接依赖第三方符号，第三方升级会破坏下游。不报：已用 `show` 收窄导出范围
