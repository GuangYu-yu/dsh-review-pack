只列 Python 的语言语义会直接产生的问题。每条都能指到具体代码位置，不需要判断口味。

**状态**：候选池——**覆盖不保证**，当检索线索用，每条的成立仍要按位置核实。

## 先跑工具链，工具链报的不写进本件

`ruff` 覆盖（规则号**以你机器上那版的规则表为准**）：未使用导入与变量（F401/F841）、可变默认参数（B006）、函数调用作默认值（B008）、闭包捕获循环变量（B023）、`create_task` 未保存引用（RUF006）、裸 `except` 与 `except: pass`（E722/S110）、`== None`（E711）、`raise` 缺 `from`（B904）、`eval`/`exec`/`pickle`/`shell=True`（S 系列）、f-string 无占位符（F541）、`type(x) ==`（E721）、未定义名与重定义（F821/F811）。

`mypy` / `pyright` 覆盖：类型错误、`Optional` 成员访问、返回类型不匹配、协议与结构子类型检查。

**所以"默认参数是不是可变的""闭包有没有捕获循环变量""task 有没有保存引用"这几族不在本件**——ruff 报得最准：先让它喊。本件只收它到不了的。

前提是它真的跑过：CI 里没有这一步时，先自己跑一遍，或先把它接进 CI。

## 先划界

本册只问 Python 语言机制本身让缺陷怎么发生。以下条目同时也是别的册在问的，报一处，说清按哪条判：

- 重试、超时、降级——`references/robustness.md`
- 模块划分、包组织——`references/architecture.md`
- 用字符串承载业务概念、布尔参数——`references/code.md`
- 代价随规模放大（字符串拼接）——`references/performance.md`
- 文本与编码的跨平台差异——`references/docs-config.md`

## 异常

- `except BaseException` 或 `except:` 捕获 `KeyboardInterrupt`、`SystemExit`、`CancelledError`，进程无法中断、协程无法取消。不报：重抛或按类型白名单放行
- `except Exception as e` 中 `e` 在块结束时被删除，块外引用抛 `UnboundLocalError`（3.13 实测）；闭包持有 `e` 时读到 `None` 或异常。不报：`e` 在块内提取为独立变量，块外不再引用
- `raise e` 重抛会在 traceback 前面**多插一帧指向重抛点**（3.13 实测：帧数 +1，**原失败位置没丢**），日志里因此多一层无关帧；裸 `raise` 不插。不报：已改用无参 `raise`
- `raise X from None` 抑制 `__cause__` 链，原始原因在日志和调用方都不可见。不报：`from None` 用于有意隐藏内部细节、且已文档声明
- `finally` 中的 `return` 或 `break`/`continue` 覆盖 `try` 的返回或跳出，`try` 中的异常被静默吞掉（3.13 实测：异常没传出去）。不报：`try` 块内无异常、`finally` 中无控制流语句
- `__del__` 或 `weakref` 回调中抛异常只打印到 `stderr`（3.13 实测：只剩 `Exception ignored in:` 那一行），调用方与日志采集都拿不到。不报：`__del__` 体不抛异常，或已用 `contextlib` 做显式清理
- 异常在 `except` 块内被新异常覆盖，原异常只挂在 `__context__`，`str()` 与默认日志看不到。不报：新异常已通过 `from` 显式串联，或已日志记录原异常

## 可变性与共享

- 类属性是可变对象（`list`/`dict`/`set`），所有实例共享同一份；一个实例的 `append` 影响其他实例（3.13 实测：`a.items is b.items`）。不报：类属性是不可变类型，或已在 `__init__` 中显式拷贝
- 函数参数按对象引用传递，函数内修改入参的可变内容影响调用方；想隔离须显式拷贝。不报：函数已文档声明会原地修改，或入参不可变
- `dict.copy()`、`list.copy()`、切片、`copy.copy()` 都是浅拷贝，嵌套可变对象仍共享。不报：嵌套对象不可变，或已用 `copy.deepcopy`
- 含**不可哈希**元素的 `tuple` 连 hash 都过不去（3.13 实测：`unhashable type`）；含**可变但可哈希**对象（自定义类按可变字段算 `__hash__`）的 `tuple` 作键后，元素一改哈希就变，键再也找不到。不报：元组内元素全部不可变

## 作用域与闭包

- 内部函数对同名变量赋值而不声明 `nonlocal`，创建新局部变量，外部变量不受影响，调用方以为已更新。不报：内部函数只读该变量，或已显式 `nonlocal` 声明
- 推导式在 Python 3 中有独立作用域，若依赖"推导式会污染外层"的旧习惯，逻辑静默失效。不报：推导式内的名字与外层无重名
- 函数里的 `global x; x = ...` 改的是模块全局，多个函数互相覆盖。不报：全局名字只在一处被写入，或已改用模块级状态对象
- `del` 后再次引用同名变量抛 `NameError`；条件分支中 `del` 一处、引用一处，路径覆盖不全。不报：`del` 与后续引用在同一作用域内必然相邻，或已改用 `None` 置空

