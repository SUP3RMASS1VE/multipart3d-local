#!/usr/bin/env node
/**
 * Proves the repair kept paint: compares the multiset of paint_color strings
 * attached to each geometric triangle (keyed by corner POSITIONS, so vertex
 * renumbering and winding flips don't matter) between two 3MFs.
 *
 *   node tools/compare-paint.cjs original.3mf repaired.3mf
 */
const { execFileSync } = require('child_process');

function load(file) {
  const entry = execFileSync('unzip', ['-Z1', file]).toString().split('\n').find((e) => e.endsWith('.model'));
  const xml = execFileSync('unzip', ['-p', file, entry], { maxBuffer: 1 << 30 }).toString('utf8');
  const v = [];
  for (const m of xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) v.push(`${+m[1]},${+m[2]},${+m[3]}`);
  const faces = new Map();
  for (const m of xml.matchAll(/<triangle\b([^>]*)\/>/g)) {
    const a = m[1];
    const k = [v[+/v1="(\d+)"/.exec(a)[1]], v[+/v2="(\d+)"/.exec(a)[1]], v[+/v3="(\d+)"/.exec(a)[1]]].sort().join('|');
    const p = /paint_color="([^"]*)"/.exec(a);
    faces.set(k, p ? p[1] : '');
  }
  return faces;
}

const [a, b] = process.argv.slice(2);
const A = load(a);
const B = load(b);
let same = 0, changed = 0, removed = 0;
const changes = [];
for (const [k, p] of A) {
  if (!B.has(k)) { removed++; continue; }
  if (B.get(k) === p) same++;
  else { changed++; if (changes.length < 5) changes.push({ from: p, to: B.get(k) }); }
}
const added = [...B.keys()].filter((k) => !A.has(k));
const addedPaint = {};
for (const k of added) { const p = B.get(k) || '(none)'; addedPaint[p] = (addedPaint[p] || 0) + 1; }
console.log(JSON.stringify({
  originalFaces: A.size, repairedFaces: B.size,
  paintIdentical: same, paintChanged: changed, facesRemoved: removed,
  facesAdded: added.length, addedFacePaint: addedPaint, sampleChanges: changes,
}, null, 1));
