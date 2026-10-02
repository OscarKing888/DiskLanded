# 新占 DiskLanded

跨平台桌面应用（macOS / Windows / Linux），回答两件事：

1. 磁盘空间被哪些目录占着；
2. 哪些大文件是最近才出现在这台机器上的。

Go 负责扫描和业务逻辑，界面用 Wails v2（系统自带 WebView），界面文字为简体中文。应用只读取元数据，不读取文件内容，不做清理、删除、移动或上传，也不请求管理员权限。

## 功能

- **卷概览**：扫描根所在卷的总容量、已用、可用、占用百分比（十进制 GB，保留一位小数；百分比 = 已用 / 总容量）。
- **大目录**：按分配大小（实际占用块数）从大到小排列，默认阈值 1 GB，可调。
- **新出现的大文件**：默认单个文件分配大小 ≥ 500 MB、出现日期在最近 60 天内，按出现日期从新到旧排，阈值和天数可调。
  - 出现日期：macOS 用 birth time；Windows 用 creation time；Linux 用 `statx` 的 birth time，读不到时改用修改时间，并在该行标注「修改时间」。
- 分配大小与逻辑大小相差 ≥10% 且 ≥10 MB 时，在该行下方显示逻辑大小；鼠标悬停可看两者的精确字节数。
- 点击路径在文件管理器中显示：macOS `open -R`；Windows 文件用 `explorer /select,`、目录直接打开；Linux 用 `xdg-open` 打开所在目录（目录本身则打开该目录）。

## 扫描规则

- 默认扫描根为当前用户主目录，可添加任意本地目录（输入路径或「浏览…」）。同一文件系统上嵌套的扫描根会合并，避免重复计数。
- 可取消；进行中显示已走过的文件数和当前路径。
- 无权限、被占用、已删除的路径跳过并计数，结束后列出分类计数和前 500 条明细。
- 不跟随符号链接；Windows 上不进入 junction、目录符号链接和卷挂载点。
- 不进入另一块挂载的文件系统（按设备号判断），除非该挂载点本身被选为扫描根。
- 硬链接的文件只计一次（Windows 上只对 ≥1 MB 的文件按文件 ID 去重）。
- 结果保存在内存中：全部目录的汇总，以及分配大小 ≥1 MB 的文件。因此文件阈值最低 1 MB，调整阈值无需重新扫描。
- 不修改时间戳：只做 `fstatat`/`statx`/目录枚举，不打开文件；Linux 以 `O_NOATIME` 打开目录（仅对自己拥有的目录有效）。

## 构建

本地构建需要 Go（版本见 `go.mod`），并将 `go` 加入 `PATH`。macOS 还需要 Xcode Command Line
Tools（可用 `xcode-select --install` 安装）；Windows 可使用系统自带的 Windows PowerShell 5.1。

在仓库根目录运行：

```sh
# macOS：Intel / Apple Silicon 通用应用，生成 build/bin/DiskLanded.app
./build-mac.sh
```

```powershell
# Windows x64：生成 build\bin\DiskLanded.exe（PowerShell 或 cmd 均可运行）
.\build-win.cmd
# 也可直接在 PowerShell 中运行
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-win.ps1
```

脚本自动定位仓库目录，支持含空格的路径，也可从其他目录用脚本路径启动。通过 `go run` 使用
`go.mod` 指定版本的 Wails CLI，无需提前安装 CLI；首次运行需要联网下载 Go 依赖，后续复用 Go
缓存。构建失败返回非零退出码。Windows 启动脚本只为本次进程设置执行策略。

如需手动构建（含 Linux），先安装 Wails CLI：

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0

# macOS（生成 build/bin/DiskLanded.app）
wails build -skipbindings -platform darwin/universal
# Windows（生成 build\bin\DiskLanded.exe）
wails build -skipbindings -platform windows/amd64
# Linux（需要 libgtk-3-dev、libwebkit2gtk-4.1-dev；生成 build/bin/DiskLanded）
wails build -skipbindings -tags webkit2_41
```

前端是 `frontend/dist` 下的纯 HTML/CSS/JS，无需 npm。

运行时依赖：Windows 需要 WebView2（Windows 11 和更新过的 Windows 10 自带）；Linux 需要系统的 WebKitGTK 4.1（`libwebkit2gtk-4.1-0`，主流桌面发行版默认安装）。

## 版本与发布

- 版本号只在根目录 `VERSION` 维护（当前 `0.1`），编译时嵌入，显示在窗口顶部「新占」旁（如 `v0.1`）。
- 发布：修改 `VERSION` 并合入 `main` 后，对该提交打附注 Tag `v<VERSION>` 并推送，例如
  `git tag -a v0.1 -m "DiskLanded v0.1" && git push origin v0.1`。
- CI 只在推送 `v*` Tag（或手动触发）时运行：先校验 Tag 与 `VERSION` 一致，再在三种系统上测试、构建、启动，
  产物名为 `DiskLanded-v<版本>-<系统>`。

## 协作流程

每次修改使用独立 worktree 与 `session/*` 分支，验证后自动合并到 `main`，详见
`.codex/rules/feature-branch-merge.md`。

## 测试

```sh
go test ./internal/...                                          # 单元测试
DISKLANDED_HOME_SCAN=1 go test -v -run TestHomeScan ./internal/scan   # 扫描真实主目录
DISKLANDED_GUI=1 go test -v ./internal/reveal                    # 在 Finder / 资源管理器中实际定位文件
```

权限测试在 Unix 上需要以非 root 用户运行。`.github/workflows/build.yml` 在推送版本 Tag 时于三种系统上执行以上测试、构建并启动应用。
