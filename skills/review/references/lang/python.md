只列 Python 的语言语义会直接产生的问题。每条都能指到具体代码位置，不需要判断口味。

**状态**：候选池——**覆盖不保证**，当检索线索用，每条的成立仍要按位置核实。

## 先跑工具链，工具链报的不写进本件

`ruff` 覆盖（规则号**以你机器上那版的规则表为准**）：未使用导入与变量（F401/F841）、可变默认参数（B006）、函数调用作默认值（B008）、闭包捕获循环变量（B023）、`create_task` 未保存引用（RUF006）、裸 `except` 与 `except: pass`（E722/S110）、`== None`（E711）、`raise` 缺 `from`（B904）、`eval`/`exec`/`pickle`/`shell=True`（S 系列）、f-string 无占位符（F541）、`type(x) ==`（E721）。

`mypy` / `pyright` 覆盖：类型错误、`Optional` 成员访问、返回类型不匹配、协议子类型检查。

**所以"默认参数是不是可变的""闭包有没有捕获循环变量""task 有没有保存引用"这几族不在本件**——ruff 报得最准：先让它喊。本件只收它到不了的。

前提是它真的跑过：CI 里没有这一步时，先自己跑一遍。

## 先划界

本册只问 Python 语言机制本身让缺陷怎么发生。以下条目同时也是别的册在问的，报一处，说清按哪条判：

- 重试、超时、降级——`references/robustness.md`
- 模块划分、包组织——`references/architecture.md`
- 文本与编码的跨平台差异——`references/docs-config.md`

## 异常

- `except BaseException` 或 `except:` 捕获 `KeyboardInterrupt`、`SystemExit`、`CancelledError`，进程无法中断、协程无法取消。不报：重抛或按类型白名单放行
- `except Exception as e` 中 `e` 在块结束时被删除，块外引用抛 `NameError: name 'e' is not defined`（函数内才是 `UnboundLocalError`——3.13 实测，两种作用域各跑一次；按异常类型 grep 日志会漏掉模块级与类体级）；闭包持有 `e` 时读到 `None` 或异常。不报：`e` 在块内提取为独立变量，块外不再引用
- `raise e` 重抛会在 traceback 前面**多插一帧指向重抛点**（3.13 实测：帧数 +1，**原失败位置没丢**），日志里因此多一层无关帧；裸 `raise` 不插。不报：已改用无参 `raise`
- `raise X from None` 抑制 `__cause__` 链，原始原因在日志和调用方都不可见。不报：`from None` 用于有意隐藏内部细节、且已文档声明
- `finally` 中的 `return` 或 `break`/`continue` 覆盖 `try` 的返回或跳出，`try` 中的异常被静默吞掉（3.13 实测：异常没传出去）。不报：`try` 块内无异常、`finally` 中无控制流语句
- `__del__` 或 `weakref` 回调中抛异常只打印到 `stderr`（3.13 实测：只剩 `Exception ignored in:` 那一行），调用方与日志采集都拿不到。不报：`__del__` 体不抛异常，或已用 `contextlib` 做显式清理
- 异常在 `except` 块内被新异常覆盖，原异常只挂在 `__context__`，`str()` 与默认日志看不到。不报：新异常已通过 `from` 显式串联，或已日志记录原异常

## 可变性与共享

- 类属性是可变对象（`list`/`dict`/`set`），所有实例共享同一份；一个实例的 `append` 影响其他实例（3.13 实测：`a.items is b.items`）。不报：类属性是不可变类型，或已在 `__init__` 中显式拷贝
- 函数参数按对象引用传递，函数内修改入参的可变内容影响调用方；想隔离须显式拷贝。不报：函数已文档声明会原地修改，或入参不可变
- `dict.copy()`、切片、`copy.copy()` 都是浅拷贝，嵌套可变对象仍共享。不报：嵌套对象不可变，或已用 `copy.deepcopy`
- 含**不可哈希**元素的 `tuple` 仍不可哈希（3.13 实测：`unhashable type`）；含**可变但可哈希**对象（自定义类按可变字段算 `__hash__`）的 `tuple` 作键后，元素一改哈希就变，键再也找不到。不报：元组内元素全部不可变

