'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

function removeFixture(root) {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) removeFixture(file);
    else {
      // Git 对象在 Windows 上可能为只读；只调整本测试临时文件的权限。
      if (process.platform === 'win32' && item.isFile()) fs.chmodSync(file, 0o600);
      fs.unlinkSync(file);
    }
  }
  fs.rmdirSync(root);
}

function command(executable, args, cwd) {
  return spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: 30000 });
}
function git(root, ...args) {
  const result = command('git', args, root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function fixture(t, repository = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disklanded bump 中文 '));
  t.after(() => removeFixture(root));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['bump-version.js', 'version.js']) fs.copyFileSync(path.join(__dirname, file), path.join(root, 'scripts', file));
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n## [0.1] - 2026-09-01\n\n- Initial.\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.worktrees/\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'original\n');
  if (repository) {
    git(root, '-c', 'init.defaultBranch=main', 'init');
    git(root, 'config', 'user.name', 'Version Test');
    git(root, 'config', 'user.email', 'version-test@example.invalid');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'config', 'tag.gpgsign', 'false');
    git(root, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Initial fixture');
  }
  return root;
}
function bump(root, version, ...options) {
  return command(process.execPath, [path.join(root, 'scripts/bump-version.js'), version, '--date', '2026-10-02', ...options], root);
}
function success(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }
function snapshot(root) { return ['VERSION', 'CHANGELOG.md'].map(file => fs.readFileSync(path.join(root, file), 'utf8')); }

test('default bump commits directly on main, tags and preserves unrelated staged work', t => {
  const root = fixture(t);
  const hooks = path.join(root, '.git', 'version-test-hooks');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\ngit branch --show-current > "$(git rev-parse --git-common-dir)/bump-branch-observed"\ngit worktree list --porcelain > "$(git rev-parse --git-common-dir)/bump-worktrees-observed"\n', { mode: 0o755 });
  git(root, 'config', 'core.hooksPath', hooks);
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'staged work\n');
  git(root, 'add', 'unrelated.txt');
  const staged = git(root, 'diff', '--cached', '--binary');
  success(bump(root, '0.1.1', '--notes', '中文版本说明', '--notes', 'Windows x64 packaging.'));
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '0.1.1\n');
  assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), /## \[0\.1\.1\] - 2026-10-02[\s\S]*中文版本说明/);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore: bump version to 0.1.1');
  assert.deepEqual(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(), ['CHANGELOG.md', 'VERSION']);
  assert.equal(git(root, 'cat-file', '-t', 'refs/tags/v0.1.1'), 'tag');
  assert.equal(git(root, 'rev-parse', 'v0.1.1^{commit}'), git(root, 'rev-parse', 'main'));
  assert.equal(git(root, 'show', 'HEAD:unrelated.txt'), 'original');
  assert.equal(git(root, 'diff', '--cached', '--binary'), staged);
  assert.equal(fs.readFileSync(path.join(root, '.git/bump-branch-observed'), 'utf8').trim(), 'main');
  assert.equal(fs.readFileSync(path.join(root, '.git/bump-worktrees-observed'), 'utf8').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  assert.equal(git(root, 'branch', '--list', 'session/*'), '');
  assert.equal(git(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  assert.equal(fs.existsSync(path.join(root, '.git/disklanded-main-merge.lock')), false);

  const head = git(root, 'rev-parse', 'HEAD'), tag = git(root, 'rev-parse', 'refs/tags/v0.1.1');
  success(bump(root, '0.1.1'));
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'rev-parse', 'refs/tags/v0.1.1'), tag);
  git(root, 'commit', '-m', 'Unrelated later change');
  success(bump(root, '0.1.1'));
  assert.equal(git(root, 'rev-parse', 'refs/tags/v0.1.1'), tag);
});

test('--no-tag commits; retry adds the missing tag without another commit', t => {
  const root = fixture(t);
  success(bump(root, '0.2', '--no-tag'));
  assert.equal(git(root, 'tag', '--list', 'v0.2'), '');
  const head = git(root, 'rev-parse', 'HEAD');
  success(bump(root, '0.2'));
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'rev-parse', 'v0.2^{commit}'), head);
});

test('--no-commit only updates main files and rejects source archives without Git', t => {
  const root = fixture(t), head = git(root, 'rev-parse', 'HEAD');
  success(bump(root, '0.1.1', '--no-commit'));
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '0.1.1\n');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'tag', '--list'), '');
  const archive = fixture(t, false), before = snapshot(archive);
  assert.equal(bump(archive, '0.2').status, 1);
  assert.deepEqual(snapshot(archive), before);
  assert.equal(bump(archive, '0.2', '--no-commit').status, 1);
  assert.deepEqual(snapshot(archive), before);
});