## 类与继承

- 定义了 `__eq__` 但未定义 `__hash__`，Python 3 自动将 `__hash__` 置 `None`，实例放入 `set`/`dict` 时抛 `TypeError`（3.13 实测：`unhashable type`）。不报：类明确设计为不可哈希且已文档声明
- `__eq__` 与 `__hash__` 不一致：相等的对象哈希不同，`dict` 查找失败、`set` 去重失效。不报：类不实现 `__eq__`，或两者均基于同一组不可变字段
- 零参 `super()` 依赖 `__class__` cell，在类体外（如 `exec`、装饰器替换函数）调用行为异常。不报：`super()` 调用位于类体内的普通方法中
- 多重继承下 `super().__init__()` 调用链由 MRO 决定，跳过某一基类的 `__init__` 时基类状态未初始化。不报：继承层次中只有一个基类实现 `__init__`，或已用 `super().__init__()` 链式传递
- 描述符在实例访问与类访问上都会触发 `__get__`，参数不同（`__get__(instance, owner)` vs `__get__(None, owner)`）；数据描述符在类访问上也优先于实例字典，非数据描述符在实例访问时被实例字典遮蔽。不报：类未定义描述符，或访问方式与类型一致
- `__init__` 中把值赋给类属性而非实例属性（未加 `self.`），实例读到时落在类上，实例间共享。不报：赋值目标是 `self.x`，或类属性本就是有意共享的常量
- `__slots__` 的继承限制：子类未声明时实例重新获得 `__dict__`（收益消失）；基类未声明时子类的 `__slots__` 无效；多基类各自声明非空 `__slots__` 时多继承抛 `TypeError: multiple bases have instance lay-out conflict`（3.13 实测）。不报：层次中所有类均声明了且不涉及多继承

## 迭代与生成器

- 一次性迭代对象（生成器、`__iter__` 返回 `self` 的迭代器）第二次遍历得到空序列。不报：调用方已文档声明单次消费，或返回的是 `list`/`tuple`
- 生成器惰性求值，函数体内副作用（日志、写文件、网络请求）在消费点才发生，与定义点顺序无关。不报：生成器体内无副作用，或调用点即为消费点
- 生成器被 `.close()` 时抛 `GeneratorExit`：裸 `except:` 吞掉后**若继续 `yield`**，`.close()` 抛 `RuntimeError: generator ignored GeneratorExit`；**只吞掉并从函数返回则不报**（3.13 实测）。不报：生成器中未捕获 `GeneratorExit`，或已显式 `raise` 放行
- `zip` 在 Python 3 返回惰性迭代器，`for` 结束后无法复用（3.13 实测：第二次 `list(z)` 为空）；`dict.items()`/`dict.keys()` 是视图而非快照，迭代期间增删字典抛 `RuntimeError: dictionary changed size during iteration`。不报：迭代前已转为 `list`，或迭代期间不修改底层字典
- `return` 在生成器中作为 `StopIteration.value` 传出（3.13 实测），被 `for` 循环吞掉，调用方拿不到返回值。不报：生成器内不使用 `return value`，或调用方显式用 `next` 捕获 `StopIteration`

## 并发与异步

- `async def` 内调用阻塞 API（`time.sleep`、`requests.get`、`subprocess.run`、`open().read()`），阻塞整个事件循环，其他协程全部停摆。不报：已用 `asyncio.sleep`、`aiohttp`、`run_in_executor` 等异步替代
- `asyncio.gather` 默认 `return_exceptions=False`：一个任务抛异常时**其余任务不会被取消**（3.13 实测：同伴照旧跑完），异常立刻抛给调用方——调用方以为都停了，后台还在跑。要取消兄弟任务得用 `TaskGroup`。不报：已设 `return_exceptions=True` 并逐项检查，或已改用 `TaskGroup`
- `asyncio.wait_for` / `asyncio.timeout` 超时取消协程，`CancelledError` 从 `await` 点抛出；协程内已获取的资源、已写入的一半状态由谁收拾。拿不出结论的，把每个协程的取消语义写成契约。不报：协程在 `await` 点上无未提交状态，或已用 `try/finally` 覆盖所有取消路径
- `asyncio.shield` 保护的不是整个协程，只是屏蔽了外层取消；内层任务若自己收到取消仍然终止。不报：内层任务不响应 `CancelledError`，且已文档声明
- `threading.Lock` 未用 `with`，异常路径上锁不释放，其他线程永久阻塞。不报：锁的获取与释放之间无异常路径，或已用 `with` 保证释放
- `+=`、`check-then-act`、`dict.setdefault` 等在 GIL 下仍是复合操作，其他线程可在字节码之间插入。不报：操作对象只在单线程内可见，或已用锁保护
- `threading.Event.wait` 与 `Condition.wait` 的丢失唤醒：条件未在持锁状态下检查或通知。不报：等待与通知均在同一把锁下进行，且条件在循环中复检

