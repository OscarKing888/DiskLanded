'use strict';
// Adapted from CodeSearch's scripts/bump-version.js and its shell/batch entry points.
// CodeSearch's MIT copyright and permission notice: CODESEARCH-LICENSE.txt.
const fs = require('node:fs');
const path = require('node:path');
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
  if (!version) throw new Error('Usage: bump-version.sh|bump-version.bat <version> [--date YYYY-MM-DD] [--notes "text"] [--no-tag] [--no-commit] [--resume]');
  validateVersion(version);
  const options = { version, date: formatLocalDate(new Date()), notes: [], commit: true, tag: true };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--no-commit') options.commit = false;
    else if (flag === '--no-tag') options.tag = false;
    else if (flag === '--resume') options.resume = true;
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
  if (options.resume && !options.commit) throw new Error('--resume cannot be combined with --no-commit.');
  if (options.resume && options.notes.length) throw new Error('--resume keeps existing notes; edit CHANGELOG.md before resuming instead of passing --notes.');
  return options;
}

function git(args, cwd = ROOT) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // diff --check 的诊断在 stdout；只读 stderr 会丢失真正的失败原因。
    throw new Error([`git ${args[0]} failed (exit ${error.status ?? error.code}):`,
      error.stdout?.trim(), error.stderr?.trim(), !error.stdout && !error.stderr ? error.message : ''].filter(Boolean).join('\n'));
  }
}

