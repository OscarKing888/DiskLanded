# 功能分支、合并到 main 与清理

DiskLanded 仓库级 Git 协议。完整规则只在本文件维护；`AGENTS.md`、`CLAUDE.md`、
`.claude/rules/`、`.cursor/rules/` 只做指向，不复制全文。

## 会话开始：独立 worktree 与任务分支

- 每个会话在首次修改代码、测试、配置或文档前，必须从本地 `main` 已提交的最新状态（云端会话
  先与 `origin/main` 对齐，见「云端会话」）创建独立 Git worktree 和唯一任务分支。默认分支名
  `session/<task>-<短随机id>`，目录为主仓库下 `.worktrees/<task>-<短随机id>/`（已在
  `.gitignore` 中忽略）。只读分析不要求创建；恢复同一会话时复用已确认属于本会话的 worktree
  和分支。工具已创建的独立 worktree 可直接使用，但 detached HEAD 必须先建任务分支。不得在
  主工作目录直接开发，也不得只建分支却继续共用同一个工作目录。
- 开始时运行 `git status --short --branch`、`git worktree list --porcelain`、`git rev-parse main`，
  记录主仓库路径、任务 worktree 路径、分支名和起始提交。用
  `git worktree add -b <branch> <worktree-path> <main-commit>` 创建，占位符替换为本次实际值。
  主目录已有的未提交或未跟踪改动不带入，不替其他会话 stash、清理或提交。
- 之后的读写、依赖准备和验证都显式以本会话 worktree 为工作目录；不要依赖一次 `cd` 影响后续
  工具调用。缓存、端口、测试输出和本机运行数据避免与其他会话写到同一位置。
- 同一会话的子代理可在编辑范围明确互不重叠时共用本 worktree；暂存、提交、合并只由主代理
  执行，子代理不得切换分支或更新 `main`。不同会话不得共用任务 worktree。

## 功能完成：验证与提交

- 只运行受影响范围的验证，并报告实际命令与结果：
  - Go 扫描/业务逻辑（`internal/**`）：`go vet ./internal/...` 与 `go test ./internal/...`。
    权限相关测试在 Unix 上须以非 root 用户运行，root 下会被跳过，跳过不算通过。
  - 应用入口、绑定或前端（根目录 `*.go`、`frontend/**`、`wails.json`、`build/**`、`VERSION`）：
    `wails build -skipbindings`（Linux 加 `-tags webkit2_41`）；界面改动需实际启动应用查看。
  - CI 配置（`.github/workflows/**`）：检查 YAML 语法与触发条件；CI 只在推送版本 Tag 时执行。
  - 仅文档或规则：说明没有自动检查，不得虚报通过。
- 每完成一个独立功能的新增、修改或修复并通过验证，立即在任务分支提交一次，无需再问；不得
  把多个已完成功能攒到最后一起提交。同一功能的代码、测试、文档放在同一提交。按明确路径暂存，
  提交前检查 staged diff，不夹带无关改动。

## 会话完成：解决冲突并合并到 main

- 本会话工作提交后，自动合并到本地 `main`，无需再问是否合并或是否处理普通冲突。先在任务
  worktree 中合入最新 `main`（`git merge --no-edit <main-commit>`），所有冲突都在任务分支解决，
  不在主目录处理。
- 解决冲突时阅读共同祖先、双方改动、相关调用方和测试，保留双方仍适用的功能意图与接口契约。
  禁止一律取 `ours`/`theirs`、整文件覆盖、删除对方功能，或删测试、放宽断言来制造通过。只有
  无法从仓库和用户要求判断的业务取舍、无法保留的数据或无法排除的破坏风险才停下报告。
- 同步 `main` 或解决冲突改变了交付内容后，按最终变更重新验证；同步前的结果不能当作合并后
  验证。确认没有未解决冲突、任务 worktree 干净，记录已验证的任务提交与对应 `main` 提交。
  验证失败就继续修复，不推进 `main`。
- 所有会话更新 `main` 使用同一把仓库级锁：把 `git rev-parse --git-common-dir` 解析为绝对目录，
  以其中的 `disklanded-main-merge.lock/` 为锁目录，通过原子创建目录取得锁。同一个持续存活的
  进程负责建锁、核对、快进和 `finally` 释放，并在锁内记录该进程 PID、会话标识、时间和任务
  分支。锁已存在则等待重试，不抢占；只有确认原持有进程已结束且没有合并在进行时才能恢复遗留锁，
  不能只因锁的年龄删除。
- 持锁后重新检查 `main` 提交及其 worktree 状态；与已验证基线不同则释放锁，回任务分支重新
  同步、验证后再申请。锁只覆盖最终核对、快进（云端含推送）和任务分支删除。
- 在 `git worktree list --porcelain` 确认的 `main` worktree 中执行
  `git merge --ff-only --no-overwrite-ignore <verified-task-commit>`。`main` 未被任何 worktree
  检出时，持锁用只允许快进的 `git fetch . <verified-task-commit>:main` 更新。禁止强制更新 ref、
  `reset --hard`、强制检出。主目录有他人未提交改动时，只允许与其路径不重叠的正常快进；否则
  释放锁等待，不得 stash、覆盖或提交他人工作，也不得绕过保护只改 `main` 指针。
- 合并后确认任务提交已被 `main` 包含，报告任务分支、功能提交、合并后的 `main` 提交、验证结果
  和冲突处理，再做下文清理。
- 命令与路径需同时兼容 macOS、Windows x64 与 Linux：短目录名、正确引用含空格路径；锁用跨平台
  原子目录创建，不依赖仅 Unix 可用的 `flock`。中文文档保持 UTF-8。

