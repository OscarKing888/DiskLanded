# 新占 DiskLanded

跨平台桌面应用（macOS / Windows / Linux），回答两件事：

1. 磁盘空间被哪些目录占着；
2. 哪些大文件是最近才出现在这台机器上的。

Go 负责扫描和业务逻辑，界面用 Wails v2（系统自带 WebView），界面文字为简体中文。扫描只读取元数据，不读取文件内容，不上传、不请求管理员权限。用户可将结果中的单个文件移入系统回收站；不支持永久删除或删除目录。

## 功能

- **结果视图**：默认打开「图形视图」，通过 TAB 切换到「列表视图」，原有大目录、新文件表格和文件删除按钮保留。
  - 图形页参考 DaisyDisk 的环形目录图：彩色扇区表示目录，宽度表示分配占用；悬停与右侧明细联动，点击目录下钻，点击圆心或面包屑返回上层，也可前进、后退。
  - 「目录占用」展示完整扫描层级，不受大目录列表的阈值和 2,000 行上限影响；「新出现的文件」只统计符合大小、日期筛选的文件，筛选条件与列表同步。
  - 小文件、目录元数据与超出显示数量的项目合并为灰色「其他项目」，不将父子目录重复相加；图形总量是扫描目录占用，不包含未扫描的磁盘空间。
  - 点击文件可查看日期、在文件管理器定位或删除，也可从图中扇区或右侧明细拖入「待删除文件」区；加入待删除不会移动文件，点击「移入回收站」后逐个回收。失败的文件保留在待选区，重新扫描清空待选。
- **卷概览**：扫描根所在卷的总容量、已用、可用、占用百分比（十进制 GB，保留一位小数；百分比 = 已用 / 总容量）。
  图形页默认收起详细容量卡片，可点击展开；列表页默认展开。
- **大目录**：按分配大小（实际占用块数）从大到小排列，默认阈值 1 GB，可调。
- **新出现的大文件**：默认单个文件分配大小 ≥ 500 MB、出现日期在最近 60 天内，按出现日期从新到旧排，阈值和天数可调。
  - 出现日期：macOS 用 birth time；Windows 用 creation time；Linux 用 `statx` 的 birth time，读不到时改用修改时间，并在该行标注「修改时间」。
- 分配大小与逻辑大小相差 ≥10% 且 ≥10 MB 时，在该行下方显示逻辑大小；鼠标悬停可看两者的精确字节数。
- 点击路径在文件管理器中显示：macOS `open -R`；Windows 文件用 `explorer /select,`、目录直接打开；Linux 用 `xdg-open` 打开所在目录（目录本身则打开该目录）。
- 文件行末尾提供「删除」按钮：macOS 移入废纸篓，Windows x64 移入回收站，Linux 使用 `gio trash`。
  - 仅支持已扫描的普通文件，扫描中暂停删除；系统回收失败时显示错误，不回退到永久删除。
  - 成功后移除该文件行并刷新文件数量和卷概览；可在系统回收站恢复。目录占用仍是扫描时的快照，需重新扫描更新。

## 扫描规则

- 默认扫描根为当前用户主目录，可添加任意本地目录（输入路径或「浏览…」）。同一文件系统上嵌套的扫描根会合并，避免重复计数。
- 可取消；进行中显示已走过的文件数和当前路径。
- 无权限、被占用、已删除的路径跳过并计数，结束后列出分类计数和前 500 条明细。
- 不跟随符号链接；Windows 上不进入 junction、目录符号链接和卷挂载点。
- 不进入另一块挂载的文件系统（按设备号判断），除非该挂载点本身被选为扫描根。
- 硬链接的文件只计一次（Windows 上只对 ≥1 MB 的文件按文件 ID 去重）。
- 结果包含全部目录的汇总，以及分配大小 ≥1 MB 的文件。因此文件阈值最低 1 MB，调整阈值无需重新扫描。
- 扫描结束后自动将结果压缩缓存到系统用户缓存目录下的 `DiskLanded/last-scan.json.gz`（macOS 为 `~/Library/Caches`，Windows 为 `%LocalAppData%`，Linux 为 `$XDG_CACHE_HOME` 或 `~/.cache`），下次启动自动恢复扫描根、目录、文件和失败明细，并显示原扫描时间。取消扫描的部分结果也会缓存并标注不完整。
  - 缓存仅包含扫描元数据，不包含文件内容。写入完成后才替换旧缓存；缓存缺失时正常启动，损坏或写入失败时显示提示，仍可重新扫描。
  - 文件成功移入回收站后同步更新缓存。恢复的目录占用仍为上次扫描的快照，需重新扫描更新；卷概览在启动时重新读取。