## 类型与相等

- `is` 对小整数（`-5..256`）和部分短字符串走缓存，相同字面量在不同位置可能 `is` 为真或为假，行为随实现和版本变化（3.13 实测：小整数与拼接串真、`int('257') is int('257')` 假）。不报：比较的是 `None`、`True`、`False`、`NotImplemented` 等单例
- `bool` 是 `int` 的子类，`True == 1`、`isinstance(True, int)` 为真，用 `isinstance(x, int)` 过滤时布尔值也被接收。不报：已显式排除 `bool`（`type(x) is int` 或 `not isinstance(x, bool)`）
- `float('nan')` 与自身不相等、`nan in [nan]` 为假，`x != x` 是惯用法但要求读者知道 IEEE 754 的 NaN 不自等。不报：已用 `math.isnan(x)`
- 大整数 `a / b` 返回 `float`，超 53 位尾数丢精度；应使用 `a // b` 或 `Fraction`/`Decimal`。不报：值域已证明在 float 精度内
- `round` 是银行家舍入（3.13 实测：0.5→0、1.5→2、2.5→2），与数学教材的"四舍五入"不同。不报：已使用 `Decimal.quantize` 或显式加 `0.5`
- 从 JSON/环境变量/文件读入的"数字"常是 `str`：`'5' < 10` 抛 `TypeError`（3.13 实测），`'a' + b'a'` 同理。类型没在读取边界处转换，错误要到比较或拼接处才暴露。不报：类型已在边界处显式转换

## 资源与上下文

- `open()` 不指定 `encoding`，使用 `locale.getpreferredencoding()`（3.13 实测：本机 cp936），Linux 通常 UTF-8、Windows 是 GBK/CP1252，跨平台读同一文件行为不同。不报：已显式传入 `encoding='utf-8'`
- `with` 的 `__exit__` 返回真值吞掉块内异常，调用方以为成功。不报：`__exit__` 返回 `False`/`None`，或吞异常是有意且已文档声明
- `__enter__` 抛异常时 `__exit__` 不被调用，已获取的部分资源无人释放。不报：`__enter__` 实现中不获取资源，或将资源获取放在 `__init__` 并由调用方负责清理
- 依赖 GC 关闭文件/连接：CPython 引用计数会在变量超出作用域时立即关闭，但 PyPy 或其他实现可能延迟，代码跨解释器运行时资源泄漏。不报：已显式 `with` 或 `try/finally` 关闭，不依赖 GC

## 字符串与编码

- `str.encode`/`bytes.decode` 未指定 `errors`，默认 `'strict'` 遇非法序列抛 `UnicodeDecodeError`；若期望丢弃或替换，须显式传 `errors=`。不报：输入已保证可解码，或接受 `strict` 抛错作为异常路径
- 源码文件未声明编码，Python 3 默认 UTF-8，但含 BOM 时 `utf-8-sig` 与 `utf-8` 解码结果首字符不同。不报：文件不含 BOM，或读取时已显式选用 `utf-8-sig`
- f-string 在 Python 3.12 前不支持反斜杠嵌套、同一引号嵌套，跨版本行为不同（3.13 实测已可用）。不报：表达式不含反斜杠且引号类型与外层不同

## 导入与模块

- 模块顶层代码有副作用（写文件、发请求、启动线程），`import` 即触发；测试、打包工具、类型检查器都会触发。不报：顶层代码只做定义和常量赋值，无 IO 与副作用
- 循环导入：模块 A 顶层 `import B`，B 顶层 `import A`，导入顺序决定哪一方的名字未定义，表现为 `AttributeError` 或部分初始化的模块。不报：循环导入中的引用位于函数体内而非模块顶层
- `from module import *` 污染导入方命名空间，且 `__all__` 未定义时导入所有非下划线名。不报：被导入模块已显式定义 `__all__`，且导入方在受控作用域内使用
- `if __name__ == '__main__'` 缺失时，模块被 `import` 会执行主逻辑。不报：模块只被当作脚本运行，不做导入入口
- 相对导入 `from . import x` 只在包内有效，脚本直接运行时 `__package__` 为空，抛 `ImportError`。不报：模块只通过包导入方式加载，不直接执行