## 作用域与闭包

- 内部函数对同名变量赋值而不声明 `nonlocal`，创建新局部变量，外部不受影响，调用方以为已更新。不报：内部只读该变量，或已显式 `nonlocal` 声明
- 函数里的 `global x; x = ...` 改的是模块全局，多个函数互相覆盖。不报：全局名字只在一处被写入，或已改用模块级状态对象

## 类与继承

- 定义了 `__eq__` 但未定义 `__hash__`，Python 3 自动将 `__hash__` 置 `None`，实例放入 `set`/`dict` 时抛 `TypeError`（3.13 实测：`unhashable type`）。不报：类明确设计为不可哈希且已文档声明
- `__eq__` 与 `__hash__` 不一致：相等的对象哈希不同，`dict` 查找失败、`set` 去重失效。不报：类不实现 `__eq__`，或两者均基于同一组不可变字段
- 零参 `super()` 依赖 `__class__` cell，在类体外（如 `exec`、装饰器替换函数）调用行为异常。不报：`super()` 调用位于类体内的普通方法中
- 多重继承下 `super().__init__()` 调用链由 MRO 决定，跳过某一基类的 `__init__` 时基类状态未初始化。不报：继承层次中只有一个基类实现 `__init__`，或已用 `super().__init__()` 链式传递
- 描述符在实例访问与类访问上都会触发 `__get__`（类访问时 `instance` 是 `None`）；数据描述符在类访问上也优先于实例字典。不报：类未定义描述符，或访问方式与类型一致
- `__init__` 中把值赋给类属性而非实例属性（未加 `self.`），实例读到时落在类上，实例间共享。不报：赋值目标是 `self.x`，或类属性本就是有意共享的常量
- `__slots__` 的继承限制：子类未声明时实例重新获得 `__dict__`（收益消失）；基类未声明时子类的 `__slots__` 无效；多基类各自声明非空 `__slots__` 时多继承抛 `TypeError`（3.13 实测）。不报：层次中所有类均声明了

## 迭代与生成器

- 一次性迭代对象（生成器、`__iter__` 返回 `self` 的迭代器）第二次遍历得到空序列。不报：调用方已文档声明单次消费，或返回的是 `list`/`tuple`
- 生成器惰性求值，函数体内副作用（日志、写文件、网络请求）在消费点才发生，与定义点顺序无关。不报：生成器体内无副作用，或调用点即为消费点
- 生成器被 `.close()` 时抛 `GeneratorExit`：裸 `except:` 吞掉后**若继续 `yield`**，`.close()` 抛 `RuntimeError: generator ignored GeneratorExit`（3.13 实测）；只吞掉并返回则无事。不报：生成器未捕获 `GeneratorExit`，或已显式 `raise` 放行
- `zip` 返回惰性迭代器，`for` 结束后无法复用（3.13 实测）；`dict.items()`/`dict.keys()` 是视图而非快照，迭代期间增删字典抛 `RuntimeError: dictionary changed size during iteration`。不报：迭代前已转 `list`，或迭代期间不修改底层字典
- `return` 在生成器中作为 `StopIteration.value` 传出（3.13 实测），被 `for` 循环吞掉，调用方拿不到返回值。不报：生成器内不使用 `return value`，或调用方显式用 `next` 捕获 `StopIteration`

## 并发与异步

