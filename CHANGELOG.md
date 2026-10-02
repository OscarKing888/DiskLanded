# 更新记录

版本号以根目录 `VERSION` 为准。使用 `bump-version.sh` 或 `bump-version.bat` 添加版本说明。

## [Unreleased]

- 「新出现的文件」改为独立的时间线气泡图：横轴为出现日期，圆面积表示大小，颜色区分所在目录；不再与「目录占用」环形图外观相同。
- 修复图形中单击文件无法选中（指针捕获使点击目标变为容器）的问题。
- 环形图改用 DaisyDisk 风格的明亮色环配色：颜色随扇区位置连续渐变，外层更亮，合并项目为深灰。
- 修复 bump version：始终在 main 更新和提交版本，从其他 worktree 调用也不会创建临时分支。
- 增加 macOS 通用应用、Windows x64 和 Linux x64 的自动打包及 GitHub Release。
- 增加跨平台 bump version 脚本，维护版本号、更新记录、版本提交和附注 Tag。

## [0.1.1] - 2026-10-02

### Changed

- Build Test
