'use strict';
// Adapted from CodeSearch's scripts/bump-version.js and its shell/batch entry points.
// CodeSearch's MIT copyright and permission notice: CODESEARCH-LICENSE.txt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateVersion, readVersion } = require('./version');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILES = ['VERSION', 'CHANGELOG.md'];

function formatLocalDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseArgs(argv) {
  const args = [...argv];
  const version = args.shift();
  if (!version) throw new Error('Usage: bump-version.sh|bump-version.bat <version> [--date YYYY-MM-DD] [--notes "text"] [--no-tag] [--no-commit]');
  validateVersion(version);
  const options = { version, date: formatLocalDate(new Date()), notes: [], commit: true, tag: true };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--no-commit') options.commit = false;
    else if (flag === '--no-tag') options.tag = false;
    else if (flag === '--date' || flag === '--notes') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
      if (flag === '--date') options.date = value;
      else options.notes.push(value);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date) ||
      !Number.isFinite(Date.parse(options.date + 'T00:00:00Z')) ||
      new Date(options.date + 'T00:00:00Z').toISOString().slice(0, 10) !== options.date) {
    throw new Error(`Invalid date "${options.date}". Expected a real YYYY-MM-DD date.`);
  }
  options.tag = options.commit && options.tag;
  return options;
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function updateFiles(root, options) {
  const versionFile = path.join(root, 'VERSION');
  const changelogFile = path.join(root, 'CHANGELOG.md');
  const current = fs.readFileSync(changelogFile, 'utf8');
  const heading = `## [${options.version}]`;
  let changelog = current;
  if (!current.split(/\r?\n/).some(line => line === heading || line.startsWith(heading + ' - '))) {
    const notes = options.notes.length ? options.notes : [`Release ${options.version}.`];
    const entry = `${heading} - ${options.date}\n\n### Changed\n\n${notes.map(note => '- ' + note.replace(/\r?\n/g, '\n  ')).join('\n')}\n\n`;
    const firstRelease = current.search(/^## \[(?!Unreleased\])/m);
    changelog = firstRelease < 0 ? current.trimEnd() + '\n\n' + entry : current.slice(0, firstRelease) + entry + current.slice(firstRelease);
  }
  // 全部内容校验完成后再写入；版本的唯一来源仍是 VERSION。
  fs.writeFileSync(versionFile, options.version + '\n', 'utf8');
  fs.writeFileSync(changelogFile, changelog, 'utf8');
}

function withLock(common, branch, action) {
  const lock = path.join(common, 'disklanded-main-merge.lock');
  const deadline = Date.now() + 10000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('main merge lock is occupied; retry after the other session finishes.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  const owner = path.join(lock, 'owner.json');
  try {
    fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, session: 'bump-version', branch, time: new Date().toISOString() }), 'utf8');
    return action();
  } finally {
    if (fs.existsSync(owner)) fs.unlinkSync(owner);
    fs.rmdirSync(lock);
  }
}

