**状态**：候选池——**覆盖不保证**，当检索线索用，每条的成立仍要按位置核实。

## 先跑工具链，工具链报的不写进本件

`flutter analyze` 配 `analysis_options.yaml` 的 lint 规则覆盖：`use_build_context_synchronously`、`unawaited_futures`、`cancel_subscriptions`、`close_sinks`、`avoid_print`、`prefer_const_constructors`、`avoid_unnecessary_containers`、`sized_box_for_whitespace`、`use_key_in_widget_constructors`、`library_private_types_in_public_api`。空安全由编译器强制；`flutter test` 覆盖 widget 与单元测试。

**与工具链重叠的条目，本册只写它看不见的那一类**——跨方法、跨字段传出去的形态，以及"这一处的豁免成不成立"。

**本机未实测过这套工具链**：Dart SDK 3.12.2 在，但 `flutter` 工具在本机沙箱里起不来（`CreateFile failed 5`、`where aapt` 被拒）。所以本节的**工具链断言以你机器上那版为准**；跑过的照贴三件套，**跑不了的按 `references/contract.md` 交交接实验，别写成跑过的**。

## 先划界

**本册只问 Flutter 框架语义本身让缺陷怎么发生**：框架在什么时候替你做事、什么时候不替你做事。轴是**生命周期与所有权**——谁创建、谁必须释放、依赖在哪一刻建立、变化往哪里传。**它不是"代码写得整不整齐"的清单。**

**不管**：Dart 语言语义（`late`、`const` 实例化、空安全、`part`/`export`/`show`/`@visibleForTesting`）——`references/lang/dart.md`；界面语义的一致性（同一语义几处定义、状态矩阵缺项）——`references/lang/web.md` 那根轴；重试、超时、降级——`references/robustness.md`；模块划分与包组织——`references/architecture.md`；用字符串承载业务概念、布尔参数——`references/code.md`。

**Provider / Riverpod 是生态包，不是框架**——按同一条轴收在「状态管理与数据流」里，**用到它们时才读那一节**。

## 状态与生命周期

- `setState()` 在 `await` 之后调用，widget 可能已卸载，抛 "setState() called after dispose()"。不报：`await` 后已检查 `mounted`
- `dispose()` 中未释放 `TextEditingController` / `ScrollController` / `AnimationController` / `PageController` / `TabController` / `FocusNode` / `OverlayEntry` / `ValueNotifier`。不报：这些对象的生命周期已由作用域内 `dispose` 覆盖
- `dispose()` 中未 `removeObserver(this)`（`WidgetsBindingObserver`），observer 泄漏到 `WidgetsBinding`，每次页面 push 泄漏一个。不报：该 `State` 未实现 `WidgetsBindingObserver`
- `didUpdateWidget` 中未取消旧订阅或未订阅新对象，监听器指向过期对象。不报：`didUpdateWidget` 中无订阅逻辑，或订阅对象不随 widget 更新变化
- `didChangeDependencies` 中做一次性初始化（如发网络请求），依赖一变就再跑一次。不报：初始化放在 `initState` 中
- `deactivate` 中未 `super.deactivate()`，或在该方法中做耗时操作。不报：只做轻量清理，且 `super.deactivate()` 已调用

## 异步与并发

- **`BuildContext` 经参数或字段传出去之后再用**——`use_build_context_synchronously` 只看得到同一个同步块里 `await` 后的直接使用，**看不见跨方法传出去的形态**。不报：使用前已检查 `context.mounted`，或改用 `GlobalKey<NavigatorState>`
- **`Future` 被存进字段、之后忘了处理**——`unawaited_futures` 只看得到表达式语句里没被等的 `Future`。不报：已显式 `await`、`.catchError`，或 `unawaited()` 且已文档声明有意忽略
- `FutureBuilder` 的 `future` 在 `build` 中直接创建，每次 rebuild 重新发起请求。不报：`future` 已在 `initState` 中创建并缓存
- `FutureBuilder` 未指定 `future` 参数，UI 永远停在 `ConnectionState.waiting`。不报：`future` 已显式传入且非 null
- `StreamBuilder` 的 `stream` 在 `build` 中直接创建，每次 rebuild 重新订阅。不报：已在 `initState` 中创建并缓存
- **订阅被交给别的对象保管，本 widget 的 `dispose` 里就没有它了**——`cancel_subscriptions` 只看得到本类自己持有的 `StreamSubscription`。不报：`dispose()` 中已取消本 widget 创建的全部定时器与订阅，或所有权已显式移交并写明
- 同步计算阻塞主 isolate，UI 帧率下降或卡顿。不报：计算已在 `Isolate.run` / `compute` 中执行 [半可判]

## 动画与 Ticker

