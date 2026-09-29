'use strict';
/**
 * Paint-preserving mesh repair for 3MF models.
 *
 * The cut engine (Manifold) only accepts a closed, consistently oriented
 * surface: every edge shared by exactly two triangles running in opposite
 * directions. Measured on the user's "alien humanoid" (1.94M triangles):
 *
 *   24,492 split vertices (most of the 48,738 open edges Bambu reports)
 *   7 holes (24 open edges once vertices are joined), the largest 5 edges
 *   3 back-to-front triangles
 *   0 duplicates, 0 non-manifold edges, 1 connected piece
 *
 * Steps (3-5 repeat until clean, max MAX_PASSES):
 *   1. weld vertices at identical positions
 *   2. drop degenerate triangles
 *   3. drop duplicate triangles, keeping a painted copy when there is one
 *   4. make winding consistent per connected piece (flip the minority)
 *   5. fill holes: 3-edge holes get one triangle, small ones are ear-clipped,
 *      anything else gets a centroid fan (always valid)
 *   6. flip any closed piece that faces inwards
 *
 * Paint
 * -----
 * Kept original triangles are written back with their ORIGINAL attribute
 * text, so paint_color strings survive byte for byte, sub-triangle detail
 * included. Exceptions, all counted in the report:
 *   - a flipped triangle with sub-triangle paint is reduced to its dominant
 *     filament (the detail is laid out relative to corner order and would be
 *     mirrored)
 *   - fill triangles: if every original triangle around a filled hole has the
 *     same plain colour, the fill gets that colour. Otherwise it is left
 *     unpainted, so it shows in the object's base filament, ready to paint
 *     over in the slicer.
 */

const MAX_PASSES = 4;
const EAR_CLIP_MAX = 64;

/* ---------------------------------------------------------------------- *
 * Paint encoding helpers (Bambu / Prusa TriangleSelector)
 * ---------------------------------------------------------------------- */

const PAINT_ATTR = /\s*\b(paint_color|[\w-]+:mmu_segmentation)="([^"]*)"/;

/** Single unsplit triangle code: "4", "8", "0C", "1C", ... */
function isLeafCode(code) {
  if (!code) return true;
  const last = parseInt(code[code.length - 1], 16);
  if (Number.isNaN(last) || (last & 3) !== 0) return false;
  return (last & 12) === 12 ? code.length === 2 : code.length === 1;
}

/** Filament state of a leaf code; -1 if not a leaf. 0 = unpainted. */
function leafState(code) {
  if (!code) return 0;
  if (!isLeafCode(code)) return -1;
  const last = parseInt(code[code.length - 1], 16);
  return (last & 12) === 12 ? parseInt(code[0], 16) + 3 : last >> 2;
}

/** Filament covering the most area of a (possibly split) code. */
function dominantState(code) {
  const t = String(code || '').trim();
  if (!t) return 0;
  const n = [];
  for (let i = t.length - 1; i >= 0; i--) {
    const v = parseInt(t[i], 16);
    if (Number.isNaN(v)) return 0;
    n.push(v);
  }
  let r = 0;
  const area = new Map();
  const walk = (w) => {
    if (r >= n.length) return false;
    const x = n[r++];
    const split = x & 3;
    if (split === 0) {
      let s;
      if ((x & 12) === 12) {
        if (r >= n.length) return false;
        s = n[r++] + 3;
      } else s = x >> 2;
      area.set(s, (area.get(s) || 0) + w);
      return true;
    }
    const kids = split + 1;
    for (let k = 0; k < kids; k++) if (!walk(w / kids)) return false;
    return true;
  };
  if (!walk(1)) return 0;
  let best = 0;
  let bestA = -1;
  for (const [s, a] of area) if (a > bestA) (bestA = a), (best = s);
  return best;
}

function leafCode(state) {
  if (state <= 0) return null;
  if (state < 3) return (state << 2).toString(16).toUpperCase();
  return (state - 3).toString(16).toUpperCase() + 'C';
}

function paintOf(rest) {
  const m = PAINT_ATTR.exec(rest);
  return m ? m[2] : '';
}

