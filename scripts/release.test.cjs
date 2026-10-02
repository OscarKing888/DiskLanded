'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { archiveName, releaseNotes } = require('./release');
const { validateVersion, productVersion } = require('./version');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disklanded release '));
  t.after(() => {
    for (const dir of ['scripts', 'dist']) {
      for (const file of fs.readdirSync(path.join(root, dir))) fs.unlinkSync(path.join(root, dir, file));
      fs.rmdirSync(path.join(root, dir));
    }
    for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file));
    fs.rmdirSync(root);
  });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'dist'));
  for (const file of ['release.js', 'version.js']) fs.copyFileSync(path.join(__dirname, file), path.join(root, 'scripts', file));
  fs.writeFileSync(path.join(root, 'VERSION'), '0.1\n');
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [0.1] - 2026-10-02\n\n- 中文说明。\n\n## [0.0] - 2026-09-01\n\n- Old.\n');
  fs.writeFileSync(path.join(root, 'wails.json'), JSON.stringify({ name: 'DiskLanded', info: { productVersion: '9.9.9', comments: '新占' } }));
  return root;
}
function run(root, args, env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/release.js'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_REF_TYPE: '', GITHUB_REF_NAME: '', GITHUB_OUTPUT: '', ...env }
  });
}

test('version validation matches native packaging constraints and legacy two-part versions', () => {
  for (const version of ['0.1', '1.2.3', '65535.1.0']) assert.equal(validateVersion(version), version);
  for (const version of ['v0.1', '01.2', '1.2.3-beta', '1.2.3.4', '65536.1', '../escape']) assert.throws(() => validateVersion(version));
  assert.equal(productVersion('0.1'), '0.1.0');
  assert.equal(productVersion('1.2.3'), '1.2.3');
});

test('package names are unique per platform and notes select the exact version', () => {
  assert.equal(archiveName('0.1', 'macos-universal'), 'DiskLanded-v0.1-macos-universal.zip');
  assert.equal(archiveName('0.1', 'windows-x64'), 'DiskLanded-v0.1-windows-x64.zip');
  assert.equal(archiveName('0.1', 'linux-x64'), 'DiskLanded-v0.1-linux-x64.tar.gz');
  assert.throws(() => archiveName('0.1', '../unknown'));
  const notes = '# Changelog\n\n## [0.10] - 2026-10-01\n\n- Wrong.\n\n## [0.1] - 2026-09-01\n\n- 中文说明。\n';
  assert.equal(releaseNotes(notes, '0.1'), '## [0.1] - 2026-09-01\n\n- 中文说明。\n');
});

test('tag mismatch fails before changing metadata; prepare derives metadata only from VERSION', t => {
  const root = fixture(t), config = fs.readFileSync(path.join(root, 'wails.json'), 'utf8');
  assert.equal(run(root, ['prepare'], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.2' }).status, 1);
  assert.equal(fs.readFileSync(path.join(root, 'wails.json'), 'utf8'), config);
  const output = path.join(root, 'output');
  assert.equal(run(root, ['prepare'], { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.1', GITHUB_OUTPUT: output }).status, 0);
  assert.match(fs.readFileSync(output, 'utf8'), /^version=0\.1\n$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'wails.json'), 'utf8')), { name: 'DiskLanded', info: { productVersion: '0.1.0', comments: '新占' } });
});

test('release verification requires every platform and rejects corrupt or unexpected packages', t => {
  const root = fixture(t);
  assert.equal(run(root, ['verify']).status, 1);
  for (const platform of ['macos-universal', 'windows-x64', 'linux-x64']) {
    const file = path.join(root, 'dist', archiveName('0.1', platform));
    fs.writeFileSync(file, 'test package ' + platform);
    assert.equal(run(root, ['checksum', platform]).status, 0);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(fs.readFileSync(file + '.sha256', 'utf8'), `${hash}  ${path.basename(file)}\n`);
  }
  assert.equal(run(root, ['verify']).status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'dist/SHA256SUMS.txt'), 'utf8').trim().split('\n').length, 3);
  assert.match(fs.readFileSync(path.join(root, 'dist/release-notes.md'), 'utf8'), /中文说明/);
  const file = path.join(root, 'dist', archiveName('0.1', 'windows-x64'));
  fs.appendFileSync(file, 'corruption');
  assert.equal(run(root, ['verify']).status, 1);
  assert.equal(run(root, ['checksum', 'windows-x64']).status, 0);
  fs.writeFileSync(path.join(root, 'dist/unexpected.zip'), 'unexpected');
  assert.equal(run(root, ['verify']).status, 1);
});
