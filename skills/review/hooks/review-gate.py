#!/usr/bin/env python3
"""review 门禁 —— 只判「有没有」，不判「好不好」。

它检查的是「AI 有没有按技能做」，不检查「结论对不对」。
判断类的（结论深不深、对不对）不要塞进来：那会让门禁变成第二个评审，而那种监督不可靠。

## 可判定清单（唯一真源：技能文本与门禁脚本都照这一张）

| # | 触发（机械可判） | 判定式 | 不合格的动作 |
|---|---|---|---|
| R1 | 对象是**代码实现或变更集**（文本里出现源码路径/补丁/`diff` 之类） | 报告里必须出现 `references/adversarial.md` | 拦下，或把结论降级为「待查」 |
| R2 | 文本看起来是一份**评审报告**（出现「发现的问题」/「停止审查的依据」） | 必须含「停止审查的依据」这一段 | 同上 |

R1 就是那次真实漏审的复盘产物：技能里已写成**机械规则**（对象是代码/变更集 → `references/adversarial.md` 必载，没有判断）。
门禁只核对**报告里写没写**——因为「脑子里记得读」是看不见的，「报告里写了」才判得了。

## 怎么接（宿主无关）

    # 允许            → 退出码 0，不输出
    # 拦下            → 退出码 2，理由打印在 stderr
    # 用法一：读 stdin 的 JSON（Trae / DSH 这类 hook 常见形态）
    python review-gate.py < payload.json
    # 用法二：直接给文本（没有 hook 时，手工/CI 里也能用）
    python review-gate.py --text report.md
    # 自测（内置正反例，交付前跑一遍）
    python review-gate.py --selftest

**JSON 字段名**：不同宿主的 hook 负载字段名不同。本脚本按下面的顺序找，找不到就当作纯文本处理：
`text` / `content` / `output` / `message` / `response` / `result`。
真要精确适配某个宿主，只改 `extract_text()` 一处。

## 它不是 AI

纯规则匹配，没有模型调用。规则说不清的那一小块（例如「这段文字算不算覆盖表」）**不要**让它判——
要请 AI 就另起一路，而且那份判断**只能提示，不能放行/拦截**。
"""
import json
import re
import sys
from pathlib import Path

# ---- 规则表（与上面那张清单一一对应，改一处就改这里）----
ADVERSARIAL = "references/adversarial.md"

# 什么算「对象是代码实现或变更集」：出现源码文件路径或补丁痕迹
CODE_SIGNAL = re.compile(
    r"""(?x)
      \. ( c | h | cc | cpp | hpp | rs | go | py | js | ts | java | cs | rb | php | swift | kt | dart | zig | sh | ps1 ) \b
    | \bdiff\b | \bpatch\b | ^\+\+\+ | ^--- | ^@@
    """
)

# 什么算「一份评审报告」：技能规定的固定段落名
REPORT_SIGNAL = re.compile(r"发现的问题|停止审查的依据")
REQUIRED_SECTION = "停止审查的依据"


def extract_text(payload) -> str:
    """从宿主传进来的负载里取出「要检查的文本」。

    适配别的宿主时**只改这一个函数**。
    """
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for key in ("text", "content", "output", "message", "response", "result"):
            value = payload.get(key)
            if isinstance(value, str):
                return value
            # 有些宿主把消息放在数组里
            if isinstance(value, list):
                parts = [
                    item.get("text", "") if isinstance(item, dict) else str(item)
                    for item in value
                ]
                if any(parts):
                    return "\n".join(parts)
        # 退一步：把整个负载串起来判，宁可误判也不放过
        return json.dumps(payload, ensure_ascii=False)
    return str(payload)


# 否定词：紧挨着册名出现，说明那是「没读」，不是「读了」——
# 少了这一条，一句「我没读 references/adversarial.md」会被判成合规。
NEGATION = re.compile(r"(没|未|没有|不)\s*(读|加载|看|载入)|not\s+read|without\s+reading", re.I)

# 申诉通道：技能允许「确有不载的理由 → 写进覆盖表 + 结论降级」。
# 门禁必须认这个例外，否则它会把合规的报告也拦下——那就从严格变成过头了。
APPEAL = re.compile(r"覆盖表|不载理由|未载理由|不加载理由")
DOWNGRADE = re.compile(r"待查")