function updateFiles(root, options) {
  const versionFile = path.join(root, 'VERSION');
  const changelogFile = path.join(root, 'CHANGELOG.md');
  const current = fs.readFileSync(changelogFile, 'utf8');
  const heading = `## [${options.version}]`;
  let changelog = current;
  if (!current.split(/\r?\n/).some(line => line === heading || line.startsWith(heading + ' - '))) {
    const notes = options.notes.length ? options.notes : [`Release ${options.version}.`];
    const entry = `${heading} - ${options.date}\n\n### Changed\n\n${notes.map(note => '- ' + note.replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ')).join('\n')}\n\n`
      .split('\n').map(line => line.trimEnd()).join('\n');
    const firstRelease = current.search(/^## \[(?!Unreleased\])/m);
    changelog = firstRelease < 0 ? current.trimEnd() + '\n\n' + entry : current.slice(0, firstRelease) + entry + current.slice(firstRelease);
  }
  // 先生成完整内容再写入；版本的唯一来源仍是 VERSION。
  fs.writeFileSync(versionFile, options.version + '\n', 'utf8');
  fs.writeFileSync(changelogFile, changelog.trimEnd() + '\n', 'utf8');
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

function mainWorktree() {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  try {
    if (normalize(fs.realpathSync(git(['rev-parse', '--show-toplevel']))) !== normalize(fs.realpathSync(ROOT))) {
      throw new Error('The script must belong to this repository.');
    }
    // 使用 NUL 分隔，正确处理 Windows 路径、空格、中文及 Git 的路径转义。
    const records = git(['worktree', 'list', '--porcelain', '-z']).split('\0\0');
    const record = records.map(value => value.split('\0')).find(fields => fields.includes('branch refs/heads/main'));
    if (!record) throw new Error('Check out main in a worktree before running bump-version.');
    const root = fs.realpathSync(record.find(field => field.startsWith('worktree ')).slice(9));
    if (git(['branch', '--show-current'], root) !== 'main') throw new Error('The main worktree changed branches; retry.');
    return root;
  } catch (error) {
    throw new Error(`Version preparation requires a Git worktree checked out on main: ${error.message}\nNo version files were changed.`);
  }
}

function tagVersion(version, commit, root) {
  const tag = `v${version}`;
  try {
    git(['tag', '-a', tag, commit, '-m', `Release ${version}`], root);
    console.log(`Created annotated tag ${tag} at ${commit}.`);
  } catch (error) {
    throw new Error(`Version commit ${commit} was kept, but creating tag ${tag} failed: ${error.message}\nFix the reported Git error and rerun the same version. Existing tags are never overwritten.`);
  }
}

function main(argv) {
  const options = parseArgs(argv);
  const root = mainWorktree();
  process.chdir(root);
  const mainGit = args => git(args, root);
  const common = fs.realpathSync(path.resolve(root, mainGit(['rev-parse', '--git-common-dir'])));
  // 所有版本修改、提交和 Tag 均在 main 上执行，不创建或切换其他分支。
  withLock(common, 'main', () => {
    if (mainGit(['branch', '--show-current']) !== 'main') throw new Error('The main worktree changed branches; retry. No files were changed.');
    mainGit(['ls-files', '--error-unmatch', '--', ...VERSION_FILES]);
    const previous = readVersion(root);
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const dirty = Boolean(mainGit(['status', '--porcelain', '--untracked-files=all', '--', ...VERSION_FILES]));
    const hasEntry = changelog.split(/\r?\n/).some(line => line.startsWith(`## [${options.version}] - `));
    if (options.resume && (previous !== options.version || !hasEntry)) {
      throw new Error('--resume requires VERSION and an existing CHANGELOG heading to match the requested version. No files were changed.');
    }
    if (options.commit && dirty && !options.resume) {
      throw new Error(`Version files already have uncommitted changes on main. Review VERSION and CHANGELOG.md; to finish the prepared version, rerun its existing VERSION (${previous}) with --resume. No files were changed.`);
    }
    const tag = `v${options.version}`;
    mainGit(['check-ref-format', `refs/tags/${tag}`]);
    if (mainGit(['tag', '--list', tag])) {
      if (dirty || previous !== options.version || mainGit(['diff', '--name-only', `${tag}^{commit}`, 'main', '--', ...VERSION_FILES])) {
        throw new Error(`Version tag ${tag} already exists for different version files; use a new version. No files were changed.`);
      }
      console.log(`Version ${options.version} is already committed and tagged as ${tag}; no changes needed.`);
      return;
    }
    const committedVersion = validateVersion(mainGit(['show', 'HEAD:VERSION']));
    const after = options.version.split('.').map(Number);
    for (const baseline of [previous, committedVersion]) {
      const before = baseline.split('.').map(Number);
      const delta = [0, 1, 2].map(i => (after[i] || 0) - (before[i] || 0)).find(value => value !== 0);
      if (delta < 0) throw new Error('The new version must not be lower than working or committed VERSION. No files were changed.');
    }

    if (!options.commit) {
      updateFiles(root, options);
      console.log(`Updated VERSION ${previous} -> ${options.version} and CHANGELOG.md on main; skipped commit and tag (--no-commit).`);
      return;
    }
    if (!dirty && previous === options.version && hasEntry) {
      if (options.tag) tagVersion(options.version, mainGit(['rev-parse', 'main']), root);
      console.log('No version changes to commit.');
      return;
    }

    updateFiles(root, options);
    try {
      mainGit(['diff', '--check', 'HEAD', '--', ...VERSION_FILES]);
    } catch (error) {
      throw new Error(`Version file validation failed before commit:\n${error.message}\nChanges were kept in ${root}. Fix the reported formatting, then rerun version ${options.version} with --resume.`);
    }
    try {
      // --only 只提交版本文件，保留其他路径的暂存内容。
      mainGit(['commit', '--only', '-m', `chore: bump version to ${options.version}`, '--', ...VERSION_FILES]);
    } catch (error) {
      throw new Error(`Version files were updated on main, but the commit failed:\n${error.message}\nChanges were kept in ${root}. Fix the reported Git error, then rerun version ${options.version} with --resume.`);
    }
    const commit = mainGit(['rev-parse', 'main']);
    if (options.tag) tagVersion(options.version, commit, root);
    console.log(`Updated VERSION ${previous} -> ${options.version}; committed ${commit} on main.`);
    console.log(options.tag ? `Ready for: git push origin main ${tag}` : 'Skipped tag (--no-tag). Ready for: git push origin main');
  });
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, updateFiles };
