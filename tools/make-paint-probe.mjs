#!/usr/bin/env node
/**
 * Writes tiny test 3MFs to learn what Bambu Studio accepts from a non-Bambu
 * exporter: a 20 mm cube whose top faces are painted with filament 2 and one
 * side with filament 3 (exercises the >=3 escape encoding).
 *
 *   node tools/make-paint-probe.mjs <outdir>
 *
 * Variants:
 *   paint-only.3mf       paint_color per triangle, nothing else
 *   paint-colours.3mf    + Metadata/project_settings.config with filament_colour
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const out = path.resolve(process.argv[2] || '.');
fs.mkdirSync(out, { recursive: true });

// Bambu / Prusa TriangleSelector encoding for an unsplit triangle, 1-based
// filament. Nibbles are read from the END of the string, so multi-nibble codes
// are written reversed.
export function encodePaint(state) {
  if (state <= 0) return null;
  if (state < 3) return (state << 2).toString(16).toUpperCase();
  return (state - 3).toString(16).toUpperCase() + 'C';
}

const s = 20;
const v = [
  [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
  [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
];
// [tri, filament]
const tris = [
  [[0, 2, 1], 1], [[0, 3, 2], 1], // bottom
  [[4, 5, 6], 2], [[4, 6, 7], 2], // top    -> filament 2
  [[0, 1, 5], 3], [[0, 5, 4], 3], // front  -> filament 3
  [[1, 2, 6], 1], [[1, 6, 5], 1],
  [[2, 3, 7], 1], [[2, 7, 6], 1],
  [[3, 0, 4], 1], [[3, 4, 7], 1],
];

const model = (withPaint) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">Multipart3D</metadata><resources><object id="1" type="model"><mesh><vertices>${v
    .map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`)
    .join('')}</vertices><triangles>${tris
    .map(([[a, b, c], f]) => {
      const p = withPaint ? encodePaint(f) : null;
      return `<triangle v1="${a}" v2="${b}" v3="${c}"${p && f !== 1 ? ` paint_color="${p}"` : ''}/>`;
    })
    .join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;

const CT = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

function pack(name, files) {
  const dir = fs.mkdtempSync(path.join(out, '.stage-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const target = path.join(out, name);
  fs.rmSync(target, { force: true });
  execFileSync('zip', ['-q', '-X', '-r', target, '.'], { cwd: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('wrote', target);
}

const base = {
  '[Content_Types].xml': CT,
  '_rels/.rels': RELS,
  '3D/3dmodel.model': model(true),
};
pack('paint-only.3mf', base);
pack('paint-colours.3mf', {
  ...base,
  'Metadata/project_settings.config': JSON.stringify(
    { filament_colour: ['#FFFFFF', '#E01010', '#10A020'] },
    null,
    2
  ),
});
