#!/usr/bin/env node
/**
 * Builds a small multi-plate Bambu project (cubes) to learn what Bambu Studio
 * accepts: how plates are laid out in world space and whether it keeps our
 * plate assignment.
 *
 *   node tools/make-plates-probe.cjs <out.3mf> <project_settings source.3mf|none> <plates> <bedX> <bedY> [mode]
 *
 * mode: "bambu-grid" (default) places plate k at Bambu's own plate origin.
 *       "all-at-origin" puts every object on plate 1's area (tests whether
 *       Bambu trusts the plate list or the positions).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [out, src, platesArg, bxArg, byArg, mode = 'bambu-grid'] = process.argv.slice(2);
const plates = Number(platesArg);
const bx = Number(bxArg);
const by = Number(byArg);

// BambuStudio PartPlate: columns = round-up of sqrt(count); gap = 1/5 of bed.
function cols(n) {
  const v = Math.sqrt(n);
  const r = Math.round(v);
  return v > r ? r + 1 : r;
}
function plateOrigin(i, n) {
  const c = cols(n);
  const col = i % c;
  const row = Math.floor(i / c);
  return [col * bx * 1.2, -row * by * 1.2];
}

const s = 20;
const cube = () => {
  const v = [[-s / 2, -s / 2, -s / 2], [s / 2, -s / 2, -s / 2], [s / 2, s / 2, -s / 2], [-s / 2, s / 2, -s / 2], [-s / 2, -s / 2, s / 2], [s / 2, -s / 2, s / 2], [s / 2, s / 2, s / 2], [-s / 2, s / 2, s / 2]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { v, f };
};

let objects = '';
let items = '';
let plateXml = '';
let settingsObjects = '';
for (let p = 0; p < plates; p++) {
  const [ox, oy] = mode === 'all-at-origin' ? [0, 0] : plateOrigin(p, plates);
  const id = p + 1;
  const { v, f } = cube();
  objects += `<object id="${id}" type="model" name="cube${id}"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${f
    .map(([a, b, c], k) => `<triangle v1="${a}" v2="${b}" v3="${c}"${k === 2 && p % 2 ? ' paint_color="8"' : ''}/>`)
    .join('')}</triangles></mesh></object>`;
  items += `<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${ox + bx / 2} ${oy + by / 2} ${s / 2}" printable="1"/>`;
  settingsObjects += `  <object id="${id}">\n    <metadata key="name" value="cube${id}"/>\n    <metadata key="extruder" value="1"/>\n    <part id="${id}" subtype="normal_part">\n      <metadata key="name" value="cube${id}"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n    </part>\n  </object>\n`;
  plateXml += `  <plate>\n    <metadata key="plater_id" value="${p + 1}"/>\n    <metadata key="plater_name" value="Plate ${p + 1}"/>\n    <metadata key="locked" value="false"/>\n    <model_instance>\n      <metadata key="object_id" value="${id}"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n  </plate>\n`;
}

const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"><metadata name="Application">BambuStudio-02.08.03.66</metadata><metadata name="BambuStudio:3mfVersion">1</metadata><resources>${objects}</resources><build>${items}</build></model>`;
const settings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${settingsObjects}${plateXml}</config>\n`;

const w = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3dpl-'));
fs.mkdirSync(path.join(w, '3D'));
fs.mkdirSync(path.join(w, '_rels'));
fs.mkdirSync(path.join(w, 'Metadata'));
fs.writeFileSync(path.join(w, '[Content_Types].xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>');
fs.writeFileSync(path.join(w, '_rels/.rels'), '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');
fs.writeFileSync(path.join(w, '3D/3dmodel.model'), model);
fs.writeFileSync(path.join(w, 'Metadata/model_settings.config'), settings);
if (src !== 'none') {
  const j = JSON.parse(execFileSync('unzip', ['-p', src, 'Metadata/project_settings.config']).toString());
  if (process.env.NO_TOWER) { j.enable_prime_tower = "0"; }
  j.printable_area = ['0x0', `${bx}x0`, `${bx}x${by}`, `0x${by}`];
  fs.writeFileSync(path.join(w, 'Metadata/project_settings.config'), JSON.stringify(j, null, 4));
}
fs.rmSync(out, { force: true });
execFileSync('zip', ['-q', '-X', '-r', '-nw', path.resolve(out), '.'], { cwd: w });
fs.rmSync(w, { recursive: true, force: true });
console.log('wrote', out);
