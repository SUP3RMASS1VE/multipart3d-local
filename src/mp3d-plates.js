/**
 * Plates + multi-plate project export (local build only).
 *
 * "Plates" in the Parts panel opens a plate planner:
 *   - Auto-arrange packs every part onto as few plates of the selected
 *     printer as it can (turning parts 90 degrees where that helps).
 *   - Each part has a plate picker, so parts can be moved by hand; plates can
 *     be added and empty ones removed. A top-down drawing shows each plate.
 *   - "Export project 3MF" writes ONE Bambu/Orca project: every part on its
 *     plate, the painted colours, and the printer + filament settings
 *     (src/mp3d-color-export.js does the writing).
 *
 * Settings come from the loaded model when it was a slicer project, or from
 * any other slicer project 3MF the user picks (for example one saved for the
 * printer they're actually using). The bed size always follows the printer
 * selected in the side panel.
 *
 * The plan lives here, keyed by part id. It doesn't move parts in the app's
 * 3D view; the layout is applied only in the exported project.
 */
(function () {
  'use strict';

  const MARGIN = 5; // mm kept clear of the bed edge
  const GAP = 5; // mm between parts
  const cutStore = () => globalThis.__mp3dCutStore;
  const printerStore = () => globalThis.__mp3dPrinterStore;

  // plan: { plates: [{ name }], assign: Map(partId -> plateIndex), rot: Map(partId -> rotation) }
  let plan = { plates: [{ name: 'Plate 1' }], assign: new Map(), rot: new Map() };

  /* ------------------------------------------------------------------ *
   * Geometry: part size in export (Z-up) coordinates
   * ------------------------------------------------------------------ */

  const sizeCache = new WeakMap();

  /** Size of the part as the exporter will write it (Z up), before plate rotation. */
  function exportSize(part) {
    const key = part.geometry;
    const cached = sizeCache.get(key);
    const tkey = JSON.stringify(part.transform);
    if (cached && cached.tkey === tkey) return cached.size;
    const api = globalThis.__mp3dExportApi;
    const { vertices } = api.toVerts(part.geometry, part.transform);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = vertices[i + k];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    const size = { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
    sizeCache.set(key, { tkey, size });
    return size;
  }

  function bedVolume() {
    const P = printerStore();
    return P ? P.getState().getBuildVolume() : null;
  }

  /**
   * Orientation for a part on this bed: keep it as it is if it fits;
   * otherwise the flattest orientation that fits. null if nothing fits.
   */
  function chooseRotation(size, bed) {
    const { rotatedDims } = globalThis.__mp3dRotations;
    const ux = bed.x - 2 * MARGIN, uy = bed.y - 2 * MARGIN, uz = bed.z;
    const fitsBed = (d) => d.z <= uz && ((d.x <= ux && d.y <= uy) || (d.y <= ux && d.x <= uy)) && packPlate([{ id: 0, w: d.x, d: d.y }], bed).overflow.length === 0;
    const opts = [0, 2, 4].map((r) => ({ r, d: rotatedDims(size, r) })).filter((o) => fitsBed(o.d));
    if (!opts.length) return null;
    if (opts[0].r === 0) return 0;
    opts.sort((a, b) => a.d.z - b.d.z);
    return opts[0].r;
  }

  /* ------------------------------------------------------------------ *
   * Packing: shelf rows on one plate, keeping the prime tower corner free
   * ------------------------------------------------------------------ */

  /**
   * Finds free room for the prime tower AFTER the parts are packed, instead
   * of reserving a fixed corner (a fixed corner blocked any part wider than
   * about 200 mm). Tries the four corners first, then a 5 mm grid.
   * Returns { x, y, w, d, tower: {x,y} } or null.
   */
  function findTowerSpot(placed, bed, towerW) {
    const w = towerW + 2 * GAP;
    const d = towerW + 25 + 2 * GAP; // tower plus its brim and wipe depth
    const rects = [...placed.values()];
    const free = (x, y) =>
      x >= MARGIN - GAP && y >= MARGIN - GAP && x + w <= bed.x - MARGIN + GAP && y + d <= bed.y - MARGIN + GAP &&
      rects.every((r) => x >= r.x + r.w || x + w <= r.x || y >= r.y + r.d || y + d <= r.y);
    const cands = [
      [bed.x - MARGIN + GAP - w, bed.y - MARGIN + GAP - d],
      [MARGIN - GAP, bed.y - MARGIN + GAP - d],
      [bed.x - MARGIN + GAP - w, MARGIN - GAP],
      [MARGIN - GAP, MARGIN - GAP],
    ];
    for (let y = MARGIN - GAP; y + d <= bed.y; y += 5) for (let x = MARGIN - GAP; x + w <= bed.x; x += 5) cands.push([x, y]);
    for (const [x, y] of cands) if (free(x, y)) return { x, y, w, d, tower: { x: x + GAP, y: y + GAP } };
    return null;
  }

  /** Does this part use more than one filament? (Only those plates need a tower.) */
  const multiCache = new WeakMap();
  function isMultiColour(part) {
    const L = part.slotLabels;
    if (!L || !L.length) return false;
    if (multiCache.has(L)) return multiCache.get(L);
    let first = 0, multi = false;
    for (let i = 0; i < L.length; i++) {
      const v = L[i];
      if (v <= 0) continue;
      if (!first) first = v;
      else if (v !== first) { multi = true; break; }
    }
    multiCache.set(L, multi);
    return multi;
  }

  /** No-print zones from the printer settings (bed_exclude_area), bed coords. */
  function excludeRects() {
    const s = settingsCache;
    const pts = (s && s.json && Array.isArray(s.json.bed_exclude_area) ? s.json.bed_exclude_area : [])
      .map((q) => String(q).split('x').map(Number))
      .filter((q) => q.length === 2 && q.every(Number.isFinite));
    if (pts.length < 3) return [];
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return [{ x: x - GAP, y: y - GAP, w: Math.max(...xs) - x + 2 * GAP, d: Math.max(...ys) - y + 2 * GAP }];
  }

  const overlaps = (a, b) => !(a.x >= b.x + b.w || a.x + a.w <= b.x || a.y >= b.y + b.d || a.y + a.d <= b.y);

  /**
   * Bottom-left first fit on a 2 mm grid, trying both 90-degree turns.
   * Keeps clear of the bed edge margin, other parts and no-print zones.
   * items: [{ id, w, d }]. Returns { placed: Map(id -> {x,y,w,d,turned}), overflow }.
   */
  function packPlate(items, bed) {
    const blocked = excludeRects();
    const placed = new Map();
    const overflow = [];
    const taken = [];
    const order = [...items].sort((p, q) => Math.max(q.w, q.d) - Math.max(p.w, p.d) || q.w * q.d - p.w * p.d);
    const STEP = 2;
    for (const it of order) {
      let spot = null;
      for (const turned of [false, true]) {
        const w = turned ? it.d : it.w, d = turned ? it.w : it.d;
        for (let y = MARGIN; !spot && y + d <= bed.y - MARGIN + 1e-6; y += STEP) {
          for (let x = MARGIN; x + w <= bed.x - MARGIN + 1e-6; x += STEP) {
            const r = { x, y, w, d };
            const pad = { x: x - GAP / 2, y: y - GAP / 2, w: w + GAP, d: d + GAP };
            if (blocked.some((z) => overlaps(r, z)) || taken.some((t) => overlaps(pad, t))) continue;
            spot = { ...r, turned };
            break;
          }
        }
        if (spot) break;
      }
      if (!spot) { overflow.push(it.id); continue; }
      placed.set(it.id, spot);
      taken.push({ x: spot.x - GAP / 2, y: spot.y - GAP / 2, w: spot.w + GAP, d: spot.d + GAP });
    }
    return { placed, overflow };
  }


  /* ------------------------------------------------------------------ *
   * Plan
   * ------------------------------------------------------------------ */

  function context() {
    const S = cutStore();
    const bed = bedVolume();
    const parts = S ? S.getState().parts : [];
    return { parts, bed };
  }

  function footprint(part, bed) {
    const { rotatedDims } = globalThis.__mp3dRotations;
    let r = plan.rot.get(part.id);
    if (r === undefined) {
      r = chooseRotation(exportSize(part), bed);
      if (r !== null) plan.rot.set(part.id, r);
    }
    if (r === null || r === undefined) return null;
    const d = rotatedDims(exportSize(part), r);
    return { r, w: d.x, d: d.y, h: d.z };
  }

  let settingsCache = null;
  async function refreshSettings() {
    settingsCache = globalThis.__mp3dProjectSettings ? await globalThis.__mp3dProjectSettings() : null;
    return settingsCache;
  }

  /** Tower width if the project uses a prime tower at all, else 0. */
  function towerWidth() {
    const s = settingsCache;
    if (!s || !s.json) return 0;
    return s.json.filament_colour.length > 1 && s.json.enable_prime_tower !== '0' ? Number(s.json.prime_tower_width) || 35 : 0;
  }

  /**
   * Packs one plate and places its tower. A plate "fits" when every part is
   * placed and, if any part on it is multi-colour, the tower found room.
   */
  function packWithTower(items, bed) {
    // The prime tower is left to the slicer (move it there if needed).
    const { placed, overflow } = packPlate(items, bed);
    return { placed, overflow, reserve: null, towerBlocked: false };
  }

  /** Lays out every plate from the current assignment. */
  function layout() {
    const { parts, bed } = context();
    const tooBig = [];
    const byPlate = plan.plates.map(() => []);
    for (const p of parts) {
      const f = bed ? footprint(p, bed) : null;
      if (!f) {
        tooBig.push(p);
        continue;
      }
      let k = plan.assign.get(p.id);
      if (k === undefined || k >= plan.plates.length) {
        k = 0;
        plan.assign.set(p.id, 0);
      }
      byPlate[k].push({ id: p.id, w: f.w, d: f.d, part: p, f });
    }
    const plates = byPlate.map((items, i) => {
      const r = packWithTower(items, bed);
      return { index: i, name: plan.plates[i].name, items, ...r };
    });
    return { bed, parts, plates, tooBig };
  }

  /** First-fit decreasing over plates: fewest plates the packer can manage. */
  function autoArrange() {
    const { parts, bed } = context();
    if (!bed) return;
    const sized = parts
      .map((p) => ({ p, f: footprint(p, bed) }))
      .filter((x) => x.f)
      .sort((a, b) => b.f.w * b.f.d - a.f.w * a.f.d);
    const plates = [];
    for (const { p, f } of sized) {
      const it = { id: p.id, w: f.w, d: f.d, part: p };
      let done = false;
      for (const pl of plates) {
        const trial = packWithTower([...pl, it], bed);
        if (!trial.overflow.length && !trial.towerBlocked) {
          pl.push(it);
          done = true;
          break;
        }
      }
      if (!done) plates.push([it]);
    }
    plan.plates = plates.map((_, i) => ({ name: `Plate ${i + 1}` }));
    if (!plan.plates.length) plan.plates = [{ name: 'Plate 1' }];
    plan.assign = new Map();
    plates.forEach((pl, i) => pl.forEach((it) => plan.assign.set(it.id, i)));
  }

  /** Drops assignments for parts that no longer exist (after new cuts). */
  function syncWithParts() {
    const ids = new Set(context().parts.map((p) => p.id));
    for (const id of [...plan.assign.keys()]) if (!ids.has(id)) plan.assign.delete(id);
    for (const id of [...plan.rot.keys()]) if (!ids.has(id)) plan.rot.delete(id);
    const unassigned = [...ids].some((id) => !plan.assign.has(id));
    return unassigned;
  }

  /* ------------------------------------------------------------------ *
   * Export
   * ------------------------------------------------------------------ */

  async function exportProject(onProgress) {
    const L = layout();
    const problems = [];
    if (L.tooBig.length) problems.push(`${L.tooBig.length} part(s) are too big for this printer`);
    for (const pl of L.plates) {
      if (pl.overflow.length) problems.push(`${pl.name} has more than fits on the bed`);
      else if (pl.towerBlocked) problems.push(`${pl.name} has no room left for the prime tower`);
    }
    if (problems.length) throw new Error(problems.join('; ') + '. Fix those first (Auto-arrange, or move parts to another plate).');
    const used = L.plates.filter((pl) => pl.placed.size > 0);
    if (!used.length) throw new Error('there are no parts to export');
    const items = [];
    used.forEach((pl, newIndex) => {
      for (const it of pl.items) {
        const slot = pl.placed.get(it.id);
        let rot = it.f.r;
        if (slot.turned) rot ^= 1; // 90 degree turn about Z
        items.push({ part: it.part, plate: newIndex, rot, slot });
      }
    });
    const plates = used.map((pl) => ({ name: pl.name, tower: pl.reserve ? pl.reserve.tower : null }));
    const res = await globalThis.__mp3dExportProject({ items, plates, bed: L.bed, onProgress });
    const S = cutStore();
    const modelName = (S && S.getState().parts[0] && S.getState().parts[0].name.replace(/ [AB](?: [AB])*$/, '')) || 'model';
    const base = String(modelName).replace(/[^\w .()+-]/g, '_').trim() || 'model';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(res.blob);
    a.download = `${base}_plates.3mf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    window.__mp3dLastProject = { ...res.report, fileName: a.download };
    return res.report;
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  const style = document.createElement('style');
  style.textContent = `
    .mp3d-pl-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin-top:6px;
      font:inherit;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;border-radius:6px;
      padding:6px 8px;cursor:pointer;border:1px solid #dfe22a;background:#dfe22a;color:#09090b}
    .mp3d-pl-btn:focus-visible,.mp3d-pl button:focus-visible,.mp3d-pl select:focus-visible{outline:2px solid #fafafa;outline-offset:2px}
    .mp3d-pl-back{position:fixed;inset:0;z-index:2147482999;background:rgba(0,0,0,.55)}
    .mp3d-pl{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483000;width:min(980px,calc(100vw - 40px));
      max-height:calc(100vh - 60px);overflow:auto;background:#18181b;color:#e4e4e7;border:1px solid #3f3f46;border-radius:12px;
      padding:18px;font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)}
    .mp3d-pl h2{margin:0 0 4px;font-size:15px;color:#fafafa}
    .mp3d-pl h3{margin:0;font-size:13px;color:#fafafa}
    .mp3d-pl p{margin:0 0 6px;color:#a1a1aa}
    .mp3d-pl .warn{color:#fca5a5}.mp3d-pl .ok{color:#86efac}
    .mp3d-pl .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}
    .mp3d-pl button{font:inherit;font-weight:600;border-radius:8px;padding:6px 12px;cursor:pointer;border:1px solid #52525b;background:#27272a;color:#f4f4f5}
    .mp3d-pl button.primary{background:#dfe22a;border-color:#dfe22a;color:#09090b}
    .mp3d-pl button:disabled{opacity:.5;cursor:not-allowed}
    .mp3d-pl .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
    .mp3d-pl .card{border:1px solid #3f3f46;border-radius:10px;padding:10px;background:#111113}
    .mp3d-pl .card.bad{border-color:#b91c1c}
    .mp3d-pl .card header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
    .mp3d-pl svg{width:100%;height:auto;background:#09090b;border-radius:6px;display:block}
    .mp3d-pl ul{list-style:none;margin:8px 0 0;padding:0}
    .mp3d-pl li{display:flex;align-items:center;gap:6px;padding:2px 0;font-size:12px}
    .mp3d-pl li .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mp3d-pl li .sw{width:10px;height:10px;border-radius:2px;flex:none}
    .mp3d-pl select{background:#09090b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:6px;padding:2px 4px;font:inherit;font-size:12px}
    .mp3d-pl .status{min-height:1.4em}`;
  document.head.appendChild(style);

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  };

  let dialog = null;
  let backdrop = null;
  let returnFocus = null;
  let busy = false;

  function close() {
    if (busy) return;
    if (dialog) dialog.remove();
    if (backdrop) backdrop.remove();
    dialog = backdrop = null;
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog) close();
  });

  /* ---- top-down plate images (software raster, painted colours) ---- */

  const meshCache = new WeakMap();
  const hexRgb = (h) => {
    let t = String(h || '#8a9a5b').replace('#', '');
    if (t.length === 3) t = t.split('').map((c) => c + c).join('');
    const n = parseInt(t.slice(0, 6), 16);
    return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [138, 154, 91];
  };

  /** Export-space vertices + per-triangle colour for a part, cached. */
  function meshData(part) {
    const tkey = JSON.stringify(part.transform);
    const c = meshCache.get(part.geometry);
    if (c && c.tkey === tkey) return c;
    const { vertices, triangles } = globalThis.__mp3dExportApi.toVerts(part.geometry, part.transform);
    const n = triangles.length / 3;
    const rgb = new Uint8Array(n * 3);
    const L = part.slotLabels && part.slotLabels.length === n ? part.slotLabels : null;
    const palette = (part.slotColors || []).map(hexRgb);
    const base = hexRgb(part.color);
    let dom = 1;
    if (L) {
      const h = new Map();
      for (let i = 0; i < n; i++) if (L[i] > 0) h.set(L[i], (h.get(L[i]) || 0) + 1);
      let best = -1;
      for (const [k, v] of h) if (v > best) (best = v), (dom = k);
    }
    for (let i = 0; i < n; i++) {
      const lab = L ? L[i] || dom : 0;
      const col = (L && palette[lab - 1]) || base;
      rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];
    }
    const d = { tkey, vertices, triangles, rgb };
    meshCache.set(part.geometry, d);
    return d;
  }

  const LIGHT = (() => { const v = [-0.35, -0.45, 0.82]; const l = Math.hypot(...v); return v.map((x) => x / l); })();

  function paintPlate(canvas, pl, bed) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, s = W / bed.x;
    const img = ctx.createImageData(W, H);
    const px = img.data;
    for (let i = 0; i < W * H; i++) { px[i * 4] = 20; px[i * 4 + 1] = 20; px[i * 4 + 2] = 23; px[i * 4 + 3] = 255; }
    const zb = new Float32Array(W * H).fill(-Infinity);
    const { ROTS } = globalThis.__mp3dRotations;

    for (const it of pl.items) {
      const slot = pl.placed.get(it.id);
      if (!slot) continue;
      const R = ROTS[it.f.r ^ (slot.turned ? 1 : 0)];
      const md = meshData(it.part);
      const V = md.vertices, T = md.triangles;
      const rv = new Float32Array(V.length);
      let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity;
      for (let i = 0; i < V.length; i += 3) {
        const a = V[i], b = V[i + 1], c = V[i + 2];
        const x = R[0] * a + R[1] * b + R[2] * c, y = R[3] * a + R[4] * b + R[5] * c, z = R[6] * a + R[7] * b + R[8] * c;
        rv[i] = x; rv[i + 1] = y; rv[i + 2] = z;
        if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y; if (z < mnz) mnz = z;
      }
      const ox = slot.x + slot.w / 2 - (mnx + mxx) / 2, oy = slot.y + slot.d / 2 - (mny + mxy) / 2;
      for (let i = 0; i < V.length; i += 3) {
        rv[i] = (rv[i] + ox) * s;
        rv[i + 1] = H - (rv[i + 1] + oy) * s;
        rv[i + 2] -= mnz;
      }
      for (let t = 0; t < T.length / 3; t++) {
        const ia = T[t * 3] * 3, ib = T[t * 3 + 1] * 3, ic = T[t * 3 + 2] * 3;
        const ax = rv[ia], ay = rv[ia + 1], az = rv[ia + 2];
        const bx = rv[ib], by = rv[ib + 1], bz = rv[ib + 2];
        const cx = rv[ic], cy = rv[ic + 1], cz = rv[ic + 2];
        // Normal in world space (screen Y is flipped, so recompute from mm coords).
        const ux = bx - ax, uy = -(by - ay), uz = bz - az, vx = cx - ax, vy = -(cy - ay), vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const shade = 0.28 + 0.72 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        const r = md.rgb[t * 3] * shade, g = md.rgb[t * 3 + 1] * shade, bl = md.rgb[t * 3 + 2] * shade;
        const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
        const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
        if (x1 - x0 <= 1 && y1 - y0 <= 1) {
          // Sub-pixel triangle: splat its centroid.
          const xx = Math.min(W - 1, Math.max(0, Math.round((ax + bx + cx) / 3))), yy = Math.min(H - 1, Math.max(0, Math.round((ay + by + cy) / 3)));
          const z = Math.max(az, bz, cz), k = yy * W + xx;
          if (z > zb[k]) { zb[k] = z; px[k * 4] = r; px[k * 4 + 1] = g; px[k * 4 + 2] = bl; }
          continue;
        }
        const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        if (Math.abs(area) < 1e-9) continue;
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const qx = x + 0.5, qy = y + 0.5;
            const w0 = ((bx - qx) * (cy - qy) - (by - qy) * (cx - qx)) / area;
            const w1 = ((cx - qx) * (ay - qy) - (cy - qy) * (ax - qx)) / area;
            const w2 = 1 - w0 - w1;
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const z = w0 * az + w1 * bz + w2 * cz, k = y * W + x;
            if (z > zb[k]) { zb[k] = z; px[k * 4] = r; px[k * 4 + 1] = g; px[k * 4 + 2] = bl; }
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#71717a';
    for (const z of excludeRects()) ctx.strokeRect(z.x * s, H - (z.y + z.d) * s, z.w * s, z.d * s);
  }

  let paintToken = 0;
  function drawPlate(pl, bed) {
    const W = 360, H = Math.round((360 * bed.y) / bed.x);
    const c = el('canvas', { width: W, height: H });
    c.style.cssText = 'width:100%;height:auto;display:block;border-radius:6px;background:#141417';
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', `${pl.name}, top view: ${pl.items.map((i) => i.part.name).join(', ') || 'empty'}`);
    c.__mp3dPaint = () => paintPlate(c, pl, bed);
    return c;
  }

  /** Paints plate canvases one per frame so the dialog stays responsive. */
  function paintAll() {
    const token = ++paintToken;
    window.__mp3dPlateImagesDone = false;
    const list = dialog ? [...dialog.querySelectorAll('canvas')] : [];
    let i = 0;
    const step = () => {
      if (token !== paintToken || !dialog) return;
      if (i >= list.length) { window.__mp3dPlateImagesDone = true; return; }
      try { list[i].__mp3dPaint(); } catch (e) { console.warn('[mp3d-plates] image failed', e); }
      i++;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function drawPlateBoxes(pl, bed, colourOf) {
    const s = svg('svg', { viewBox: `0 0 ${bed.x} ${bed.y}`, role: 'img', 'aria-label': `${pl.name} layout, top view` });
    s.append(svg('rect', { x: 0, y: 0, width: bed.x, height: bed.y, fill: '#141417', stroke: '#3f3f46', 'stroke-width': Math.max(1, bed.x / 200) }));
    const fy = (y, d) => bed.y - y - d; // bed Y points away from you; SVG Y points down
    if (pl.reserve) {
      const r = pl.reserve;
      s.append(svg('rect', { x: r.x, y: fy(r.y, r.d), width: r.w, height: r.d, fill: 'none', stroke: '#71717a', 'stroke-dasharray': '4 3', 'stroke-width': Math.max(1, bed.x / 250) }));
    }
    for (const it of pl.items) {
      const p = pl.placed.get(it.id);
      if (!p) continue;
      s.append(svg('rect', { x: p.x, y: fy(p.y, p.d), width: p.w, height: p.d, rx: 2, fill: colourOf(it.part), 'fill-opacity': 0.85, stroke: '#fafafa', 'stroke-opacity': 0.35, 'stroke-width': Math.max(0.6, bed.x / 400) }));
    }
    return s;
  }

  function partColour(part) {
    return part.color || '#8a9a5b';
  }

  async function render(statusText) {
    const L = layout();
    const S = settingsCache;
    const P = printerStore().getState();
    const preset = P.getSelectedPreset && P.getSelectedPreset();
    const printerName = preset ? `${preset.brand} ${preset.model}` : 'Custom printer';

    dialog.replaceChildren();
    dialog.append(el('h2', { id: 'mp3d-pl-title', textContent: 'Plates' }));
    if (!L.bed) {
      dialog.append(el('p', { className: 'warn', textContent: 'Choose a printer in the side panel first.' }));
      dialog.append(el('div', { className: 'bar' }, el('button', { type: 'button', textContent: 'Close', onclick: close })));
      return;
    }
    dialog.append(el('p', { textContent: `${printerName}: ${L.bed.x} × ${L.bed.y} × ${L.bed.z} mm. ${L.parts.length} parts on ${L.plates.length} plate${L.plates.length === 1 ? '' : 's'}.` }));

    // Settings line.
    if (S) {
      const prof = S.json.printer_settings_id || 'unnamed printer profile';
      const cols = S.json.filament_colour.length;
      dialog.append(el('p', { textContent: `Printer and filament settings: ${prof}, ${cols} filament${cols === 1 ? '' : 's'} (from ${S.from}).` }));
      if (preset && !String(prof).toLowerCase().includes(String(preset.model).toLowerCase())) {
        dialog.append(
          el('p', {
            className: 'warn',
            textContent: `These settings are for ${prof}, not the ${printerName}. The bed size will be set to the ${printerName}’s, but speeds and temperatures stay as they are. For a proper profile, use settings from a project saved for the ${printerName}.`,
          })
        );
      }
    } else {
      dialog.append(
        el('p', {
          className: 'warn',
          textContent: 'No printer/filament settings yet. The loaded model isn’t a slicer project, so pick any project 3MF saved for your printer (Bambu Studio or OrcaSlicer) to take the settings from.',
        })
      );
    }

    // Toolbar.
    const pickSettings = el('input', { type: 'file', accept: '.3mf', hidden: true });
    pickSettings.dataset.mp3dInternal = '1';
    pickSettings.onchange = async () => {
      const f = pickSettings.files && pickSettings.files[0];
      if (!f) return;
      try {
        globalThis.__mp3dSettingsOverride = await globalThis.__mp3dSettingsFromFile(new Uint8Array(await f.arrayBuffer()), f.name);
        await refreshSettings();
        plan.rot = new Map();
        render(`Using settings from ${f.name}.`);
      } catch (err) {
        render(String(err.message || err));
      }
    };
    const exportBtn = el('button', { type: 'button', className: 'primary', textContent: 'Export project 3MF', disabled: !S });
    exportBtn.onclick = async () => {
      busy = true;
      exportBtn.disabled = true;
      const st = dialog.querySelector('.status');
      try {
        const r = await exportProject((m) => (st.textContent = m));
        busy = false;
        render(`Exported ${r.parts} parts on ${r.plates} plate${r.plates === 1 ? '' : 's'} (${(r.bytes / 1048576).toFixed(1)} MB, ${r.painted.toLocaleString('en-US')} painted triangles). Open it in Bambu Studio or OrcaSlicer.`);
      } catch (err) {
        busy = false;
        render(String(err.message || err));
      }
    };
    dialog.append(
      el(
        'div',
        { className: 'bar' },
        el('button', { type: 'button', textContent: 'Auto-arrange', onclick: () => { autoArrange(); render('Arranged onto the fewest plates the packer could manage.'); } }),
        el('button', { type: 'button', textContent: 'Add plate', onclick: () => { plan.plates.push({ name: `Plate ${plan.plates.length + 1}` }); render(); } }),
        el('button', { type: 'button', textContent: 'Remove empty plates', onclick: () => { removeEmpty(); render(); } }),
        el('button', { type: 'button', textContent: 'Use settings from another 3MF…', onclick: () => pickSettings.click() }),
        pickSettings,
        exportBtn,
        el('button', { type: 'button', textContent: 'Close', onclick: close })
      )
    );
    dialog.append(el('p', { className: 'status', role: 'status', textContent: statusText || '' }));

    if (L.tooBig.length) {
      dialog.append(el('p', { className: 'warn', textContent: `Too big for this printer in any orientation (use Auto-cut to fit first): ${L.tooBig.map((p) => p.name).join(', ')}` }));
    }

    const grid = el('div', { className: 'grid' });
    for (const pl of L.plates) {
      const bad = pl.overflow.length > 0 || pl.towerBlocked;
      const card = el('section', { className: 'card' + (bad ? ' bad' : '') });
      card.setAttribute('aria-label', pl.name);
      card.append(
        el('header', {}, el('h3', { textContent: `${pl.name} · ${pl.items.length} part${pl.items.length === 1 ? '' : 's'}` }), bad ? el('span', { className: 'warn', textContent: pl.overflow.length ? 'Doesn’t fit' : 'No room for prime tower' }) : null)
      );
      card.append(drawPlate(pl, L.bed));
      const ul = el('ul');
      for (const it of pl.items) {
        const sel = el('select', { 'aria-label': `Plate for ${it.part.name}` });
        L.plates.forEach((_, i) => sel.append(el('option', { value: String(i), textContent: `Plate ${i + 1}`, selected: i === pl.index })));
        sel.onchange = () => {
          plan.assign.set(it.id, Number(sel.value));
          render(`Moved ${it.part.name} to Plate ${Number(sel.value) + 1}.`);
        };
        const over = pl.overflow.includes(it.id);
        ul.append(
          el(
            'li',
            {},
            el('span', { className: 'sw', style: `background:${partColour(it.part)}` }),
            el('span', { className: 'nm' + (over ? ' warn' : ''), title: it.part.name, textContent: `${it.part.name}${over ? ' (no room)' : ''}` }),
            el('span', { textContent: `${Math.round(it.f.w)}×${Math.round(it.f.d)}×${Math.round(it.f.h)}` }),
            sel
          )
        );
      }
      if (!pl.items.length) ul.append(el('li', { textContent: 'Empty' }));
      card.append(ul);
      grid.append(card);
    }
    dialog.append(grid);
    paintAll();
    dialog.append(el('p', { textContent: 'Parts keep their orientation when it fits, otherwise they’re laid flattest-side down. Parts stay clear of the printer’s no-print zone. The prime tower isn’t placed; move it in the slicer if it lands on a part. The layout is applied in the exported project; the 3D view isn’t changed.' }));
  }

  function removeEmpty() {
    const L = layout();
    const keep = L.plates.filter((pl) => pl.items.length > 0).map((pl) => pl.index);
    if (!keep.length) keep.push(0);
    const remap = new Map(keep.map((old, i) => [old, i]));
    plan.plates = keep.map((_, i) => ({ name: `Plate ${i + 1}` }));
    for (const [id, k] of plan.assign) plan.assign.set(id, remap.has(k) ? remap.get(k) : 0);
  }

  async function open() {
    const S = cutStore();
    if (!S || !globalThis.__mp3dExportApi || !globalThis.__mp3dExportProject) return;
    returnFocus = document.activeElement;
    backdrop = el('div', { className: 'mp3d-pl-back', onclick: close });
    dialog = el('section', { className: 'mp3d-pl' });
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'mp3d-pl-title');
    document.body.append(backdrop, dialog);
    await refreshSettings();
    const fresh = syncWithParts();
    // First open, or new parts since last time: arrange automatically.
    if (fresh) autoArrange();
    await render();
    const first = dialog.querySelector('button');
    if (first) first.focus();
  }

  window.__mp3dPlates = { open, autoArrange, layout, exportProject, plan: () => plan, refreshSettings };

  /* ---- "Plates" button in the Parts panel --------------------------- */
  const ICON =
    '<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

  function decorate() {
    if (document.querySelector('.mp3d-pl-btn')) return;
    const arrange = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === 'arrange');
    if (!arrange) return;
    const row = arrange.parentElement;
    const b = el('button', { type: 'button', className: 'mp3d-pl-btn', title: 'Put parts on plates and export one project 3MF with colours and printer settings', onclick: open });
    b.innerHTML = ICON;
    b.append('Plates & project export');
    row.insertAdjacentElement('afterend', b);
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      decorate();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  decorate();
})();