- `async def` 内调用阻塞 API（`time.sleep`、`requests.get`、`subprocess.run`、`open().read()`），阻塞整个事件循环，其他协程全部停摆。不报：已用 `asyncio.sleep`、`aiohttp`、`run_in_executor` 等异步替代
- `asyncio.gather` 默认 `return_exceptions=False`：一个任务抛异常时**其余任务不会被取消**（3.13 实测：同伴照旧跑完）——调用方以为都停了，后台还在跑。要取消兄弟任务得用 `TaskGroup`。不报：已设 `return_exceptions=True` 并逐项检查，或已改用 `TaskGroup`
- `asyncio.wait_for` / `asyncio.timeout` 超时取消协程，`CancelledError` 从 `await` 点抛出；协程内已获取的资源、已写入的一半状态由谁收拾。拿不出结论的，把每个协程的取消语义写成契约。不报：协程在 `await` 点上无未提交状态
- `asyncio.shield` 保护的不是整个协程，只是屏蔽了外层取消；内层任务若自己收到取消仍然终止。不报：内层任务不响应 `CancelledError`，且已文档声明
- `threading.Lock` 未用 `with`，异常路径上锁不释放，其他线程永久阻塞。不报：锁的获取与释放之间无异常路径，或已用 `with` 保证释放
- `+=`、`check-then-act`（`if k not in d: d[k] = v`）在**带 GIL 的默认构建**下仍是复合操作，线程可在字节码之间插入（无 GIL 的构建不适用这条前提，但共享可变状态照样要同步）。**`dict.setdefault` 不在这里**：3.13 `dis` 显示它是单条 `CALL`，查与插在 C 层一次完成，没有"查到不存在、还没插"的字节码间隙——它是这类的替代写法。（仅当 key 的 `__hash__`/`__eq__` 本身是 Python 代码时才又露出窗口。）不报：操作对象只在单线程内可见，或已用锁保护，或已改用 `setdefault`/`Counter` 这类把查与插收进一次调用的写法
- `threading.Event.wait` 与 `Condition.wait` 的丢失唤醒：条件未在持锁状态下检查或通知。不报：等待与通知均在同一把锁下进行，且条件在循环中复检

## 类型与相等

- `is` 对小整数（`-5..256`）和部分短字符串走缓存，相同字面量在不同位置可能 `is` 为真或为假（3.13 实测：小整数与拼接串为真、`int('257') is int('257')` 为假）。不报：比较的是 `None`、`True`、`False` 等单例
- `bool` 是 `int` 的子类，`True == 1`、`isinstance(True, int)` 为真，用 `isinstance(x, int)` 过滤时布尔值也被接收。不报：已显式排除 `bool`（`type(x) is int` 或 `not isinstance(x, bool)`）
- `float('nan')` 与自身不相等、`nan in [nan]` 为假，`x != x` 是惯用法但要求读者知道 IEEE 754 的 NaN 不自等。不报：已用 `math.isnan(x)`
- 大整数 `a / b` 返回 `float`，超 53 位尾数丢精度；该用 `a // b` 或 `Fraction`。不报：两侧都是源码常量，且结果不用于相等判断或金额
- `round` 是银行家舍入（3.13 实测：0.5→0、1.5→2、2.5→2），与数学教材的"四舍五入"不同。不报：已使用 `Decimal.quantize` 或显式加 `0.5`
- 从 JSON/环境变量读入的"数字"常是 `str`：`'5' < 10` 抛 `TypeError`（3.13 实测），`'a' + b'a'` 同理。不报：类型已在读取边界处显式转换

## 资源与上下文

- `open()` 不指定 `encoding` 时用 `locale.getpreferredencoding()`：**默认编码随环境变**（3.13.1 实测 `cp936`；Linux 通常 UTF-8、Windows 是 GBK/CP1252）。不报：已显式传入 `encoding='utf-8'`
- `with` 的 `__exit__` 返回真值吞掉块内异常，调用方以为成功。不报：`__exit__` 返回 `False`/`None`，或吞异常是有意的
- `__enter__` 抛异常时 `__exit__` 不被调用，已获取的部分资源无人释放。不报：`__enter__` 实现中不获取资源，或将资源获取放在 `__init__` 并由调用方负责清理
- 依赖 GC 关闭文件/连接：CPython 引用计数会在变量超出作用域时立即关闭，但 PyPy 等实现可能延迟，跨解释器运行时资源泄漏。不报：已显式 `with`/`try/finally` 关闭，不依赖 GC

## 字符串与编码

