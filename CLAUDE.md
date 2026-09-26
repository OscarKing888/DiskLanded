# DiskLanded - Claude 适配

@AGENTS.md

路径规则：`**`（功能 Git 流程）→ `.claude/rules/feature-branch-merge.md`。

- 每次开始或恢复开发任务，先按 `.codex/rules/feature-branch-merge.md` 建立并记录本会话 worktree、
  任务分支和起始提交；不能因改动小、只改文档而省略。
- 云端会话（`CLAUDE_CODE_REMOTE=true`）按该文件「云端会话」一节执行：平台预建的 `claude/...`
  分支不用于开发和推送，完成后持锁快进推送 `origin/main`。
- 交付前完成验证、提交、同步 `main`、解决冲突、重新验证、合并和清理；最终回复报告任务分支、
  功能提交、合并后的 `main`（云端另报 `origin/main`）、验证、冲突与清理结果。

完整 Git 协议只在 `.codex/rules/feature-branch-merge.md` 维护。
