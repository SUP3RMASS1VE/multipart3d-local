/**
 * In-page UI for paint-preserving mesh repair (local build only).
 *
 * Entry points:
 *   - "Repair" in the top toolbar: repairs the loaded model, loads the fixed
 *     version back in, offers "Save repaired 3MF…".
 *   - "Repair a 3MF file…" on the start screen, and File › Repair 3MF File…:
 *     standalone. Pick a file, the repaired copy is saved to disk, nothing is
 *     loaded unless you press "Open in app".
 *   - "Repair model (keeps colours)" on the cut tool's "Not manifold" error.
 *
 * Heavy work runs in the main process (src/repair/) via window.mp3dRepair.
 * The page is sandboxed and has no file paths, so the "loaded model" is the
 * last File the user opened or dropped, captured here.
 */
(function () {
  'use strict';
  if (!window.mp3dRepair) return; // not running inside the desktop app

  let currentFile = null;
  let lastRepaired = null; // { bytes, name } of an in-app repair
  let running = false;

  /* ---- remember the model the user loads ---------------------------- */
  document.addEventListener(
    'change',
    (e) => {
      const t = e.target;
      if (t && t.type === 'file' && t.files && t.files[0] && !t.dataset.mp3dInternal) currentFile = t.files[0];
    },
    true
  );
  document.addEventListener(
    'drop',
    (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) currentFile = f;
    },
    true
  );

  const modelLoaded = () => /MODEL INFO/.test(document.body.innerText || '');

  /* ---- styles ------------------------------------------------------- */
  const style = document.createElement('style');
  style.textContent = `
    .mp3d-rp{position:fixed;right:20px;bottom:48px;z-index:2147483000;width:390px;max-width:calc(100vw - 40px);
      background:#18181b;color:#e4e4e7;border:1px solid #3f3f46;border-radius:12px;padding:16px 16px 14px;
      font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.55)}
    .mp3d-rp h2{margin:0 0 8px;font-size:14px;font-weight:600;color:#fafafa}
    .mp3d-rp p{margin:0 0 6px;color:#a1a1aa}
    .mp3d-rp .label{margin-top:8px;color:#e4e4e7;font-weight:600}
    .mp3d-rp ul{margin:4px 0 8px;padding-left:18px;color:#d4d4d8}
    .mp3d-rp li{margin:2px 0}
    .mp3d-rp .ok{color:#86efac}.mp3d-rp .warn{color:#fca5a5}
    .mp3d-rp .path{word-break:break-all;color:#d4d4d8}
    .mp3d-rp .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px}
    .mp3d-rp button,.mp3d-rbtn{font:inherit;font-weight:600;border-radius:8px;padding:6px 12px;cursor:pointer;
      border:1px solid #52525b;background:#27272a;color:#f4f4f5}
    .mp3d-rp button.primary,.mp3d-rbtn{background:#dfe22a;border-color:#dfe22a;color:#09090b}
    .mp3d-rp button:focus-visible,.mp3d-rbtn:focus-visible,.mp3d-tb:focus-visible,.mp3d-start:focus-visible{outline:2px solid #fafafa;outline-offset:2px}
    .mp3d-rbtn{margin-top:8px;font-size:12px;padding:5px 10px}
    .mp3d-rp .bar{height:4px;background:#27272a;border-radius:2px;overflow:hidden;margin:8px 0 4px}
    .mp3d-rp .bar i{display:block;height:100%;width:35%;background:#dfe22a;animation:mp3dslide 1.2s ease-in-out infinite}
    @keyframes mp3dslide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
    @media (prefers-reduced-motion:reduce){.mp3d-rp .bar i{animation:none;width:100%;opacity:.5}}
    .mp3d-tb svg,.mp3d-start svg{flex:none}`;
  document.head.appendChild(style);

  /* ---- panel helpers ------------------------------------------------ */
  let panel = null;
  let returnFocus = null;
  function showPanel(build) {
    if (!panel) returnFocus = document.activeElement;
    closePanel(true);
    panel = document.createElement('section');
    panel.className = 'mp3d-rp';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'mp3d-rp-title');
    panel.setAttribute('aria-live', 'polite');
    build(panel);
    document.body.appendChild(panel);
    const f = panel.querySelector('button.primary') || panel.querySelector('button');
    if (f) f.focus();
  }
  function closePanel(keepFocus) {
    if (panel) panel.remove();
    panel = null;
    if (!keepFocus && returnFocus && document.contains(returnFocus)) returnFocus.focus();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && !running) closePanel();
  });

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) n.append(k);
    return n;
  };
  const button = (label, onClick, primary) =>
    el('button', { type: 'button', className: primary ? 'primary' : '', textContent: label, onclick: onClick });
  const list = (items, cls) => {
    const ul = el('ul');
    for (const t of items) ul.append(el('li', { textContent: t, className: cls || '' }));
    return ul;
  };
  const cleanError = (err) =>
    String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function showBusy(title) {
    running = true;
    const status = el('p', { textContent: 'Starting…' });
    showPanel((p) => {
      p.append(el('h2', { id: 'mp3d-rp-title', textContent: title }));
      p.append(el('p', { textContent: 'This can take a minute on large models. Paint is kept.' }));
      p.append(el('div', { className: 'bar' }, el('i')));
      p.append(status);
    });
    window.__mp3dRepairStatus = status;
  }

  function titleFor(summary, noun) {
    if (summary.nothingToFix) return 'No problems found';
    return summary.clean ? `${noun} repaired` : `${noun} partly repaired`;
  }

  function summaryBlock(p, summary) {
    if (summary.nothingToFix) {
      p.append(
        el('p', {
          className: 'ok',
          textContent: 'This mesh is already closed and consistently facing. Nothing was changed.',
        })
      );
      return;
    }
    p.append(
      el('p', {
        textContent: summary.clean
          ? 'The mesh is now closed and ready to cut or print. Colours were kept.'
          : 'Most problems were fixed, but some remain.',
        className: summary.clean ? 'ok' : 'warn',
      })
    );
    p.append(list(summary.lines));
    p.append(el('p', { className: 'label', textContent: 'Paint' }));
    p.append(list(summary.paintLines));
    if (summary.problems.length) p.append(list(summary.problems, 'warn'));
  }

  function showError(title, msg) {
    running = false;
    showPanel((p) => {
      p.append(el('h2', { id: 'mp3d-rp-title', textContent: title }));
      p.append(el('p', { textContent: msg, className: 'warn' }));
      const row = el('div', { className: 'row' });
      row.append(button('Close', () => closePanel(), true));
      p.append(row);
    });
  }

  /* ---- load a File into the app ------------------------------------- */
  function loadIntoApp(file) {
    const input = [...document.querySelectorAll('input[type=file]')].find((i) => /3mf/i.test(i.accept || ''));
    if (!input) throw new Error('could not find the app’s file input');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    currentFile = file;
  }

  function repairedName(name) {
    const base = String(name || 'model').replace(/\.3mf$/i, '').replace(/_repaired$/i, '');
    return `${base}_repaired.3mf`;
  }

  /* ---- flow 1: repair the loaded model ------------------------------ */
  async function repairCurrent() {
    if (running) return;
    if (!currentFile || !modelLoaded()) {
      // Nothing loaded: fall back to the standalone flow.
      return repairFile();
    }
    if (!/\.3mf$/i.test(currentFile.name)) {
      showError(
        'Repair needs a 3MF file',
        'The repair works on 3MF files so it can keep the paint. Open or export the model as 3MF and try again.'
      );
      return;
    }
    const name = repairedName(currentFile.name);
    showBusy(`Repairing ${currentFile.name}`);
    try {
      const res = await window.mp3dRepair.repair(await currentFile.arrayBuffer());
      lastRepaired = { bytes: res.bytes, name };
      window.__mp3dLastRepair = { mode: 'current', name, summary: res.summary, size: res.bytes.byteLength };
      // Clean already: keep the loaded model (and any work on it) as it is.
      if (!res.summary.nothingToFix) loadIntoApp(new File([res.bytes], name, { type: 'model/3mf' }));
      running = false;
      showPanel((p) => {
        p.append(el('h2', { id: 'mp3d-rp-title', textContent: titleFor(res.summary, 'Model') }));
        summaryBlock(p, res.summary);
        const row = el('div', { className: 'row' });
        if (res.summary.nothingToFix) {
          row.append(button('Close', () => closePanel(), true));
          p.append(row);
          return;
        }
        p.append(el('p', { textContent: `The repaired model is now loaded as ${name}. It isn’t saved yet.` }));
        row.append(
          button('Close', () => closePanel()),
          button(
            'Save repaired 3MF…',
            async () => {
              const saved = await window.mp3dRepair.saveAs(lastRepaired.bytes, lastRepaired.name);
              if (saved) {
                const note = p.querySelector('.mp3d-saved') || el('p', { className: 'ok mp3d-saved' });
                note.textContent = `Saved to ${saved}`;
                p.insertBefore(note, row);
              }
            },
            true
          )
        );
        p.append(row);
      });
    } catch (err) {
      showError('Repair failed', cleanError(err));
    }
  }

  /* ---- flow 2: standalone file repair ------------------------------- */
  async function repairFile() {
    if (running) return;
    running = true; // blocks double clicks while the native dialogs are open
    try {
      const res = await window.mp3dRepair.repairFile();
      if (res.canceled) {
        running = false;
        if (panel) closePanel();
        return;
      }
      running = false;
      window.__mp3dLastRepair = { mode: 'file', ...res };
      showPanel((p) => {
        p.append(el('h2', { id: 'mp3d-rp-title', textContent: titleFor(res.summary, 'File') }));
        summaryBlock(p, res.summary);
        p.append(el('p', { className: 'label', textContent: 'Saved to' }));
        p.append(el('p', { className: 'path', textContent: res.outputPath }));
        p.append(el('p', { textContent: `Your original ${res.inputName} was not changed.` }));
        const row = el('div', { className: 'row' });
        row.append(
          button('Close', () => closePanel()),
          button('Show in Finder', () => window.mp3dRepair.reveal(res.outputPath)),
          button(
            'Open in app',
            async () => {
              try {
                const bytes = await window.mp3dRepair.readOutput(res.outputPath);
                loadIntoApp(new File([bytes], res.outputName, { type: 'model/3mf' }));
                closePanel();
              } catch (err) {
                showError('Could not open the repaired file', cleanError(err));
              }
            },
            true
          )
        );
        p.append(row);
      });
    } catch (err) {
      showError('Repair failed', cleanError(err));
    }
  }

  window.mp3dRepair.onStarted(({ name }) => showBusy(`Repairing ${name}`));
  window.mp3dRepair.onProgress((m) => {
    if (window.__mp3dRepairStatus && document.contains(window.__mp3dRepairStatus)) window.__mp3dRepairStatus.textContent = m;
  });

  window.__mp3dRepairCurrent = repairCurrent;
  window.__mp3dRepairFile = repairFile;

  /* ---- buttons injected into the app's own UI ----------------------- */
  const WRENCH =
    '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';

  const findButton = (text) =>
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === text && !b.closest('.mp3d-rp'));

  function decorate() {
    // Toolbar: "Repair" before "New File", styled like it.
    const newFile = findButton('New File');
    if (newFile && !document.querySelector('.mp3d-tb')) {
      const b = el('button', {
        type: 'button',
        className: newFile.className + ' mp3d-tb',
        title: 'Repair the loaded model (holes, flipped faces, duplicates). Colours are kept.',
        onclick: () => repairCurrent(),
      });
      b.innerHTML = WRENCH;
      b.append('Repair');
      newFile.parentElement.insertBefore(b, newFile);
    }

    // Start screen: "Repair a 3MF file…" under "Try demo model".
    const demo = findButton('Try demo model');
    if (demo && !document.querySelector('.mp3d-start')) {
      const b = el('button', {
        type: 'button',
        className: demo.className + ' mp3d-start',
        title: 'Repair a 3MF file without loading it. Colours are kept.',
        onclick: () => repairFile(),
      });
      b.innerHTML = WRENCH.replace(/width="16" height="16"/, 'width="12" height="12"');
      b.append('Repair a 3MF file…');
      // Same flex row as "Try demo model". Adding a sibling to the page's grid
      // instead would drop the button into the next free cell (under the video).
      demo.parentElement.style.gap = '8px';
      demo.insertAdjacentElement('afterend', b);
    }

    // Cut tool error: "Repair model (keeps colours)".
    for (const node of document.querySelectorAll('div,p,span')) {
      if (node.dataset.mp3dRepair || node.children.length > 3) continue;
      const text = node.textContent || '';
      if (!/Not manifold/i.test(text) || text.length > 300) continue;
      if ([...node.children].some((c) => /Not manifold/i.test(c.textContent || ''))) continue;
      node.dataset.mp3dRepair = '1';
      const b = el('button', {
        type: 'button',
        className: 'mp3d-rbtn',
        textContent: 'Repair model (keeps colours)',
        onclick: (e) => {
          e.stopPropagation();
          repairCurrent();
        },
      });
      node.append(document.createElement('br'), b);
    }
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      decorate();
    });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  decorate();
})();