- 扫描不修改时间戳：只做 `fstatat`/`statx`/目录枚举，不打开文件；Linux 以 `O_NOATIME` 打开目录（仅对自己拥有的目录有效）。用户主动删除时由系统回收接口执行移动，不手动设置时间戳。

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

版本号只在根目录 `VERSION` 维护，编译时嵌入，显示在窗口顶部「新占」旁（如 `v0.1`）。
CI 根据它生成安装包的版本元数据，不需要手动同步 `wails.json`。版本支持 `0.1` 或 `0.1.1`
这样的两段、三段数字，每段不超过 65535。

版本制作机制参考 [CodeSearch](https://github.com/OscarKing888/CodeSearch)，bump 脚本需要
Node.js 22 或更新版本及 Git。可从任意分支的 worktree 运行，脚本会定位到同一仓库中检出
`main` 的 worktree；如果没有检出 `main`，会停止并提示先检出，不自动切换调用方分支：

```sh
# macOS / Linux
./bump-version.sh 0.1.1 --notes "本次版本的更新说明"
```

```bat
:: Windows x64，PowerShell 也可运行
.\bump-version.bat 0.1.1 --notes "本次版本的更新说明"
```

脚本直接在 `main` 的 worktree 更新 `VERSION` 和 `CHANGELOG.md`，只提交这两个文件，
然后在该 `main` 提交上创建附注 Tag `v0.1.1`。不创建临时分支或 worktree，所有操作使用
仓库级锁串行执行。它保留调用方的分支和改动，以及 `main` 上无关的暂存或未提交内容；自动
提交时，版本文件有未提交修改会停止。已有 Tag 不会被覆盖。提交失败保留 `main` 上的版本
文件修改，修复 Git 设置后只提交这两个文件；Tag 创建失败保留版本提交，修复后可用同一版本重试。

- `--notes` 可重复使用；`--date YYYY-MM-DD` 指定更新记录日期。
- `--no-tag` 在 `main` 提交版本变更，不创建 Tag。
- `--no-commit` 同样只修改 `main` worktree 的版本文件，不提交或打 Tag；不支持无 Git 仓库的
  源码压缩包。检查并验证后，只提交 `VERSION` 和 `CHANGELOG.md`，再在该 `main` 提交上打 Tag。

脚本不自动推送。检查更新说明并完成本地构建验证后，推送对应版本：

```sh
git push origin main v0.1.1
```

`.github/workflows/build.yml` 只在推送 `v*` Tag 或手动触发时运行。CI 校验 Tag 等于
`v` + `VERSION`，执行脚本和前端测试，再在三种系统上执行 Go 测试、构建及启动检查。
推送 Tag 后自动创建 GitHub Release，附上对应版本的 CHANGELOG、GitHub 生成的更新说明及：

- `DiskLanded-v<版本>-macos-universal.zip`：Intel / Apple Silicon 通用 `.app`。
- `DiskLanded-v<版本>-windows-x64.zip`：Windows x64 `.exe`。
- `DiskLanded-v<版本>-linux-x64.tar.gz`：Linux x64 可执行文件。
- `SHA256SUMS.txt`：三个安装包的 SHA-256 校验值。

手动选择分支运行 Action 时仅生成可下载的构建产物；选择版本 Tag 时也会发布该版本。
已发布的 Tag 不移动或重打；发布修复时使用新版本号。

## 协作流程

每次修改使用独立 worktree 与 `session/*` 分支，验证后自动合并到 `main`，详见
`.codex/rules/feature-branch-merge.md`。

## 测试

```sh
go test ./internal/...                                          # 单元测试
node --test frontend/graph.test.cjs scripts/*.test.cjs             # 图形、版本制作及打包校验（需要 Node.js 22+）
DISKLANDED_HOME_SCAN=1 go test -v -run TestHomeScan ./internal/scan   # 扫描真实主目录
DISKLANDED_GUI=1 go test -v ./internal/reveal                    # 在 Finder / 资源管理器中实际定位文件
```

权限测试在 Unix 上需要以非 root 用户运行。`.github/workflows/build.yml` 在推送版本 Tag 时于三种系统上执行以上测试、构建并启动应用。
