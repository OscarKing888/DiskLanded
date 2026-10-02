'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readVersion, productVersion } = require('./version');

const root = path.resolve(__dirname, '..');
const platforms = ['macos-universal', 'windows-x64', 'linux-x64'];

function checkVersion() {
  const version = readVersion(root);
  if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`Tag ${process.env.GITHUB_REF_NAME} does not match VERSION ${version} (expected v${version}).`);
  }
  return version;
}

function archiveName(version, platform) {
  if (!platforms.includes(platform)) throw new Error(`Unknown release platform: ${platform}`);
  return `DiskLanded-v${version}-${platform}.${platform === 'linux-x64' ? 'tar.gz' : 'zip'}`;
}

function digest(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`## [${version}] - `));
  if (start < 0) return `DiskLanded v${version}\n`;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## [')) end++;
  return lines.slice(start, end).join('\n').trim() + '\n';
}

function main(command, platform) {
  const version = checkVersion();
  if (command === 'check' || command === 'prepare') {
    if (command === 'prepare') {
      const file = path.join(root, 'wails.json');
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.info.productVersion = productVersion(version);
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8');
    }
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`, 'utf8');
    console.log(`DiskLanded v${version}, productVersion ${productVersion(version)}`);
    return;
  }
  const dist = path.join(root, 'dist');
  if (command === 'checksum') {
    const name = archiveName(version, platform);
    const file = path.join(dist, name);
    if (fs.statSync(file).size === 0) throw new Error(`Empty release archive: ${name}`);
    fs.writeFileSync(file + '.sha256', `${digest(file)}  ${name}\n`, 'utf8');
    return;
  }
  if (command === 'verify') {
    const expected = platforms.map(target => archiveName(version, target));
    const actual = fs.readdirSync(dist).filter(name => /\.(zip|tar\.gz)$/.test(name)).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('Release archives are missing or unexpected.');
    const checksums = expected.map(name => {
      const file = path.join(dist, name);
      if (fs.statSync(file).size === 0) throw new Error(`Empty archive: ${name}`);
      const line = `${digest(file)}  ${name}\n`;
      if (fs.readFileSync(file + '.sha256', 'utf8') !== line) throw new Error(`Checksum mismatch: ${name}`);
      return line;
    });
    fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), checksums.join(''), 'utf8');
    fs.writeFileSync(path.join(dist, 'release-notes.md'), releaseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version), 'utf8');
    console.log(`Verified ${expected.length} platform packages for v${version}.`);
    return;
  }
  throw new Error('Usage: node scripts/release.js check|prepare|checksum <platform>|verify');
}

if (require.main === module) {
  try { main(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { archiveName, releaseNotes };