- `SingleTickerProviderStateMixin` 被用于给多个 `AnimationController` 提供 `vsync`，第二个 controller 创建时运行期抛异常。不报：该 `State` 生命周期内只创建一个 `AnimationController`
- `TickerProviderStateMixin` 与 `SingleTickerProviderStateMixin` 在同一继承链中混用，ticker 生命周期管理冲突，动画在 `dispose` 后仍运行或提前停止。不报：继承链中只用一种 TickerProvider mixin
- `AnimationController` 未在 `dispose()` 中释放，ticker 持续运行。不报：`dispose()` 中已释放所有 `AnimationController`

## 布局与渲染

- `Expanded` / `Flexible` 直接放在非 `Flex` 组件内，运行期抛 "Incorrect use of ParentDataWidget"。不报：它是 `Row` / `Column` / `Flex` 的直接子级
- `ListView` 里用 `Column(children: [...].map(...))` 渲染全部子项而非按需构建。不报：**上界来自源码里的常量**（如 `[a, b, c].map(...)`）；**上界来自输入或 `items.length` → 报**，应改 `ListView.builder`
- `CustomPainter` 的 `shouldRepaint` 返回 `false` 但绘制依赖的数据已变化。不报：`shouldRepaint` 已比较新旧数据
- `RenderSliver` 被放进 `RenderBox` 期望的子级位置。不报：放在 `CustomScrollView` / `SliverList` 这类 Sliver 上下文里
- `const` 构造函数未在可能的位置使用，静态 widget 每次 rebuild 重新创建。不报：该 widget 依赖运行时数据，无法声明为 `const`

## 状态管理与数据流

- `context.watch<T>()` 在 `build` 之外调用，抛 "Tried to listen to a provider outside of build"。不报：`build` 之外用 `context.read<T>()` 取一次性数据
- `context.read<T>()` 在 `build` 中调用且期望数据变化时重建，但 `read` 不监听变化。不报：该数据在 widget 生命周期内不会变化 [半可判]
- `InheritedWidget` 的 `updateShouldNotify` 返回 `false`，依赖方收不到通知。不报：该数据确实不需要通知依赖方 [半可判]
- 依赖 `InheritedWidget` 的 widget 在 `initState` 中读它的值，此时依赖关系尚未建立。不报：读取在 `build` 或 `didChangeDependencies` 中执行
- Provider / Riverpod 的 `Provider` 在 widget 中初始化，每次 rebuild 重新创建。不报：provider 已在 widget 树的稳定位置声明
- `dependOnInheritedWidgetOfExactType` 与 `getElementForInheritedWidgetOfExactType` 混用：前者注册依赖、变化时通知，后者不注册。需要随数据重建的位置用了后者，UI 不更新。不报：有意只取数据、不建立依赖 [半可判]
- `ValueNotifier` 未在 `dispose` 中释放，widget 卸载后 `ValueListenableBuilder` 仍被通知。不报：生命周期已由作用域内 `dispose` 覆盖，或该 notifier 由外部传入、所有权不在本 widget [半可判]
- 在 `ValueListenableBuilder` 的 `builder` 中改其 `valueListenable` 的值，触发递归重建。不报：`builder` 中只读不写

## 通知与冒泡

- `NotificationListener.onNotification` 返回 `true` 阻止冒泡、`false` 继续向上。该阻止处返回了 `false`（或反之），通知被意外拦截或重复处理。不报：已文档声明该返回值就是设计意图 [半可判]

## 导航与路由

- `Navigator.of(context)` 在 `await` 之后调用，context 已失效。不报：`await` 后已检查 `context.mounted`，或用 `GlobalKey<NavigatorState>`
- 路由 `pop` 时传返回值，调用方未 `await` 或未处理 `null`。不报：返回值已显式处理，或调用方已文档声明可接受 `null`
- 嵌套 `Navigator` 中 `Navigator.of(context)` 拿到错误的层级。不报：已用 `Navigator.of(context, rootNavigator: true)` 明确指定

## 平台通道

- `MethodChannel` 在非创建它的 isolate 中调用，抛 `MissingPluginException`。不报：调用点与创建点在同一个 isolate，或已 `BackgroundIsolateBinaryMessenger.ensureInitialized()`
- `MethodChannel` 的 `invokeMethod` 未处理 `PlatformException` 与 `MissingPluginException`。不报：已显式处理这两种异常，或已文档声明可接受失败
- 同一通道的名称散在多处、彼此不一致。不报：通道名称集中定义在一处，或只在单一文件中使用
- `EventChannel` 的 `StreamSubscription` 未在 `dispose` 中取消，原生侧继续推事件，回调执行于已销毁的 `State`。不报：`dispose` 中已取消该订阅
- `setMethodCallHandler` 注册后未在 `dispose` 中传 `null` 移除，widget 卸载后原生侧仍能调进已失效的 Dart 对象。不报：`dispose` 中已调用 `setMethodCallHandler(null)`
- `BasicMessageChannel` 被当作 `MethodChannel` 用（期望方法名与一次回调），但它没有方法名、双向、消息而非调用。不报：有意做双向消息传递

