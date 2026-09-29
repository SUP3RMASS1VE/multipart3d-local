#!/usr/bin/env node
/**
 * Stress test for src/repair/core.js on meshes damaged in known ways.
 * Every repair step gets exercised, then the result is checked:
 *   - closed and consistently wound (0 open / non-manifold / conflicting edges)
 *   - every piece faces outwards (positive volume)
 *   - every surviving original triangle keeps its paint text exactly,
 *     except flipped split-paint triangles, which must become their
 *     dominant filament
 *
 *   node tools/repair-selftest.cjs
 */
const core = require('../src/repair/core.js');

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** Icosphere: closed, outward-wound. */
function icosphere(level, r, cx) {
  const t = (1 + Math.sqrt(5)) / 2;
  let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = (p) => { const l = Math.hypot(...p); return p.map((x) => x / l); };
  v = v.map(norm);
  for (let l = 0; l < level; l++) {
    const mid = new Map();
    const m = (a, b) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (!mid.has(k)) { v.push(norm(v[a].map((x, i) => (x + v[b][i]) / 2))); mid.set(k, v.length - 1); }
      return mid.get(k);
    };
    const nf = [];
    for (const [a, b, c] of f) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  return { v: v.map(([x, y, z]) => [x * r + cx, y * r, z * r]), f };
}

function toXml(objects) {
  let xml = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>';
  objects.forEach((o, i) => {
    xml += `<object id="${i + 1}" type="model"><mesh><vertices>`;
    for (const [x, y, z] of o.v) xml += `<vertex x="${x}" y="${y}" z="${z}"/>`;
    xml += '</vertices><triangles>';
    o.f.forEach(([a, b, c], k) => {
      const p = o.paint[k];
      xml += `<triangle v1="${a}" v2="${b}" v3="${c}"${p ? ` paint_color="${p}"` : ''}/>`;
    });
    xml += '</triangles></mesh></object>';
  });
  xml += '</resources><build>' + objects.map((_, i) => `<item objectid="${i + 1}"/>`).join('') + '</build></model>';
  return xml;
}

function parseOut(xml) {
  const objs = [];
  for (const om of xml.matchAll(/<object\b[^>]*>([\s\S]*?)<\/object>/g)) {
    const v = [...om[1].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((m) => [+m[1], +m[2], +m[3]]);
    const f = [];
    const paint = [];
    for (const m of om[1].matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"([^/]*)\/>/g)) {
      f.push([+m[1], +m[2], +m[3]]);
      const p = /paint_color="([^"]*)"/.exec(m[4]);
      paint.push(p ? p[1] : '');
    }
    objs.push({ v, f, paint });
  }
  return objs;
}

const key = (v, tri) => tri.map((i) => v[i].join(',')).sort().join('|');

