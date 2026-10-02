#!/usr/bin/env bash
# ./bump-version.sh 0.1.1 --notes "更新说明"
# scripts/bump-version.js 校验并更新 main 上的版本文件；提交、Tag 和推送在这里直接用 git 完成。
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$script_dir"
fail() { echo "$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "Error: install Node.js 22 or newer to use bump-version."
command -v git >/dev/null 2>&1 || fail "Error: install Git to use bump-version."
common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
    fail "Version preparation requires a Git worktree checked out on main. No version files were changed."

# 与其他会话更新 main 共用同一把仓库级锁（原子创建目录），覆盖版本修改、提交、Tag 和推送。
lock="$common/disklanded-main-merge.lock"
locked=0
for _ in {1..100}; do
    if mkdir -- "$lock" 2>/dev/null; then locked=1; break; fi
    sleep 0.1
done
[ "$locked" = 1 ] || fail "main merge lock is occupied; retry after the other session finishes."
release_lock() { rm -f -- "$lock/owner.json"; rmdir -- "$lock"; }
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '{"pid":%d,"session":"bump-version","branch":"main","time":"%s"}\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$lock/owner.json"

plan="$(node scripts/bump-version.js "$@")"
root='' version='' commit=0 create_tag=0 push=0 push_tag=0
while IFS= read -r line; do
    value="${line#*=}"
    case "${line%%=*}" in
        root) root="$value" ;;
        version) version="$value" ;;
        commit) commit="$value" ;;
        create_tag) create_tag="$value" ;;
        push) push="$value" ;;
        push_tag) push_tag="$value" ;;
    esac
done <<<"$plan"
[ -n "$root" ] && [ -n "$version" ] || fail "bump-version.js returned an incomplete plan."
tag="v$version"

if [ "$commit" = 1 ]; then
    [ "$(git -C "$root" branch --show-current)" = main ] ||
        fail "The main worktree changed branches. Changes were kept in $root; check out main there, then rerun: ./bump-version.sh $version --resume"
    # --only 只提交版本文件，保留其他路径的暂存内容。
    git -C "$root" commit --only -m "chore: bump version to $version" -- VERSION CHANGELOG.md ||
        fail "Version files were updated on main, but the commit failed. Changes were kept in $root. Fix the reported Git error, then rerun: ./bump-version.sh $version --resume"
fi

if [ "$create_tag" = 1 ]; then
    head="$(git -C "$root" rev-parse main)"
    git -C "$root" tag -a "$tag" "$head" -m "Release $version" ||
        fail "Version commit $head was kept, but creating tag $tag failed. Fix the reported Git error and rerun the same version. Existing tags are never overwritten."
    echo "Created annotated tag $tag at $head."
fi

if [ "$push" = 1 ]; then
    refs=(refs/heads/main:refs/heads/main)
    [ "$push_tag" = 1 ] && refs+=("refs/tags/$tag:refs/tags/$tag")
    # --atomic：main 与 Tag 要么一起推送成功，要么都不更新远端。
    git -C "$root" push --atomic origin "${refs[@]}" ||
        fail "The local version commit and tag were kept, but pushing to origin failed. Fix the reported Git error (for example, merge origin/main into main), then rerun: ./bump-version.sh $version"
    echo "Pushed main$([ "$push_tag" = 1 ] && echo " and $tag") to origin."
fi
