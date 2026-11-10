// The app runs the dashboard from this repo, so it needs to know where the
// repo is. The path is written at build time into a git-ignored file, so no
// machine path ever lands in the code.
const { writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

writeFileSync(join(__dirname, 'repo-path.json'), JSON.stringify({ repo: resolve(__dirname, '..') }) + '\n');
