/**
 * Runs every *.test.js under test/ through the node:test runner.
 *
 * Passing the directory directly behaves inconsistently across shells on
 * Windows, so the files are enumerated here and handed over explicitly.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const BUILD = path.join(DIR, '..', 'build');

if (!fs.existsSync(BUILD) || !fs.existsSync(path.join(BUILD, 'StakingVault.json'))) {
  console.error('no artifacts in build/ — run: npm run build');
  process.exit(1);
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(DIR, f));

if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(res.status === null ? 1 : res.status);