/** Attribute text for an original triangle written with v2/v3 swapped. */
function flippedAttrs(rest, stats) {
  let out = rest;
  const p2 = /\bp2="([^"]*)"/.exec(out);
  const p3 = /\bp3="([^"]*)"/.exec(out);
  if (p2 && p3) {
    out = out
      .replace(/\bp2="[^"]*"/, '\u0000')
      .replace(/\bp3="[^"]*"/, `p2="${p3[1]}"`)
      .replace('\u0000', `p3="${p2[1]}"`);
  }
  const m = PAINT_ATTR.exec(out);
  if (m && !isLeafCode(m[2])) {
    const code = leafCode(dominantState(m[2]));
    out = code ? out.replace(PAINT_ATTR, ` ${m[1]}="${code}"`) : out.replace(PAINT_ATTR, '');
    stats.flippedSplitPaintReduced++;
  }
  return out;
}

/* ---------------------------------------------------------------------- *
 * Parsing
 * ---------------------------------------------------------------------- */

function attr(s, name) {
  const m = new RegExp('\\b' + name + '="([^"]*)"').exec(s);
  return m ? m[1] : null;
}

function parseMesh(meshXml) {
  const xs = [];
  const ys = [];
  const zs = [];
  const vRe = /<vertex\b([^>]*?)\/?>/g;
  let m;
  while ((m = vRe.exec(meshXml))) {
    xs.push(attr(m[1], 'x'));
    ys.push(attr(m[1], 'y'));
    zs.push(attr(m[1], 'z'));
  }
  const nv = xs.length;
  const pos = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    pos[i * 3] = +xs[i];
    pos[i * 3 + 1] = +ys[i];
    pos[i * 3 + 2] = +zs[i];
  }
  const tri = [];
  const rest = [];
  const tRe = /<triangle\b([^>]*?)\/?>/g;
  while ((m = tRe.exec(meshXml))) {
    const a = m[1];
    tri.push(+attr(a, 'v1'), +attr(a, 'v2'), +attr(a, 'v3'));
    const r = a.replace(/\s*\bv[123]="[^"]*"/g, '').trim();
    rest.push(r ? ' ' + r : '');
  }
  return { xs, ys, zs, pos, tri: Uint32Array.from(tri), rest };
}

/* ---------------------------------------------------------------------- *
 * Topology helpers. Half-edge h = face*3 + corner, runs fv[h] -> next corner.
 * ---------------------------------------------------------------------- */

function weld(pos) {
  const n = pos.length / 3;
  const map = new Uint32Array(n);
  const first = [];
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const k = pos[i * 3] + ',' + pos[i * 3 + 1] + ',' + pos[i * 3 + 2];
    let w = seen.get(k);
    if (w === undefined) {
      w = first.length;
      seen.set(k, w);
      first.push(i);
    }
    map[i] = w;
  }
  return { map, first };
}

function buildEdges(fv, F, V) {
  const head = new Map();
  const next = new Int32Array(F * 3).fill(-1);
  for (let f = 0; f < F; f++) {
    for (let c = 0; c < 3; c++) {
      const a = fv[f * 3 + c];
      const b = fv[f * 3 + ((c + 1) % 3)];
      const key = a < b ? a * V + b : b * V + a;
      const h = f * 3 + c;
      const prev = head.get(key);
      if (prev !== undefined) next[h] = prev;
      head.set(key, h);
    }
  }
  return { head, next };
}

function edgeStats(fv, F, V) {
  const { head, next } = buildEdges(fv, F, V);
  let boundary = 0;
  let nonManifold = 0;
  let conflicts = 0;
  for (const h0 of head.values()) {
    const h1 = next[h0];
    if (h1 === -1) boundary++;
    else if (next[h1] !== -1) nonManifold++;
    else if (fv[h0] === fv[h1]) conflicts++;
  }
  return { edges: head.size, boundary, nonManifold, orientationConflicts: conflicts };
}

/* ---------------------------------------------------------------------- *
 * Repair
 * ---------------------------------------------------------------------- */