test('calls from another worktree target main without changing the caller branch or files', t => {
  const root = fixture(t);
  const caller = path.join(root, '.worktrees', 'caller 中文');
  git(root, 'worktree', 'add', '-b', 'feature/caller', caller, 'main');
  fs.writeFileSync(path.join(caller, 'VERSION'), '9.9.9\n');
  fs.writeFileSync(path.join(caller, 'unrelated.txt'), 'caller staged work\n');
  git(caller, 'add', 'unrelated.txt');
  const before = snapshot(caller), staged = git(caller, 'diff', '--cached', '--binary');
  const head = git(caller, 'rev-parse', 'HEAD');
  success(bump(caller, '0.1.1', '--notes', 'Only main changes.'));
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '0.1.1\n');
  assert.equal(git(root, 'rev-parse', 'main'), git(root, 'rev-parse', 'v0.1.1^{commit}'));
  assert.equal(git(caller, 'branch', '--show-current'), 'feature/caller');
  assert.equal(git(caller, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(snapshot(caller), before);
  assert.equal(git(caller, 'diff', '--cached', '--binary'), staged);
  assert.equal(git(root, 'branch', '--list', 'session/*'), '');
  assert.equal(git(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 2);

  const mainHead = git(root, 'rev-parse', 'main');
  success(bump(caller, '0.2', '--no-commit'));
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '0.2\n');
  assert.equal(git(root, 'rev-parse', 'main'), mainHead);
  assert.deepEqual(snapshot(caller), before);
  assert.equal(git(caller, 'diff', '--cached', '--binary'), staged);
  assert.equal(git(root, 'tag', '--list', 'v0.2'), '');
});

test('a missing main checkout stops all modes without switching branches or changing files', t => {
  const root = fixture(t), before = snapshot(root);
  git(root, 'switch', '-c', 'feature/caller');
  const head = git(root, 'rev-parse', 'main');
  for (const options of [[], ['--no-commit'], ['--no-tag']]) {
    const result = bump(root, '0.1.1', ...options);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Check out main/);
    assert.deepEqual(snapshot(root), before);
    assert.equal(git(root, 'branch', '--show-current'), 'feature/caller');
    assert.equal(git(root, 'rev-parse', 'main'), head);
    assert.equal(git(root, 'tag', '--list'), '');
  }
});

test('dirty version files and invalid requests are rejected before writes', t => {
  const root = fixture(t), before = snapshot(root);
  for (const args of [['invalid'], ['0.1.1', '--date', '2026-02-30'], ['0.1.1', '--notes'], ['0.1.1', '--unknown'], ['65536.1'], ['0.0.1']]) {
    assert.equal(bump(root, ...args).status, 1);
    assert.deepEqual(snapshot(root), before);
  }
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.2\n');
  const dirty = snapshot(root);
  assert.equal(bump(root, '0.2').status, 1);
  assert.deepEqual(snapshot(root), dirty);
  git(root, 'add', 'VERSION');
  const staged = git(root, 'diff', '--cached', '--binary');
  assert.equal(bump(root, '0.2').status, 1);
  assert.equal(git(root, 'diff', '--cached', '--binary'), staged);
});

test('existing tags are never overwritten, including with --no-tag', t => {
  const root = fixture(t);
  git(root, 'tag', '-a', 'v0.1.1', '-m', 'Existing unrelated tag');
  const tag = git(root, 'rev-parse', 'refs/tags/v0.1.1'), before = snapshot(root);
  for (const args of [[], ['--no-tag']]) {
    assert.equal(bump(root, '0.1.1', ...args).status, 1);
    assert.deepEqual(snapshot(root), before);
    assert.equal(git(root, 'rev-parse', 'refs/tags/v0.1.1'), tag);
  }
});

test('a commit failure keeps the version edits on main without creating a branch or tag', t => {
  const root = fixture(t), head = git(root, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'staged work\n');
  git(root, 'add', 'unrelated.txt');
  const staged = git(root, 'diff', '--cached', '--binary');
  git(root, 'config', 'user.name', '');
  const result = bump(root, '0.1.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit failed/);
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '0.1.1\n');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'tag', '--list'), '');
  assert.equal(git(root, 'diff', '--cached', '--binary'), staged);
  assert.equal(git(root, 'branch', '--list', 'session/*'), '');
  assert.equal(git(root, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
});

test('tag signing failure keeps the main commit and allows a safe retry', t => {
  const root = fixture(t);
  git(root, 'config', 'tag.gpgsign', 'true');
  git(root, 'config', 'gpg.program', path.join(root, 'missing-gpg'));
  const result = bump(root, '0.1.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit .* was kept, but creating tag/);
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '0.1.1\n');
  assert.equal(git(root, 'branch', '--list', 'session/*'), '');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'config', 'tag.gpgsign', 'false');
  success(bump(root, '0.1.1'));
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'rev-parse', 'v0.1.1^{commit}'), head);
});
