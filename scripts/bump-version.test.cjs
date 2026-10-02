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
function fixture(t, repository = true, changelog = '# Changelog\n\n## [Unreleased]\n\n## [0.1] - 2026-09-01\n\n- Initial.\n') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'disklanded bump 中文 '));
  t.after(() => removeFixture(base));
  const root = path.join(base, 'repo 中文');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const file of ['bump-version.js', 'version.js']) fs.copyFileSync(path.join(__dirname, file), path.join(root, 'scripts', file));
  fs.copyFileSync(path.join(__dirname, '../bump-version.sh'), path.join(root, 'bump-version.sh'));
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
  fs.writeFileSync(path.join(root, '.gitignore'), '.worktrees/\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'original\n');
  if (repository) {
    git(root, '-c', 'init.defaultBranch=main', 'init');
    configure(root);
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'Initial fixture');
    // 本地裸仓库充当 origin，验证脚本推送 main 与版本 Tag。
    git(base, '-c', 'init.defaultBranch=main', 'init', '--bare', 'origin.git');
    git(root, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
    git(root, 'push', '-q', 'origin', 'main');
  }
  return root;
}
function configure(root) {
  git(root, 'config', 'user.name', 'Version Test');
  git(root, 'config', 'user.email', 'version-test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'tag.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
}
function origin(root) { return path.join(path.dirname(root), 'origin.git'); }
function remoteRef(root, ref) {
  const result = command('git', ['rev-parse', '-q', '--verify', ref], origin(root));
  return result.status === 0 ? result.stdout.trim() : '';
}
// 提交、Tag 和推送由入口脚本完成，因此端到端行为都经过 bump-version.sh。
function bump(root, version, ...options) {
  return command('bash', [path.join(root, 'bump-version.sh'), version, '--date', '2026-10-02', ...options], root);
}
function prepare(root, version, ...options) {
  return command(process.execPath, [path.join(root, 'scripts/bump-version.js'), version, '--date', '2026-10-02', ...options], root);
}
function success(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }
function snapshot(root) { return ['VERSION', 'CHANGELOG.md'].map(file => fs.readFileSync(path.join(root, file), 'utf8')); }

test('first release succeeds through the shell entry point with one final newline and multiline notes', t => {
  for (const changelog of ['# 更新记录\n\n## [Unreleased]\n\n- 初始说明。\n', '# 更新记录\n']) {
    const root = fixture(t, true, changelog);
    success(command('bash', [path.join(root, 'bump-version.sh'), '0.1.1', '--notes', '中文说明  \r\n\r\n第二段  '], os.tmpdir()));
    const content = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.match(content, /## \[0\.1\.1\]/);
    assert.equal(content, content.trimEnd() + '\n');
    git(root, 'show', '--format=', '--check', 'HEAD');
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(git(root, 'rev-parse', 'v0.1.1^{commit}'), git(root, 'rev-parse', 'main'));
    assert.equal(remoteRef(root, 'refs/heads/main'), git(root, 'rev-parse', 'main'));
    assert.equal(remoteRef(root, 'refs/tags/v0.1.1'), git(root, 'rev-parse', 'refs/tags/v0.1.1'));
    const head = git(root, 'rev-parse', 'main');
    success(bump(root, '0.1.1'));
    assert.equal(git(root, 'rev-parse', 'main'), head);
  }
});

test('--resume repairs the old first-release EOF failure and preserves staged unrelated work', t => {
  const root = fixture(t, true, '# 更新记录\n\n## [Unreleased]\n\n- 初始说明。\n');
  const original = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1.1\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), original + '\n## [0.1.1] - 2026-10-02\n\n### Changed\n\n- Build Test\n\n');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated staged work\n');
  git(root, 'add', 'unrelated.txt', 'VERSION', 'CHANGELOG.md');
  const head = git(root, 'rev-parse', 'main');
  const pending = snapshot(root);
  const staged = git(root, 'diff', '--cached', '--binary', '--', 'unrelated.txt');
  assert.match(bump(root, '0.1.1').stderr, /--resume/);
  assert.deepEqual(snapshot(root), pending);
  success(bump(root, '0.1.1', '--resume'));
  assert.notEqual(git(root, 'rev-parse', 'main'), head);
  assert.equal(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), pending[1].trimEnd() + '\n');
  assert.equal(git(root, 'diff', '--cached', '--binary', '--', 'unrelated.txt'), staged);
  assert.equal(git(root, 'rev-parse', 'v0.1.1^{commit}'), git(root, 'rev-parse', 'main'));
  git(root, 'show', '--format=', '--check', 'HEAD');
});

