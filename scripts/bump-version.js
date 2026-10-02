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
  if (!version) throw new Error('Usage: bump-version.sh|bump-version.bat <version> [--date YYYY-MM-DD] [--notes "text"] [--no-tag] [--no-push] [--no-commit] [--resume]');
  validateVersion(version);
  const options = { version, date: formatLocalDate(new Date()), notes: [], commit: true, tag: true, push: true };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--no-commit') options.commit = false;
    else if (flag === '--no-tag') options.tag = false;
    else if (flag === '--no-push') options.push = false;
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
  options.push = options.commit && options.push;
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

// stdout 只输出给 bump-version.sh/.bat 的执行计划；说明信息走 stderr。
function info(message) { console.error(message); }

// 提交、Tag 和推送由入口脚本直接用 git 命令完成；入口脚本已持有仓库级锁。
function main(argv) {
  const options = parseArgs(argv);
  const root = mainWorktree();
  process.chdir(root);
  const mainGit = args => git(args, root);
  const plan = (commit, createTag) => ({
    root, version: options.version, commit, create_tag: createTag,
    push: options.push, push_tag: options.push && options.tag,
  });
  // 所有版本修改均在 main 上执行，不创建或切换其他分支。
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
    info(`Version ${options.version} is already committed and tagged as ${tag}; no new commit needed.`);
    return plan(false, false);
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
    info(`Updated VERSION ${previous} -> ${options.version} and CHANGELOG.md on main; skipped commit, tag and push (--no-commit).`);
    return plan(false, false);
  }
  if (!dirty && previous === options.version && hasEntry) {
    info(`Version ${options.version} is already committed; no new commit needed.`);
    return plan(false, options.tag);
  }

  updateFiles(root, options);
  try {
    mainGit(['diff', '--check', 'HEAD', '--', ...VERSION_FILES]);
  } catch (error) {
    throw new Error(`Version file validation failed before commit:\n${error.message}\nChanges were kept in ${root}. Fix the reported formatting, then rerun version ${options.version} with --resume.`);
  }
  info(`Updated VERSION ${previous} -> ${options.version} and CHANGELOG.md on main.`);
  return plan(true, options.tag);
}

function formatPlan(plan) {
  return Object.entries(plan).map(([key, value]) => `${key}=${typeof value === 'boolean' ? Number(value) : value}`).join('\n') + '\n';
}

if (require.main === module) {
  try { process.stdout.write(formatPlan(main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { parseArgs, updateFiles };
