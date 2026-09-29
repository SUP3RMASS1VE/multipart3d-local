#!/usr/bin/env node
// Command-line front end for the repair, used for testing.
//   node tools/repair-3mf.cjs in.3mf out.3mf
const { repair3mf } = require('../src/repair/repair3mf.js');

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/repair-3mf.cjs in.3mf out.3mf');
  process.exit(1);
}
const t0 = Date.now();
const res = repair3mf(input, output, (m) => console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`));
console.log(JSON.stringify(res, null, 1));
