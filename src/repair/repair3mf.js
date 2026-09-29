'use strict';
/**
 * Repairs a .3mf file on disk: unpacks it, repairs every .model mesh with
 * core.js, and repacks it. Every other file in the package (project settings,
 * thumbnails, model_settings.config, ...) is copied through unchanged.
 *
 * Uses macOS's built-in `unzip` / `zip`, so no extra dependency.
 * `-nw` stops zip treating "[Content_Types].xml" as a wildcard pattern.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('./core.js');

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

/**
 * @param {string} input  source .3mf
 * @param {string} output destination .3mf (must differ from input)
 * @param {(msg: string) => void} [progress]
 * @returns {{ reports: object[], ms: number }}
 */
function repair3mf(input, output, progress) {
  const say = progress || (() => {});
  const t0 = Date.now();
  if (path.resolve(input) === path.resolve(output)) throw new Error('output must not overwrite the input');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3d-repair-'));
  try {
    say('unpacking');
    execFileSync('unzip', ['-q', '-o', input, '-d', work], { maxBuffer: 64 << 20 });

    const files = listFiles(work);
    const models = files.filter((f) => f.toLowerCase().endsWith('.model'));
    if (!models.length) throw new Error('no 3D model found inside this 3MF');

    const reports = [];
    for (const rel of models) {
      const p = path.join(work, rel);
      const xml = fs.readFileSync(p, 'utf8');
      if (!xml.includes('<mesh')) continue; // assembly-only model file
      const res = core.repairModelXml(xml, (m) => say(`${rel} ${m}`));
      fs.writeFileSync(p, res.xml);
      for (const r of res.reports) reports.push({ file: rel, ...r });
    }

    say('packing');
    const tmpOut = output + '.partial';
    fs.rmSync(tmpOut, { force: true });
    const ordered = [
      ...files.filter((f) => f === '[Content_Types].xml'),
      ...files.filter((f) => f !== '[Content_Types].xml'),
    ];
    execFileSync('zip', ['-q', '-X', '-nw', '-6', tmpOut, ...ordered], { cwd: work, maxBuffer: 64 << 20 });
    fs.renameSync(tmpOut, output);

    return { reports, ms: Date.now() - t0 };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { repair3mf };
