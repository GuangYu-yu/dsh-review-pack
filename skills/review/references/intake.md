**没有现成的改动可审、要自己把输入取出来时**读本件。取到之后**按入口件的分发表选对象件**；每条结论要交代到什么程度，按 `references/contract.md`。

- **未提交的更改**：先 `git --no-pager diff HEAD --stat` 看规模（已 `git add` 的改动不在裸 `git diff` 里，`HEAD` 才看得全），再决定整读还是按同口径分片 `git --no-pager diff HEAD -- <path>`。只看 diff 会漏掉**未跟踪的新文件**——先 `git status --porcelain` 补齐，它们不在 `git diff` 里。
- **已提交的范围**：`git --no-pager diff <base>..<head>`，同样先 `--stat`。
- **拿不到 shell 时**：不要假装取过。直接向用户索取 diff（或让他把输出贴过来），并说明你只看到了这一部分——未跟踪文件、被跳过的路径，都算没看到。
- **以 diff 为对象可以省下大量上下文，代价是看不到改动周围的全貌。** 任何结论依赖"这段代码之外还有别的东西"时，停下来去追那块上下文，再回来定性。
