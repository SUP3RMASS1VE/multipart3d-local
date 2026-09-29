'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const repairService = require('./src/repair/service.js');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SITE_DIR = path.join(__dirname, 'site');

// Kept in sync with tools/sync-site.mjs (FONT_CDN).
const FONT_CDN =
  'https://cdn.jsdelivr.net/gh/lojjic/unicode-font-resolver@v1.0.1/packages/data';

/* ------------------------------------------------------------------ *
 * Performance / stability switches
 *
 * Honest scope note: the mesh booleans run in a single-threaded
 * WebAssembly module (Manifold) on the renderer's main thread. Nothing
 * here makes that math faster, and a long cut will still stop painting
 * while it runs. What these switches do buy:
 *
 *   - the work no longer competes with other browser tabs
 *   - macOS/Chromium never throttles or backgrounds the process
 *   - V8 is asked for its maximum heap up front instead of growing into it
 *   - a hung or crashed renderer only takes down this window
 *
 * V8 in Electron is built with pointer compression, so the JS heap is
 * capped near 4 GB no matter what we request here. Asking for more is
 * harmless; it just clamps.
 * ------------------------------------------------------------------ */
const totalGiB = os.totalmem() / 1024 ** 3;
const heapMB = Math.max(4096, Math.min(8192, Math.floor(totalGiB * 0.25) * 1024));