function volume(o) {
  let s = 0;
  for (const [a, b, c] of o.f) {
    const [ax, ay, az] = o.v[a], [bx, by, bz] = o.v[b], [cx, cy, cz] = o.v[c];
    s += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return s / 6;
}

function run(name, build) {
  const { objects, expectFlippedSplit } = build();
  const xml = toXml(objects);
  const { xml: out, reports } = core.repairModelXml(xml);
  const res = parseOut(out);
  const failures = [];

  res.forEach((o, i) => {
    const flat = new Uint32Array(o.f.flat());
    const st = core.edgeStats(flat, o.f.length, o.v.length);
    if (st.boundary || st.nonManifold || st.orientationConflicts)
      failures.push(`object ${i + 1} not closed: ${JSON.stringify(st)}`);
    if (!(volume(o) > 0)) failures.push(`object ${i + 1} volume ${volume(o)} not positive`);

    // Paint of surviving originals.
    const orig = new Map();
    objects[i].f.forEach((tri, k) => {
      const kk = key(objects[i].v, tri);
      if (!orig.has(kk)) orig.set(kk, objects[i].paint[k]);
    });
    let kept = 0, changed = 0, reducedOk = 0;
    o.f.forEach((tri, k) => {
      const kk = key(o.v, tri);
      if (!orig.has(kk)) return;
      const was = orig.get(kk), now = o.paint[k];
      if (was === now) kept++;
      else if (!core.isLeafCode(was) && now === (core.leafCode(core.dominantState(was)) || '')) reducedOk++;
      else changed++;
    });
    if (changed) failures.push(`object ${i + 1}: ${changed} original triangles had paint changed`);
    reports[i].check = { kept, reducedOk, changed };
  });

  const flippedSplit = reports.reduce((a, r) => a + r.flippedSplitPaintReduced, 0);
  if (expectFlippedSplit && !flippedSplit) failures.push('expected flipped split-paint triangles to be reduced');

  const summary = reports.map((r) => ({
    dup: r.duplicatesRemoved, degen: r.degenerateRemoved, flipped: r.flipped, holes: r.holesFilled,
    fillTris: r.fillTriangles, fillVerts: r.fillVertices, inverted: r.componentsInverted,
    matched: r.fillsColourMatched, base: r.fillsLeftBase, splitReduced: r.flippedSplitPaintReduced,
    before: r.before, after: r.after, passes: r.passes, check: r.check,
  }));
  console.log(`${failures.length ? 'FAIL' : 'PASS'}  ${name}`);
  console.log('      ' + JSON.stringify(summary));
  for (const f of failures) console.log('      ! ' + f);
  return failures.length === 0;
}

function paintedSphere(level, r, cx) {
  const s = icosphere(level, r, cx);
  // Paint: top cap filament 2, a band of filament 4 (escape code), some split codes.
  s.paint = s.f.map(([a, b, c], k) => {
    const y = (s.v[a][1] + s.v[b][1] + s.v[c][1]) / 3;
    if (y > r * 0.5) return '8';
    if (Math.abs(y) < r * 0.1) return '1C';
    if (k % 97 === 0) return '0442'; // sub-triangle paint
    return '';
  });
  return s;
}

const results = [];

results.push(run('many small holes + duplicates + flips (alien-like)', () => {
  const s = paintedSphere(5, 20, 0);
  const keepF = [], keepP = [];
  s.f.forEach((tri, k) => {
    const r = rand();
    if (r < 0.01) return; // drop 1%: single-triangle holes
    let t = tri;
    if (r > 0.995) t = [tri[0], tri[2], tri[1]]; // flip 0.5%
    keepF.push(t); keepP.push(s.paint[k]);
    if (r > 0.98 && r <= 0.995) { keepF.push(tri); keepP.push(s.paint[k]); } // duplicate
  });
  return { objects: [{ v: s.v, f: keepF, paint: keepP }], expectFlippedSplit: false };
}));

results.push(run('large hole (60+ edges), cap removed across a colour border', () => {
  const s = paintedSphere(4, 20, 0);
  const keep = s.f.map((tri) => {
    const [a, b, c] = tri;
    const x = (s.v[a][0] + s.v[b][0] + s.v[c][0]) / 3;
    return x < 17.5; // cut off a cap
  });
  return {
    objects: [{ v: s.v, f: s.f.filter((_, k) => keep[k]), paint: s.paint.filter((_, k) => keep[k]) }],
    expectFlippedSplit: false,
  };
}));

results.push(run('huge hole (fan fallback): half the sphere missing', () => {
  const s = paintedSphere(4, 20, 0);
  const keep = s.f.map(([a, b, c]) => (s.v[a][2] + s.v[b][2] + s.v[c][2]) / 3 > -2);
  return { objects: [{ v: s.v, f: s.f.filter((_, k) => keep[k]), paint: s.paint.filter((_, k) => keep[k]) }] };
}));

results.push(run('inside-out piece + split paint on flipped triangles', () => {
  const a = paintedSphere(3, 10, 0);
  const b = paintedSphere(3, 10, 40);
  // Whole second piece inside out, merged into one object with the first.
  const off = a.v.length;
  const f = [...a.f, ...b.f.map(([x, y, z]) => [x + off, z + off, y + off])];
  // Also flip a few painted split triangles in piece A (minority).
  let flippedSplit = 0;
  for (let k = 0; k < a.f.length && flippedSplit < 5; k++) {
    if (a.paint[k] === '0442') { const [x, y, z] = f[k]; f[k] = [x, z, y]; flippedSplit++; }
  }
  return { objects: [{ v: [...a.v, ...b.v], f, paint: [...a.paint, ...b.paint] }], expectFlippedSplit: true };
}));

results.push(run('degenerate + exact duplicate vertices (split seams)', () => {
  const s = paintedSphere(3, 15, 0);
  // Duplicate every vertex used by odd faces, so the surface is split along seams.
  const v = s.v.slice();
  const f = s.f.map((tri, k) => {
    if (k % 2) return tri;
    return tri.map((i) => { v.push(s.v[i].slice()); return v.length - 1; });
  });
  f.push([0, 0, 1]); // degenerate
  const paint = [...s.paint, ''];
  return { objects: [{ v, f, paint }] };
}));

results.push(run('clean mesh is left untouched', () => {
  const s = paintedSphere(3, 15, 0);
  return { objects: [{ v: s.v, f: s.f, paint: s.paint }] };
}));

const ok = results.every(Boolean);
console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
process.exit(ok ? 0 : 1);