function repairMesh(parsed, progress) {
  const say = progress || (() => {});
  const stats = {
    inputTriangles: parsed.tri.length / 3,
    inputVertices: parsed.pos.length / 3,
    weldedVertices: 0,
    degenerateRemoved: 0,
    duplicatesRemoved: 0,
    flipped: 0,
    flippedSplitPaintReduced: 0,
    holesFilled: 0,
    fillTriangles: 0,
    fillVertices: 0,
    fillsColourMatched: 0,
    fillsLeftBase: 0,
    componentsInverted: 0,
    passes: 0,
    before: null,
    after: null,
  };

  say('welding vertices');
  const { map, first } = weld(parsed.pos);
  const V0 = first.length;
  stats.weldedVertices = V0;
  const px = [];
  const py = [];
  const pz = [];
  for (let w = 0; w < V0; w++) {
    const i = first[w];
    px.push(parsed.pos[i * 3]);
    py.push(parsed.pos[i * 3 + 1]);
    pz.push(parsed.pos[i * 3 + 2]);
  }

  const T = parsed.tri.length / 3;
  let fv = new Uint32Array(T * 3);
  let src = new Int32Array(T);
  let F = 0;
  for (let t = 0; t < T; t++) {
    const a = map[parsed.tri[t * 3]];
    const b = map[parsed.tri[t * 3 + 1]];
    const c = map[parsed.tri[t * 3 + 2]];
    if (a === b || b === c || a === c) {
      stats.degenerateRemoved++;
      continue;
    }
    fv[F * 3] = a;
    fv[F * 3 + 1] = b;
    fv[F * 3 + 2] = c;
    src[F] = t;
    F++;
  }
  const origFlip = new Uint8Array(T);
  const isPainted = (f) => src[f] >= 0 && PAINT_ATTR.test(parsed.rest[src[f]]);

  stats.before = edgeStats(fv, F, V0);

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    stats.passes = pass;
    const V = px.length;

    /* ---- duplicates ------------------------------------------------- */
    say(`pass ${pass}: removing duplicate triangles`);
    {
      const k1 = new Float64Array(F);
      const k2 = new Float64Array(F);
      for (let f = 0; f < F; f++) {
        let a = fv[f * 3], b = fv[f * 3 + 1], c = fv[f * 3 + 2], t;
        if (a > b) (t = a), (a = b), (b = t);
        if (b > c) (t = b), (b = c), (c = t);
        if (a > b) (t = a), (a = b), (b = t);
        k1[f] = a * V + b;
        k2[f] = c;
      }
      const order = new Uint32Array(F);
      for (let f = 0; f < F; f++) order[f] = f;
      order.sort((p, q) => k1[p] - k1[q] || k2[p] - k2[q] || p - q);
      const drop = new Uint8Array(F);
      for (let i = 0; i < F; ) {
        let j = i + 1;
        while (j < F && k1[order[j]] === k1[order[i]] && k2[order[j]] === k2[order[i]]) j++;
        if (j - i > 1) {
          let keep = order[i];
          for (let k = i; k < j; k++) {
            if (isPainted(order[k])) {
              keep = order[k];
              break;
            }
          }
          for (let k = i; k < j; k++) if (order[k] !== keep) drop[order[k]] = 1;
          stats.duplicatesRemoved += j - i - 1;
        }
        i = j;
      }
      let w = 0;
      for (let f = 0; f < F; f++) {
        if (drop[f]) continue;
        if (w !== f) {
          fv[w * 3] = fv[f * 3];
          fv[w * 3 + 1] = fv[f * 3 + 1];
          fv[w * 3 + 2] = fv[f * 3 + 2];
          src[w] = src[f];
        }
        w++;
      }
      F = w;
    }

    /* ---- winding ---------------------------------------------------- */
    say(`pass ${pass}: fixing triangle winding`);
    {
      const { head, next } = buildEdges(fv, F, V);
      const flip = new Int8Array(F).fill(-1);
      const comp = new Int32Array(F);
      const queue = new Int32Array(F);
      const flippedIn = [];
      const sizeOf = [];
      for (let seed = 0; seed < F; seed++) {
        if (flip[seed] !== -1) continue;
        const id = flippedIn.length;
        let qh = 0;
        let qt = 0;
        flip[seed] = 0;
        comp[seed] = id;
        queue[qt++] = seed;
        let flipped = 0;
        while (qh < qt) {
          const f = queue[qh++];
          if (flip[f]) flipped++;
          for (let c = 0; c < 3; c++) {
            const a = fv[f * 3 + c];
            const b = fv[f * 3 + ((c + 1) % 3)];
            const h0 = head.get(a < b ? a * V + b : b * V + a);
            const h1 = next[h0];
            if (h1 === -1 || next[h1] !== -1) continue; // boundary / non-manifold
            const other = ((h0 / 3) | 0) === f ? h1 : h0;
            const g = (other / 3) | 0;
            if (flip[g] !== -1) continue;
            // Consistent neighbours traverse the shared edge in opposite
            // directions (their half-edge starts at b). Same direction means
            // exactly one of the two must be flipped.
            flip[g] = fv[other] === a ? 1 - flip[f] : flip[f];
            comp[g] = id;
            queue[qt++] = g;
          }
        }
        flippedIn.push(flipped);
        sizeOf.push(qt);
      }
      for (let f = 0; f < F; f++) {
        let fl = flip[f];
        if (flippedIn[comp[f]] * 2 > sizeOf[comp[f]]) fl = 1 - fl; // flip the minority
        if (!fl) continue;
        const t = fv[f * 3 + 1];
        fv[f * 3 + 1] = fv[f * 3 + 2];
        fv[f * 3 + 2] = t;
        if (src[f] >= 0) origFlip[src[f]] ^= 1;
        stats.flipped++;
      }
    }

    /* ---- holes ------------------------------------------------------ */
    say(`pass ${pass}: filling holes`);
    const edges = buildEdges(fv, F, V);
    const ekey = (a, b) => (a < b ? a * V + b : b * V + a);
    const added = new Set();
    const edgeUsed = (a, b) => edges.head.has(ekey(a, b)) || added.has(ekey(a, b));

    const out = new Map(); // hole graph: vertex -> next vertices
    let boundary = 0;
    for (const h0 of edges.head.values()) {
      if (edges.next[h0] !== -1) continue;
      const f = (h0 / 3) | 0;
      const c = h0 % 3;
      const a = fv[f * 3 + c];
      const b = fv[f * 3 + ((c + 1) % 3)];
      // The fill face must contain b -> a.
      let list = out.get(b);
      if (!list) out.set(b, (list = []));
      list.push(a);
      boundary++;
    }
    if (boundary === 0) break;

    const loops = [];
    for (const start of [...out.keys()]) {
      while (out.get(start).length) {
        const path = [start];
        const at = new Map([[start, 0]]);
        let cur = start;
        for (;;) {
          const list = out.get(cur);
          if (!list || !list.length) break; // open chain (inconsistent input)
          const nxt = list.pop();
          if (at.has(nxt)) {
            // Closed a loop; split it off so pinched holes become simple loops.
            const i = at.get(nxt);
            loops.push(path.slice(i));
            for (let k = i + 1; k < path.length; k++) at.delete(path[k]);
            path.length = i + 1;
            cur = nxt;
            if (path.length === 1 && !out.get(cur).length) break;
            continue;
          }
          at.set(nxt, path.length);
          path.push(nxt);
          cur = nxt;
        }
      }
    }

    const addFaces = [];
    const push = (a, b, c) => {
      addFaces.push(a, b, c);
      added.add(ekey(a, b));
      added.add(ekey(b, c));
      added.add(ekey(c, a));
    };
    for (const L of loops) {
      if (L.length < 3) continue;
      stats.holesFilled++;
      if (L.length === 3) {
        push(L[0], L[1], L[2]);
        continue;
      }
      const tris = L.length <= EAR_CLIP_MAX ? earClip(L, px, py, pz, edgeUsed) : null;
      if (tris) {
        for (let i = 0; i < tris.length; i += 3) push(tris[i], tris[i + 1], tris[i + 2]);
      } else {
        let cx = 0, cy = 0, cz = 0;
        for (const v of L) (cx += px[v]), (cy += py[v]), (cz += pz[v]);
        px.push(cx / L.length);
        py.push(cy / L.length);
        pz.push(cz / L.length);
        const m = px.length - 1;
        stats.fillVertices++;
        for (let i = 0; i < L.length; i++) push(L[i], L[(i + 1) % L.length], m);
      }
    }

    const add = addFaces.length / 3;
    stats.fillTriangles += add;
    const fv2 = new Uint32Array((F + add) * 3);
    fv2.set(fv.subarray(0, F * 3));
    fv2.set(addFaces, F * 3);
    const src2 = new Int32Array(F + add).fill(-1);
    src2.set(src.subarray(0, F));
    fv = fv2;
    src = src2;
    F += add;
  }

  /* ---- outward orientation ------------------------------------------ */
  say('checking outward orientation');
  {
    const V = px.length;
    const parent = new Int32Array(V);
    for (let i = 0; i < V; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let f = 0; f < F; f++) {
      const a = find(fv[f * 3]);
      parent[find(fv[f * 3 + 1])] = a;
      parent[find(fv[f * 3 + 2])] = a;
    }
    const vol = new Map();
    for (let f = 0; f < F; f++) {
      const a = fv[f * 3], b = fv[f * 3 + 1], c = fv[f * 3 + 2];
      const v =
        px[a] * (py[b] * pz[c] - pz[b] * py[c]) -
        py[a] * (px[b] * pz[c] - pz[b] * px[c]) +
        pz[a] * (px[b] * py[c] - py[b] * px[c]);
      const r = find(a);
      vol.set(r, (vol.get(r) || 0) + v);
    }
    const invert = new Set();
    for (const [r, v] of vol) if (v < 0) invert.add(r);
    stats.componentsInverted = invert.size;
    if (invert.size) {
      for (let f = 0; f < F; f++) {
        if (!invert.has(find(fv[f * 3]))) continue;
        const t = fv[f * 3 + 1];
        fv[f * 3 + 1] = fv[f * 3 + 2];
        fv[f * 3 + 2] = t;
        if (src[f] >= 0) origFlip[src[f]] ^= 1;
      }
    }
  }

  /* ---- paint for fill triangles ------------------------------------- */
  say('colouring filled holes');
  const fillPaint = new Map(); // face index -> code (absent = unpainted)
  {
    const V = px.length;
    const { head, next } = buildEdges(fv, F, V);
    // Cluster fill faces that share edges (one cluster per filled hole).
    const fills = [];
    for (let f = 0; f < F; f++) if (src[f] < 0) fills.push(f);
    const idx = new Map(fills.map((f, i) => [f, i]));
    const parent = fills.map((_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    const neighbours = fills.map(() => []);
    for (let i = 0; i < fills.length; i++) {
      const f = fills[i];
      for (let c = 0; c < 3; c++) {
        const a = fv[f * 3 + c];
        const b = fv[f * 3 + ((c + 1) % 3)];
        let h = head.get(a < b ? a * V + b : b * V + a);
        while (h !== -1) {
          const g = (h / 3) | 0;
          if (g !== f) {
            if (src[g] < 0) parent[find(idx.get(g))] = find(i);
            else neighbours[i].push(g);
          }
          h = next[h];
        }
      }
    }
    // Per cluster: the set of plain colours around it.
    const states = new Map();
    for (let i = 0; i < fills.length; i++) {
      const r = find(i);
      let s = states.get(r);
      if (!s) states.set(r, (s = new Set()));
      for (const g of neighbours[i]) s.add(leafState(paintOf(parsed.rest[src[g]])));
    }
    for (let i = 0; i < fills.length; i++) {
      const s = states.get(find(i));
      if (s.size === 1) {
        const [only] = s;
        if (only > 0) fillPaint.set(fills[i], leafCode(only));
        if (only >= 0) {
          stats.fillsColourMatched++;
          continue;
        }
      }
      stats.fillsLeftBase++;
    }
  }

  stats.after = edgeStats(fv, F, px.length);
  stats.outputTriangles = F;
  return { fv, src, F, px, py, pz, V0, first, origFlip, fillPaint, stats };
}

/**
 * Ear clipping of a small hole in its best-fit plane. Returns flat vertex
 * triples, or null if it cannot finish without reusing an existing edge; the
 * caller then falls back to a centroid fan.
 */
function earClip(L, px, py, pz, edgeUsed) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < L.length; i++) {
    const a = L[i], b = L[(i + 1) % L.length];
    nx += (py[a] - py[b]) * (pz[a] + pz[b]);
    ny += (pz[a] - pz[b]) * (px[a] + px[b]);
    nz += (px[a] - px[b]) * (py[a] + py[b]);
  }
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0)) return null;
  nx /= len; ny /= len; nz /= len;
  let ux, uy, uz;
  if (Math.abs(nx) < 0.9) (ux = 0), (uy = nz), (uz = -ny);
  else (ux = -nz), (uy = 0), (uz = nx);
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const P = new Map();
  for (const v of L) P.set(v, [px[v] * ux + py[v] * uy + pz[v] * uz, px[v] * vx + py[v] * vy + pz[v] * vz]);

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;

  const poly = L.slice();
  const out = [];
  let guard = poly.length * poly.length + 10;
  while (poly.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[(i - 1 + poly.length) % poly.length];
      const c = poly[i];
      const n = poly[(i + 1) % poly.length];
      const A = P.get(p), B = P.get(c), C = P.get(n);
      if (cross(A, B, C) <= 1e-12) continue;
      let blocked = false;
      for (const q of poly) {
        if (q === p || q === c || q === n) continue;
        if (inside(P.get(q), A, B, C)) {
          blocked = true;
          break;
        }
      }
      if (blocked || edgeUsed(n, p)) continue;
      out.push(p, c, n);
      poly.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (poly.length !== 3) return null;
  out.push(poly[0], poly[1], poly[2]);
  return out;
}

