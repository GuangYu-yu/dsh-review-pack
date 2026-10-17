只列 JavaScript 运行时与宿主机制本身让缺陷怎么发生的问题。每条都能指到具体代码位置，不需要判断口味。

**状态**：候选池——**覆盖不保证**，当检索线索用，每条的成立仍要按位置核实。

## 先跑工具链，工具链报的不写进本件

`eslint` / `oxlint` 配合 `eslint-plugin-security` 覆盖一部分：`eval`、`new Function`、`innerHTML`、`child_process` 命令注入、弱哈希、不安全随机数。**该插件对原型污染、ReDoS、时序攻击只有启发式规则**（`detect-unsafe-regex` 管 ReDoS、`detect-possible-timing-attacks` 管拿 `==`／`===` 比敏感值）：误报多、覆盖窄，**能用不等于可信**——报了要逐个看，没报不等于没有（规则名以你机器上那版的规则表为准）。

`tsc --noEmit` / `tsc --checkJs` 覆盖类型错误（JS 中依赖 JSDoc）。`node --check` 覆盖语法。

前提是它真的跑过：CI 里没有这一步时，先自己跑一遍，或先把它接进 CI。

## 先划界

本册只问 JavaScript 运行时与宿主机制本身让缺陷怎么发生。条目跨浏览器/Node 通用，宿主特有的用 `[Browser]`/`[Node]` 标注；同一段代码在两地保证不同时，逐条按标注判。

以下条目同时也是别的册在问的，报一处，说清按哪条判：

- 重试、超时、降级——`references/robustness.md`
- 模块划分、包组织——`references/architecture.md`
- 用字符串承载业务概念、布尔参数——`references/code.md`
- 类型层的缺口（类型断言、`any` 的传播、`tsconfig` 开关）——`references/lang/typescript.md`（`.js` 经 JSDoc / `checkJs` 同样适用）

## 事件循环与异步

- 同步代码阻塞事件循环时，浏览器中用户无法交互、页面无法渲染，Node 中其他请求全部挂起。不报：阻塞操作已被拆分到 Web Worker / Worker Threads / 子进程
- `await` 之后的微任务在当前宏任务内全部执行完，不管新增多少微任务；`setTimeout` 等宏任务要等微任务队列清空后才执行。不报：依赖的正是微任务优先级语义，且已文档声明
- `Promise` 构造函数中同步抛出的异常被转为 rejected promise，不会被外层 `try/catch` 捕获。不报：调用方已 `.catch` 或 `await`
- 未处理的 promise rejection 在 Node 中触发 `unhandledRejection`，浏览器中触发 `unhandledrejection`；**Node ≥15 默认把未处理的 rejection 升级成未捕获异常，进程带非零码退出**（只有 `--unhandled-rejections=warn` 才是"只警告"）；浏览器侧同样不静默，会在控制台打 `Uncaught (in promise)`。所以它不是"没人看见"，是**一条能拖掉整个进程的失败路径**——别按低危处理。不报：已注册全局监听，或每个 promise 都已处理
- `async` 函数返回的 promise 中抛出的异常，调用方不 `await` 就看不到。不报：调用点必然 `await` 或 `.catch`
- `forEach`/`map` 里传 `async` 回调：回调返回的 promise 没有任何东西在等——外层循环立刻走完，异常也无处可去（Node 实测：外层早已继续，回调里的 `await` 之后才完成）。不报：已改用 `for...of` + `await`，或 `Promise.all(arr.map(...))`

## 类型转换与相等