app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${heapMB} --expose-gc`);
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'IntensiveWakeUpThrottling,CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-zero-copy');
// Renderer gets its own process and is never shared with anything else.
app.commandLine.appendSwitch('renderer-process-limit', '4');

/* ------------------------------------------------------------------ *
 * Static file server on 127.0.0.1
 *
 * Serving over http (instead of file://) keeps the app's original
 * semantics intact: ES module workers, WASM streaming compilation and
 * same-origin fetches all behave exactly as they do on the website.
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.hdr': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveSafe(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = path.normalize(path.join(SITE_DIR, decoded));
  // Block path traversal outside of site/
  if (target !== SITE_DIR && !target.startsWith(SITE_DIR + path.sep)) return null;
  return target;
}

async function statFile(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        let filePath = resolveSafe(req.url || '/');
        if (!filePath) {
          res.writeHead(403).end('Forbidden');
          return;
        }

        let st = await statFile(filePath);
        if (!st && (await statFile(path.join(filePath, 'index.html')))) {
          filePath = path.join(filePath, 'index.html');
          st = await statFile(filePath);
        }
        // SPA fallback: client-side routes (/faq, /features/...) have no file.
        // Asset requests must NOT fall back to HTML, or the renderer tries to
        // parse HTML as JavaScript.
        if (!st) {
          const ext = path.extname(filePath).toLowerCase();
          if (ext && ext !== '.html') {
            console.warn(`[missing asset] ${req.url}`);
            res.writeHead(404).end('Not found');
            return;
          }
          filePath = path.join(SITE_DIR, 'index.html');
          st = await statFile(filePath);
        }
        if (!st) {
          res.writeHead(404).end('Not found');
          return;
        }

        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Content-Length': st.size,
          'Cache-Control': 'no-cache',
          // Needed for the redirected font-CDN request, which the worker
          // issues as a cross-origin fetch. Server is loopback-only.
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });

    // A STABLE port matters for correctness, not just tidiness: the origin is
    // scheme://host:port, so a random port each launch means a brand new
    // localStorage every time. That is why the app forgot dismissed dialogs
    // and printer choices on every start.
    const candidates = [47615, 47616, 47617, 47618, 0];
    let i = 0;

    const tryNext = () => {
      const port = candidates[i++];
      server.listen(port, '127.0.0.1', () => {
        const actual = server.address().port;
        if (port === 0) {
          console.warn(
            `[mp3d] preferred ports busy; using random port ${actual}. ` +
              'Saved settings and dismissed dialogs will not persist this session.'
          );
        }
        resolve(actual);
      });
    };

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && i < candidates.length) {
        server.removeAllListeners('listening');
        tryNext();
        return;
      }
      reject(err);
    });

    tryNext();
  });
}

/* ------------------------------------------------------------------ */

let win = null;

function buildMenu(port) {
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload App',
          accelerator: 'CmdOrCtrl+R',
          click: () => win && win.loadURL(`http://127.0.0.1:${port}/`),
        },
        { type: 'separator' },
        {
          label: 'Repair 3MF File…',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => win && win.webContents.executeJavaScript('window.__mp3dRepairFile && window.__mp3dRepairFile()'),
        },
        {
          label: 'Repair Current Model',
          click: () => win && win.webContents.executeJavaScript('window.__mp3dRepairCurrent && window.__mp3dRepairCurrent()'),
        },
        { type: 'separator' },
        {
          label: 'Open Downloads Folder',
          click: () => shell.openPath(app.getPath('downloads')),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Performance',
      submenu: [
        {
          label: 'Raycast Acceleration',
          type: 'checkbox',
          checked: true,
          click: async (item) => {
            const enable = item.checked;
            const ok = await win.webContents
              .executeJavaScript(
                `(() => {
                  const proto = globalThis.__mp3dMesh &&
                    (function(p){ while (p && !Object.prototype.hasOwnProperty.call(p,'raycast'))
                      p = Object.getPrototypeOf(p); return p; })(Object.getPrototypeOf(globalThis.__mp3dMesh));
                  if (!proto || !globalThis.__mp3dOriginalRaycast) return false;
                  proto.raycast = ${enable ? 'globalThis.__mp3dPatchedRaycast' : 'globalThis.__mp3dOriginalRaycast'};
                  return true;
                })()`
              )
              .catch(() => false);
            if (!ok) {
              item.checked = !enable;
              dialog.showMessageBox(win, {
                type: 'warning',
                message: 'Could not toggle raycast acceleration.',
                detail: 'Load a model first, then try again.',
                buttons: ['OK'],
              });
            }
          },
        },
        {
          label: 'Show Raycast Statistics',
          click: async () => {
            const s = await win.webContents
              .executeJavaScript(`globalThis.__mp3dBvhStats ? globalThis.__mp3dBvhStats() : null`)
              .catch(() => null);
            dialog.showMessageBox(win, {
              type: 'info',
              message: s ? 'Raycast acceleration' : 'Not active yet',
              detail: s
                ? `BVHs built: ${s.builds} (${Math.round(s.buildMs)} ms total)\n` +
                  `Accelerated raycasts: ${s.fastRaycasts}\n` +
                  `Unaccelerated (small meshes / warm-up): ${s.slowRaycasts}\n` +
                  `Fallbacks: ${s.fallbacks}\n\n` +
                  `Triangles per raycast: ${s.avgCandidates} tested instead of ${s.avgTriangles}`
                : 'Load a model and move the pointer over it first.',
              buttons: ['OK'],
            });
          },
        },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'About This Build',
          click: () =>
            dialog.showMessageBox(win, {
              type: 'info',
              message: 'Multipart3D Local',
              detail:
                'A local, offline copy of multipart3d.com by Roy Roeven (dreamlayer.nl), ' +
                'wrapped in Electron for personal use.\n\n' +
                `Requested JS heap: ${heapMB} MB (V8 caps this near 4096 MB)\n` +
                `Serving: ${SITE_DIR}\n\n` +
                'All model processing happens on this Mac. Nothing is uploaded.',
              buttons: ['OK'],
            }),
        },
        {
          label: 'Open Original Website',
          click: () => shell.openExternal('https://multipart3d.com/'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * Mesh repair (paint-preserving). Heavy work runs on a worker thread.
 * ------------------------------------------------------------------ */

function sendProgress(message) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('mp3d:repair-progress', message);
  win.setProgressBar(2); // indeterminate on the Dock icon
}

function clearProgress() {
  if (win && !win.isDestroyed()) win.setProgressBar(-1);
}

// Only accept repair requests from our own page.
function fromOurPage(e) {
  return !!(e.senderFrame && /^http:\/\/127\.0\.0\.1:\d+\//.test(e.senderFrame.url));
}

ipcMain.handle('mp3d:repair', async (e, bytes) => {
  if (!fromOurPage(e)) throw new Error('not allowed');
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) throw new Error('not a 3MF file');
  try {
    const res = await repairService.repairBytes(Buffer.from(bytes), sendProgress);
    return { bytes: new Uint8Array(res.bytes), summary: repairService.summarise(res.reports) };
  } finally {
    clearProgress();
  }
});

ipcMain.handle('mp3d:save', async (e, bytes, suggestedName) => {
  if (!fromOurPage(e)) throw new Error('not allowed');
  const safeName = path.basename(String(suggestedName)).replace(/[^\w .()+-]/g, '_') || 'model_repaired.3mf';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save repaired 3MF',
    defaultPath: path.join(app.getPath('downloads'), safeName),
    filters: [{ name: '3MF model', extensions: ['3mf'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
});

/* ---- standalone repair: file on disk -> repaired copy on disk ------ */

// Paths this session produced. The page may only read or reveal these.
const producedOutputs = new Set();

async function pickRepairPaths() {
  // Test hook: skip the two native dialogs.
  if (process.env.MP3D_SMOKE === '1' && process.env.MP3D_TEST_PICK_IN) {
    return { input: process.env.MP3D_TEST_PICK_IN, output: process.env.MP3D_TEST_PICK_OUT };
  }
  const pick = await dialog.showOpenDialog(win, {
    title: 'Choose a 3MF model to repair',
    properties: ['openFile'],
    filters: [{ name: '3MF model', extensions: ['3mf'] }],
  });
  if (pick.canceled || !pick.filePaths[0]) return null;
  const input = pick.filePaths[0];
  const base = path.basename(input).replace(/\.3mf$/i, '').replace(/_repaired$/i, '');
  const save = await dialog.showSaveDialog(win, {
    title: 'Save the repaired copy as',
    defaultPath: path.join(path.dirname(input), `${base}_repaired.3mf`),
    filters: [{ name: '3MF model', extensions: ['3mf'] }],
  });
  if (save.canceled || !save.filePath) return null;
  if (path.resolve(save.filePath) === path.resolve(input)) {
    throw new Error('Choose a different name for the repaired copy. The repair never overwrites your original.');
  }
  return { input, output: save.filePath };
}

ipcMain.handle('mp3d:repair-pick', async (e) => {
  if (!fromOurPage(e)) throw new Error('not allowed');
  if (repairService.isBusy()) throw new Error('A repair is already running.');
  const paths = await pickRepairPaths();
  if (!paths) return { canceled: true };
  const { input, output } = paths;
  e.sender.send('mp3d:repair-started', { name: path.basename(input) });
  try {
    win.setTitle(`Repairing ${path.basename(input)}…`);
    const res = await repairService.runRepair(input, output, sendProgress);
    producedOutputs.add(path.resolve(output));
    return {
      canceled: false,
      inputName: path.basename(input),
      outputName: path.basename(output),
      outputPath: output,
      summary: repairService.summarise(res.reports),
    };
  } finally {
    clearProgress();
    win.setTitle('Multipart3D Local');
  }
});

function producedPath(p) {
  const r = path.resolve(String(p || ''));
  if (!producedOutputs.has(r)) throw new Error('not allowed');
  return r;
}

ipcMain.handle('mp3d:read-output', (e, p) => {
  if (!fromOurPage(e)) throw new Error('not allowed');
  return new Uint8Array(fs.readFileSync(producedPath(p)));
});

ipcMain.handle('mp3d:reveal', (e, p) => {
  if (!fromOurPage(e)) throw new Error('not allowed');
  shell.showItemInFolder(producedPath(p));
  return true;
});

async function createWindow(port) {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#111318',
    title: 'Multipart3D Local',
    show: false,
    webPreferences: {
      // Only exposes window.mp3dRepair (repair / save / progress). See preload.js.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      webgl: true,
      spellcheck: false,
    },
  });

  /* ---------------------------------------------------------------- *
   * Network policy. Electron allows only one onBeforeRequest listener
   * per session, so all rules live here.
   *
   *  - analytics beacons are dropped
   *  - the troika font CDN is redirected to the local mirror. That fetch
   *    happens inside a blob-URL worker, where a root-relative path has
   *    no base to resolve against, so it has to be rewritten here where
   *    the server port is known.
   *  - MP3D_OFFLINE_TEST=1 refuses everything non-local (test aid)
   * ---------------------------------------------------------------- */
  const localBase = `http://127.0.0.1:${port}`;
  const ANALYTICS = ['va.vercel-scripts.com', 'vercel-insights.com', '/_vercel/insights/'];

  win.webContents.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    const { url } = details;

    if (ANALYTICS.some((frag) => url.includes(frag))) return cb({ cancel: true });

    // Test aid: block the dialog-suppression seed, to prove the dialog test
    // actually detects the dialogs when they are present.
    if (process.env.MP3D_NO_PREFS === '1' && url.endsWith('/mp3d-prefs.js')) {
      return cb({ cancel: true });
    }

    if (url.startsWith(FONT_CDN)) {
      return cb({ redirectURL: localBase + '/fontdata' + url.slice(FONT_CDN.length) });
    }

    const isLocal = url.startsWith(localBase) || url.startsWith('devtools:');
    if (process.env.MP3D_LOG_EXTERNAL === '1' && !isLocal) console.log(`[external] ${url}`);
    if (process.env.MP3D_OFFLINE_TEST === '1' && !isLocal) {
      console.log(`[offline-blocked] ${url}`);
      return cb({ cancel: true });
    }
    cb({});
  });

  // External links go to the default browser, not into this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'The 3D engine stopped responding.',
      detail:
        `Reason: ${details.reason}\n\n` +
        'This usually means the model was too large for the mesh engine. ' +
        'Reload and try a lower-detail version of the model.',
      buttons: ['Reload', 'Quit'],
    }).then(({ response }) => {
      if (response === 0) win.loadURL(`http://127.0.0.1:${port}/`);
      else app.quit();
    });
  });

  // In test mode, downloads go to a temp folder instead of ~/Downloads.
  if (process.env.MP3D_SMOKE === '1') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3d-dl-'));
    win.webContents.session.on('will-download', (_e, item) => {
      const target = path.join(dir, item.getFilename());
      item.setSavePath(target);
      item.once('done', (_ev, state) => console.log(`DOWNLOAD_DONE ${state} ${target}`));
    });
    console.log('DOWNLOAD_DIR ' + dir);
  }

  win.once('ready-to-show', () => {
    win.show();
    if (process.env.MP3D_MAXIMIZE === '1') win.maximize();
  });

  // Smoke test hook: MP3D_SMOKE=1 prints renderer diagnostics then exits.
  if (process.env.MP3D_SMOKE === '1') {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[renderer:${level}] ${message}`);
    });
  }

  await win.loadURL(`http://127.0.0.1:${port}/`);

  if (process.env.MP3D_SMOKE === '1') {
    // Control mode: wipe the persisted flags so the dialogs really do get a
    // chance to appear. Now that the port is stable, localStorage survives
    // across runs, so a previous seeded run would otherwise mask the test.
    if (process.env.MP3D_NO_PREFS === '1') {
      await win.webContents.executeJavaScript(
        `localStorage.removeItem('m3d.introSeenRevision');
         localStorage.removeItem('m3d.thanksHidden'); true`
      );
      await win.webContents.reload();
      await new Promise((r) => setTimeout(r, 3000));
    }

    await new Promise((r) => setTimeout(r, 4000));

    if (process.env.MP3D_SMOKE_FILE) {
      const name = JSON.stringify(process.env.MP3D_SMOKE_FILE);
      await win.webContents.executeJavaScript(`(async () => {
        const res = await fetch('/' + ${name});
        const blob = await res.blob();
        const file = new File([blob], ${name}.replace('__smoke', 'model'), { type: 'model/stl' });
        const input = document.querySelector('input[type=file]');
        if (!input) throw new Error('file input not found');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      // Wait until the model is actually loaded (large painted 3MFs can take
      // well over 20 s), rather than a fixed sleep.
      const loadDeadline = Date.now() + 180000;
      await new Promise((r) => setTimeout(r, 3000));
      while (Date.now() < loadDeadline) {
        const loaded = await win.webContents
          .executeJavaScript(`/MODEL INFO/.test(document.body.innerText)`)
          .catch(() => false);
        if (loaded) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (process.env.MP3D_PROBE === '1') {
      const controls = await win.webContents.executeJavaScript(`
        [...document.querySelectorAll('button,[role=button]')]
          .map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g,' '))
          .filter(Boolean)
      `);
      console.log('PROBE_CONTROLS ' + JSON.stringify(controls));
    }

    if (process.env.MP3D_PROBE_PRINTER === '1') {
      if (process.env.MP3D_PROBE_TARGET) {
        await win.webContents.executeJavaScript(
          `globalThis.__mp3dProbeTarget = ${JSON.stringify(process.env.MP3D_PROBE_TARGET)}; true`
        );
      }
      const src = fs.readFileSync(path.join(__dirname, 'tools', 'probe-printer.js'), 'utf8');
      const res = await win.webContents.executeJavaScript(src, true).catch((e) => ({ error: e.message }));
      console.log('PROBE_PRINTER ' + JSON.stringify(res));
    }

    // Exercise a real boolean cut: this is the Manifold WASM path.
    if (process.env.MP3D_SMOKE_CUT === '1') {
      const click = (label) => `(() => {
        const el = [...document.querySelectorAll('button,[role=button]')]
          .find(b => (b.innerText || b.getAttribute('aria-label') || '')
            .trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}));
        if (!el) return false;
        el.click();
        return true;
      })()`;

      const opened = await win.webContents.executeJavaScript(click('planar cut'));
      console.log('CUT_TOOL_OPENED ' + opened);
      await new Promise((r) => setTimeout(r, 2500));

      if (process.env.MP3D_PROBE === '1') {
        const controls = await win.webContents.executeJavaScript(`
          [...document.querySelectorAll('button,[role=button]')]
            .map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g,' '))
            .filter(Boolean)
        `);
        console.log('PROBE_CUT_CONTROLS ' + JSON.stringify(controls));
      }

      const applyLabel = process.env.MP3D_CUT_LABEL || 'apply cut';
      const t0 = Date.now();
      const applied = await win.webContents.executeJavaScript(click(applyLabel));
      console.log('CUT_APPLIED ' + applied);

      // Poll for the parts list so we can report how long the cut really took.
      let cutMs = null;
      const limit = Date.now() + 120000;
      while (Date.now() < limit) {
        const done = await win.webContents.executeJavaScript(
          `/PARTS \\((\\d+)\\)/.test(document.body.innerText)`
        );
        if (done) {
          cutMs = Date.now() - t0;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      console.log('CUT_MS ' + cutMs);
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Scale the model up before profiling. The lag the user reports only
    // appears on a supersized model, so measuring at default scale is
    // measuring the wrong thing.
    if (process.env.MP3D_SUPERSIZE) {
      const label = process.env.MP3D_SUPERSIZE; // e.g. "3", "5", "10"
      const clicked = await win.webContents.executeJavaScript(`(() => {
        const want = ['\\u00d7' + ${JSON.stringify(label)}, 'x' + ${JSON.stringify(label)}];
        const el = [...document.querySelectorAll('button,[role=button]')].find(b => {
          const t = (b.innerText || '').trim().toLowerCase();
          return want.some(w => t === w.toLowerCase());
        });
        if (!el) return false;
        el.click();
        return true;
      })()`);
      console.log('SUPERSIZE_CLICKED ' + clicked + ' (x' + label + ')');
      await new Promise((r) => setTimeout(r, 6000));
      const dims = await win.webContents.executeJavaScript(
        `(() => { const m = document.body.innerText.match(/DIMENSIONS[\\s\\S]{0,60}/); return m ? m[0].replace(/\\s+/g,' ') : null; })()`
      );
      console.log('SUPERSIZE_DIMS ' + JSON.stringify(dims));
    }

    // Checks both dialogs. Run with MP3D_NO_PREFS=1 as a control: that blocks
    // the suppression seed, so the dialogs SHOULD be detected. If the control
    // reports "clean" too, the test is broken rather than the fix working.
    if (process.env.MP3D_TEST_DIALOGS === '1') {
      const flags = await win.webContents.executeJavaScript(
        `JSON.stringify({intro: localStorage.getItem('m3d.introSeenRevision'), thanks: localStorage.getItem('m3d.thanksHidden')})`
      );
      console.log('DIALOG_FLAGS ' + flags);

      const introVisible = await win.webContents.executeJavaScript(`(() => {
        const t = document.body.innerText || '';
        return t.includes('Explore the features') || t.includes('Get started');
      })()`);
      console.log('DIALOG_INTRO_VISIBLE ' + introVisible);

      // Cut, then download, which is what triggers the thanks dialog.
      const click = (label) => `(() => {
        const el = [...document.querySelectorAll('button,[role=button]')]
          .find(b => (b.innerText || '').trim().toLowerCase().startsWith(${JSON.stringify('')} + ${JSON.stringify(label)}));
        if (!el) return false;
        el.click();
        return true;
      })()`;

      await win.webContents.executeJavaScript(click('planar cut'));
      await new Promise((r) => setTimeout(r, 2500));
      await win.webContents.executeJavaScript(click('place cut'));

      let ready = false;
      const limit = Date.now() + 90000;
      while (Date.now() < limit) {
        ready = await win.webContents.executeJavaScript(
          `/PARTS \\((\\d+)\\)/.test(document.body.innerText)`
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      console.log('DIALOG_CUT_DONE ' + ready);

      const dl = await win.webContents.executeJavaScript(click('all .zip'));
      console.log('DIALOG_DOWNLOAD_CLICKED ' + dl);
      await new Promise((r) => setTimeout(r, 12000));

      const thanksVisible = await win.webContents.executeJavaScript(`(() => {
        const t = document.body.innerText || '';
        return t.includes('Enjoy your multipart') || t.includes('Leave a like or boost');
      })()`);
      console.log('DIALOG_THANKS_VISIBLE ' + thanksVisible);
      console.log(
        'DIALOG_RESULT ' +
          JSON.stringify({ introVisible, thanksVisible, clean: !introVisible && !thanksVisible })
      );
    }

    // Colour-preserving export: load a painted 3MF, cut it, export every part
    // as 3MF. tools/verify-color-export.mjs then checks the files.
    if (process.env.MP3D_TEST_COLOR === '1') {
      const click = (label) => `(() => {
        const el = [...document.querySelectorAll('button,[role=button]')]
          .find(b => (b.innerText || '').trim().toLowerCase().startsWith(${JSON.stringify(label)}));
        if (!el) return false;
        el.click();
        return true;
      })()`;

      const inApp = await win.webContents.executeJavaScript(`(() => {
        const scene = globalThis.__mp3dScene;
        let tris = 0;
        if (scene) scene.traverse(o => {
          if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.color) {
            const g = o.geometry; tris = Math.max(tris, (g.index ? g.index.count : g.attributes.position.count) / 3);
          }
        });
        return { colouredMeshTris: tris, srcZip: !!globalThis.__mp3dSrcZip, exporter: typeof globalThis.__mp3dExport3mf };
      })()`);
      console.log('COLOR_LOADED ' + JSON.stringify(inApp));

      const buttons = () =>
        win.webContents.executeJavaScript(
          `[...document.querySelectorAll('button')].map(b => (b.innerText||'').trim().replace(/\\s+/g,' ')).filter(Boolean)`
        );
      console.log('COLOR_OPEN_PLANAR ' + (await win.webContents.executeJavaScript(click('planar cut'))));
      await new Promise((r) => setTimeout(r, 3000));
      console.log('COLOR_BUTTONS ' + JSON.stringify(await buttons()));
      console.log('COLOR_PLACE ' + (await win.webContents.executeJavaScript(click('place cut'))));

      let parts = 0;
      const limit = Date.now() + 180000;
      while (Date.now() < limit) {
        parts = await win.webContents.executeJavaScript(
          `(() => { const m = document.body.innerText.match(/PARTS \\((\\d+)\\)/); return m ? +m[1] : 0; })()`
        );
        if (parts >= 2) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      console.log('COLOR_CUT_PARTS ' + parts);
      if (parts < 2) {
        const err = await win.webContents.executeJavaScript(
          `(() => { const m = (document.body.innerText||'').match(/The cut couldn.t be completed[^\\n]*/); return m ? m[0] : null; })()`
        );
        console.log('COLOR_CUT_ERROR ' + JSON.stringify(err));
      }
      if (parts < 2) {
        const txt = await win.webContents.executeJavaScript(
          `(document.body.innerText||'').replace(/\\s*\\n\\s*/g,' | ').slice(0,1200)`
        );
        console.log('COLOR_PAGE ' + txt);
      }

      console.log('COLOR_FORMAT_3MF ' + (await win.webContents.executeJavaScript(click('3mf'))));
      await new Promise((r) => setTimeout(r, 500));
      console.log('COLOR_DOWNLOAD_CLICKED ' + (await win.webContents.executeJavaScript(click('all .zip'))));

      // Export of multi-million-triangle parts takes a while.
      const until = Date.now() + 240000;
      let st = null;
      while (Date.now() < until) {
        st = await win.webContents.executeJavaScript(
          `globalThis.__mp3dColorStats ? globalThis.__mp3dColorStats() : null`
        );
        if (st && st.exports >= parts) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      await new Promise((r) => setTimeout(r, 5000));
      console.log('COLOR_STATS ' + JSON.stringify(st));
    }

    // One ordinary cut through the app's own store, with N connectors placed
    // far apart, for each connector type. Isolates the app's connector
    // geometry from anything auto-cut does.
    if (process.env.MP3D_TEST_ONECUT === '1') {
      const res = await win.webContents.executeJavaScript(`(async () => {
        const S = globalThis.__mp3dCutStore, st = () => S.getState();
        const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const nm = (geom) => {
          const pos = geom.getAttribute('position');
          const bits = new Uint32Array(pos.array.buffer, pos.array.byteOffset, pos.count * 3);
          const vid = new Map(); const ids = new Uint32Array(pos.count);
          for (let i = 0; i < pos.count; i++) { const k = bits[i*3]+','+bits[i*3+1]+','+bits[i*3+2]; let w = vid.get(k); if (w === undefined) vid.set(k, (w = vid.size)); ids[i] = w; }
          const V = vid.size, cnt = new Map(), faces = new Map();
          for (let t = 0; t < pos.count / 3; t++) { const s = [ids[t*3], ids[t*3+1], ids[t*3+2]].sort((a,b)=>a-b).join(','); faces.set(s, (faces.get(s)||0)+1);
            for (let e = 0; e < 3; e++) { const a = ids[t*3+e], b = ids[t*3+(e+1)%3]; const k = a < b ? a*V+b : b*V+a; cnt.set(k, (cnt.get(k)||0)+1); } }
          let n = 0, open = 0; for (const c of cnt.values()) { if (c > 2) n++; if (c === 1) open++; }
          let dupFaces = 0; for (const c of faces.values()) if (c > 1) dupFaces += c - 1;
          return { nm: n, open, dupFaces };
        };
        const base = st().history[st().historyIndex];
        const types = ${JSON.stringify((process.env.MP3D_ONECUT_TYPES || 'none,plug,dowel,magnet,snap').split(','))};
        const counts = ${JSON.stringify((process.env.MP3D_ONECUT_COUNTS || '1,4').split(',').map(Number))};
        const out = [];
        // Optional: first make a plain Y cut at MP3D_ONECUT_PRE and test the
        // connector cut on its upper piece ("B"), the way auto-cut's 2nd cut
        // works on an already-cut part.
        const pre = ${JSON.stringify(process.env.MP3D_ONECUT_PRE || '')};
        for (const type of types) for (const count of (type === 'none' ? [0] : counts)) {
          // Restore the original single part.
          S.setState({ parts: base.parts.map(p => ({ ...p })), nextPartIndex: base.nextPartIndex });
          await frame();
          let part = st().parts[0];
          if (pre) {
            st().setCutMethod('planar'); st().selectPart(part.id); st().enterCutMode(); await frame();
            const q = st().parts.find(x => x.id === part.id), b0 = q.boundingBox;
            st().setCutNormal({ x: 0, y: 1, z: 0 });
            st().setCutOrigin({ x: 0, y: b0.min.y + Number(pre), z: 0 });
            st().clearConnectors();
            await st().enterConnectorsStage();
            const ids0 = new Set(st().parts.map(x => x.id));
            if (${JSON.stringify(process.env.MP3D_ONECUT_PRE_CONN || '')}) {
              const pv0 = st().cutPreview, V0 = b0.min.constructor;
              const w0 = new V0((pv0.capBounds.uMin + pv0.capBounds.uMax) / 2, (pv0.capBounds.vMin + pv0.capBounds.vMax) / 2, pv0.offset).applyQuaternion(pv0.planeQuat);
              st().addConnectorAtWorld(w0);
            }
            await st().confirmCut();
            const made = st().parts.filter(x => !ids0.has(x.id));
            part = made.find(x => / B$/.test(x.name)) || made[1];
            out.push({ pre: Number(pre), preOuts: made.map(x => ({ name: x.name, ...nm(x.geometry) })) });
          }
          st().setCutMethod('planar'); st().selectPart(part.id); st().enterCutMode(); await frame();
          const p = st().parts.find(q => q.id === part.id);
          const bb = p.boundingBox;
          st().setCutNormal({ x: 0, y: 1, z: 0 });
          st().setCutOrigin({ x: (bb.min.x+bb.max.x)/2, y: bb.min.y + (bb.max.y-bb.min.y) * ${Number(process.env.MP3D_ONECUT_AT || 0.19)}, z: (bb.min.z+bb.max.z)/2 });
          if (type !== 'none') st().setConnectorParams({ type });
          await st().enterConnectorsStage();
          const pv = st().cutPreview;
          if (!pv) { out.push({ type, count, error: st().cutError }); continue; }
          // Candidate spots: sample the face, keep the most inset, spread apart.
          const Vec = bb.min.constructor;
          let placed = 0;
          if (count) {
            const { uMin, uMax, vMin, vMax } = pv.capBounds;
            const spots = [];
            for (let i = 1; i < 12; i++) for (let j = 1; j < 12; j++) spots.push([uMin + (uMax-uMin)*i/12, vMin + (vMax-vMin)*j/12]);
            const chosen = [];
            for (const [u, v] of spots) {
              if (placed >= count) break;
              const w = new Vec(u, v, pv.offset).applyQuaternion(pv.planeQuat);
              const id = st().addConnectorAtWorld(w);
              if (!id) continue;
              const c = st().connectors.find(k => k.id === id);
              if (chosen.some(q => Math.hypot(q[0]-c.u, q[1]-c.v) < 12)) { st().removeConnector(id); continue; }
              chosen.push([c.u, c.v]); placed++;
            }
          }
          const before = new Set(st().parts.map(q => q.id));
          await st().confirmCut();
          const outs = st().parts.filter(q => !before.has(q.id)).map(q => ({ name: q.name, ...nm(q.geometry) }));
          out.push({ type, count, placed, error: st().cutError, outs });
        }
        return out;
      })()`, true).catch((e) => ({ error: e.message }));
      console.log('ONECUT ' + JSON.stringify(res));
    }

    // Plates: auto-cut (optional), open the Plates dialog, Auto-arrange,
    // click Export. The download lands in the test download dir.
    //   MP3D_PLATES_PRINTER  preset id      MP3D_PLATES_SCALE  optional
    //   MP3D_PLATES_CUT=1    auto-cut first
    if (process.env.MP3D_TEST_PLATES === '1') {
      const js = (s) => win.webContents.executeJavaScript(s);
      const waitFor = async (expr, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const v = await js(expr).catch(() => null);
          if (v) return v;
          await new Promise((r) => setTimeout(r, 300));
        }
        return null;
      };
      const out = {};
      if (process.env.MP3D_PLATES_PRINTER) {
        out.bed = await js(`(() => { globalThis.__mp3dPrinterStore.getState().selectPreset(${JSON.stringify(process.env.MP3D_PLATES_PRINTER)}); return globalThis.__mp3dPrinterStore.getState().getBuildVolume(); })()`);
      }
      if (process.env.MP3D_PLATES_SCALE) {
        await js(`(() => { const s = globalThis.__mp3dCutStore.getState(); for (const p of s.parts) s.setPartTransform(p.id, { scale: ${Number(process.env.MP3D_PLATES_SCALE)} }); s.commitToHistory(); return true; })()`);
      }
      if (process.env.MP3D_PLATES_CUT === '1') {
        out.cut = await js(`window.__mp3dAutoCut({ margin: 5, connectors: true }, () => {}).then(r => ({ cuts: r.cuts, parts: r.parts, allFit: r.allFit }))`);
      }
      out.button = await waitFor(`(() => { const b = document.querySelector('.mp3d-pl-btn'); return b ? b.textContent : null; })()`, 20000);
      await js(`document.querySelector('.mp3d-pl-btn').click(); true`);
      await waitFor(`!!document.querySelector('.mp3d-pl .card')`, 300000);
      out.dialog = await js(`document.querySelector('.mp3d-pl').innerText.split('\\n').filter(Boolean).slice(0, 8)`);
      out.plan = await js(`(() => { const L = window.__mp3dPlates.layout(); return { plates: L.plates.map(p => ({ name: p.name, parts: p.items.length, overflow: p.overflow.length })), tooBig: L.tooBig.length }; })()`);
      const t0img = Date.now();
      out.imagesDone = await waitFor(`window.__mp3dPlateImagesDone === true`, 300000);
      out.imagesMs = Date.now() - t0img;
      if (process.env.MP3D_CAPTURE_PLATES) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.MP3D_CAPTURE_PLATES, img.toPNG());
      }
      await js(`window.__mp3dLastProject = null; [...document.querySelectorAll('.mp3d-pl button')].find(b => b.textContent === 'Export project 3MF').click(); true`);
      out.report = await waitFor(`window.__mp3dLastProject`, 900000);
      await new Promise((r) => setTimeout(r, 4000));
      out.status = await js(`(document.querySelector('.mp3d-pl .status') || {}).textContent || null`);
      console.log('PLATES ' + JSON.stringify(out));
    }

    // Auto-cut, driven through the real side-panel button and setup panel.
    //   MP3D_AUTOCUT_PRINTER  preset id, e.g. flashforge-ad5x
    //   MP3D_AUTOCUT_SCALE    optional part scale before cutting
    //   MP3D_AUTOCUT_EXPORT=1 also export all parts as a 3MF zip
    if (process.env.MP3D_TEST_AUTOCUT === '1') {
      const js = (s) => win.webContents.executeJavaScript(s);
      const waitFor = async (expr, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const v = await js(expr).catch(() => null);
          if (v) return v;
          await new Promise((r) => setTimeout(r, 300));
        }
        return null;
      };
      const out = {};
      if (process.env.MP3D_AUTOCUT_PRINTER) {
        out.printerSet = await js(`(() => { const s = globalThis.__mp3dPrinterStore.getState(); s.selectPreset(${JSON.stringify(process.env.MP3D_AUTOCUT_PRINTER)}); return s.getBuildVolume && globalThis.__mp3dPrinterStore.getState().getBuildVolume(); })()`);
      }
      if (process.env.MP3D_AUTOCUT_SCALE) {
        await js(`(() => { const s = globalThis.__mp3dCutStore.getState(); for (const p of s.parts) s.setPartTransform(p.id, { scale: ${Number(process.env.MP3D_AUTOCUT_SCALE)} }); s.commitToHistory(); return true; })()`);
        await new Promise((r) => setTimeout(r, 1500));
      }
      out.before = await js(`globalThis.__mp3dCutStore.getState().parts.map(p => { const s = window.__mp3dPartSize(p); const L = p.slotLabels; const hist = {}; if (L) for (let i = 0; i < L.length; i++) hist[L[i]] = (hist[L[i]] || 0) + 1; return { name: p.name, size: [s.x, s.y, s.z].map(v => Math.round(v)), tris: p.triangleCount, labelHistogram: hist }; })`);
      out.button = await waitFor(`(() => { const b = document.querySelector('.mp3d-ac-btn'); return b ? b.textContent : null; })()`, 20000);
      await js(`document.querySelector('.mp3d-ac-btn').click(); true`);
      await new Promise((r) => setTimeout(r, 500));
      out.setupText = await js(`document.querySelector('.mp3d-ac') ? document.querySelector('.mp3d-ac').innerText : null`);
      if (process.env.MP3D_AUTOCUT_NO_CONNECTORS === '1') {
        await js(`(() => { const c = document.getElementById('mp3d-ac-conn'); if (c.checked) c.click(); return c.checked; })()`);
      }
      const t0 = Date.now();
      await js(`window.__mp3dAutoCutReport = null; [...document.querySelectorAll('.mp3d-ac button')].find(b => b.textContent === 'Auto-cut').click(); true`);
      out.report = await waitFor(`window.__mp3dAutoCutReport`, 1500000);
      out.wallMs = Date.now() - t0;
      out.resultText = await js(`document.querySelector('.mp3d-ac') ? document.querySelector('.mp3d-ac').innerText : null`);
      out.after = await js(`(() => { const v = globalThis.__mp3dPrinterStore.getState().getBuildVolume(); return globalThis.__mp3dCutStore.getState().parts.map(p => { const s = window.__mp3dPartSize(p); const labels = p.slotLabels; let painted = 0; const hist = {}; if (labels) for (let i = 0; i < labels.length; i++) { hist[labels[i]] = (hist[labels[i]] || 0) + 1; if (labels[i] > 1) painted++; } return { name: p.name, size: [s.x, s.y, s.z].map(x => Math.round(x * 10) / 10), tris: p.triangleCount, paintedTris: painted, labelHistogram: hist, hasLabels: !!labels, fits: window.__mp3dAutoCutFits(p.id, 0), appBadgeFits: !!v && p.dimensions.x <= v.x && p.dimensions.y <= v.y && p.dimensions.z <= v.z }; }); })()`);
      out.historyLength = await js(`globalThis.__mp3dCutStore.getState().history.length`);
      if (process.env.MP3D_AUTOCUT_EXPORT === '1') {
        await js(`[...document.querySelectorAll('.mp3d-ac button')].find(b => b.textContent === 'Close').click(); true`);
        const click = (label) => js(`(() => { const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim().toLowerCase().startsWith(${JSON.stringify(label)})); if (!el) return false; el.click(); return true; })()`);
        await click('3mf');
        await new Promise((r) => setTimeout(r, 500));
        await click('all .zip');
        const n = out.after.length;
        await waitFor(`globalThis.__mp3dColorStats && globalThis.__mp3dColorStats().exports >= ${n}`, 600000);
        await new Promise((r) => setTimeout(r, 5000));
        out.exportStats = await js(`globalThis.__mp3dColorStats()`);
      }
      console.log('AUTOCUT ' + JSON.stringify(out));
    }

    // Standalone repair entry points. Uses MP3D_TEST_PICK_IN / _OUT instead of
    // the native dialogs. Without MP3D_SMOKE_FILE it starts on the start screen.
    if (process.env.MP3D_TEST_STANDALONE === '1') {
      const js = (s) => win.webContents.executeJavaScript(s);
      const waitFor = async (expr, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const v = await js(expr).catch(() => null);
          if (v) return v;
          await new Promise((r) => setTimeout(r, 300));
        }
        return null;
      };
      const tris = () =>
        js(`(() => { let t = 0; const s = globalThis.__mp3dScene; if (s && /MODEL INFO/.test(document.body.innerText)) s.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.color) { const g = o.geometry; t = Math.max(t, (g.index ? g.index.count : g.attributes.position.count) / 3); } }); return t; })()`);
      const report = {};
      const out = process.env.MP3D_TEST_PICK_OUT;

      if (!process.env.MP3D_SMOKE_FILE) {
        // A: start screen -> "Repair a 3MF file…" -> saved, nothing loaded -> Open in app
        report.startButton = await waitFor(`(() => { const b = document.querySelector('.mp3d-start'); return b ? b.textContent : null; })()`, 20000);
        report.toolbarButtonOnStartScreen = await js(`!!document.querySelector('.mp3d-tb')`);
        if (fs.existsSync(out)) fs.rmSync(out);
        const t0 = Date.now();
        await js(`document.querySelector('.mp3d-start').click(); true`);
        const r = await waitFor(`window.__mp3dLastRepair && window.__mp3dLastRepair.mode === 'file' && window.__mp3dLastRepair`, 600000);
        report.fileRepairMs = Date.now() - t0;
        report.fileRepair = r && { clean: r.summary.clean, lines: r.summary.lines, paint: r.summary.paintLines, outputName: r.outputName };
        report.outputExists = fs.existsSync(out);
        report.outputBytes = report.outputExists ? fs.statSync(out).size : 0;
        report.modelLoadedAfterFileRepair = await js(`/MODEL INFO/.test(document.body.innerText)`);
        report.panelButtons = await js(`[...document.querySelectorAll('.mp3d-rp button')].map(b => b.textContent)`);
        await js(`[...document.querySelectorAll('.mp3d-rp button')].find(b => b.textContent === 'Open in app').click(); true`);
        await waitFor(`/MODEL INFO/.test(document.body.innerText)`, 120000);
        await new Promise((r2) => setTimeout(r2, 8000));
        report.openInAppTris = await tris();
        report.panelClosedAfterOpen = await js(`!document.querySelector('.mp3d-rp')`);
      }

      // B: loaded model -> toolbar "Repair"
      report.toolbarButton = await waitFor(`(() => { const b = document.querySelector('.mp3d-tb'); return b ? b.textContent : null; })()`, 20000);
      report.trisBeforeToolbarRepair = await tris();
      await js(`window.__mp3dLastRepair = null; document.querySelector('.mp3d-tb').click(); true`);
      const c = await waitFor(`(window.__mp3dLastRepair && window.__mp3dLastRepair.mode === 'current' && window.__mp3dLastRepair) || (document.querySelector('.mp3d-rp') && /failed|needs/i.test(document.querySelector('.mp3d-rp h2').textContent) && { error: document.querySelector('.mp3d-rp').innerText })`, 600000);
      report.toolbarRepair = c && (c.error ? c : { name: c.name, clean: c.summary.clean, lines: c.summary.lines, paint: c.summary.paintLines });
      await waitFor(`/MODEL INFO/.test(document.body.innerText)`, 120000);
      await new Promise((r2) => setTimeout(r2, 8000));
      report.trisAfterToolbarRepair = await tris();
      report.toolbarPanelButtons = await js(`[...document.querySelectorAll('.mp3d-rp button')].map(b => b.textContent)`);
      console.log('STANDALONE ' + JSON.stringify(report));
    }

    // Repair flow, exactly as a user hits it: cut fails -> click the injected
    // "Repair model" button -> repaired model loads -> cut succeeds.
    if (process.env.MP3D_TEST_REPAIR === '1') {
      const js = (s) => win.webContents.executeJavaScript(s);
      const click = (label) =>
        js(`(() => { const el = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim().toLowerCase().startsWith(${JSON.stringify(label)})); if (!el) return false; el.click(); return true; })()`);
      const sceneTris = () =>
        js(`(() => { let t = 0; const s = globalThis.__mp3dScene; if (s) s.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.color) { const g = o.geometry; t = Math.max(t, (g.index ? g.index.count : g.attributes.position.count) / 3); } }); return t; })()`);
      const waitFor = async (expr, ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const v = await js(expr).catch(() => null);
          if (v) return v;
          await new Promise((r) => setTimeout(r, 300));
        }
        return null;
      };

      console.log('REPAIR_LOADED_TRIS ' + (await sceneTris()));
      await click('planar cut');
      await new Promise((r) => setTimeout(r, 3000));
      await click('place cut');
      const err = await waitFor(`/Not manifold/i.test(document.body.innerText)`, 120000);
      console.log('REPAIR_CUT_ERROR_SHOWN ' + !!err);
      const hasBtn = await waitFor(`!!document.querySelector('.mp3d-rbtn')`, 5000);
      console.log('REPAIR_BUTTON_PRESENT ' + !!hasBtn);
      if (hasBtn) {
        const t0 = Date.now();
        await js(`document.querySelector('.mp3d-rbtn').click(); true`);
        const done = await waitFor(`window.__mp3dLastRepair || (document.querySelector('.mp3d-rp h2') && /failed|No model|needs/i.test(document.querySelector('.mp3d-rp h2').textContent) && document.querySelector('.mp3d-rp').innerText)`, 600000);
        console.log('REPAIR_RESULT ' + JSON.stringify(done));
        console.log('REPAIR_MS ' + (Date.now() - t0));
        const panel = await js(`document.querySelector('.mp3d-rp') ? document.querySelector('.mp3d-rp').innerText : null`);
        console.log('REPAIR_PANEL ' + JSON.stringify(panel));
        // Wait for the repaired model to replace the broken one.
        await waitFor(`/MODEL INFO/.test(document.body.innerText)`, 120000);
        await new Promise((r) => setTimeout(r, 8000));
        console.log('REPAIR_RELOADED_TRIS ' + (await sceneTris()));
        await js(`document.querySelector('.mp3d-rp button') && [...document.querySelectorAll('.mp3d-rp button')].find(b => b.textContent === 'Close').click(); true`);
        await click('planar cut');
        await new Promise((r) => setTimeout(r, 3000));
        await click('place cut');
        const parts = await waitFor(
          `(() => { const m = document.body.innerText.match(/PARTS \\((\\d+)\\)/); if (m && +m[1] >= 2) return +m[1]; return /Not manifold/i.test(document.body.innerText) ? -1 : 0; })()`,
          180000
        );
        console.log('REPAIR_CUT_AFTER ' + parts);
        if (parts >= 2) {
          await click('3mf');
          await new Promise((r) => setTimeout(r, 500));
          await click('all .zip');
          await waitFor(`globalThis.__mp3dColorStats && globalThis.__mp3dColorStats().exports >= ${parts}`, 240000);
          await new Promise((r) => setTimeout(r, 4000));
          console.log('REPAIR_EXPORT_STATS ' + JSON.stringify(await js(`globalThis.__mp3dColorStats()`)));
        }
      }
    }

    if (process.env.MP3D_PROBE_GIZMO === '1') {
      const { setZSize, enterAreaCutOnly } = require('./tools/profile.js');
      const dbg = win.webContents.debugger;
      try {
        dbg.attach('1.3');
      } catch (e) {}
      if (process.env.MP3D_SET_Z) await setZSize(win, dbg, process.env.MP3D_SET_Z);
      await enterAreaCutOnly(win);
      const src = fs.readFileSync(path.join(__dirname, 'tools', 'probe-gizmo.js'), 'utf8');
      try {
        console.log('GIZMO_PROBE ' + JSON.stringify(await win.webContents.executeJavaScript(src, true)));
      } catch (err) {
        console.log('GIZMO_PROBE_ERROR ' + err.message);
      }
      try {
        dbg.detach();
      } catch (e) {}
    }

    if (process.env.MP3D_PROBE_SIZE === '1') {
      const src = fs.readFileSync(path.join(__dirname, 'tools', 'probe-size-inputs.js'), 'utf8');
      const rows = await win.webContents.executeJavaScript(src, true);
      for (const r of rows) {
        if (r.visible && (r.type === 'number' || r.type === 'text')) console.log('SIZEIN ' + JSON.stringify(r));
      }
    }

    if (process.env.MP3D_PROBE_AREACUT === '1') {
      const src = fs.readFileSync(path.join(__dirname, 'tools', 'probe-areacut.js'), 'utf8');
      try {
        console.log('AREACUT_PROBE ' + JSON.stringify(await win.webContents.executeJavaScript(src, true)));
      } catch (err) {
        console.log('AREACUT_PROBE_ERROR ' + err.message);
      }
    }

    if (process.env.MP3D_VERIFY === '1') {
      // A real mouse move first, so the app raycasts and the BVH patch can
      // capture three.js's Raycaster/Ray classes.
      const { orbit } = require('./tools/profile.js');
      const dbg = win.webContents.debugger;
      try {
        dbg.attach('1.3');
        const b = win.getContentBounds();
        await orbit(dbg, {
          x: Math.round(b.width / 2),
          y: Math.round(b.height / 2),
          steps: 12,
          radiusX: 60,
          radiusY: 40,
        });
        dbg.detach();
      } catch (err) {
        console.log('VERIFY_WARN input failed: ' + err.message);
      }

      const src = fs.readFileSync(path.join(__dirname, 'tools', 'verify-raycast.js'), 'utf8');
      try {
        const res = await win.webContents.executeJavaScript(src, true);
        console.log('VERIFY_REPORT ' + JSON.stringify(res));
      } catch (err) {
        console.log('VERIFY_ERROR ' + err.message);
      }
    }

    if (process.env.MP3D_PROBE_SCENE === '1') {
      const src = fs.readFileSync(path.join(__dirname, 'tools', 'probe-scene.js'), 'utf8');
      try {
        console.log('SCENE_PROBE ' + JSON.stringify(await win.webContents.executeJavaScript(src, true)));
      } catch (err) {
        console.log('SCENE_PROBE_ERROR ' + err.message);
      }
    }

    if (process.env.MP3D_PROFILE === '1') {
      const profiler = require('./tools/profile.js');
      await profiler.run({ win, app, siteDir: SITE_DIR });
    }

    if (process.env.MP3D_DIAG === '1') {
      const diagScript = fs.readFileSync(path.join(__dirname, 'tools', 'diag-page.js'), 'utf8');
      try {
        const diag = await win.webContents.executeJavaScript(diagScript, true);
        console.log('DIAG_REPORT ' + JSON.stringify(diag));
      } catch (err) {
        console.log('DIAG_ERROR ' + err.message);
      }
      console.log('GPU_STATUS ' + JSON.stringify(app.getGPUFeatureStatus()));
    }

    // Screenshot of the window contents, independent of which app is in front.
    if (process.env.MP3D_CAPTURE) {
      await new Promise((r) => setTimeout(r, 1500));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.MP3D_CAPTURE, img.toPNG());
      console.log('CAPTURED ' + process.env.MP3D_CAPTURE);
    }

    const report = await win.webContents.executeJavaScript(`(() => ({
      title: document.title,
      rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
      canvases: document.querySelectorAll('canvas').length,
      webgl2: (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; } })(),
      bodyText: (document.body.innerText || '').replace(/\\s*\\n\\s*/g, ' | ').slice(0, 900),
      heapLimitMB: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null
    }))()`);
    console.log('SMOKE_REPORT ' + JSON.stringify(report));
    app.quit();
  }
}

app.whenReady().then(async () => {
  if (!fs.existsSync(path.join(SITE_DIR, 'index.html'))) {
    dialog.showErrorBox('Missing app files', `Could not find site/index.html in:\n${SITE_DIR}`);
    app.quit();
    return;
  }

  const port = await startServer();
  buildMenu(port);
  await createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => app.quit());
