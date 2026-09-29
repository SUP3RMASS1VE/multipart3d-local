'use strict';
/**
 * Main-process side of the repair: runs src/repair/worker.js in a worker
 * thread and summarises the result for people.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

let busy = false;

/** Repairs input -> output on a worker thread. Resolves with { reports, ms }. */
function runRepair(input, output, onProgress) {
  if (busy) return Promise.reject(new Error('A repair is already running.'));
  busy = true;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { input, output },
      // Large meshes need far more than the default worker heap.
      resourceLimits: { maxOldGenerationSizeMb: 12288 },
    });
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      busy = false;
      fn(v);
    };
    worker.on('message', (m) => {
      if (m.type === 'progress') onProgress && onProgress(m.message);
      else if (m.type === 'done') finish(resolve, { reports: m.reports, ms: m.ms });
      else if (m.type === 'error') finish(reject, new Error(m.message));
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => {
      if (code !== 0) finish(reject, new Error(`repair worker stopped (code ${code}); the model may be too large`));
    });
  });
}

/** Repairs an in-memory 3MF. Resolves with { bytes: Buffer, reports, ms }. */
async function repairBytes(bytes, onProgress) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3d-repairbuf-'));
  try {
    const input = path.join(dir, 'in.3mf');
    const output = path.join(dir, 'out.3mf');
    fs.writeFileSync(input, bytes);
    const res = await runRepair(input, output, onProgress);
    return { bytes: fs.readFileSync(output), ...res };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const n = (x) => Number(x || 0).toLocaleString('en-US');

/** One summary object for the UI, merged over all repaired meshes. */
function summarise(reports) {
  const sum = (k) => reports.reduce((a, r) => a + (r[k] || 0), 0);
  const sumAfter = (k) => reports.reduce((a, r) => a + ((r.after && r.after[k]) || 0), 0);
  const sumBefore = (k) => reports.reduce((a, r) => a + ((r.before && r.before[k]) || 0), 0);
  const clean = sumAfter('boundary') === 0 && sumAfter('nonManifold') === 0 && sumAfter('orientationConflicts') === 0;

  const lines = [];
  lines.push(`Triangles: ${n(sum('inputTriangles'))} → ${n(sum('outputTriangles'))}`);
  // Slicers count open edges before joining split vertices, so this line is
  // what reconciles our numbers with, e.g., Bambu's "48,738 open edges".
  const joined = sum('inputVertices') - sum('weldedVertices');
  if (joined > 0) lines.push(`Joined ${n(joined)} split vertices (these show up as open edges in slicers)`);
  if (sum('duplicatesRemoved')) lines.push(`Removed ${n(sum('duplicatesRemoved'))} duplicate triangles`);
  if (sum('degenerateRemoved')) lines.push(`Removed ${n(sum('degenerateRemoved'))} collapsed triangles`);
  if (sum('flipped')) lines.push(`Turned ${n(sum('flipped'))} back-to-front triangles the right way round`);
  if (sum('holesFilled'))
    lines.push(`Filled ${n(sum('holesFilled'))} holes with ${n(sum('fillTriangles'))} new triangles`);
  if (sum('componentsInverted')) lines.push(`Turned ${n(sum('componentsInverted'))} inside-out pieces outward`);
  lines.push(`Open edges: ${n(sumBefore('boundary'))} → ${n(sumAfter('boundary'))}`);

  const paintLines = [];
  paintLines.push(`${n(sum('originalPaintKeptExactly'))} painted triangles kept exactly as they were`);
  if (sum('fillsColourMatched'))
    paintLines.push(`${n(sum('fillsColourMatched'))} new triangles matched to the colour around them`);
  if (sum('fillsLeftBase'))
    paintLines.push(
      `${n(sum('fillsLeftBase'))} new triangles on colour borders left in the base filament (paint over them in the slicer)`
    );
  if (sum('flippedSplitPaintReduced'))
    paintLines.push(`${n(sum('flippedSplitPaintReduced'))} flipped triangles had fine paint detail simplified`);

  const problems = [];
  if (sumAfter('boundary')) problems.push(`${n(sumAfter('boundary'))} open edges remain`);
  if (sumAfter('nonManifold')) problems.push(`${n(sumAfter('nonManifold'))} edges shared by more than two triangles remain`);
  if (sumAfter('orientationConflicts')) problems.push(`${n(sumAfter('orientationConflicts'))} winding conflicts remain`);

  const changes =
    joined +
    sum('duplicatesRemoved') +
    sum('degenerateRemoved') +
    sum('flipped') +
    sum('holesFilled') +
    sum('componentsInverted');

  return { clean, nothingToFix: clean && changes === 0, lines, paintLines, problems, fillsLeftBase: sum('fillsLeftBase') };
}

function isBusy() {
  return busy;
}

module.exports = { runRepair, repairBytes, summarise, isBusy };