- `==` 触发隐式类型转换，`'5' == 5` 为真、`null == undefined` 为真、`[] == false` 为真（Node 实测）。不报：比较双方类型已显式转换且相同
- `+` 对字符串做拼接、对数字做加法，操作数一方是字符串时另一方被隐式转换。不报：操作数类型已显式声明且相同
- `NaN` 与自身比较不相等，`isNaN` 对非数字参数先做类型转换，应使用 `Number.isNaN`（Node 实测：`NaN === NaN` 为假、`Object.is(NaN, NaN)` 为真）。不报：已使用 `Number.isNaN` 或 `Object.is`
- `typeof null === 'object'`，对 null 做类型判断须单独检查。不报：已用 `x === null` 单独判空
- 对象转原始值走 `Symbol.toPrimitive` / `valueOf` / `toString`，顺序和结果随对象类型变化。不报：对象已实现 `Symbol.toPrimitive` 且已文档声明
- 从外部读入的"数字"经 `Number()` 转换时会静默吞掉空值：`Number('')` 与 `Number(null)` 都是 `0`、`Number(undefined)` 是 `NaN`、`parseInt('0x10')` 是 `16`（Node 实测）。空串与"缺失"被当成 0 是金额与计数类字段的典型来源。不报：输入在读取边界处已做显式校验与解析

## 数字与精度

- 浮点：`0.1 + 0.2 !== 0.3`（Node 实测为 `0.30000000000000004`），相等判断、累加与展示都会偏。不报：金额与计量已改用整数最小单位或十进制库
- 超过 `Number.MAX_SAFE_INTEGER` 的整数不再精确：`MAX_SAFE_INTEGER + 1 === MAX_SAFE_INTEGER + 2` 为真（Node 实测）。标识符、时间戳纳秒、雪花 ID 会悄悄撞在一起。不报：该量级的值用 `BigInt` 或字符串承载

## 数组与集合

- `Array.prototype.sort()` **默认按字符串排序**：`[10, 9, 1].sort()` 得到 `[1, 10, 9]`（Node 实测）。不报：已传比较函数，且比较函数对全部元素返回数字
- 对象的键一律被转成字符串：`o[1]` 与 `o['1']` 是同一个键，对象作键会变成 `'[object Object]'`（Node 实测）——不同类型的键互相覆盖。不报：已改用 `Map`/`Set`，或键本就全是字符串
- `for...in` 遍历**原型链上的可枚举属性**（Node 实测会带出继承来的键），`Object.keys` 只列自身。不报：已用 `Object.keys`/`Object.entries` 或 `Object.hasOwn` 过滤

## 原型链与 this

- `__proto__` 或 `constructor.prototype` 被写入时，`Object.prototype` 被污染，所有对象继承被注入的属性。不报：使用 `Object.create(null)` 或 `Map`/`Set` 替代普通对象，或已用 `--disable-proto=delete`
- 递归合并用户输入时未过滤 `__proto__`、`constructor`、`prototype` 键，构成原型污染。不报：合并前已显式拒绝这三个键，或使用结构化克隆
- `this` 绑定随调用点变化：普通函数调用指向全局对象（严格模式为 `undefined`），方法调用指向接收者，`call`/`apply`/`bind` 显式指定，箭头函数捕获外层 `this`。不报：所有函数调用点均已在同一对象上调用，或使用箭头函数锁定 `this`
- `[Node]` 模块顶层的 `this`：**CJS 是 `module.exports`，ESM 恒为 `undefined`**——只有 REPL 里才是 `global`。把 REPL 的行为当成模块行为，是这一条最常被写错的地方。`[Browser]` 顶层是 `window`，模块脚本里是 `undefined`。不报：代码不依赖顶层 `this`
- `Object.freeze()` 是浅冻结，嵌套对象仍可变；冻结后写入静默失败（非严格模式）或抛错（严格模式）。不报：嵌套对象已单独冻结
- `var` 提升，且 `var` 在循环里是**同一个绑定**：循环里建的闭包全读到终值（Node 实测 `[3, 3, 3]`），而 `let` 每次迭代一个新绑定（实测 `[0, 1, 2]`）。不报：已统一用 `let`/`const`

## JSON 与序列化

- `JSON.stringify` 静默丢弃 `undefined`、函数与 `Symbol` 值（Node 实测：`{a: undefined, b: () => 1, c: 1}` 得到 `{"c":1}`）——字段消失而调用方以为写全了。不报：序列化前已显式检查字段
- `JSON.stringify` 遇 `BigInt` 或循环引用直接抛 `TypeError`（Node 实测），而这类值常常是运行到某个分支才出现。不报：序列化前已做类型与结构校验

## 模块与加载

