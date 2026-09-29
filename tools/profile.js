'use strict';

/**
 * CPU profiling of a real orbit interaction, driven through the Chrome
 * DevTools Protocol so the events are trusted input and actually reach the
 * app's camera controls (synthetic dispatchEvent() calls did not).
 *
 * Used by main.js when MP3D_PROFILE=1. Prints the functions that dominate
 * self time, plus a source excerpt for each so minified names can be
 * identified in the bundle.
 */

const fs = require('node:fs');
const path = require('node:path');

async function orbit(dbg, { x, y, steps = 90, radiusX = 260, radiusY = 120 }) {
  await dbg.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });

  for (let i = 0; i < steps; i++) {
    const a = i * 0.07;
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x + Math.cos(a) * radiusX),
      y: Math.round(y + Math.sin(a) * radiusY),
      button: 'left',
      buttons: 1,
    });
    // Roughly one move per frame at 60Hz.
    await new Promise((r) => setTimeout(r, 16));
  }

  await dbg.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
  });
}

/** Walk a .cpuprofile and total self time per function. */
function aggregate(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfTicks = new Map();

  for (const id of profile.samples) selfTicks.set(id, (selfTicks.get(id) || 0) + 1);

  const totalTicks = profile.samples.length || 1;
  const durationMs = (profile.endTime - profile.startTime) / 1000;

  const rows = [];
  for (const [id, ticks] of selfTicks) {
    const node = byId.get(id);
    if (!node) continue;
    const cf = node.callFrame;
    rows.push({
      name: cf.functionName || '(anonymous)',
      url: cf.url ? cf.url.replace(/^https?:\/\/[^/]+/, '') : '(native)',
      line: cf.lineNumber,
      col: cf.columnNumber,
      ms: +((ticks / totalTicks) * durationMs).toFixed(1),
      pct: +((ticks / totalTicks) * 100).toFixed(1),
    });
  }

  rows.sort((a, b) => b.ms - a.ms);
  return { rows, durationMs: +durationMs.toFixed(0) };
}

/**
 * Pull a short excerpt around a call frame so we can tell what a minified
 * function actually does.
 */
function excerpt(siteDir, url, line, col, width = 260) {
  if (!url || !url.startsWith('/assets/')) return null;
  const file = path.join(siteDir, url);
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const text = lines[line];
  if (text === undefined) return null;
  const start = Math.max(0, col - 40);
  return text.slice(start, start + width).replace(/\s+/g, ' ');
}

/** Drag horizontally across a slider, one step per frame. */
async function dragSlider(dbg, { x, y, w, steps = 70 }) {
  const from = Math.round(x - w * 0.35);
  const to = Math.round(x + w * 0.35);

  await dbg.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });

  for (let i = 0; i <= steps; i++) {
    // Sweep out and back so the window keeps moving over the model.
    const t = i / steps;
    const p = t < 0.5 ? t * 2 : (1 - t) * 2;
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(from + (to - from) * p),
      y,
      button: 'left',
      buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 16));
  }

  await dbg.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to,
    y,
    button: 'left',
    buttons: 0,
  });
}

/**
 * Types a new Z size, which is how the user scales the model up.
 *
 * React ignores plain `el.value = x` writes, so this goes through real CDP
 * input. Verification reads the model's own world-space bounding box: the
 * MODEL INFO "DIMENSIONS" text shows the *original file* dimensions and never
 * changes on rescale, which made an earlier check report a false failure.
 */
