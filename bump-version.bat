:: .\bump-version.bat 0.1.1 --notes "更新说明"
:: scripts/bump-version.js 校验并更新 main 上的版本文件；提交、Tag 和推送在这里直接用 git 完成。

@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
set "BUMP_STATUS=1"
where node >nul 2>&1
if errorlevel 1 (
    echo Error: install Node.js 22 or newer to use bump-version. 1>&2
    exit /b 1
)
where git >nul 2>&1
if errorlevel 1 (
    echo Error: install Git to use bump-version. 1>&2
    exit /b 1
)

:: 读取 UTF-8 的路径和执行计划时临时切到代码页 65001，结束时恢复。
set "BUMP_OLDCP="
for /f "tokens=*" %%C in ('chcp') do for %%N in (%%C) do set "BUMP_OLDCP=%%N"
if defined BUMP_OLDCP set "BUMP_OLDCP=%BUMP_OLDCP:.=%"
chcp 65001 >nul

set "BUMP_COMMON="
for /f "usebackq delims=" %%D in (`git rev-parse --path-format^=absolute --git-common-dir 2^>nul`) do set "BUMP_COMMON=%%D"
if not defined BUMP_COMMON (
    echo Version preparation requires a Git worktree checked out on main. No version files were changed. 1>&2
    goto :restore
)
set "BUMP_COMMON=%BUMP_COMMON:/=\%"

:: 与其他会话更新 main 共用同一把仓库级锁（原子创建目录），覆盖版本修改、提交、Tag 和推送。
set "BUMP_LOCK=%BUMP_COMMON%\disklanded-main-merge.lock"
set /a BUMP_TRIES=0
:lock
mkdir "%BUMP_LOCK%" 2>nul && goto :locked
set /a BUMP_TRIES+=1
if %BUMP_TRIES% geq 10 (
    echo main merge lock is occupied; retry after the other session finishes. 1>&2
    goto :restore
)
ping -n 2 127.0.0.1 >nul
goto :lock
:locked
> "%BUMP_LOCK%\owner.json" echo {"session":"bump-version","branch":"main","time":"%DATE% %TIME%"}

set "BUMP_PLAN=%BUMP_LOCK%\plan.txt"
node scripts/bump-version.js %* > "%BUMP_PLAN%"
if errorlevel 1 goto :unlock
for %%K in (root version commit create_tag push push_tag) do set "BUMP_%%K="
for /f "usebackq tokens=1,* delims==" %%A in ("%BUMP_PLAN%") do set "BUMP_%%A=%%B"
if not defined BUMP_root goto :bad_plan
if not defined BUMP_version goto :bad_plan
set "BUMP_TAG=v%BUMP_version%"

if not "%BUMP_commit%"=="1" goto :tag
set "BUMP_BRANCH="
for /f "usebackq delims=" %%B in (`git -C "%BUMP_root%" branch --show-current`) do set "BUMP_BRANCH=%%B"
if not "%BUMP_BRANCH%"=="main" goto :branch_changed
:: --only 只提交版本文件，保留其他路径的暂存内容。
git -C "%BUMP_root%" commit --only -m "chore: bump version to %BUMP_version%" -- VERSION CHANGELOG.md
if errorlevel 1 goto :commit_failed

:tag
if not "%BUMP_create_tag%"=="1" goto :push
set "BUMP_HEAD="
for /f "usebackq delims=" %%H in (`git -C "%BUMP_root%" rev-parse main`) do set "BUMP_HEAD=%%H"
if not defined BUMP_HEAD goto :tag_failed
git -C "%BUMP_root%" tag -a "%BUMP_TAG%" %BUMP_HEAD% -m "Release %BUMP_version%"
if errorlevel 1 goto :tag_failed
echo Created annotated tag %BUMP_TAG% at %BUMP_HEAD%.

:push
if not "%BUMP_push%"=="1" goto :success
set "BUMP_REFS=refs/heads/main:refs/heads/main"
if "%BUMP_push_tag%"=="1" set "BUMP_REFS=%BUMP_REFS% refs/tags/%BUMP_TAG%:refs/tags/%BUMP_TAG%"
:: --atomic：main 与 Tag 要么一起推送成功，要么都不更新远端。
git -C "%BUMP_root%" push --atomic origin %BUMP_REFS%
if errorlevel 1 goto :push_failed
if "%BUMP_push_tag%"=="1" (echo Pushed main and %BUMP_TAG% to origin.) else echo Pushed main to origin.

:success
set "BUMP_STATUS=0"
goto :unlock

:bad_plan
echo bump-version.js returned an incomplete plan. 1>&2
goto :unlock

:branch_changed
echo The main worktree changed branches. Changes were kept in "%BUMP_root%"; check out main there, then rerun: bump-version.bat %BUMP_version% --resume 1>&2
goto :unlock

:commit_failed
echo Version files were updated on main, but the commit failed. Changes were kept in "%BUMP_root%". Fix the reported Git error, then rerun: bump-version.bat %BUMP_version% --resume 1>&2
goto :unlock

:tag_failed
echo Version commit %BUMP_HEAD% was kept, but creating tag %BUMP_TAG% failed. Fix the reported Git error and rerun the same version. Existing tags are never overwritten. 1>&2
goto :unlock

:push_failed
echo The local version commit and tag were kept, but pushing to origin failed. Fix the reported Git error, for example merge origin/main into main, then rerun: bump-version.bat %BUMP_version% 1>&2
goto :unlock

:unlock
del /q "%BUMP_PLAN%" "%BUMP_LOCK%\owner.json" >nul 2>&1
rmdir "%BUMP_LOCK%" 2>nul

:restore
if defined BUMP_OLDCP chcp %BUMP_OLDCP% >nul
exit /b %BUMP_STATUS%