/* ---------------------------------------------------------------------- *
 * Serialisation
 * ---------------------------------------------------------------------- */

function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/\.?0+$/, '');
}

function writeMesh(parsed, r) {
  const { fv, src, F, px, py, pz, V0, first, origFlip, fillPaint, stats } = r;
  const newId = new Int32Array(px.length).fill(-1);
  const order = [];
  for (let i = 0; i < F * 3; i++) {
    const v = fv[i];
    if (newId[v] === -1) {
      newId[v] = order.length;
      order.push(v);
    }
  }
  const chunks = ['<mesh><vertices>'];
  let buf = [];
  const flush = () => {
    if (buf.length) chunks.push(buf.join(''));
    buf = [];
  };
  for (const v of order) {
    if (v < V0) {
      // Reuse the original coordinate text: positions stay bit-identical.
      const o = first[v];
      buf.push(`<vertex x="${parsed.xs[o]}" y="${parsed.ys[o]}" z="${parsed.zs[o]}"/>`);
    } else {
      buf.push(`<vertex x="${fmt(px[v])}" y="${fmt(py[v])}" z="${fmt(pz[v])}"/>`);
    }
    if (buf.length >= 50000) flush();
  }
  flush();
  chunks.push('</vertices><triangles>');
  let painted = 0;
  let exactPaintKept = 0;
  for (let f = 0; f < F; f++) {
    const a = newId[fv[f * 3]], b = newId[fv[f * 3 + 1]], c = newId[fv[f * 3 + 2]];
    let rest = '';
    if (src[f] >= 0) {
      rest = parsed.rest[src[f]];
      if (origFlip[src[f]]) rest = flippedAttrs(rest, stats);
      else if (PAINT_ATTR.test(rest)) exactPaintKept++;
      if (PAINT_ATTR.test(rest)) painted++;
    } else {
      const code = fillPaint.get(f);
      if (code) {
        rest = ` paint_color="${code}"`;
        painted++;
      }
    }
    buf.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${rest}/>`);
    if (buf.length >= 50000) flush();
  }
  flush();
  chunks.push('</triangles></mesh>');
  stats.outputVertices = order.length;
  stats.outputPainted = painted;
  stats.originalPaintKeptExactly = exactPaintKept;
  return chunks.join('');
}

/* ---------------------------------------------------------------------- *
 * Public API
 * ---------------------------------------------------------------------- */

/**
 * Repairs every <object> mesh in a 3MF .model document. Everything outside
 * the <mesh> elements is passed through unchanged.
 */
function repairModelXml(xml, progress) {
  const reports = [];
  const pieces = [];
  let last = 0;
  const objRe = /<object\b([^>]*)>/g;
  let m;
  while ((m = objRe.exec(xml))) {
    const objEnd = xml.indexOf('</object>', m.index);
    if (objEnd < 0) break;
    const meshStart = xml.indexOf('<mesh', m.index);
    if (meshStart < 0 || meshStart > objEnd) {
      objRe.lastIndex = objEnd;
      continue;
    }
    const meshEnd = xml.indexOf('</mesh>', meshStart);
    if (meshEnd < 0 || meshEnd > objEnd) break;
    const id = attr(m[1], 'id');
    const say = (s) => progress && progress(`object ${id}: ${s}`);
    say('reading mesh');
    const parsed = parseMesh(xml.slice(meshStart, meshEnd + 7));
    const r = repairMesh(parsed, say);
    say('writing mesh');
    pieces.push(xml.slice(last, meshStart), writeMesh(parsed, r));
    last = meshEnd + 7;
    reports.push({ objectId: id, ...r.stats });
    objRe.lastIndex = objEnd;
  }
  pieces.push(xml.slice(last));
  return { xml: pieces.join(''), reports };
}

module.exports = { repairModelXml, isLeafCode, leafState, dominantState, leafCode, edgeStats };
