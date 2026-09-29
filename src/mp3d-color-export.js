/**
 * Colour-preserving 3MF export for the local Multipart3D build.
 *
 * The problem
 * -----------
 * The app already reads Bambu/Orca painted 3MFs correctly: every triangle gets
 * a filament number ("slot label", 1-based), and the cut pipeline carries those
 * labels through Manifold onto each part. But the stock 3MF writer ignores them
 * and gives the whole part a single <basematerials> display colour, so the
 * slicer sees an unpainted model.
 *
 * What this writes instead
 * ------------------------
 * Per-triangle `paint_color`, the attribute Bambu Studio and OrcaSlicer use
 * for MMU painting. Verified against Bambu Studio 02.08.04.57's own loader.
 *
 * Two modes, chosen automatically:
 *
 *   project mode   The source was a slicer project with a real
 *                  Metadata/project_settings.config. We write that config back
 *                  verbatim and mark the model as a Bambu project, so the
 *                  slicer also restores the filament COLOURS and count, not just
 *                  which triangle uses which filament. Bambu only honours
 *                  project_settings when the model is marked this way, and a
 *                  partial/synthetic config crashed it in testing, so the real
 *                  file is the only safe source.
 *
 *   plain mode     No source config (e.g. an STL-derived part, or a 3MF from
 *                  another tool). The original export format plus paint_color.
 *                  The slicer still keeps the painted regions; it just uses its
 *                  own current filament colours.
 *
 * Paint encoding
 * --------------
 * Bambu/Prusa TriangleSelector serialisation for an unsplit triangle painted
 * with filament N:
 *     N = 1, 2   ->  one nibble, (N << 2)            "4", "8"
 *     N >= 3     ->  0b1100 then (N - 3), nibbles are read from the END of the
 *                    string, so it is written reversed  "0C", "1C", ...
 * This matches the app's own decoder and what Bambu wrote in the user's files.
 *
 * Unpainted triangles follow the object's filament, which is 1 because we
 * never assign one. So label 1 is left unpainted (exactly Bambu's convention)
 * and everything else is painted explicitly.
 *
 * Label 0 means "unknown", which is what cut caps get: they are new faces from
 * the cutting tool and have no source triangle. They take the part's dominant
 * filament, which is also the colour the app shows for the part.
 *
 * Wiring: tools/sync-site.mjs patches the bundle so the stock exporter calls
 * globalThis.__mp3dExport3mf for parts that carry slot labels, and falls back
 * to the stock export if this throws.
 */
