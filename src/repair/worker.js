'use strict';
// worker_threads entry: runs one repair off the main thread so the window
// stays responsive during multi-million-triangle repairs.
const { parentPort, workerData } = require('node:worker_threads');
const { repair3mf } = require('./repair3mf.js');

try {
  const res = repair3mf(workerData.input, workerData.output, (message) =>
    parentPort.postMessage({ type: 'progress', message })
  );
  parentPort.postMessage({ type: 'done', ...res });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
}