def _claims_read(text: str, needle: str) -> bool:
    """文本里是否**正面**提到过 needle（附近没有否定词）。"""
    for m in re.finditer(re.escape(needle), text):
        window = text[max(0, m.start() - 14): m.end() + 14]
        if not NEGATION.search(window):
            return True
    return False


def check(text: str) -> list:
    """返回问题列表；空列表表示放行。"""
    problems = []

    # R1：对象是代码/变更集 → 必须引用对抗册（除非走了申诉通道）
    if CODE_SIGNAL.search(text) and not _claims_read(text, ADVERSARIAL):
        appealed = bool(APPEAL.search(text) and DOWNGRADE.search(text))
        if not appealed:
            problems.append(
                f"R1：对象看着是代码实现或变更集，但报告里没有正面提到 `{ADVERSARIAL}`。"
                "技能里这条是机械规则（没有判断余地）：该册必载。"
                "确有不载的理由，就写进覆盖表并声明结论最高「待查」——那样门禁会放行。"
            )

    # R2：是评审报告 → 必须有固定段
    if REPORT_SIGNAL.search(text) and REQUIRED_SECTION not in text:
        problems.append(
            f"R2：这像一份评审报告，但缺「{REQUIRED_SECTION}」这一段。"
            "技能要求固定三段，缺段算没做完。"
        )

    return problems


# ---- 自测用例：交付前跑一遍，证明它真的会拦、也不会乱拦 ----
SELFTEST = [
    (
        "代码变更 + 合规报告 → 放行",
        "## 发现的问题\n- `src/disk.rs:42` 写盘前没 fsync。\n"
        "## 决策点\n零散。\n## 停止审查的依据\n读了 references/adversarial.md、references/verification.md。",
        [],
    ),
    (
        "代码变更 + 缺对抗册 → 拦下",
        "## 发现的问题\n- `src/disk.rs:42` 写盘前没 fsync。\n"
        "## 停止审查的依据\n读了 references/diff.md。",
        ["R1"],
    ),
    (
        "纯文档变更 → 不管对抗册",
        "## 发现的问题\n`README.md` 的部署步骤过期。\n"
        "## 停止审查的依据\n读了 references/docs-config.md。",
        [],
    ),
    (
        "像报告但缺第三段 → 拦下",
        "## 发现的问题\n- 无。\n## 决策点\n零散。",
        ["R2"],
    ),
    (
        "写着「没读」对抗册 → 仍拦下（否定检测）",
        "## 发现的问题\n- `src/disk.rs:42` 没 fsync。\n"
        "## 停止审查的依据\n我没读 references/adversarial.md。",
        ["R1"],
    ),
    (
        "有理由 + 降级 → 放行（申诉通道）",
        "## 发现的问题\n- `src/disk.rs:42` 没 fsync。\n"
        "## 停止审查的依据\n读了 references/diff.md。\n"
        "覆盖表：本轮不载 references/adversarial.md，理由是本机没有目标平台工具链、"
        "结论最高只能到待查。",
        [],
    ),
]


def selftest() -> int:
    failed = 0
    for name, text, expect_prefixes in SELFTEST:
        got = check(text)
        got_prefixes = [p[:2] for p in got]
        ok = got_prefixes == expect_prefixes
        print(f"{'ok  ' if ok else 'FAIL'} {name} → {got_prefixes or '[]'}")
        if not ok:
            failed += 1
            print(f"      期望 {expect_prefixes}，实际 {got_prefixes}")
    print(f"\n自测 {len(SELFTEST) - failed}/{len(SELFTEST)} 通过")
    return 1 if failed else 0


def main(argv: list) -> int:
    if "--selftest" in argv:
        return selftest()

    if "--text" in argv:
        path = argv[argv.index("--text") + 1]
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    else:
        raw = sys.stdin.read()
        try:
            text = extract_text(json.loads(raw))
        except Exception:
            text = raw  # 不是 JSON 就当纯文本

    problems = check(text)
    if problems:
        print("门禁未通过：", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)
        return 2  # 拦下
    return 0  # 放行


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