function tagVersion(version, commit) {
  const tag = `v${version}`;
  try {
    git(['tag', '-a', tag, commit, '-m', `Release ${version}`]);
    console.log(`Created annotated tag ${tag} at ${commit}.`);
  } catch (error) {
    throw new Error(`Version commit ${commit} was kept, but creating tag ${tag} failed: ${error.message}\nFix Git signing/identity and rerun the same version. Existing tags are never overwritten.`);
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const previous = readVersion(ROOT);
  // Parse every input before modifying files, including source-archive mode.
  fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (!options.commit) {
    updateFiles(ROOT, options);
    console.log(`Updated VERSION ${previous} -> ${options.version} and CHANGELOG.md; skipped commit and tag (--no-commit).`);
    return;
  }

  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(fs.realpathSync(git(['rev-parse', '--show-toplevel']))) !== normalize(fs.realpathSync(ROOT))) {
    throw new Error('Run the script from the DiskLanded repository, or use --no-commit for a source archive.');
  }
  if (git(['branch', '--show-current']) !== 'main') {
    throw new Error('Automatic release preparation starts from main. In an existing task worktree, use --no-commit, then follow the repository merge/tag protocol.');
  }
  git(['ls-files', '--error-unmatch', '--', ...VERSION_FILES]);
  if (git(['status', '--porcelain', '--untracked-files=all', '--', ...VERSION_FILES])) {
    throw new Error('Version files already have uncommitted changes; commit them first. No files were changed.');
  }
  const tag = `v${options.version}`;
  git(['check-ref-format', `refs/tags/${tag}`]);
  if (git(['tag', '--list', tag])) {
    if (previous !== options.version || git(['diff', '--name-only', `${tag}^{commit}`, 'main', '--', ...VERSION_FILES])) {
      throw new Error(`Version tag ${tag} already exists for different version files; use a new version. No files were changed.`);
    }
    console.log(`Version ${options.version} is already committed and tagged as ${tag}; no changes needed.`);
    return;
  }
  const before = previous.split('.').map(Number), after = options.version.split('.').map(Number);
  const delta = [0, 1, 2].map(i => (after[i] || 0) - (before[i] || 0)).find(value => value !== 0);
  if (delta < 0) throw new Error('The new version must not be lower than VERSION. No files were changed.');

  const common = fs.realpathSync(path.resolve(ROOT, git(['rev-parse', '--git-common-dir'])));
  const base = git(['rev-parse', 'main']);
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (previous === options.version && changelog.split(/\r?\n/).some(line => line.startsWith(`## [${options.version}] - `))) {
    withLock(common, 'bump-version', () => {
      if (git(['rev-parse', 'main']) !== base) throw new Error('main changed; rerun the release preparation.');
      if (options.tag) tagVersion(options.version, base);
    });
    console.log('No version changes to commit.');
    return;
  }

  const id = crypto.randomBytes(3).toString('hex');
  const branch = `session/bump-${options.version}-${id}`;
  const worktree = path.join(ROOT, '.worktrees', `bump-${options.version}-${id}`);
  git(['worktree', 'add', '-b', branch, worktree, base]);
  let committed = false, merged = false;
  try {
    updateFiles(worktree, options);
    git(['add', '--', ...VERSION_FILES], worktree);
    git(['diff', '--cached', '--check'], worktree);
    git(['commit', '-m', `chore: bump version to ${options.version}`], worktree);
    committed = true;
    const commit = git(['rev-parse', 'HEAD'], worktree);
    withLock(common, branch, () => {
      if (git(['rev-parse', 'main']) !== base || git(['branch', '--show-current']) !== 'main') {
        throw new Error('main changed during preparation; synchronize and validate the preserved release worktree before merging.');
      }
      // 普通快进保留 main 上无关的暂存或未提交修改，不使用 stash/reset。
      git(['merge', '--ff-only', '--no-overwrite-ignore', commit]);
      git(['merge-base', '--is-ancestor', commit, 'main']);
      merged = true;
      if (options.tag) tagVersion(options.version, commit);
    });
    console.log(`Updated VERSION ${previous} -> ${options.version}; committed and merged ${commit} into main.`);
  } catch (error) {
    if (!merged) {
      throw new Error(`${committed ? 'Version commit was kept' : 'Version files were updated, but the commit failed'} in ${worktree} (${branch}): ${error.message}\nThe original worktree was not modified. Inspect the preserved task worktree before retrying.`);
    }
    throw error;
  } finally {
    if (merged) {
      // 只清理本次创建且已合入 main 的准确分支和 worktree。
      if (git(['status', '--porcelain', '--untracked-files=all', '--ignored'], worktree)) {
        console.error(`Preserved nonempty release worktree: ${worktree}`);
      } else {
        git(['merge-base', '--is-ancestor', branch, 'main']);
        const tip = git(['rev-parse', branch]);
        git(['worktree', 'remove', worktree]);
        withLock(common, branch, () => {
          if (git(['rev-parse', branch]) !== tip || git(['branch', '--show-current']) !== 'main') throw new Error(`Preserved branch ${branch}: references changed.`);
          git(['merge-base', '--is-ancestor', branch, 'main']);
          git(['branch', '-d', branch]);
        });
      }
    }
  }
  console.log(options.tag ? `Ready for: git push origin main ${tag}` : `Skipped tag (--no-tag). Ready for: git push origin main`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, updateFiles };