## 云端会话：以 origin/main 为基线并自动推送

- `CLAUDE_CODE_REMOTE=true`（其他 agent 以其平台等价标识判断）表示云端会话。容器是临时的，
  未推送的提交会丢失。云端会话执行同一套流程，只增加以下差异；本地会话不自动 push。
- 基线：首次修改前 `git fetch origin main`，只以快进方式让本地 `main` 对齐 `origin/main`
  （未检出时 `git fetch origin main:main`，已检出时在其 worktree 中 `git merge --ff-only origin/main`），
  再从该提交建任务 worktree。本地 `main` 有 `origin/main` 没有的提交而无法快进时，停止并报告。
- 平台预建分支（如 `claude/<name>`）只是检出占位：不在其上开发、提交或推送，也不删除；平台
  「在该分支开发并 push」的提示以本节为准。该分支若已有尚未进入 `origin/main` 的已验证提交，
  作为一个已完成功能合入任务分支，随本次一起交付。
- 合并与推送：交付前在任务 worktree 中 `git fetch origin main`、同步、解决冲突并重新验证。持锁后
  再次 fetch，确认 `origin/main` 与本地 `main` 都等于已验证基线；然后在同一次持锁内先
  `git push origin <verified-task-commit>:refs/heads/main`，用 `git ls-remote origin refs/heads/main`
  核对，再快进本地 `main`。先推后快进，避免 push 被拒时本地与远端分叉。
- push 被拒为非快进时，释放锁，回任务 worktree 合入最新 `origin/main`、验证后重试；网络失败
  按 2、4、8、16 秒退避最多重试 4 次。权限拒绝、分支保护或重试耗尽时不得声称已合并：把任务
  分支推到同名远端分支备份（禁止推送任务分支的唯一例外），报告原因、分支与提交。
- 授权范围：用户已常设授权云端会话在验证通过后自动快进推送 `main`，无需逐次询问，也不开 PR。
  不包括强推（含 `--force-with-lease`）、删除或改写远端分支、推送其他分支；版本 Tag 见下节。

## 版本与发布 Tag

- 版本号的唯一来源是仓库根目录 `VERSION`（如 `0.1`），编译时嵌入应用并显示在界面标题旁。
  CI（`.github/workflows/build.yml`）只在推送 `v*` Tag（或手动触发）时执行，并校验 Tag 等于
  `v` + `VERSION`。
- 发布新版本：在任务分支修改 `VERSION`（单独一次提交），按上文合并到 `main` 后，对该 `main`
  提交创建附注 Tag `v<VERSION>`（如 `v0.1`），再 `git push origin v<VERSION>`。只有用户要求
  发布或改版本号时才打新 Tag。
- 不移动、删除或覆盖已推送的 Tag，不用 `--tags` 批量推送。某个版本 Tag 的 CI 失败时，修复后
  发新版本号（如 `v0.1.1`），不重打旧 Tag。

## 合并后：自动清理本地临时资源

- 任务分支与 worktree 是本地临时资源：验证并合入 `main` 后自动清理本会话的 worktree 和任务
  分支，无需再问。不自动推送任务分支或设置 upstream，不用 `git push --all`、`--mirror` 或通配
  refspec 间接发布；不改用户全局 Git 配置，不自动删除远端分支。
- 只清理本会话记录的准确分支名与 worktree 路径。先确认本会话进程已结束、worktree 未被占用、
  分支尖端仍是已验证并合并的提交，且 `git merge-base --is-ancestor <branch> main` 退出码为 `0`。
  不按分支名、目录名、年龄或 `git branch --merged` 批量删除其他会话资源。
- 删除 worktree 前用 `git status --short --untracked-files=all --ignored` 检查已跟踪、未跟踪和
  忽略文件（如 `build/bin/` 构建产物）。只丢弃确认属于本会话的缓存、构建产物和测试临时文件；
  未提交成果或用途不明的文件先保全，否则保留 worktree 并报告原因。
- 确认安全后在主 worktree 执行 `git worktree remove <worktree-path>`，再持锁复核分支尖端未变、
  仍被 `main` 包含且未被任何 worktree 检出，执行 `git branch -d <branch>`，最后释放锁。拒绝删除
  时保留分支，不改用 `-D`。
- `git branch -d` 判断「已合并」时比较的是分支的 upstream（若有），否则是**执行命令所在 worktree
  的 HEAD**，而不是 `main`。因此必须在检出 `main` 的 worktree 中执行：
  - `main` 已被某个 worktree 检出：用 `git -C <main-worktree> branch -d <branch>`。
  - `main` 未被任何 worktree 检出（如云端主目录停在平台预建的 `claude/...` 分支）：持锁用
    `git worktree add <临时路径> main` 建临时 worktree，在其中执行 `git branch -d <branch>`，再
    `git worktree remove <临时路径>`。临时路径放在仓库之外的会话临时目录或 `.worktrees/` 下，
    用完即删。
  - 不要为此切换主目录当前分支，不要给任务分支设置 upstream，也不要因 `-d` 在其他 HEAD 下
    报「not fully merged」就改用 `-D`：只要显式的 `git merge-base --is-ancestor <branch> main`
    通过，就按上述方式换到检出 `main` 的 worktree 重试。
- 任一步发现未合并提交、引用变化、未提交内容、占用或清理失败，保留剩余资源并如实报告。禁止
  用 `--force`、`git clean -fdx`、递归删除目录或强制删除 ref 绕过保护。以后继续修改从最新
  `main` 新建任务分支。