test('--resume rejects mismatched versions, missing entries, downgrades and conflicting options before writes', t => {
  const root = fixture(t);
  for (const [version, content, args] of [
    ['0.1', '## [0.1.1] - 2026-10-02\n', []],
    ['0.1.1', '# No version entry\n', []],
    ['0.0.1', '## [0.0.1] - 2026-10-02\n', []],
    ['0.1.1', '## [0.1.1] - 2026-10-02\n', ['--no-commit']],
    ['0.1.1', '## [0.1.1] - 2026-10-02\n', ['--notes', 'replace notes']],
  ]) {
    fs.writeFileSync(path.join(root, 'VERSION'), version + '\n');
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), content);
    const before = snapshot(root);
    assert.equal(bump(root, version === '0.1' ? '0.1.1' : version, '--resume', ...args).status, 1);
    assert.deepEqual(snapshot(root), before);
    assert.equal(git(root, 'tag', '--list'), '');
  }
});

test('formatting failures report Git stdout and can be resumed after the reported line is fixed', t => {
  const root = fixture(t);
  success(bump(root, '0.1.1', '--no-commit'));
  const file = path.join(root, 'CHANGELOG.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Release 0.1.1.', 'Release 0.1.1.  '));
  git(root, 'add', 'VERSION', 'CHANGELOG.md');
  const head = git(root, 'rev-parse', 'main');
  const result = bump(root, '0.1.1', '--resume');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /validation failed before commit/);
  assert.match(result.stderr, /CHANGELOG.md:\d+: trailing whitespace/);
  assert.doesNotMatch(result.stderr, /identity\/signing/);
  assert.equal(git(root, 'rev-parse', 'main'), head);
  assert.equal(git(root, 'tag', '--list'), '');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Release 0.1.1.  ', 'Release 0.1.1.'));
  success(bump(root, '0.1.1', '--resume'));
});

test('--resume never commits edits to an already tagged version', t => {
  const root = fixture(t);
  success(bump(root, '0.1.1'));
  const head = git(root, 'rev-parse', 'main'), tag = git(root, 'rev-parse', 'v0.1.1');
  const file = path.join(root, 'CHANGELOG.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n- Pending notes.\n');
  const before = snapshot(root);
  assert.equal(bump(root, '0.1.1', '--resume').status, 1);
  assert.deepEqual(snapshot(root), before);
  assert.equal(git(root, 'rev-parse', 'main'), head);
  assert.equal(git(root, 'rev-parse', 'v0.1.1'), tag);
});

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
  assert.equal(remoteRef(root, 'refs/heads/main'), head);
  assert.equal(remoteRef(root, 'refs/tags/v0.2'), '');
  success(bump(root, '0.2'));
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'rev-parse', 'v0.2^{commit}'), head);
  assert.equal(remoteRef(root, 'refs/tags/v0.2'), git(root, 'rev-parse', 'refs/tags/v0.2'));
});