async function setZSize(win, dbg, value) {
  const rect = await win.webContents.executeJavaScript(`(() => {
    const el = [...document.querySelectorAll('input[type=number]')].find(el => {
      const prev = el.previousElementSibling;
      const label = prev ? (prev.innerText || prev.textContent || '').trim() : '';
      const row = el.parentElement && el.parentElement.parentElement
        ? (el.parentElement.parentElement.innerText || '').replace(/\\s+/g,' ') : '';
      return label === 'Z' && row.includes('mm') && !row.includes('\\u00b0');
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`);

  if (!rect) {
    console.log('PROFILE_WARN Z size field not found');
    return false;
  }

  // Measure via the scene, not via __mp3dMesh (that one is an empty helper).
  const measure = () =>
    win.webContents.executeJavaScript(`(() => {
      const scene = globalThis.__mp3dScene;
      if (!scene) return null;
      let model = null, maxTris = 0;
      scene.traverse(o => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        const g = o.geometry;
        const t = Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
        if (t > maxTris) { maxTris = t; model = o; }
      });
      if (!model) return null;
      model.updateWorldMatrix(true, false);
      model.geometry.computeBoundingBox();
      const bb = model.geometry.boundingBox.clone().applyMatrix4(model.matrixWorld);
      return {
        worldZ: +(bb.max.z - bb.min.z).toFixed(1),
        scale: +model.scale.z.toFixed(4),
        tris: maxTris
      };
    })()`);

  const before = await measure();

  // Triple-click selects the field contents, then type over them.
  for (const type of ['mousePressed', 'mouseReleased']) {
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type,
      x: rect.x,
      y: rect.y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 3,
    });
  }
  await dbg.sendCommand('Input.insertText', { text: String(value) });
  for (const type of ['keyDown', 'keyUp']) {
    await dbg.sendCommand('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  }
  await new Promise((r) => setTimeout(r, 6000));

  const after = await measure();
  console.log(`PROFILE_SETZ ${value}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const changed = before && after && Math.abs(after.worldZ - before.worldZ) > 0.5;
  if (!changed) console.log('PROFILE_WARN model scale did not change; profile is not representative');
  return changed;
}

/** Opens Area Cut without needing the slider. */
async function enterAreaCutOnly(win) {
  const opened = await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button,[role=button]')].find(b =>
      (b.innerText||'').trim().toLowerCase().startsWith('area cut'));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 3000));
  return opened;
}

/**
 * Screen position of the cut gizmo's centre handle, plus its world position so
 * the caller can confirm a drag actually moved it.
 */
async function gizmoState(win) {
  return win.webContents.executeJavaScript(`(() => {
    const scene = globalThis.__mp3dScene, camera = globalThis.__mp3dCamera;
    const canvas = document.querySelector('canvas');
    if (!scene || !camera || !canvas) return null;
    let g = null;
    scene.traverse(o => {
      if (!g && o.type === 'TransformControlsGizmo') g = o;
    });
    if (!g) return null;
    const ctrl = g.parent || g;
    ctrl.updateWorldMatrix(true, false);
    const V = camera.position.constructor;
    const wp = ctrl.getWorldPosition(new V());
    const r = canvas.getBoundingClientRect();
    const p = wp.clone().project(camera);
    return {
      screen: {
        x: Math.round(r.left + ((p.x + 1) / 2) * r.width),
        y: Math.round(r.top + ((1 - p.y) / 2) * r.height)
      },
      world: [+wp.x.toFixed(2), +wp.y.toFixed(2), +wp.z.toFixed(2)]
    };
  })()`);
}

/**
 * Finds a point that actually grabs the gizmo.
 *
 * three's TransformControls sets `.axis` on hover, so we can move the pointer
 * over candidate points and ask the controls what it thinks is under the
 * cursor. Pressing at the gizmo's projected centre grabs nothing, because the
 * centre handle's picker is tiny compared to the axis arrows.
 */
async function findGrabPoint(win, dbg, center) {
  const readAxis = () =>
    win.webContents.executeJavaScript(`(() => {
      const scene = globalThis.__mp3dScene;
      if (!scene) return null;
      let g = null;
      scene.traverse(o => { if (!g && o.type === 'TransformControlsGizmo') g = o; });
      const ctrl = g && g.parent;
      return ctrl ? (ctrl.axis || null) : null;
    })()`);

  // Candidate offsets, nearest first, biased along the screen axes where the
  // translate arrows live.
  const offsets = [[0, 0]];
  for (let r = 10; r <= 200; r += 10) {
    offsets.push([0, -r], [0, r], [-r, 0], [r, 0], [-r, -r], [r, r], [-r, r], [r, -r]);
  }

  for (const [dx, dy] of offsets) {
    const x = center.x + dx;
    const y = center.y + dy;
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await new Promise((r) => setTimeout(r, 20));
    const axis = await readAxis();
    if (axis) return { x, y, axis };
  }
  return null;
}

/** Drag the cut gizmo up and down, one move per frame. */
async function dragGizmo(dbg, { x, y }, { steps = 90, amplitude = 220 } = {}) {
  await dbg.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    buttons: 0,
  });
  await new Promise((r) => setTimeout(r, 120));
  await dbg.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const dy = Math.round(Math.sin(t * Math.PI * 2) * amplitude);
    const dx = Math.round(Math.sin(t * Math.PI * 4) * 20);
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x + dx,
      y: y + dy,
      button: 'left',
      buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 16));
  }

  await dbg.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
  });
}

/** Opens Area Cut and returns the POS U slider rect. */
async function enterAreaCut(win) {
  const rect = await win.webContents.executeJavaScript(`(async () => {
    const btn = [...document.querySelectorAll('button,[role=button]')].find(b =>
      (b.innerText||'').trim().toLowerCase().startsWith('area cut'));
    if (!btn) return null;
    btn.click();
    await new Promise(r => setTimeout(r, 2500));
    const sliders = [...document.querySelectorAll('input[type=range]')];
    const posU = sliders.find(el => {
      let n = el.parentElement;
      for (let i = 0; i < 4 && n; i++) {
        if ((n.innerText||'').includes('POS U')) return true;
        n = n.parentElement;
      }
      return false;
    });
    if (!posU) return null;
    const r = posU.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: Math.round(r.width) };
  })()`, true);
  return rect;
}

async function run({ win, app, siteDir }) {
  const dbg = win.webContents.debugger;
  try {
    dbg.attach('1.3');
  } catch (err) {
    console.log('PROFILE_ERROR could not attach debugger: ' + err.message);
    return;
  }

  if (process.env.MP3D_SET_Z) await setZSize(win, dbg, process.env.MP3D_SET_Z);

  const scenario = process.env.MP3D_PROFILE_SCENARIO || 'orbit';
  const bounds = win.getContentBounds();
  const cx = Math.round(bounds.width / 2);
  const cy = Math.round(bounds.height / 2);

  let gizmoBefore = null;
  let grabPoint = null;
  if (scenario === 'gizmo') {
    if (!(await enterAreaCutOnly(win))) {
      console.log('PROFILE_ERROR could not open Area Cut');
      dbg.detach();
      return;
    }
    gizmoBefore = await gizmoState(win);
    if (!gizmoBefore) {
      console.log('PROFILE_ERROR cut gizmo not found');
      dbg.detach();
      return;
    }
    console.log('PROFILE_GIZMO_AT ' + JSON.stringify(gizmoBefore));

    grabPoint = await findGrabPoint(win, dbg, gizmoBefore.screen);
    if (!grabPoint) {
      console.log('PROFILE_ERROR no grabbable gizmo handle found near ' + JSON.stringify(gizmoBefore.screen));
      dbg.detach();
      return;
    }
    console.log('PROFILE_GRAB ' + JSON.stringify(grabPoint));
  }

  let sliderRect = null;
  if (scenario === 'area-cut') {
    sliderRect = await enterAreaCut(win);
    if (!sliderRect) {
      console.log('PROFILE_ERROR could not open Area Cut / find POS U slider');
      dbg.detach();
      return;
    }
    console.log('PROFILE_SCENARIO area-cut slider ' + JSON.stringify(sliderRect));
  }

  // Frame timing is collected in-page at the same time as the CPU profile.
  await win.webContents.executeJavaScript(`
    window.__frames = [];
    (function sample(){
      let last = performance.now();
      const tick = () => {
        const now = performance.now();
        window.__frames.push(now - last);
        last = now;
        if (!window.__stopSampling) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
    window.__longTasks = 0;
    try {
      new PerformanceObserver((l) => { window.__longTasks += l.getEntries().length; })
        .observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    true;
  `);

  await dbg.sendCommand('Profiler.enable');
  await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 100 });
  await dbg.sendCommand('Profiler.start');

  if (scenario === 'gizmo') await dragGizmo(dbg, grabPoint);
  else if (scenario === 'area-cut') await dragSlider(dbg, sliderRect);
  else await orbit(dbg, { x: cx, y: cy });

  const { profile } = await dbg.sendCommand('Profiler.stop');

  if (scenario === 'gizmo') {
    const after = await gizmoState(win);
    const moved =
      after &&
      gizmoBefore.world.some((v, i) => Math.abs(v - after.world[i]) > 0.01);
    console.log(
      `PROFILE_GIZMO_MOVED ${moved} ${JSON.stringify(gizmoBefore.world)} -> ${JSON.stringify(after && after.world)}`
    );
    if (!moved) console.log('PROFILE_WARN gizmo did not move; drag missed the handle');
  }
  const frameStats = await win.webContents.executeJavaScript(`(() => {
    window.__stopSampling = true;
    const f = window.__frames.slice(4).sort((a,b) => a-b);
    if (!f.length) return null;
    const p = (q) => +f[Math.floor(f.length*q)].toFixed(1);
    return { frames: f.length, p50: p(0.5), p90: p(0.9), p99: p(0.99),
             max: +f[f.length-1].toFixed(1), longTasks: window.__longTasks };
  })()`);

  const { rows, durationMs } = aggregate(profile);
  const idle = rows.find((r) => r.name === '(idle)' || r.name === '(program)');

  console.log(
    'PROFILE_SUMMARY ' +
      JSON.stringify({
        durationMs,
        viewport: [bounds.width, bounds.height],
        frameStats,
        idlePct: idle ? idle.pct : null,
      })
  );

  console.log('PROFILE_TOP');
  for (const r of rows.slice(0, 18)) {
    const ex = excerpt(siteDir, r.url, r.line, r.col);
    console.log(
      `  ${String(r.ms).padStart(7)}ms ${String(r.pct).padStart(5)}%  ${r.name}  ` +
        `${r.url}:${r.line}:${r.col}`
    );
    if (ex) console.log(`            | ${ex}`);
  }

  dbg.detach();
}

module.exports = { run, orbit, setZSize, enterAreaCutOnly, dragSlider };