- `[Node]` CommonJS 的 `require` 是同步加载，循环依赖时返回部分初始化的 `exports`。不报：模块间无循环依赖
- `[Node]` ESM 与 CommonJS 混用：ESM 中 `require` 不可用（除非 `createRequire`），CommonJS 中 `import` 不可用。不报：项目已统一为单一模块系统
- `[Browser]` 模块脚本默认 defer，内联脚本默认同步执行，加载顺序与书写顺序可能不同。不报：脚本已用 `type="module"` 统一，或加载顺序无依赖

## 错误处理

- `catch {}` 省略绑定由语法直接允许（ES2019），**任何模式下都合法**——所以这里要判的不是"模式"，是**这个异常对象该不该丢**：丢了就不能记日志、不能按类型分支。不报：该处确实只需知道"失败了"，且没有可恢复分支
- `throw` 可抛出任意值（字符串、数字、对象），`catch` 中按类型判断时假设是 `Error` 会失败。不报：抛出点保证只抛 `Error` 子类
- 异步函数中 `try/catch` 只捕获同步代码和 `await` 的异常，未 `await` 的 promise 异常逃逸。不报：所有 promise 都已 `await` 或 `.catch`

## 全局与宿主对象

- `[Browser]` `var` 声明的顶层变量成为 `window` 属性，与已有全局名冲突时静默覆盖。不报：使用 `let`/`const` 或模块作用域
- `[Node]` `global` 对象可被任意模块写入，模块间通过 `global` 通信不可预期。不报：全局变量已文档声明为模块级配置，且写入点唯一

## 官方契约的常咬点（不保证覆盖）

标准库与内建对象**契约**层面的咬人处——形态见 `references/lang/method.md` 的「官方契约那一层」。**每条都是 node v22.22.0 本机实测**（`node --version` 复查）；这里没写的当场查原文。

- **`Date` 解析的时区看字符串的写法**：只有日期时按 **UTC** 解析，带时间时按**本地时间**解析（实测，本机 `Asia/Shanghai`：`new Date("2024-01-01").toISOString()` 是 `2024-01-01T00:00:00.000Z`，而 `new Date("2024-01-01T00:00").toISOString()` 是 `2023-12-31T16:00:00.000Z`）——同一天的两个写法差 8 小时。**别解析字符串，用数字构造或带 `Z`/偏移量的形式**。不报：输入已带显式时区偏移
- **`toFixed` 返回字符串，不是数字**（实测：`typeof (1).toFixed(2)` 是 `"string"`），且**它按二进制值舍入**：`(1.005).toFixed(2)` 是 `"1.00"`、`(1.45).toFixed(1)` 是 `"1.4"`（实测）——金额四舍五入会少一分。不报：展示用，且已接受二进制舍入
- **大小写转换会改变长度**（实测：`"ß".toUpperCase()` 是 `"SS"`，长度 1→2；`"İ".toLowerCase()` 同样是 1→2）——按下标映射、按长度切片、按原串回填都会错位。不报：先按 `Array.from()` 或 `Intl.Segmenter` 切分，再逐段转换
- **`Object.keys` 的顺序：整数键先按升序，其余按插入序**（实测：按 `b, "2", a, "1"` 插入，得到 `["1","2","b","a"]`）——需要稳定顺序时别指望插入序。不报：已改用 `Map`，或键全部是整数
- **`includes` 用 SameValueZero、`indexOf` 用严格相等**（实测：`[NaN].includes(NaN)` 是 `true`，而 `[NaN].indexOf(NaN)` 是 `-1`；`[-0].includes(0)` 是 `true`）——查重与查存在用错方法会漏。不报：两种语义都对结果无影响
- **`parseInt` 遇到非数字就截断，`Number` 则整串校验**（实测：`parseInt("12abc")` 是 `12`、`Number("12abc")` 是 `NaN`；`parseInt("1e3")` 是 `1`、`Number("1e3")` 是 `1000`）——把两者当等价换用，会把非法输入读成合法值。不报：输入已在读取边界处校验过

## 报告

本件只给清单，不含报告契约——**档位与报告形态以 `references/contract.md` 为准**。本件条目多且机械，**命中多不等于分量重**。