test('--no-commit only updates main files and rejects source archives without Git', t => {
  const root = fixture(t), head = git(root, 'rev-parse', 'HEAD');
  success(bump(root, '0.1.1', '--no-commit'));
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '0.1.1\n');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'tag', '--list'), '');
  assert.equal(remoteRef(root, 'refs/heads/main'), head);
  const archive = fixture(t, false), before = snapshot(archive);
  assert.equal(bump(archive, '0.2').status, 1);
  assert.deepEqual(snapshot(archive), before);
  assert.equal(bump(archive, '0.2', '--no-commit').status, 1);
  assert.deepEqual(snapshot(archive), before);
  assert.equal(prepare(archive, '0.2', '--no-commit').status, 1);
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
  git(root, 'config', 'user.name', 'Version Test');
  success(bump(root, '0.1.1', '--resume'));
  assert.equal(git(root, 'rev-parse', 'v0.1.1^{commit}'), git(root, 'rev-parse', 'main'));
  assert.equal(git(root, 'diff', '--cached', '--binary'), staged);
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

test('the plan on stdout drives the entry script; messages stay on stderr', t => {
  const root = fixture(t);
  const result = prepare(root, '0.1.1', '--no-push');
  success(result);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `root=${fs.realpathSync(root)}`, 'version=0.1.1', 'commit=1', 'create_tag=1', 'push=0', 'push_tag=0',
  ]);
  assert.match(result.stderr, /Updated VERSION 0\.1 -> 0\.1\.1/);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'Initial fixture');
  assert.equal(git(root, 'tag', '--list'), '');
});

test('--no-push commits and tags locally; a later run pushes main and the tag together', t => {
  const root = fixture(t), remoteHead = remoteRef(root, 'refs/heads/main');
  success(bump(root, '0.1.1', '--no-push'));
  assert.equal(git(root, 'rev-parse', 'v0.1.1^{commit}'), git(root, 'rev-parse', 'main'));
  assert.equal(remoteRef(root, 'refs/heads/main'), remoteHead);
  assert.equal(remoteRef(root, 'refs/tags/v0.1.1'), '');
  const head = git(root, 'rev-parse', 'main');
  success(bump(root, '0.1.1'));
  assert.equal(git(root, 'rev-parse', 'main'), head);
  assert.equal(remoteRef(root, 'refs/heads/main'), head);
  assert.equal(remoteRef(root, 'refs/tags/v0.1.1'), git(root, 'rev-parse', 'refs/tags/v0.1.1'));
});

test('a rejected push keeps the local commit and tag, updates nothing remotely, and can be retried', t => {
  const root = fixture(t);
  const other = path.join(path.dirname(root), 'other clone');
  git(path.dirname(root), 'clone', '-q', origin(root), other);
  configure(other);
  fs.writeFileSync(path.join(other, 'unrelated.txt'), 'remote change\n');
  git(other, 'commit', '-qam', 'Remote change');
  git(other, 'push', '-q', 'origin', 'main');
  const remoteHead = remoteRef(root, 'refs/heads/main');

  const result = bump(root, '0.1.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /commit and tag were kept, but pushing to origin failed/);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore: bump version to 0.1.1');
  assert.equal(git(root, 'rev-parse', 'v0.1.1^{commit}'), git(root, 'rev-parse', 'main'));
  assert.equal(remoteRef(root, 'refs/heads/main'), remoteHead);
  assert.equal(remoteRef(root, 'refs/tags/v0.1.1'), '');
  assert.equal(fs.existsSync(path.join(root, '.git/disklanded-main-merge.lock')), false);

  git(root, 'pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main');
  success(bump(root, '0.1.1'));
  assert.equal(remoteRef(root, 'refs/heads/main'), git(root, 'rev-parse', 'main'));
  assert.equal(remoteRef(root, 'refs/tags/v0.1.1'), git(root, 'rev-parse', 'refs/tags/v0.1.1'));
});

test('an occupied main merge lock stops before any version change', { timeout: 60000 }, t => {
  const root = fixture(t), before = snapshot(root), head = git(root, 'rev-parse', 'main');
  const lock = path.join(root, '.git/disklanded-main-merge.lock');
  fs.mkdirSync(lock);
  const result = bump(root, '0.1.1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lock is occupied/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(git(root, 'rev-parse', 'main'), head);
  assert.equal(fs.existsSync(lock), true);
  fs.rmdirSync(lock);
});
