只列 TypeScript 类型层与运行时之间的缺口让缺陷怎么发生的问题。每条都能指到具体代码位置，不需要判断口味。

**状态**：候选池——**覆盖不保证**，当检索线索用，每条的成立仍要按位置核实。

## 先跑工具链，工具链报的不写进本件

`tsc --noEmit` 覆盖：类型错误、未使用局部变量（`noUnusedLocals`）、未使用参数（`noUnusedParameters`）、隐式 `any`（`noImplicitAny`）、null/undefined 未检查（`strictNullChecks`）、隐式 `this`（`noImplicitThis`）、索引访问未检查（`noUncheckedIndexedAccess`）、可选属性精确类型（`exactOptionalPropertyTypes`）、switch 贯穿（`noFallthroughCasesInSwitch`）、catch 变量类型（`useUnknownInCatchVariables`）。

`eslint` 配合 `@typescript-eslint` 覆盖：`no-explicit-any`、`no-non-null-assertion`、`no-unnecessary-type-assertion`、`consistent-type-imports`、`no-floating-promises`、`await-thenable`、`no-unnecessary-condition`。

前提是它真的跑过：CI 里没有这一步时，先自己跑一遍。

**本册的机制条目是从类型层与运行时的缺口推出来的，未逐条核实**——遇到可疑的先按位置核实。**「官方契约的常咬点」那一节是 tsc 7.0.2 实测**（`tsc --version` 复查）。**开关名与默认值随版本变**：别按记忆里的默认值假设，以你机器上那版为准。

## 先划界

本册只问 TypeScript 类型层与运行时之间的缺口。纯粹是 JavaScript 运行时/宿主机制的问题（事件循环、原型链、`this` 绑定、模块加载）归 `references/lang/javascript.md`，本册不重复。

以下条目同时也是别的册在问的，报一处，说清按哪条判：

- 重试、超时、降级——`references/robustness.md`
- 模块划分、包组织——`references/architecture.md`
- 用字符串承载业务概念、布尔参数——`references/code.md`

## 类型断言与逃逸

- `x as T` 在运行时不做任何检查，只告诉编译器把 `x` 当作 `T`。当 `T` 与 `x` 的运行时类型不重叠时，后续成员访问在运行期失败，编译期无警告。不报：断言处已由前置 `is` 收窄，或有运行时校验
- `x!` 非空断言从静态类型里去掉 `null`/`undefined`，不产生运行时检查。断言错误时，失败点从缺失值的边界**移到后续使用处**，更难诊断。不报：`x` 已由运行时检查确立非空
- 链式断言 `x as unknown as T`（或经 `never`、经中间变量、经辅助函数）跨过不兼容的类型，中间类型不提供任何运行时证据。不报：转换经适配器或运行时校验完成
- 类字段上的明确赋值断言 `field!: T` 抑制初始化分析，运行时仍可能是 `undefined`。不报：字段在构造函数中必然已赋值，或类型显式包含未初始化状态
- 函数返回类型标注为 `T` 时，实现体的返回值不做运行时校验——返回类型是**断言**不是保证。不报：调用点在使用前已做运行时检查

## 结构化类型与运行时身份

- TypeScript 按结构子类型比较（有 `y` 的成员即可赋给 `y`），运行时的 `instanceof` 按原型链判断：编译期通过的赋值可能在 `instanceof` 处失败。不报：代码只用形状消费，不做 `instanceof` 或类身份判断
- 两个形状相同但无继承关系的类可互相赋值，运行时的原型方法可能在另一方上不存在。不报：类已通过私有字段建立名义区分
- 对象字面量赋给接口时只检查形状：直接赋值时多余属性报错，**经中间变量赋值时不报**，而运行时的多余属性仍存在。不报：多余属性已由运行时校验拒绝
- 接口可被任意形状匹配，表达不了"此类型必须由某特定来源产生"。不报：来源约束已由品牌字段在编译期区分

## any 与类型健全性

- `any` 可赋给任何类型、也可从任何类型赋值，并屏蔽其上的所有检查；经它中转的值在运行时的类型与静态类型无任何对应。不报：`any` 只出现在与外部无类型边界的单点，且该点已运行时校验
- `any` 经泛型、返回值、数组元素传播：一个 `any` 流入后，下游在该路径上的检查全部失效。不报：传播路径已由显式类型标注截断
- `catch (e)` 在 `useUnknownInCatchVariables` 关闭时 `e` 是 `any`，对 `e.message` 一类访问不做检查；开启时是 `unknown`。不报：已开启该标志，或 catch 块内已收窄
- `JSON.parse` 返回 `any`，调用方直接访问字段：结构不符时得到 `undefined` 而不是编译期错误。不报：解析结果已经过运行时校验器转为领域类型
- 环境声明（`declare`）给已有运行时对象贴类型：声明与实际对象不一致时编译期通过、运行期失败。不报：声明来自与运行时同步生成的 `.d.ts`