(function () {
  'use strict';

  const PROJECT_SETTINGS = 'Metadata/project_settings.config';

  const CONTENT_TYPES_PLAIN =
    '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';

  const CONTENT_TYPES_PROJECT =
    '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '<Default Extension="config" ContentType="text/xml"/>' +
    '</Types>';

  const RELS =
    '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';

  const stats = { exports: 0, projectMode: 0, plainMode: 0, lastExport: null };

  /** Precomputed paint codes for filament 0..255. */
  const PAINT = new Array(256);
  for (let n = 0; n < 256; n++) {
    if (n <= 0) PAINT[n] = null;
    else if (n < 3) PAINT[n] = (n << 2).toString(16).toUpperCase();
    else PAINT[n] = (n - 3).toString(16).toUpperCase() + 'C';
  }

  /** Same number formatting as the stock exporter. */
  function num(v) {
    return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/\.?0+$/, '');
  }

  /** The stock exporter's display-colour normalisation, for plain mode. */
  function displayColor(c) {
    let t = String(c || '').trim();
    if (t.startsWith('#')) t = t.slice(1);
    if (t.length === 3) t = t.split('').map((ch) => ch + ch).join('');
    if (t.length === 8) t = t.slice(0, 6);
    if (!/^[0-9a-fA-F]{6}$/.test(t)) t = 'CCCCCC';
    return `#${t.toUpperCase()}FF`;
  }

  function escapeXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Returns the source project's settings, or null.
   *
   * The importer stashes the JSZip of the most recently loaded 3MF in
   * globalThis.__mp3dSrcZip (re-set on every 3MF load, so it cannot leak from
   * one painted file into another).
   */
  async function sourceProjectSettings() {
    const zip = globalThis.__mp3dSrcZip;
    const entry = zip && zip.files && zip.files[PROJECT_SETTINGS];
    if (!entry) return null;
    const text = await entry.async('string');
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return null;
    }
    // Only trust a full slicer config. A partial one crashed Bambu Studio.
    if (!json || !Array.isArray(json.filament_colour) || Object.keys(json).length < 50) return null;
    return { text, json };
  }

  /** Bed centre from printable_area ["0x0","256x0",...], default 128,128. */
  function bedCentre(json) {
    const area = Array.isArray(json.printable_area) ? json.printable_area : null;
    if (area && area.length >= 3) {
      const pts = area
        .map((p) => String(p).split('x').map(Number))
        .filter((p) => p.length === 2 && p.every(Number.isFinite));
      if (pts.length >= 3) {
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      }
    }
    return [128, 128];
  }

  /** Per-triangle filament numbers, with cut caps (0) resolved. */
  function resolveLabels(slotLabels) {
    const n = slotLabels.length;
    const hist = new Map();
    for (let i = 0; i < n; i++) {
      const l = slotLabels[i];
      if (l > 0) hist.set(l, (hist.get(l) || 0) + 1);
    }
    let dominant = 1;
    let best = -1;
    for (const [l, c] of hist) {
      if (c > best) {
        best = c;
        dominant = l;
      }
    }
    const out = new Uint8Array(n);
    let caps = 0;
    for (let i = 0; i < n; i++) {
      const l = slotLabels[i];
      if (l > 0) out[i] = l;
      else {
        out[i] = dominant;
        caps++;
      }
    }
    return { labels: out, dominant, caps, histogram: Object.fromEntries([...hist].sort((a, b) => a[0] - b[0])) };
  }

  /**
   * Builds the <triangles> body. Written in chunks to keep peak string size
   * down on multi-million triangle parts.
   */
  function trianglesXml(triangles, labels) {
    const chunks = [];
    let buf = [];
    let painted = 0;
    const triCount = triangles.length / 3;
    for (let t = 0; t < triCount; t++) {
      const code = labels[t] === 1 ? null : PAINT[labels[t]];
      const j = t * 3;
      if (code) {
        painted++;
        buf.push(`<triangle v1="${triangles[j]}" v2="${triangles[j + 1]}" v3="${triangles[j + 2]}" paint_color="${code}"/>`);
      } else {
        buf.push(`<triangle v1="${triangles[j]}" v2="${triangles[j + 1]}" v3="${triangles[j + 2]}"/>`);
      }
      if (buf.length === 50000) {
        chunks.push(buf.join(''));
        buf = [];
      }
    }
    if (buf.length) chunks.push(buf.join(''));
    return { xml: chunks.join(''), painted };
  }

  function verticesXml(vertices, dx, dy, dz) {
    const chunks = [];
    let buf = [];
    for (let i = 0; i < vertices.length; i += 3) {
      buf.push(`<vertex x="${num(vertices[i] - dx)}" y="${num(vertices[i + 1] - dy)}" z="${num(vertices[i + 2] - dz)}"/>`);
      if (buf.length === 50000) {
        chunks.push(buf.join(''));
        buf = [];
      }
    }
    if (buf.length) chunks.push(buf.join(''));
    return chunks.join('');
  }

  async function export3mf({ geometry, transform, color, part, toVerts, JSZip }) {
    const t0 = performance.now();
    const { vertices, triangles } = toVerts(geometry, transform);
    const triCount = triangles.length / 3;

    // The labels are per triangle in geometry order, and the stock
    // geometry-to-vertices step preserves that order. If the counts disagree,
    // something upstream changed: refuse rather than paint the wrong faces.
    if (!part.slotLabels || part.slotLabels.length !== triCount) {
      throw new Error(
        `slot label count ${part.slotLabels && part.slotLabels.length} != triangle count ${triCount}`
      );
    }

    const { labels, dominant, caps, histogram } = resolveLabels(part.slotLabels);
    const project = await sourceProjectSettings();
    const name = escapeXml(part.name || 'Part');

    let modelXml;
    let painted;
    const zip = new JSZip();

    if (project) {
      // Project mode. Mesh is centred on its own bounding box (as Bambu writes
      // it) and placed on the bed centre via the build item transform, because
      // slicers do not auto-arrange objects inside a project.
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      const [bx, by] = bedCentre(project.json);
      const halfH = (maxZ - minZ) / 2;

      const tri = trianglesXml(triangles, labels);
      painted = tri.painted;
      const version = String(project.json.version || '02.08.00.00').replace(/[^0-9.]/g, '');

      modelXml =
        '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
        '<model unit="millimeter" xml:lang="en-US" ' +
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
        'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">' +
        `<metadata name="Application">BambuStudio-${version}</metadata>` +
        '<metadata name="BambuStudio:3mfVersion">1</metadata>' +
        `<metadata name="Title">${name}</metadata>` +
        '<metadata name="Generator">Multipart3D Local (colour-preserving export)</metadata>' +
        `<resources><object id="1" type="model" name="${name}"><mesh><vertices>` +
        verticesXml(vertices, cx, cy, cz) +
        '</vertices><triangles>' +
        tri.xml +
        '</triangles></mesh></object></resources>' +
        `<build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${num(bx)} ${num(by)} ${num(halfH)}" printable="1"/></build>` +
        '</model>';

      zip.file('[Content_Types].xml', CONTENT_TYPES_PROJECT);
      zip.file('_rels/.rels', RELS);
      zip.file('3D/3dmodel.model', modelXml);
      zip.file(PROJECT_SETTINGS, project.text);
      stats.projectMode++;
    } else {
      // Plain mode: stock format, plus paint.
      const tri = trianglesXml(triangles, labels);
      painted = tri.painted;
      modelXml =
        '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
        '<metadata name="Application">Multipart3D</metadata><resources>' +
        (color ? `<basematerials id="2"><base name="Color" displaycolor="${displayColor(color)}"/></basematerials>` : '') +
        (color ? '<object id="1" type="model" pid="2" pindex="0"><mesh>' : '<object id="1" type="model"><mesh>') +
        '<vertices>' +
        verticesXml(vertices, 0, 0, 0) +
        '</vertices><triangles>' +
        tri.xml +
        '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>';

      zip.file('[Content_Types].xml', CONTENT_TYPES_PLAIN);
      zip.file('_rels/.rels', RELS);
      zip.file('3D/3dmodel.model', modelXml);
      stats.plainMode++;
    }

    stats.exports++;
    stats.lastExport = {
      part: part.name,
      mode: project ? 'project' : 'plain',
      triangles: triCount,
      painted,
      capsFilled: caps,
      dominant,
      histogram,
      ms: Math.round(performance.now() - t0),
    };
    console.info('[mp3d-color] ' + JSON.stringify(stats.lastExport));

    return zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      mimeType: 'model/3mf',
    });
  }

  /* ------------------------------------------------------------------ *
   * Multi-plate project export
   *
   * One Bambu/Orca project 3MF holding every part, each on its plate, with
   * the printer + filament settings. Rules verified against Bambu Studio
   * 02.08.04.57's CLI (tools/make-plates-probe.cjs):
   *   - plates are listed in Metadata/model_settings.config, and each object
   *     must also PHYSICALLY sit inside its plate, whose origin follows
   *     Bambu's grid: columns = ceil-ish sqrt(count), stride = 1.2 x bed
   *   - plates need a full project_settings.config (none: plates ignored or
   *     the CLI crashes)
   *   - a multi-colour plate's prime tower must lie on the bed
   * Meshes go in one file per object (3D/Objects/object_N.model), the layout
   * Bambu itself writes, so a huge model never becomes one giant string.
   * ------------------------------------------------------------------ */

  // Proper 90-degree rotations (row-major 3x3). Pairs (0,1), (2,3), (4,5)
  // differ by a 90-degree turn about Z, so i ^ 1 swaps a part's footprint.
  const ROTS = (() => {
    const mul = (a, b) => {
      const r = new Array(9).fill(0);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
      return r;
    };
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const Rz = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    const Rx = [1, 0, 0, 0, 0, -1, 0, 1, 0]; // old Y becomes up
    const Ry = [0, 0, 1, 0, 1, 0, -1, 0, 0]; // old X becomes up
    return [I, mul(Rz, I), Rx, mul(Rz, Rx), Ry, mul(Rz, Ry)];
  })();

  /** Size of a box {x,y,z} after rotation i. */
  function rotatedDims(d, i) {
    const R = ROTS[i];
    const v = [d.x, d.y, d.z];
    const out = [0, 0, 0];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r] += Math.abs(R[r * 3 + c]) * v[c];
    return { x: out[0], y: out[1], z: out[2] };
  }

  /** Bambu's plate grid: column count for n plates. */
  function plateColumns(n) {
    const v = Math.sqrt(n);
    const r = Math.round(v);
    return v > r ? r + 1 : r;
  }

  function areaBounds(json) {
    const pts = (Array.isArray(json.printable_area) ? json.printable_area : [])
      .map((p) => String(p).split('x').map(Number))
      .filter((p) => p.length === 2 && p.every(Number.isFinite));
    if (pts.length < 3) return null;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) };
  }

  /** Settings for a project: a user-chosen override, else the loaded file's. */
  async function projectSettings() {
    const o = globalThis.__mp3dSettingsOverride;
    if (o && o.json) return { ...o, from: o.name };
    const s = await sourceProjectSettings();
    return s ? { ...s, from: 'loaded model' } : null;
  }

  /** Reads project settings out of any Bambu/Orca 3MF (Uint8Array). */
  async function settingsFromFile(bytes, name) {
    const api = globalThis.__mp3dExportApi;
    const zip = await api.JSZip.loadAsync(bytes);
    const entry = zip.files[PROJECT_SETTINGS];
    if (!entry) throw new Error(`${name} has no printer/filament settings (not a slicer project)`);
    const text = await entry.async('string');
    const json = JSON.parse(text);
    if (!Array.isArray(json.filament_colour) || Object.keys(json).length < 50) {
      throw new Error(`${name}'s settings look incomplete`);
    }
    return { text, json, name };
  }

  /**
   * items:  [{ part, plate, rot, slot: { x, y, w, d } }]   slot in bed coords
   * plates: [{ name, tower: { x, y } | null }]            empty plates removed
   * bed:    { x, y, z }                                    selected printer
   */
  async function exportProject({ items, plates, bed, onProgress }) {
    const api = globalThis.__mp3dExportApi;
    if (!api) throw new Error('project export isn’t available in this build');
    const settings = await projectSettings();
    if (!settings) throw new Error('no printer/filament settings to put in the project');
    const say = onProgress || (() => {});
    const t0 = performance.now();

    // Settings: the project's own, with the bed set to the chosen printer.
    const json = JSON.parse(settings.text);
    const originalArea = areaBounds(json);
    const x0 = originalArea ? originalArea.x0 : 0;
    const y0 = originalArea ? originalArea.y0 : 0;
    json.printable_area = [`${x0}x${y0}`, `${x0 + bed.x}x${y0}`, `${x0 + bed.x}x${y0 + bed.y}`, `${x0}x${y0 + bed.y}`];
    json.printable_height = String(bed.z);
    // Prime tower: the project's own position on every plate (clamped onto
    // the bed). Move it in the slicer if it lands on a part.
    const towerW = Number(json.prime_tower_width) || 35;
    const tx0 = Math.min(Math.max(x0 + 5, Number((json.wipe_tower_x || [])[0]) || x0 + 15), x0 + bed.x - towerW - 5);
    const ty0 = Math.min(Math.max(y0 + 5, Number((json.wipe_tower_y || [])[0]) || y0 + 15), y0 + bed.y - towerW - 30);
    json.wipe_tower_x = plates.map(() => String(+tx0.toFixed(3)));
    json.wipe_tower_y = plates.map(() => String(+ty0.toFixed(3)));

    const zip = new api.JSZip();
    const cols = plateColumns(plates.length);
    const stride = { x: bed.x * 1.2, y: bed.y * 1.2 };
    const version = String(json.version || '02.08.00.00').replace(/[^0-9.]/g, '');
    const NS =
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ' +
      'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ' +
      'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

    const resources = [];
    const buildItems = [];
    const rels = [];
    const settingsObjects = [];
    const perPlate = plates.map(() => []);
    let painted = 0;
    let triangleTotal = 0;
    let maxLabel = 1;

    for (let k = 0; k < items.length; k++) {
      const { part, plate, rot, slot } = items[k];
      say(`Writing part ${k + 1} of ${items.length}: ${part.name}`);
      await new Promise((r) => requestAnimationFrame(() => r()));

      const { vertices, triangles } = api.toVerts(part.geometry, part.transform);
      const triCount = triangles.length / 3;
      let labels;
      if (part.slotLabels && part.slotLabels.length === triCount) labels = resolveLabels(part.slotLabels).labels;
      else labels = new Uint8Array(triCount).fill(1);
      for (let i = 0; i < triCount; i++) if (labels[i] > maxLabel) maxLabel = labels[i];

      // Rotate, then centre on the bounding box.
      const R = ROTS[rot || 0];
      const v = new Float64Array(vertices.length);
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
      for (let i = 0; i < vertices.length; i += 3) {
        const a = vertices[i], b = vertices[i + 1], c = vertices[i + 2];
        const x = R[0] * a + R[1] * b + R[2] * c;
        const y = R[3] * a + R[4] * b + R[5] * c;
        const z = R[6] * a + R[7] * b + R[8] * c;
        v[i] = x; v[i + 1] = y; v[i + 2] = z;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x;
        if (y < mny) mny = y; if (y > mxy) mxy = y;
        if (z < mnz) mnz = z; if (z > mxz) mxz = z;
      }
      const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, cz = (mnz + mxz) / 2;

      const tri = trianglesXml(triangles, labels);
      painted += tri.painted;
      triangleTotal += triCount;

      const meshId = 2 * k + 1;
      const objId = 2 * k + 2;
      const name = escapeXml(part.name || `Part ${k + 1}`);
      zip.file(
        `3D/Objects/object_${k + 1}.model`,
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          `<model unit="millimeter" xml:lang="en-US" ${NS}>` +
          '<metadata name="BambuStudio:3mfVersion">1</metadata>' +
          `<resources><object id="${meshId}" type="model"><mesh><vertices>` +
          verticesXml(v, cx, cy, cz) +
          '</vertices><triangles>' +
          tri.xml +
          '</triangles></mesh></object></resources><build/></model>'
      );
      rels.push(`<Relationship Target="/3D/Objects/object_${k + 1}.model" Id="rel-${k + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`);
      resources.push(
        `<object id="${objId}" type="model" name="${name}"><components>` +
          `<component p:path="/3D/Objects/object_${k + 1}.model" objectid="${meshId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>` +
          '</components></object>'
      );

      // World position: plate origin (Bambu grid) + slot centre on that bed.
      const col = plate % cols;
      const row = Math.floor(plate / cols);
      const wx = x0 + col * stride.x + slot.x + slot.w / 2;
      const wy = y0 - row * stride.y + slot.y + slot.d / 2;
      const wz = (mxz - mnz) / 2;
      buildItems.push(`<item objectid="${objId}" transform="1 0 0 0 1 0 0 0 1 ${num(wx)} ${num(wy)} ${num(wz)}" printable="1"/>`);

      settingsObjects.push(
        `  <object id="${objId}">\n    <metadata key="name" value="${name}"/>\n    <metadata key="extruder" value="1"/>\n` +
          `    <part id="${meshId}" subtype="normal_part">\n      <metadata key="name" value="${name}"/>\n` +
          '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n    </part>\n  </object>\n'
      );
      perPlate[plate].push(objId);
    }

    const plateXml = plates
      .map(
        (p, i) =>
          `  <plate>\n    <metadata key="plater_id" value="${i + 1}"/>\n    <metadata key="plater_name" value="${escapeXml(p.name || '')}"/>\n` +
          '    <metadata key="locked" value="false"/>\n' +
          perPlate[i].map((id) => `    <model_instance>\n      <metadata key="object_id" value="${id}"/>\n      <metadata key="instance_id" value="0"/>\n    </model_instance>\n`).join('') +
          '  </plate>\n'
      )
      .join('');

    zip.file('[Content_Types].xml', CONTENT_TYPES_PROJECT);
    zip.file('_rels/.rels', RELS);
    zip.file(
      '3D/3dmodel.model',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        `<model unit="millimeter" xml:lang="en-US" ${NS}>` +
        `<metadata name="Application">BambuStudio-${version}</metadata>` +
        '<metadata name="BambuStudio:3mfVersion">1</metadata>' +
        '<metadata name="Generator">Multipart3D Local (multi-plate project export)</metadata>' +
        `<resources>${resources.join('')}</resources><build>${buildItems.join('')}</build></model>`
    );
    zip.file(
      '3D/_rels/3dmodel.model.rels',
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>'
    );
    zip.file('Metadata/model_settings.config', '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + settingsObjects.join('') + plateXml + '</config>\n');
    zip.file(PROJECT_SETTINGS, JSON.stringify(json, null, 4));

    say('Compressing…');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'model/3mf' });
    const report = {
      parts: items.length,
      plates: plates.length,
      triangles: triangleTotal,
      painted,
      filamentsUsed: maxLabel,
      filamentsInSettings: json.filament_colour.length,
      settingsFrom: settings.from,
      printerProfile: json.printer_settings_id || null,
      bytes: blob.size,
      ms: Math.round(performance.now() - t0),
    };
    stats.lastProject = report;
    console.info('[mp3d-project] ' + JSON.stringify(report));
    return { blob, report };
  }

  globalThis.__mp3dRotations = { ROTS, rotatedDims };
  globalThis.__mp3dExportProject = exportProject;
  globalThis.__mp3dProjectSettings = projectSettings;
  globalThis.__mp3dSettingsFromFile = settingsFromFile;

  globalThis.__mp3dExport3mf = export3mf;
  globalThis.__mp3dColorStats = () => JSON.parse(JSON.stringify(stats));
  globalThis.__mp3dEncodePaint = (n) => PAINT[n];
})();
