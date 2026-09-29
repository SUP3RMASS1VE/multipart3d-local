'use strict';
/**
 * Minimal bridge between the page and the main process, for mesh repair only.
 * Runs sandboxed; the page gets these functions and nothing else. The main
 * process only lets the page read or reveal files that a repair produced.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mp3dRepair', {
  /** Repair an in-memory 3MF (the loaded model). Resolves { bytes, summary }. */
  repair: (arrayBuffer) => ipcRenderer.invoke('mp3d:repair', new Uint8Array(arrayBuffer)),

  /**
   * Standalone repair: native Open + Save dialogs, repaired copy written to
   * disk. Resolves { canceled } or { inputName, outputName, outputPath, summary }.
   */
  repairFile: () => ipcRenderer.invoke('mp3d:repair-pick'),

  /** Bytes of a repaired copy this session produced (for "Open in app"). */
  readOutput: (outputPath) => ipcRenderer.invoke('mp3d:read-output', String(outputPath)),

  /** Show a repaired copy this session produced in Finder. */
  reveal: (outputPath) => ipcRenderer.invoke('mp3d:reveal', String(outputPath)),

  /** Save bytes through a native Save dialog. Resolves the path or null. */
  saveAs: (arrayBuffer, suggestedName) =>
    ipcRenderer.invoke('mp3d:save', new Uint8Array(arrayBuffer), String(suggestedName || 'model_repaired.3mf')),

  onProgress: (cb) => {
    ipcRenderer.on('mp3d:repair-progress', (_e, message) => cb(message));
  },

  /** Fired once the user has picked files and the standalone repair begins. */
  onStarted: (cb) => {
    ipcRenderer.on('mp3d:repair-started', (_e, info) => cb(info));
  },
});