## 类型擦除与运行时

- 类型别名、接口、类型参数编译后完全擦除，不能用于运行时判断：`x is T` 写不出来，`instanceof T`（`T` 是类型参数或接口）不可用。不报：运行时判断改用可保留的标记（类、判别属性、品牌字段）
- 泛型函数的类型参数 `T` 没有运行时表示，`new T()`、`T.name` 不可用；需要构造器时必须传入值参数。不报：类型参数已有对应的运行时构造器参数

## 枚举与运行时对象

- 数字枚举在运行时生成**双向映射**对象（`Direction.Up === 1` 且 `Direction[1] === "Up"`），字符串枚举不生成反向映射——同一份代码里两种枚举的运行时形状不同。不报：枚举值只用于比较，不依赖反向查表
- `const enum` 在编译时内联并从输出中完全移除；某个编译单元若以 `isolatedModules` 单独编译，它无法内联，报错或行为不一致。不报：项目未启用 `isolatedModules`，或已改用普通枚举 / 联合字面量
- 数字枚举成员可被赋任意数字（`Direction.Up = 99` 编译通过），枚举不约束值域。不报：已改用字符串枚举或联合字面量约束值域
- 生成的映射对象**未被冻结**，`Direction.Up = 5` 在运行期静默成功。不报：运行时依赖处已 `Object.freeze`，或改用 `as const` 对象

## 函数重载与实现

- 重载签名决定调用点可见的签名，实现签名不参与调用匹配。实现签名比所有重载都宽时，实现体内的参数类型被放宽，编译期发现不了实现与重载的不一致。不报：实现签名与每个重载逐一对应，且实现体内对参数做了运行时分派
- 重载之间没有公共实现约束，实现体可返回与任一重载声明都不匹配的类型而不报错。不报：返回类型已标为所有重载返回值的联合
- 两个重载参数数量相同且类型兼容时，**先声明的优先匹配**，调换顺序会改变调用解析结果。不报：重载集合之间无参数兼容重叠

## 方差与数组协变

- 数组与对象属性按协变处理：`Array<string>` 可赋给 `Array<string | number>`，向该视图写入 `number` 后原数组被污染，后续按 `string` 消费时运行期抛错。不报：赋值后只读不写，或已改用 `readonly T[]`
- 方法参数在 `strictFunctionTypes` 下仍按双变检查（非方法函数类型按逆变）：覆写时子类放宽参数类型编译通过，运行期传入不匹配参数时访问失败。不报：覆写方法内对参数做了运行时检查，或已改成函数值属性
- `strictFunctionTypes` 关闭时函数类型参数按双变检查：接受更宽参数的函数可赋给接受更窄参数的函数类型，运行期传入窄类型时行为未定义。不报：已开启 `strictFunctionTypes`

## 声明合并与模块增强

- 同名接口合并时非函数成员类型不同会编译报错，但**跨模块的同名接口不合并**（除非经 `declare module` 增强）；合并后的成员顺序影响重载解析——后声明的重载组排在前。不报：接口名在项目内唯一，或合并顺序已文档声明
- 全局增强（`declare global`）向所有模块注入声明，与已有全局名冲突时**静默合并**，冲突成员的运行时不一致在编译期看不见。不报：增强限于单一入口文件，且不与第三方声明冲突
- 命名空间与类/函数/枚举同名时按特定顺序合并，值侧与类型侧的规则不同：改一侧可能影响另一侧。不报：不使用同名跨类别合并

## 导入省略与模块语义

- 默认启用 import elision：只用在类型位置的导入在输出中整条移除——**若该导入同时有运行时副作用，副作用被一并移除**。不报：已开启 `verbatimModuleSyntax`，或用 `import type` 显式区分
- 同时导入类型和值时（`import { Car }` 而 `Car` 仅为类型），elision 依赖跨文件分析，在 `isolatedModules` 或单文件转译器下行为不同。不报：已用 `import { type Car }` 或 `import type` 标注
- 声明文件与运行时 JS 由不同工具或不同设置生成时，`.d.ts` 可能与实际模块格式（CJS/ESM）不一致：消费方编译通过而运行期解析失败。不报：声明与运行时代码由同一工具链同步生成

## tsconfig 与编译语义

