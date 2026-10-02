'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validateVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(version) ||
      version.split('.').some(part => Number(part) > 65535)) {
    throw new Error(`Invalid version "${version}". Expected two or three numeric parts, each at most 65535 (e.g. 0.1 or 0.1.1).`);
  }
  return version;
}

function readVersion(root) {
  return validateVersion(fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim());
}

function productVersion(version) {
  return version.split('.').concat(version.split('.').length === 2 ? ['0'] : []).join('.');
}

module.exports = { validateVersion, readVersion, productVersion };
