/**
 * Auto-cut to fit the selected printer (local build only).
 *
 * Repeatedly plane-cuts every part that doesn't fit the build volume until
 * all parts fit, adding connectors on each cut face.
 *
 * Every cut goes through the app's OWN cut pipeline, via its zustand store
 * (exposed by tools/sync-site.mjs as globalThis.__mp3dCutStore):
 *   selectPart -> enterCutMode -> setCutNormal/Origin -> enterConnectorsStage
 *   -> addConnectorAtWorld (x N) -> confirmCut
 * So paint is carried exactly as in a manual cut, connectors use the app's
 * own geometry and tolerances, each cut is a normal undo step, and colour 3MF
 * export works as before.
 *
 * Connector type/size come from the app's "Add Connectors" settings, so
 * whatever you set there (plug, dowel, magnet, ...) is what auto-cut uses.
 *
 * Fitting allows 90° turns: a part fits if its three sizes, largest first,
 * each fit the bed's three sizes, largest first (that's how you'd lay it on
 * the bed).
 */
(function () {
  'use strict';

  const MAX_CUTS = 80;
  const CANDIDATES = 9; // plane positions tried per cut
  const AXES = ['x', 'y', 'z'];
  const UNIT = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 } };

  const cutStore = () => globalThis.__mp3dCutStore;
  const printerStore = () => globalThis.__mp3dPrinterStore;
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  let running = false;
  let cancelRequested = false;

  /* ------------------------------------------------------------------ *
   * Geometry helpers
   * ------------------------------------------------------------------ */

  /** World-space size of a part: its bbox, scaled and rotated (XYZ, degrees). */
  function partSize(part) {
    const bb = part.boundingBox;
    const s = (part.transform && part.transform.scale) || 1;
    const r = (part.transform && part.transform.rotation) || { x: 0, y: 0, z: 0 };
    const d = Math.PI / 180;
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(r.x * d), Math.sin(r.x * d), Math.cos(r.y * d), Math.sin(r.y * d), Math.cos(r.z * d), Math.sin(r.z * d)];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const X of [bb.min.x, bb.max.x])
      for (const Y of [bb.min.y, bb.max.y])
        for (const Zc of [bb.min.z, bb.max.z]) {
          // three.js Euler 'XYZ': v' = Rx * Ry * Rz * v
          let x = X * s, y = Y * s, z = Zc * s;
          [x, y] = [x * cz - y * sz, x * sz + y * cz];
          [x, z] = [x * cy + z * sy, -x * sy + z * cy];
          [y, z] = [y * cx - z * sx, y * sx + z * cx];
          const v = [x, y, z];
          for (let i = 0; i < 3; i++) {
            if (v[i] < lo[i]) lo[i] = v[i];
            if (v[i] > hi[i]) hi[i] = v[i];
          }
        }
    return { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
  }

  /** Usable bed size: build volume minus a safety margin on every axis. */
  function limitsFor(volume, margin) {
    return [volume.x, volume.y, volume.z].map((v) => Math.max(10, v - margin)).sort((a, b) => b - a);
  }

  /**
   * How far a part is from fitting. Pairs the part's axes (largest first) with
   * the bed limits (largest first). Returns the worst axis and how many pieces
   * it needs along that axis, or null if it already fits.
   */
  function worstAxis(size, limits) {
    const dims = AXES.map((a) => ({ axis: a, d: size[a] })).sort((p, q) => q.d - p.d);
    let worst = null;
    dims.forEach((p, i) => {
      const lim = limits[i];
      if (p.d <= lim + 1e-6) return;
      const ratio = p.d / lim;
      if (!worst || ratio > worst.ratio) worst = { axis: p.axis, d: p.d, lim, ratio, pieces: Math.ceil(p.d / lim) };
    });
    return worst;
  }

  const fits = (part, limits) => !worstAxis(partSize(part), limits);

  /** Rough piece count for the preview text. */
  function estimatePieces(parts, limits) {
    let n = 0;
    for (const p of parts) {
      const s = partSize(p);
      const dims = AXES.map((a) => s[a]).sort((a, b) => b - a);
      n += dims.reduce((acc, d, i) => acc * Math.max(1, Math.ceil(d / limits[i])), 1);
    }
    return n;
  }

  /* ---- cross-section scoring (cut faces from the app's own slicer) ---- */

  function polyArea2d(pts) {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return a / 2;
  }

  /**
   * Scores a cross-section: prefer one big solid face (room for connectors,
   * strong joint) over many small ones (cutting through fingers, horns...).
   */
  function scoreSection(lines, axis) {
    // Right-handed plane axes for each normal (y×z=x, z×x=y, x×y=z), so outer
    // loops keep positive area. (x,z) for a Y cut is mirrored, which flipped
    // every face negative and made Y cuts look impossible.
    const [ia, ib] = axis === 'x' ? ['y', 'z'] : axis === 'y' ? ['z', 'x'] : ['x', 'y'];
    let largest = 0;
    let total = 0;
    let islands = 0;
    const areas = [];
    for (const poly of lines || []) {
      if (!poly || poly.length < 3) continue;
      areas.push(polyArea2d(poly.map((p) => [p[ia], p[ib]])));
    }
    // Belt and braces: if the slicer's winding convention is the other way
    // round, the biggest loop (always an outer one) comes out negative. Flip.
    const biggest = areas.reduce((m, a) => (Math.abs(a) > Math.abs(m) ? a : m), 0);
    const sign = biggest < 0 ? -1 : 1;
    for (const raw of areas) {
      const a = raw * sign;
      if (a > 0) {
        islands++;
        if (a > largest) largest = a;
      }
      total += a; // holes are negative
    }
    return { largest, total, islands, score: largest / (1 + 0.25 * Math.max(0, islands - 1)) };
  }

  /* ---- connector placement on the cut face (u,v plane coordinates) ---- */

  function pointInPoly(u, v, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ui, vi] = poly[i];
      const [uj, vj] = poly[j];
      if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi + 1e-12) + ui) inside = !inside;
    }
    return inside;
  }

  function edgeDistance(u, v, polys) {
    let best = Infinity;
    for (const poly of polys) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, ay] = poly[j];
        const [bx, by] = poly[i];
        const dx = bx - ax, dy = by - ay;
        const L = dx * dx + dy * dy;
        let t = L > 0 ? ((u - ax) * dx + (v - ay) * dy) / L : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = ax + t * dx - u, ey = ay + t * dy - v;
        const d2 = ex * ex + ey * ey;
        if (d2 < best) best = d2;
      }
    }
    return Math.sqrt(best);
  }

  /** Clearance a connector needs from the face edge (mirrors the app's check, plus slack). */
  function neededClearance(params) {
    const r =
      params.type === 'magnet'
        ? params.magnetDiameter / 2 + 0.1
        : params.type === 'through-hole'
        ? params.throughHoleDiameter / 2 + 0.3
        : params.diameter / 2 + 0.3;
    return r + Math.min(1, Math.max(0.4, r * 0.5)) + 0.6;
  }

  /**
   * Distance from `o` along unit `dir` to the first surface of a (non-indexed)
   * geometry, ignoring hits closer than `eps` (the cut face itself). Infinity
   * if nothing is hit within `maxDist`.
   */
  /**
   * Number of surfaces a ray crosses (ignoring the first `eps`, i.e. the cut
   * face itself). From a point inside exactly one closed shell the count is
   * odd. Even means the point sits inside two overlapping shells (or none),
   * which is where connectors come out with doubled surfaces.
   */
  function crossings(geom, o, dir, eps) {
    const pos = geom.getAttribute('position');
    if (!pos) return 0;
    const a = pos.array;
    const [ox, oy, oz] = [o.x, o.y, o.z];
    const [dx, dy, dz] = [dir.x, dir.y, dir.z];
    let n = 0;
    for (let i = 0; i + 8 < a.length; i += 9) {
      const ax = a[i], ay = a[i + 1], az = a[i + 2];
      const e1x = a[i + 3] - ax, e1y = a[i + 4] - ay, e1z = a[i + 5] - az;
      const e2x = a[i + 6] - ax, e2y = a[i + 7] - ay, e2z = a[i + 8] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - ax, ty = oy - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > eps) n++;
    }
    return n;
  }

  function wallDistance(geom, o, dir, eps, maxDist) {
    const pos = geom.getAttribute('position');
    if (!pos) return Infinity;
    const a = pos.array;
    const [ox, oy, oz] = [o.x, o.y, o.z];
    const [dx, dy, dz] = [dir.x, dir.y, dir.z];
    let best = maxDist;
    for (let i = 0; i + 8 < a.length; i += 9) {
      const ax = a[i], ay = a[i + 1], az = a[i + 2];
      const e1x = a[i + 3] - ax, e1y = a[i + 4] - ay, e1z = a[i + 5] - az;
      const e2x = a[i + 6] - ax, e2y = a[i + 7] - ay, e2z = a[i + 8] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const tx = ox - ax, ty = oy - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > eps && t < best) best = t;
    }
    return best < maxDist ? best : Infinity;
  }

  /**
   * Keeps only connector spots where the material behind the cut face is
   * thicker than the connector on BOTH halves. The app warns "keep depth below
   * the local wall thickness"; ignoring that lets a socket graze or punch
   * through the back surface, which was the source of non-manifold rings.
   */
  function filterByWallThickness(picks, preview, params, Vec) {
    if (params.type === 'through-hole') return { kept: picks, dropped: 0 };
    const depth = params.type === 'magnet' ? params.magnetThickness : params.depth;
    const need = depth + 1.5;
    const n = new Vec(0, 0, 1).applyQuaternion(preview.planeQuat).normalize();
    // Orient n from A towards B, the same way the app does for connectors.
    const cA = new Vec(), cB = new Vec();
    preview.geometryA.computeBoundingBox();
    preview.geometryB.computeBoundingBox();
    preview.geometryA.boundingBox.getCenter(cA);
    preview.geometryB.boundingBox.getCenter(cB);
    if (cB.clone().sub(cA).dot(n) < 0) n.negate();
    const toB = n, toA = n.clone().negate();
    const kept = [];
    let overlap = 0;
    for (const p of picks) {
      const o = new Vec(p.u, p.v, preview.offset).applyQuaternion(preview.planeQuat);
      const inB = wallDistance(preview.geometryB, o, toB, 0.05, need * 4);
      const inA = wallDistance(preview.geometryA, o, toA, 0.05, need * 4);
      if (inA < need || inB < need) continue;
      // Inside exactly one shell on both sides? (odd crossings each way)
      if (crossings(preview.geometryB, o, toB, 0.05) % 2 === 0 || crossings(preview.geometryA, o, toA, 0.05) % 2 === 0) {
        overlap++;
        continue;
      }
      kept.push(p);
    }
    return { kept, dropped: picks.length - kept.length, overlap };
  }

  /**
   * Picks connector positions: per solid island, 1-4 points (by area), each
   * the most-inset spot still free, spread apart.
   */
  function planConnectors(preview, params) {
    const polys = (preview.capPolygons || []).filter((p) => p && p.length >= 3);
    if (!polys.length) return [];
    const { uMin, uMax, vMin, vMax } = preview.capBounds;
    const span = Math.max(uMax - uMin, vMax - vMin);
    if (!(span > 0)) return [];
    const need = neededClearance(params);
    const step = Math.max(0.4, span / 90);
    const areas = polys.map((p) => Math.abs(polyArea2d(p)));

    // Grid samples inside solid material, with clearance and island id.
    const islands = new Map();
    for (let u = uMin + step / 2; u < uMax; u += step) {
      for (let v = vMin + step / 2; v < vMax; v += step) {
        let depth = 0;
        let owner = -1;
        for (let k = 0; k < polys.length; k++) {
          if (!pointInPoly(u, v, polys[k])) continue;
          depth++;
          if (owner < 0 || areas[k] < areas[owner]) owner = k;
        }
        if (depth % 2 === 0) continue; // outside, or inside a hole
        const c = edgeDistance(u, v, polys);
        if (c < need) continue;
        let list = islands.get(owner);
        if (!list) islands.set(owner, (list = []));
        list.push({ u, v, c });
      }
    }

    const picks = [];
    for (const [owner, pts] of islands) {
      const area = areas[owner];
      if (area < Math.PI * need * need * 2) continue;
      const count = area < 400 ? 1 : area < 2500 ? 2 : area < 10000 ? 3 : 4;
      const minSep = Math.max(need * 3, Math.sqrt(area) / (count + 1));
      pts.sort((a, b) => b.c - a.c);
      const chosen = [];
      for (const p of pts) {
        if (chosen.length >= count) break;
        if (chosen.every((q) => Math.hypot(p.u - q.u, p.v - q.v) >= minSep)) chosen.push(p);
      }
      picks.push(...chosen);
    }
    return picks;
  }

  /* ------------------------------------------------------------------ *
   * Post-cut cleanup: zero-thickness internal walls
   *
   * The app's plug pin is built as two stacked cylinders (body + chamfered
   * tip). Sometimes the cut engine keeps the disc where they touch as two
   * coincident, opposite-facing triangle sheets inside the pin. That encloses
   * no volume, but slicers see it as non-manifold edges and "reversed faces".
   * Removing both triangles of every such pair never changes the solid.
   * ------------------------------------------------------------------ */

  function findWallPairs(geom) {
    const pos = geom.getAttribute('position');
    if (!pos || pos.count < 6) return null;
    const bits = new Uint32Array(pos.array.buffer, pos.array.byteOffset, pos.count * 3);
    const vid = new Map();
    const ids = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const k = `${bits[i * 3]},${bits[i * 3 + 1]},${bits[i * 3 + 2]}`;
      let w = vid.get(k);
      if (w === undefined) vid.set(k, (w = vid.size));
      ids[i] = w;
    }
    const triCount = pos.count / 3;
    const groups = new Map();
    for (let t = 0; t < triCount; t++) {
      const a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
      const s = [a, b, c].sort((x, y) => x - y);
      const k = `${s[0]},${s[1]},${s[2]}`;
      const g = groups.get(k);
      if (g) g.push(t);
      else groups.set(k, [t]);
    }
    const cyc = (t) => {
      const a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
      return a <= b && a <= c ? `${a},${b},${c}` : b <= a && b <= c ? `${b},${c},${a}` : `${c},${a},${b}`;
    };
    let drop = null;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const ref = cyc(list[0]);
      const fwd = [], rev = [];
      for (const t of list) (cyc(t) === ref ? fwd : rev).push(t);
      const n = Math.min(fwd.length, rev.length);
      for (let k = 0; k < n; k++) {
        if (!drop) drop = new Set();
        drop.add(fwd[k]);
        drop.add(rev[k]);
      }
    }
    return drop;
  }

  /** Edges shared by more than two triangles (exact-position weld). */
  function nonManifoldEdgeCount(geom) {
    const pos = geom.getAttribute('position');
    if (!pos) return 0;
    const bits = new Uint32Array(pos.array.buffer, pos.array.byteOffset, pos.count * 3);
    const vid = new Map();
    const ids = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const k = `${bits[i * 3]},${bits[i * 3 + 1]},${bits[i * 3 + 2]}`;
      let w = vid.get(k);
      if (w === undefined) vid.set(k, (w = vid.size));
      ids[i] = w;
    }
    const V = vid.size;
    const cnt = new Map();
    for (let t = 0; t < pos.count / 3; t++) {
      for (let e = 0; e < 3; e++) {
        const a = ids[t * 3 + e], b = ids[t * 3 + ((e + 1) % 3)];
        const k = a < b ? a * V + b : b * V + a;
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
    }
    let n = 0;
    for (const c of cnt.values()) if (c > 2) n++;
    return n;
  }

  /** Returns a new part with the wall triangles (and their paint labels) removed. */
  function withoutWalls(part, drop) {
    const g = part.geometry;
    const triCount = g.getAttribute('position').count / 3;
    const keep = [];
    for (let t = 0; t < triCount; t++) if (!drop.has(t)) keep.push(t);
    const ng = new g.constructor();
    for (const [name, attr] of Object.entries(g.attributes)) {
      const size = attr.itemSize;
      const src = attr.array;
      const out = new src.constructor(keep.length * 3 * size);
      let w = 0;
      for (const t of keep) {
        const base = t * 3 * size;
        for (let j = 0; j < 3 * size; j++) out[w++] = src[base + j];
      }
      ng.setAttribute(name, new attr.constructor(out, size, attr.normalized));
    }
    const { carriedColor, ...userData } = g.userData || {};
    void carriedColor;
    ng.userData = userData;
    ng.computeBoundingBox();
    let slotLabels = part.slotLabels;
    if (slotLabels && slotLabels.length === triCount) {
      slotLabels = new slotLabels.constructor(keep.length);
      keep.forEach((t, i) => (slotLabels[i] = part.slotLabels[t]));
    }
    return { ...part, geometry: ng, boundingBox: ng.boundingBox.clone(), triangleCount: keep.length, slotLabels };
  }

  /** Cleans the given parts in the store (and in the current undo entry). */
  function cleanNewParts(ids) {
    const S = cutStore();
    const replaced = new Map();
    let removed = 0;
    for (const id of ids) {
      const part = S.getState().parts.find((p) => p.id === id);
      if (!part) continue;
      const drop = findWallPairs(part.geometry);
      if (!drop || !drop.size) continue;
      replaced.set(id, withoutWalls(part, drop));
      removed += drop.size;
    }
    if (!replaced.size) return 0;
    S.setState((s) => ({
      parts: s.parts.map((p) => replaced.get(p.id) || p),
      history: s.history.map((h, i) =>
        i === s.historyIndex ? { ...h, parts: h.parts.map((p) => (replaced.has(p.id) ? { ...replaced.get(p.id) } : p)) } : h
      ),
    }));
    return removed;
  }

  /* ------------------------------------------------------------------ *
   * One cut
   * ------------------------------------------------------------------ */

  async function cutOnce(partId, plan, opts, log) {
    const S = cutStore();
    const st = () => S.getState();

    st().setCutMethod('planar');
    st().selectPart(partId);
    st().enterCutMode(); // bakes the part's transform into its geometry
    await frame();

    const part = st().parts.find((p) => p.id === partId);
    if (!part) throw new Error('part disappeared');
    const bb = part.boundingBox;
    const axis = plan.axis;
    const lo = bb.min[axis];
    const d = bb.max[axis] - lo;
    const n = Math.max(2, Math.ceil(d / plan.lim));

    // First piece thickness t: equal split is ideal; anything in the window
    // still leaves a remainder that n-1 more pieces can cover.
    const tMin = Math.max(d - (n - 1) * plan.lim, d * 0.08);
    const tMax = Math.min(plan.lim, d * 0.92);
    const ideal = Math.min(tMax, Math.max(tMin, d / n));
    const ts = new Set([ideal]);
    for (let i = 0; i < CANDIDATES; i++) ts.add(tMin + ((tMax - tMin) * i) / Math.max(1, CANDIDATES - 1));

    const center = { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 };
    st().setCutNormal(UNIT[axis]);

    // Score each candidate plane by its cut face.
    //
    // A plane that crosses nothing but still has material on both sides runs
    // through a gap between separate pieces (kits, multi-piece models). That
    // is the best cut there is: it separates pieces without a seam. It gets
    // the top score; if one side turns out empty, the app rejects it and the
    // next candidate is tried.
    const scored = [];
    let bestFace = 0;
    for (const t of ts) {
      const origin = { ...center, [axis]: lo + t };
      st().setCutOrigin(origin);
      st().updateCrossSection();
      const sec = scoreSection(st().crossSectionLines, axis);
      if (sec.largest > bestFace) bestFace = sec.largest;
      // Mild pull toward the even split, so pieces stay similar in size.
      const closeness = 1 - Math.min(1, Math.abs(t - ideal) / Math.max(1, tMax - tMin));
      scored.push({ t, origin, sec, gap: sec.largest <= 0, closeness });
    }
    for (const c of scored) c.score = c.gap ? Infinity : c.sec.score * (0.7 + 0.3 * c.closeness);
    // Among gap planes, the one nearest the even split wins.
    scored.sort((a, b) => (a.gap && b.gap ? b.closeness - a.closeness : b.score - a.score));

    // Try the best planes until one commits. Gap planes that turn out to have
    // an empty side are cheap to reject, so allow a few more attempts.
    let lastError = null;
    const tries = scored.filter((c) => c.gap).length + 4;
    const nmBefore = nonManifoldEdgeCount(part.geometry);
    for (const cand of scored.slice(0, tries)) {
     // Pass 1 with connectors; pass 2 (only if pass 1 broke a clean mesh)
     // redoes the same plane glue-only.
     for (const withConnectors of opts.connectors ? [true, false] : [false]) {
      if (cancelRequested) throw new Error('cancelled');
      if (!withConnectors) {
        // Back to the state before the bad cut, same plane.
        st().selectPart(partId);
        st().setCutMethod('planar');
        st().enterCutMode();
        await frame();
        st().setCutNormal(UNIT[axis]);
      }
      st().setCutOrigin(cand.origin);
      st().clearConnectors();
      await st().enterConnectorsStage();
      if (st().cutError || !st().cutPreview) {
        lastError = st().cutError || 'preview failed';
        st().exitConnectorsStage && st().exitConnectorsStage();
        break; // this plane can't be previewed at all: next plane
      }

      let placed = 0;
      let thinSpots = 0;
      let overlapSpots = 0;
      if (withConnectors) {
        const preview = st().cutPreview;
        const params = st().connectorParams;
        const Vec = part.boundingBox.min.constructor;
        const { kept, dropped, overlap } = filterByWallThickness(planConnectors(preview, params), preview, params, Vec);
        thinSpots = dropped - overlap;
        overlapSpots = overlap;
        // The app may move a connector to satisfy its edge clearance; when it
        // can't, it falls back to the single best spot on the face. Several
        // picks can then land on the same point, and stacked identical pegs
        // make non-manifold geometry. Read back where each one really went
        // and drop any that sit on top of (or overlap) another.
        const minGap = neededClearance(params) * 2;
        const accepted = [];
        for (const p of kept) {
          const world = new Vec(p.u, p.v, preview.offset).applyQuaternion(preview.planeQuat);
          const id = st().addConnectorAtWorld(world);
          if (!id) continue;
          const c = st().connectors.find((k) => k.id === id);
          if (!c || accepted.some((q) => Math.hypot(q.u - c.u, q.v - c.v) < minGap)) {
            st().removeConnector(id);
            continue;
          }
          accepted.push({ u: c.u, v: c.v });
          placed++;
        }
      }

      // Final guard on what will actually be baked: no two connectors may
      // overlap. Two identical pegs on one spot make the cut engine emit
      // coincident double surfaces (non-manifold edges in the slicer).
      let stacked = 0;
      if (withConnectors && st().connectors.length > 1) {
        const gap = neededClearance(st().connectorParams) * 2;
        const seen = [];
        for (const c of [...st().connectors]) {
          if (seen.some((q) => Math.hypot(q.u - c.u, q.v - c.v) < gap)) {
            st().removeConnector(c.id);
            stacked++;
          } else seen.push(c);
        }
        placed = st().connectors.length;
      }
      const connectorsAtCommit = st().connectors.map((c) => [+c.u.toFixed(2), +c.v.toFixed(2)]);

      const idsBefore = new Set(st().parts.map((p) => p.id));
      await st().confirmCut();
      if (!st().cutError) {
        const newIds = st().parts.map((p) => p.id).filter((id) => !idsBefore.has(id));
        const nmPreClean = newIds.map((id) => {
          const p = st().parts.find((q) => q.id === id);
          return p ? nonManifoldEdgeCount(p.geometry) : null;
        });
        const wallTris = globalThis.__mp3dAutoCutNoWallClean ? 0 : cleanNewParts(newIds);
        const nmAfter = newIds.map((id) => {
          const p = st().parts.find((q) => q.id === id);
          return p ? { name: p.name, nm: nonManifoldEdgeCount(p.geometry) } : null;
        });
        // Verify: a cut must not turn a clean mesh into a broken one. If the
        // connectors did, undo and redo this plane without them.
        if (withConnectors && placed > 0 && nmBefore === 0 && nmAfter.some((p) => p && p.nm > 0)) {
          st().undo();
          await frame();
          log(`connectors at one cut made bad geometry; redoing that cut glue-only`);
          continue;
        }
        return {
          wallTris,
          stacked,
          connectorsAtCommit,
          nmBefore,
          nmPreClean,
          nmAfter,
          overlapSpots,
          redoneGlueOnly: !withConnectors && opts.connectors,
          params: { ...st().connectorParams },
          axis,
          t: cand.t,
          planeAt: +(lo + cand.t).toFixed(3),
          partRange: [+lo.toFixed(3), +(lo + d).toFixed(3)],
          connectors: placed,
          thinSpots,
          faceArea: cand.sec.total,
          islands: cand.sec.islands,
        };
      }

      lastError = st().cutError;
      // Commit failed: retry this plane once without connectors.
      if (placed && !/not manifold/i.test(lastError)) {
        st().clearConnectors();
        await st().confirmCut();
        if (!st().cutError) {
          log(`connectors didn’t fit at one cut; that joint is glue-only`);
          return { axis, t: cand.t, connectors: 0, faceArea: cand.sec.total, connectorsDropped: placed };
        }
        lastError = st().cutError;
      }
      if (/not manifold/i.test(lastError)) break;
      st().exitConnectorsStage && st().exitConnectorsStage();
      break; // commit failed for a reason other than bad connector geometry: next plane
     }
     if (/not manifold/i.test(String(lastError))) break;
    }
    st().exitCutMode();
    const err = new Error(lastError || 'cut failed');
    err.notManifold = /not manifold/i.test(String(lastError));
    throw err;
  }

  /* ------------------------------------------------------------------ *
   * The whole run
   * ------------------------------------------------------------------ */

  async function autoCut(opts, onProgress) {
    const S = cutStore();
    const P = printerStore();
    if (!S || !P) throw new Error('auto-cut isn’t available in this build');
    const st = () => S.getState();
    if (!st().isManifoldReady) throw new Error('the cut engine is still loading, try again in a moment');
    const volume = P.getState().getBuildVolume();
    if (!volume) throw new Error('choose a printer in the side panel first');
    if (!st().parts.length) throw new Error('load a model first');

    const limits = limitsFor(volume, opts.margin);
    if (st().cutActive) st().exitCutMode();

    const report = { cuts: 0, connectors: 0, glueOnly: 0, skippedParts: [], startParts: st().parts.length, notManifold: false };
    const failed = new Set();
    const t0 = performance.now();


    while (report.cuts < MAX_CUTS) {
      if (cancelRequested) break;
      const todo = st().parts.filter((p) => !failed.has(p.id) && !fits(p, limits));
      if (!todo.length) break;
      // Biggest first.
      todo.sort((a, b) => {
        const sa = partSize(a), sb = partSize(b);
        return sb.x * sb.y * sb.z - sa.x * sa.y * sa.z;
      });
      const part = todo[0];
      const plan = worstAxis(partSize(part), limits);
      onProgress(`Cut ${report.cuts + 1}: ${part.name} (${Math.round(plan.d)} mm → pieces of ≤ ${Math.round(plan.lim)} mm)`);
      try {
        const r = await cutOnce(part.id, plan, opts, onProgress);
        report.cuts++;
        report.connectors += r.connectors;
        report.thinSpotsSkipped = (report.thinSpotsSkipped || 0) + (r.thinSpots || 0);
        report.wallTrianglesRemoved = (report.wallTrianglesRemoved || 0) + (r.wallTris || 0);
        report.overlapSpotsSkipped = (report.overlapSpotsSkipped || 0) + (r.overlapSpots || 0);
        if (r.redoneGlueOnly) report.redoneGlueOnly = (report.redoneGlueOnly || 0) + 1;
        (report.log = report.log || []).push({ part: part.name, ...r, faceArea: Math.round(r.faceArea) });
        if (opts.connectors && r.connectors === 0) report.glueOnly++;
      } catch (err) {
        if (String(err.message) === 'cancelled') break;
        failed.add(part.id);
        report.skippedParts.push({ name: part.name, reason: err.message });
        if (err.notManifold) {
          report.notManifold = true;
          break; // every further cut would hit the same broken mesh
        }
      }
      await frame();
    }

    if (st().cutActive) st().exitCutMode();
    if (report.cuts > 0) st().arrangeParts();

    const parts = st().parts;
    report.parts = parts.length;
    report.fitting = parts.filter((p) => fits(p, limits)).length;
    report.allFit = report.fitting === parts.length;
    report.painted = parts.some((p) => p.slotLabels && p.slotLabels.length);
    report.hitMaxCuts = report.cuts >= MAX_CUTS;
    report.cancelled = cancelRequested;
    report.ms = Math.round(performance.now() - t0);
    report.volume = volume;
    report.margin = opts.margin;
    return report;
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  const style = document.createElement('style');
  style.textContent = `
    .mp3d-ac-btn{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin-top:8px;
      font:inherit;font-size:12px;font-weight:600;border-radius:6px;padding:7px 10px;cursor:pointer;
      border:1px solid #dfe22a;background:#dfe22a;color:#09090b}
    .mp3d-ac-btn:hover{filter:brightness(1.05)}
    .mp3d-ac-btn:focus-visible{outline:2px solid #fafafa;outline-offset:2px}
    .mp3d-ac{position:fixed;right:20px;bottom:48px;z-index:2147483000;width:400px;max-width:calc(100vw - 40px);
      background:#18181b;color:#e4e4e7;border:1px solid #3f3f46;border-radius:12px;padding:16px 16px 14px;
      font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.55)}
    .mp3d-ac h2{margin:0 0 8px;font-size:14px;font-weight:600;color:#fafafa}
    .mp3d-ac p{margin:0 0 6px;color:#a1a1aa}
    .mp3d-ac ul{margin:4px 0 8px;padding-left:18px;color:#d4d4d8}
    .mp3d-ac li{margin:2px 0}
    .mp3d-ac .ok{color:#86efac}.mp3d-ac .warn{color:#fca5a5}
    .mp3d-ac label{display:flex;align-items:center;gap:8px;margin:6px 0;color:#d4d4d8}
    .mp3d-ac input[type=number]{width:64px;background:#09090b;color:#f4f4f5;border:1px solid #3f3f46;border-radius:6px;padding:3px 6px;font:inherit}
    .mp3d-ac .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px}
    .mp3d-ac button{font:inherit;font-weight:600;border-radius:8px;padding:6px 12px;cursor:pointer;border:1px solid #52525b;background:#27272a;color:#f4f4f5}
    .mp3d-ac button.primary{background:#dfe22a;border-color:#dfe22a;color:#09090b}
    .mp3d-ac button:focus-visible{outline:2px solid #fafafa;outline-offset:2px}
    .mp3d-ac .bar{height:4px;background:#27272a;border-radius:2px;overflow:hidden;margin:8px 0 4px}
    .mp3d-ac .bar i{display:block;height:100%;width:35%;background:#dfe22a;animation:mp3dacslide 1.2s ease-in-out infinite}
    @keyframes mp3dacslide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
    @media (prefers-reduced-motion:reduce){.mp3d-ac .bar i{animation:none;width:100%;opacity:.5}}`;
  document.head.appendChild(style);

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) n.append(k);
    return n;
  };
  const button = (label, onClick, primary) =>
    el('button', { type: 'button', className: primary ? 'primary' : '', textContent: label, onclick: onClick });

  let panel = null;
  let returnFocus = null;
  function showPanel(build) {
    if (!panel) returnFocus = document.activeElement;
    if (panel) panel.remove();
    panel = el('section', { className: 'mp3d-ac' });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'mp3d-ac-title');
    panel.setAttribute('aria-live', 'polite');
    build(panel);
    document.body.appendChild(panel);
    const f = panel.querySelector('button.primary') || panel.querySelector('button');
    if (f) f.focus();
  }
  function closePanel() {
    if (panel) panel.remove();
    panel = null;
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel && !running) closePanel();
  });

  const fmt = (v) => `${Math.round(v.x)} × ${Math.round(v.y)} × ${Math.round(v.z)} mm`;

  function connectorLabel(p) {
    const names = { plug: 'Plug', dowel: 'Dowel', snap: 'Snap-fit', 'through-hole': 'Pin hole', magnet: 'Magnet' };
    const size =
      p.type === 'magnet' ? `${p.magnetDiameter}×${p.magnetThickness} mm` : p.type === 'through-hole' ? `Ø${p.throughHoleDiameter} mm` : `Ø${p.diameter} mm, ${p.depth} mm deep`;
    return `${names[p.type] || p.type}, ${size}`;
  }

  function openSetup() {
    if (running) return;
    const S = cutStore(), P = printerStore();
    if (!S || !P) return;
    const volume = P.getState().getBuildVolume();
    const preset = P.getState().getSelectedPreset && P.getState().getSelectedPreset();
    const printerName = preset ? `${preset.brand} ${preset.model}` : 'Custom printer';
    const parts = S.getState().parts;

    showPanel((p) => {
      p.append(el('h2', { id: 'mp3d-ac-title', textContent: 'Auto-cut to fit printer' }));
      if (!volume) {
        p.append(el('p', { className: 'warn', textContent: 'Choose a printer in the side panel first.' }));
        const row = el('div', { className: 'row' });
        row.append(button('Close', closePanel, true));
        p.append(row);
        return;
      }
      p.append(el('p', { textContent: `${printerName}: ${fmt(volume)}` }));
      const margin = el('input', { type: 'number', min: 0, max: 50, step: 1, value: 5, id: 'mp3d-ac-margin' });
      const conn = el('input', { type: 'checkbox', checked: true, id: 'mp3d-ac-conn' });
      const estimate = el('p', {});
      const update = () => {
        const m = Math.max(0, Number(margin.value) || 0);
        const n = estimatePieces(parts, limitsFor(volume, m));
        const already = parts.every((pt) => fits(pt, limitsFor(volume, m)));
        // Box-based count: a real shape with empty space (arms, legs, gaps)
        // needs fewer, so present it as an upper bound.
        estimate.textContent = already ? 'Everything already fits this printer.' : `Up to about ${n} pieces (usually fewer).`;
        estimate.className = already ? 'ok' : '';
      };
      margin.oninput = update;
      const mLabel = el('label', { htmlFor: 'mp3d-ac-margin' }, 'Keep', margin, 'mm clear of the bed edges');
      const cLabel = el('label', { htmlFor: 'mp3d-ac-conn' }, conn, `Add connectors (${connectorLabel(S.getState().connectorParams)})`);
      p.append(mLabel, cLabel);
      p.append(el('p', { textContent: 'Connector type and size come from the cut tool’s Add Connectors settings. Paint is kept. Each cut can be undone.' }));
      p.append(estimate);
      update();
      const row = el('div', { className: 'row' });
      row.append(
        button('Cancel', closePanel),
        button('Auto-cut', () => run({ margin: Math.max(0, Number(margin.value) || 0), connectors: conn.checked }, printerName), true)
      );
      p.append(row);
    });
  }

  async function run(opts, printerName) {
    running = true;
    cancelRequested = false;
    const status = el('p', { textContent: 'Starting…' });
    showPanel((p) => {
      p.append(el('h2', { id: 'mp3d-ac-title', textContent: `Cutting to fit ${printerName}` }));
      p.append(el('div', { className: 'bar' }, el('i')));
      p.append(status);
      const row = el('div', { className: 'row' });
      row.append(button('Stop after this cut', () => { cancelRequested = true; status.textContent = 'Stopping after this cut…'; }));
      p.append(row);
    });
    let report;
    try {
      report = await autoCut(opts, (m) => (status.textContent = m));
    } catch (err) {
      running = false;
      window.__mp3dAutoCutReport = { error: String(err.message || err) };
      showPanel((p) => {
        p.append(el('h2', { id: 'mp3d-ac-title', textContent: 'Auto-cut couldn’t run' }));
        p.append(el('p', { className: 'warn', textContent: String(err.message || err) }));
        const row = el('div', { className: 'row' });
        row.append(button('Close', closePanel, true));
        p.append(row);
      });
      return;
    }
    running = false;
    window.__mp3dAutoCutReport = report;

    showPanel((p) => {
      const title = report.cuts === 0 && report.allFit ? 'Already fits' : report.allFit ? 'Every part fits' : 'Some parts still don’t fit';
      p.append(el('h2', { id: 'mp3d-ac-title', textContent: title }));
      const items = [
        `${report.parts} parts from ${report.startParts}, ${report.cuts} cuts (${(report.ms / 1000).toFixed(1)} s)`,
        `${report.fitting} of ${report.parts} fit ${fmt(report.volume)} with ${report.margin} mm clearance`,
      ];
      if (opts.connectors) items.push(`${report.connectors} connectors${report.glueOnly ? `; ${report.glueOnly} joints too small for one (glue those)` : ''}`);
      if (report.painted) items.push('Paint kept on every part');
      p.append(el('ul', {}, ...items.map((t) => el('li', { textContent: t }))));
      if (report.notManifold) {
        p.append(el('p', { className: 'warn', textContent: 'The mesh isn’t watertight, so it can’t be cut. Repair it (keeps colours), then run auto-cut again.' }));
      } else if (report.skippedParts.length) {
        p.append(el('p', { className: 'warn', textContent: `Couldn’t cut: ${report.skippedParts.map((s) => s.name).join(', ')}` }));
      }
      if (report.hitMaxCuts) p.append(el('p', { className: 'warn', textContent: `Stopped at ${MAX_CUTS} cuts. Try a bigger printer or a smaller model.` }));
      if (report.cancelled) p.append(el('p', { textContent: 'Stopped early, as asked.' }));
      p.append(el('p', { textContent: 'Use Undo to step back through the cuts. Export 3MF from the Parts panel to keep the colours.' }));
      const row = el('div', { className: 'row' });
      if (report.notManifold && window.__mp3dRepairCurrent) {
        row.append(button('Repair model', () => { closePanel(); window.__mp3dRepairCurrent(); }));
      }
      row.append(button('Close', closePanel, true));
      p.append(row);
    });
  }

  window.__mp3dAutoCut = autoCut;
  window.__mp3dAutoCutOpen = openSetup;
  window.__mp3dAutoCutFits = (partId, margin = 5) => {
    const part = cutStore().getState().parts.find((p) => p.id === partId);
    const v = printerStore().getState().getBuildVolume();
    return part && v ? fits(part, limitsFor(v, margin)) : null;
  };
  window.__mp3dPartSize = partSize;

  /* ---- button in the side panel's PRINTER section ------------------- */
  const SCISSORS =
    '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>';

  function decorate() {
    if (document.querySelector('.mp3d-ac-btn')) return;
    if (!/MODEL INFO/.test(document.body.innerText || '')) return;
    const label = [...document.querySelectorAll('div,span,p')].find(
      (n) => n.children.length === 0 && (n.textContent || '').trim() === 'BUILD VOLUME' || (n.children.length === 0 && (n.textContent || '').trim() === 'Build Volume')
    );
    if (!label) return;
    // The card holding "BUILD VOLUME" + its value.
    let card = label.parentElement;
    for (let i = 0; i < 3 && card && !/\d+\s*×\s*\d+/.test(card.textContent || ''); i++) card = card.parentElement;
    if (!card) return;
    const b = el('button', {
      type: 'button',
      className: 'mp3d-ac-btn',
      title: 'Cut the model into pieces that fit this printer, with connectors. Paint is kept.',
      onclick: openSetup,
    });
    b.innerHTML = SCISSORS;
    b.append('Auto-cut to fit');
    card.insertAdjacentElement('afterend', b);
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
