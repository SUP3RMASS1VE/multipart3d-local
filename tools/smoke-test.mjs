#!/usr/bin/env node
/**
 * End-to-end check that the packaged/local app really works offline:
 * loads a real model file through the app's own file input and confirms the
 * 3D viewport comes up (which means the STL worker and the Manifold WASM
 * module both loaded from the local mirror).
 *
 *   node tools/smoke-test.mjs /path/to/model.stl
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = process.argv[2];

if (!model || !fs.existsSync(model)) {
  console.error('usage: node tools/smoke-test.mjs <model.stl|model.3mf>');
  process.exit(1);
}

// Expose the model to the renderer through the app's own local server.
const tmpName = `__smoke${path.extname(model)}`;
fs.copyFileSync(model, path.join(ROOT, 'site', tmpName));

const child = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'), ['.'], {
  cwd: ROOT,
  env: { ...process.env, MP3D_SMOKE: '1', MP3D_SMOKE_FILE: tmpName },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
const collect = (buf) => {
  out += buf.toString();
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

child.on('exit', (code) => {
  fs.rmSync(path.join(ROOT, 'site', tmpName), { force: true });

  const line = out.split('\n').find((l) => l.includes('SMOKE_REPORT'));
  const missing = out.split('\n').filter((l) => l.includes('[missing asset]'));
  const errors = out.split('\n').filter((l) => l.includes('[renderer:3]'));

  if (missing.length) console.log(missing.join('\n'));
  if (errors.length) console.log(errors.join('\n'));

  if (!line) {
    console.error(`FAIL: no report produced (electron exit ${code})`);
    console.error(out.slice(-2000));
    process.exit(1);
  }

  const report = JSON.parse(line.slice(line.indexOf('{')));
  console.log('report:', report);

  const ok =
    report.canvases > 0 &&
    report.webgl2 === true &&
    missing.length === 0 &&
    errors.length === 0;

  console.log(ok ? '\nPASS: model loaded and viewport is live.' : '\nFAIL: see report above.');
  process.exit(ok ? 0 : 1);
});