## 不可变性与 const

- Widget 字段被声明为可变（非 `final`），试图在 `build` 中改它。不报：Widget 字段全部为 `final`
- 在 `build` 中直接改 `children` 列表（`Column(children: [])..add(...)`）。不报：构造完成后不再修改

## GlobalKey

- 同一个 `GlobalKey` 在两处同时出现，抛 "Duplicate GlobalKey detected in widget tree"：第二处出现时第一处的 widget 被移走，原位置的子树被截断。不报：`GlobalKey` 在树中只出现一次
- 在 `build` 中每次创建新的 `GlobalKey`，`State` 无法保持，子树被重建。不报：`GlobalKey` 在 `State` 初始化时创建一次，或 `build` 外持有

## 保活与图片

- `AutomaticKeepAliveClientMixin` 的 `wantKeepAlive` 返回 `true` 却从不调用 `updateKeepAlive()` 使其转 `false`，离开可视区域后仍被保活，内存持续占用。不报：`wantKeepAlive` 返回 `false`，或 `updateKeepAlive()` 已在状态变化时调用
- `ImageStreamListener` 经 `ImageStream.addListener` 添加后未在 `dispose` 中 `removeListener`，图片流持续持有 widget 引用。不报：已在 `dispose` 中移除，或它的生命周期不跨越 widget 卸载

## 半可判条目汇总

位置指得到、但"这一处的豁免成不成立"要人判的，都在下表。核验时逐条回答，**不许与完全可判的混排**；答不上来的按「未判」写进报告的覆盖限制。

| 出处 | 条目 |
|---|---|
| 异步与并发 | 同步计算是否真的仍在帧预算内 |
| 状态管理与数据流 | `read` 取的数据是否确实不会变 |
| 状态管理与数据流 | `updateShouldNotify` 是否确实无需通知 |
| 状态管理与数据流 | 用 `getElementFor...` 是否确实是有意不建立依赖 |
| 状态管理与数据流 | `ValueNotifier` 的所有权是否确实不在本 widget |
| 通知与冒泡 | `onNotification` 的返回值是否就是设计意图 |

## 官方契约的常咬点（不保证覆盖）

框架**签名级契约**层面的咬人处——形态见 `references/lang/method.md` 的「官方契约那一层」。**出处是 Flutter API 文档页**（每条的原文取自对应方法的文档与实现代码）；**版本以你机器上那版 SDK 为准**（`flutter --version` 复查）。这里没写的当场查原文。

- **`Scaffold.of(context)` 找不到祖先时，debug 下断言、release 下抛异常**（文档原文 "will cause an assert in debug mode, and throw an exception in release mode"；异常文本是 `Scaffold.of() called with a context that does not contain a Scaffold.`）——**同一个 `of`，debug 与 release 的失败形态不同**，测试里也许只是红屏、上线后是崩溃。要"没有就返回 null"得用 `maybeOf`。不报：该 `context` 确定在该 `Scaffold` 之下
- **在同一个 `build` 里创建 `Scaffold` 又用它的 `context` 去找它，是取不到的**（文档原文：context 参数在"被返回的那个 widget **之上**"，所以找不到）——这是 `Scaffold.of` 断言最常见的原因。文档给了三条出路：`Builder` 取一个更靠下的 context、把 build 拆成内外两个 widget、或给 `Scaffold` 挂 `GlobalKey` 用 `key.currentState`。不报：`Scaffold` 与该 `context` 分属不同 widget
- **`Theme.of(context)` 找不到祖先时返回 `ThemeData.fallback`，不抛错**（文档原文 "Defaults to `ThemeData.fallback` if there is no `Theme` in the given build context"）——**这与 `Scaffold.of` 的失败方式正好相反**：一处硬失败、一处静默降级。于是"忘了套 `MaterialApp`"在取主题时**不会报错**，只是整个界面用了一套与设计无关的默认色板与字号。不报：取到的值只用于非视觉逻辑
- **`Theme.of` 会按最近的 `MaterialLocalizations` 返回本地化后的数据**（文档原文：若 context 被提供 `MaterialLocalizations` 的 `Localizations` 包着，"the returned data is localized according to the nearest available MaterialLocalizations"；实现里按 `scriptCategory` 走 `geometryThemeFor`）——**同一份 `ThemeData` 在不同语言下取到的排版几何不同**，跨语言截图比对会差在这里。不报：该处只取颜色，不取文字排版
- **`Scaffold.of` 是"走元素树"的调用，文档明说它可能很贵**（原文 "This method can be expensive (it walks the element tree)"）——放在 `build` 里每帧调用、或在长列表的每个 item 里调用，代价随树深与 item 数放大。不报：调用点在树的浅层，且不在每帧路径上

## 报告

本件只给清单，不含报告契约——**依据与报告形态以 `references/contract.md` 为准**。条目多且机械，**命中多不等于分量重**。
