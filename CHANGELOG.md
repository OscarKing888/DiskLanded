# 更新记录

版本号以根目录 `VERSION` 为准。使用 `bump-version.sh` 或 `bump-version.bat` 添加版本说明。

## [Unreleased]

- 修复 bump version：始终在 main 更新和提交版本，从其他 worktree 调用也不会创建临时分支。
- 增加 macOS 通用应用、Windows x64 和 Linux x64 的自动打包及 GitHub Release。
- 增加跨平台 bump version 脚本，维护版本号、更新记录、版本提交和附注 Tag。

## [0.1.1] - 2026-10-02

### Changed

- Build Test
