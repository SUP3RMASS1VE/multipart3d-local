#!/usr/bin/env node
/**
 * Reports how a 3MF encodes colour, so we know what a cut has to preserve.
 *
 * 3MF has several incompatible colour mechanisms:
 *   - Bambu/Orca "paint_color" attribute per <triangle> (MMU painting). This
 *     is what you get from painting in Bambu Studio / OrcaSlicer.
 *   - Prusa "slic3rpe:mmu_segmentation" per <triangle> (same idea, PrusaSlicer).
 *   - Core-spec <basematerials> / <m:colorgroup> referenced via pid/p1..p3.
 *   - Per-object filament assignment in Metadata/model_settings.config
 *     ("extruder" key) - whole object one colour.
 *
 *   node tools/inspect-3mf.mjs file.3mf [more.3mf ...]
 */

import { execFileSync } from 'node:child_process';

function listEntries(file) {
  const out = execFileSync('unzip', ['-Z1', file], { maxBuffer: 64 << 20 }).toString();
  return out.split('\n').filter(Boolean);
}

function readEntry(file, entry) {
  // 1.5 GB. (Not `2 << 30`: JS bit shifts are 32-bit signed and that overflows.)
  return execFileSync('unzip', ['-p', file, entry], { maxBuffer: 1.5 * 1024 ** 3 }).toString('utf8');
}

function countMatches(text, re) {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text)) n++;
  return n;
}

function inspect(file) {
  const entries = listEntries(file);
  const models = entries.filter((e) => e.toLowerCase().endsWith('.model'));
  const report = { file, entries: entries.length, models: [] };

  for (const m of models) {
    const xml = readEntry(file, m);
    const paintValues = new Map();
    const paintRe = /paint_color="([^"]*)"/g;
    let match;
    let sampled = 0;
    while ((match = paintRe.exec(xml)) && sampled < 2000000) {
      paintValues.set(match[1], (paintValues.get(match[1]) || 0) + 1);
      sampled++;
    }
    const topPaint = [...paintValues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    report.models.push({
      entry: m,
      bytes: xml.length,
      unit: (xml.match(/unit="([^"]+)"/) || [])[1] || null,
      xmlns: [...new Set((xml.slice(0, 3000).match(/xmlns(:\w+)?="[^"]+"/g) || []))],
      objects: countMatches(xml, /<object\b/g),
      components: countMatches(xml, /<component\b/g),
      triangles: countMatches(xml, /<triangle\b/g),
      vertices: countMatches(xml, /<vertex\b/g),
      paintColorTris: sampled,
      paintColorDistinct: paintValues.size,
      paintColorTop: topPaint,
      mmuSegmentationTris: countMatches(xml, /mmu_segmentation="/g),
      basematerials: countMatches(xml, /<basematerials\b/g),
      colorgroups: countMatches(xml, /<(?:m:)?colorgroup\b/g),
      trisWithPid: countMatches(xml, /<triangle\b[^>]*\bp1="/g),
      objectPid: countMatches(xml, /<object\b[^>]*\bpid="/g),
      sampleTriangles: (xml.match(/<triangle\b[^>]*\/>/g) || []).slice(0, 3),
    });
  }

  const cfg = entries.find((e) => /model_settings\.config$/i.test(e));
  if (cfg) {
    const txt = readEntry(file, cfg);
    report.modelSettings = {
      entry: cfg,
      extruderKeys: (txt.match(/key="extruder" value="[^"]*"/g) || []).slice(0, 10),
      objects: countMatches(txt, /<object\b/g),
      parts: countMatches(txt, /<part\b/g),
    };
  }
  const proj = entries.find((e) => /project_settings\.config$/i.test(e));
  if (proj) {
    const txt = readEntry(file, proj);
    const colours = (txt.match(/"filament_colou?r"\s*:\s*\[[^\]]*\]/) || [])[0];
    report.filamentColours = colours || null;
  }
  report.otherEntries = entries.filter((e) => !e.endsWith('.model')).slice(0, 25);
  return report;
}

for (const f of process.argv.slice(2)) {
  try {
    console.log(JSON.stringify(inspect(f), null, 1));
  } catch (err) {
    console.log(JSON.stringify({ file: f, error: err.message }));
  }
}