- `str.encode`/`bytes.decode` 未指定 `errors` 时默认 `'strict'`，遇非法序列抛 `UnicodeDecodeError`；要丢弃或替换须显式传 `errors=`。不报：输入已保证可解码，或接受抛错
- 源码文件未声明编码，Python 3 默认 UTF-8，但含 BOM 时 `utf-8-sig` 与 `utf-8` 解码结果首字符不同。不报：文件不含 BOM，或读取时已显式选用 `utf-8-sig`
- 注解只在静态检查里有形状：`TypedDict` 运行期就是个 dict——字段拼错、类型不符、字段缺失全不报；`@runtime_checkable` 的 `Protocol` 只查**属性存在**、不查签名（3.13 实测：签名完全不符也 `isinstance` 为真）。**注解默认立即求值**（3.13.1 实测：前向引用未定义时 `def` 当场抛 `NameError`），`__annotations__` 存的是**注解对象本身**（实测是 `type`，不是 `str`）——**写成字符串或开 `from __future__ import annotations` 才是字符串**。不报：注解只给静态检查器看

## 构建开关与校验

- `python -O` / `-OO` / `PYTHONOPTIMIZE` 下 `assert` 被整条剥离、`__debug__` 为假，`if __debug__:` 块一并消失——发布构建里少的那道校验不会报错。不报：生产校验走显式分支

## 导入与模块

- 模块顶层代码有副作用（写文件、发请求、启动线程），`import` 即触发——测试与打包工具都会执行到。不报：顶层代码只做定义和常量赋值
- 循环导入：模块 A 顶层 `import B`，B 顶层 `import A`，导入顺序决定哪一方的名字未定义，表现为 `AttributeError` 或部分初始化的模块。不报：循环导入中的引用位于函数体内而非模块顶层
- `from module import *` 污染导入方命名空间，且 `__all__` 未定义时导入所有非下划线名。不报：被导入模块已显式定义 `__all__`，且导入方在受控作用域内使用
- `if __name__ == '__main__'` 缺失时，模块被 `import` 会执行主逻辑。不报：模块只被当作脚本运行，不做导入入口
- 相对导入 `from . import x` 只在包内有效，脚本直接运行时 `__package__` 为空，抛 `ImportError`。不报：模块只通过包导入方式加载，不直接执行

## 官方契约的常咬点（不保证覆盖）

语言与标准库**契约**层面的咬人处——形态见 `references/lang/method.md` 的「官方契约那一层」。**每条都是 Python 3.13.1 本机实测**（`python -V` 复查）；这里没写的当场查原文。

- **`str.split()` 不带参数与带 `' '` 是两回事**（实测：`'a  b '.split()` 得 `['a','b']`，而 `split(' ')` 得 `['a','','b','']`）——按分隔符解析却漏传参数，会多出空字段（CSV 式的定长解析尤其）。不报：输入已保证没有连续分隔符与首尾分隔符
- **`json.dumps` 默认 `ensure_ascii=True`**（实测：`'中文'` 序列化成 `"\u4e2d\u6587"`）——要给人看或要做体积对比时，得显式 `ensure_ascii=False`。不报：输出只给机器读，或已接受转义
- **`datetime.utcnow()` 返回的是 naive 时间**（实测 `tzinfo` 是 `None`；3.13.1 上它已带 `DeprecationWarning`，提示改用 `datetime.now(datetime.UTC)`）——naive 与 aware 相减抛 `TypeError`，本地时间和 UTC 也可能被当成同一串数字。不报：该值只在本进程内排序、不跨时区
- **文本模式写文件会转换换行**（实测：Windows 上写 `'a\nb\n'`，文件里是 `b'a\r\nb\r\n'`；传 `newline=''` 才是 `b'a\nb\n'`）——按字节算长度、做校验和、与外部约定比对都会差。不报：文件只在本平台内读写，或已用二进制模式

## 报告

本件只给清单，不含报告契约——**档位与报告形态以 `references/contract.md` 为准**。本件条目多且机械，**命中多不等于分量重**。