- `strict` 是一组开关的预设，但 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes` **不在其中**，须单独开启：未开启时 `arr[i]` 的类型是元素类型而不是 `元素类型 | undefined`，`obj.optional` 允许显式赋 `undefined`。不报：已显式开启这两个标志
- `skipLibCheck` 开启时跳过 `.d.ts` 的类型检查：三方声明里的类型错误被忽略，消费方可能基于错误声明通过编译。不报：依赖的 `.d.ts` 已单独验证，或该开关关闭
- `target` 决定降级后的运行时语义：`ES5` 下 `class` 降级为函数构造器（**版本边界**：`target: es5` 在 TS 6.0 起标为弃用、7.0 移除，按你那版 tsc 先确认它还收不收——旧版迁移过来的项目才见得到这个语义）、`const enum` 可内联、生成器改写为状态机——同一段代码在不同 `target` 下运行时行为不同。不报：`target` 与部署运行时一致，且已文档声明
- `moduleResolution` 影响类型解析路径：`node` 与 `node16`/`nodenext` 对 `exports` 字段、`.js`/`.ts` 扩展名的处理不同，同一导入在一个设置下解析成功、另一个失败。不报：`module` 与 `moduleResolution` 已按目标运行时的严格解析规则配置
- `esModuleInterop` 开启时允许 `import x from` 导入 CJS 模块，关闭时报错；开启后生成的 helper 在运行时的 `default` 语义与 CJS 的 `module.exports` 不同。不报：导入方已文档声明按该语义使用

## 类型谓词与收窄

- 类型谓词 `v is T` 是**开发者承诺**，编译器不检查函数体是否真能判定 `T`；谓词实现错误时收窄结果在运行期无效。不报：谓词函数体已实现完整运行时检查
- 断言函数 `function assert(v: unknown): asserts v is T` 靠抛错终止——返回即承诺 `v` 是 `T`；函数体不抛、或抛错条件不完整时，承诺为假。不报：断言函数体覆盖了所有非 `T` 的输入
- 控制流收窄在回调、闭包、`await` 之后**不保持**：`if (x !== null)` 内定义的闭包在调用时 `x` 可能已被重新赋值，编译器不报而运行期读到 `null`。不报：收窄后 `x` 是 `const` 或未被重新赋值

## 官方契约的常咬点（不保证覆盖）

编译器**默认值**层面的咬人处——形态见 `references/lang/method.md` 的「官方契约那一层」。**下列默认值以 tsc 7.0.2 为基准实测**（`tsc --version` 复查）；条目里带**版本边界**标记的，边界之外不适用。这里没写的当场查原文。**默认值随版本前移过**，从旧版迁移过来的项目会看到一批新错。

- **`strictNullChecks` 在 7.0.2 上默认就是开的**（实测：`let s: string = null;` **不加任何开关**即报 `TS2322: Type 'null' is not assignable to type 'string'`；加 `--strictNullChecks false` 或 `--strict false` 才放行）——按"默认为关"写的代码与配置说明已经过期。不报：项目 tsconfig 里已显式写死并文档声明
- **`noImplicitOverride` 不在 `strict` 里**（实测：`--strict` 下覆写基类方法不报，加 `--noImplicitOverride` 才报 `TS4114: This member must have an 'override' modifier`）——以为"开了 strict 就都查了"会漏掉改名后静默不再覆写的情形。不报：项目未使用继承，或该开关已单独开启
- **`noUncheckedIndexedAccess` 也不在 `strict` 里**（实测：`--strict` 下 `const n: number = arr[5]` 通过，加该开关才报 `number | undefined` 不可赋给 `number`）——越界读在类型上仍然"安全"，运行期拿到 `undefined`。不报：该开关已单独开启，或索引来源已保证在界内
- **`useDefineForClassFields` 随 `target` 变，后果是运行期反转**（实测同一份源码：`--target es2021` 编成 `this.v = 2`，运行期抛 `TypeError: Cannot set property v of #<P> which has only a getter`；`--target es2022` 编成 `v = 2`，运行期输出 `2`）——**子类字段与基类取值器相遇时，换个 target 就从能跑到崩溃**。不报：目标 target 已固定，且类层次里没有同名取值器
- **`noEmitOnError` 默认 `false`：有类型错误时 JS 照样产出**（实测：`const bad: number = "x";` 报 `TS2322`、退出码非零，而 `.js` **仍然被写出**；加 `--noEmitOnError` 才不写）——构建脚本只看退出码而不清理产物时，仓库里会留下与被拒源码对应的 JS。不报：构建流程会先清理产物目录，或按产物发布
- **不传 `--target` 时默认不做降级**（实测：类字段与箭头函数原样保留为 `class K { x = 1; y = () => 2; }`）——**默认目标随 tsc 版本前移过，别按 ES5 时代的记忆假设**它会降级成函数构造器。不报：项目显式声明了 `target`

## 报告

本件只给清单，不含报告契约——**依据与报告形态以 `references/contract.md` 为准**。本件条目多且机械，**命中多不等于分量重**。
