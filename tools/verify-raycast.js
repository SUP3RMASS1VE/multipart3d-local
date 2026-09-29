/**
 * Differential correctness test for the BVH raycast patch.
 *
 * Fires rays at the loaded model from many directions and compares the
 * accelerated result against three.js's original brute-force result field by
 * field. A broad phase is only valid if it never changes the answer, so any
 * mismatch here means the patch must not ship.
 *
 * Requires that the app has already raycast at least once (so the real
 * Raycaster/Ray classes have been captured) — main.js drives a mouse move
 * before evaluating this.
 */
(async () => {
  const original = globalThis.__mp3dOriginalRaycast;
  const patched = globalThis.__mp3dPatchedRaycast;
  const Raycaster = globalThis.__mp3dRaycasterCtor;
  const statsFn = globalThis.__mp3dBvhStats;
  const seed = globalThis.__mp3dMesh;

  if (!seed) return { error: 'no mesh captured' };
  if (!original || !patched) return { error: 'patch not installed' };
  if (!Raycaster) return { error: 'no raycaster captured (app has not raycast yet)' };

  // Prefer the mesh the app itself raycast; the captured seed is an empty
  // helper mesh with no parent, so traversing from it finds nothing.
  let root = globalThis.__mp3dLastTarget || seed;
  while (root.parent) root = root.parent;

  let target = null;
  let maxTris = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const g = o.geometry;
    const c = g.index ? g.index.count : g.attributes.position.count;
    const tris = Math.floor(c / 3);
    if (tris > maxTris) {
      maxTris = tris;
      target = o;
    }
  });
  if (!target) return { error: 'no mesh with geometry found' };

  const Vector3 = target.position.constructor;
  target.updateWorldMatrix(true, false);
  target.geometry.computeBoundingBox();

  // Bounding box in world space, to place ray origins around the model.
  const bb = target.geometry.boundingBox.clone().applyMatrix4(target.matrixWorld);
  const c = new Vector3((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2);
  const radius =
    Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) * 1.5 || 100;

  const makeRay = (u, v, jitterU, jitterV) => {
    const theta = u * Math.PI * 2;
    const phi = Math.acos(Math.min(1, Math.max(-1, 2 * v - 1)));
    const origin = new Vector3(
      c.x + radius * Math.sin(phi) * Math.cos(theta),
      c.y + radius * Math.cos(phi),
      c.z + radius * Math.sin(phi) * Math.sin(theta)
    );
    // Aim near the centre, jittered, so most rays hit and some graze or miss.
    const aim = new Vector3(
      c.x + (jitterU - 0.5) * (bb.max.x - bb.min.x) * 1.1,
      c.y + (jitterV - 0.5) * (bb.max.y - bb.min.y) * 1.1,
      c.z + (jitterU * jitterV - 0.25) * (bb.max.z - bb.min.z) * 1.1
    );
    const dir = aim.sub(origin).normalize();
    return new Raycaster(origin, dir, 0, Infinity);
  };

  // Warm up: force the BVH to be built (it is created on an idle callback).
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const hits = [];
    patched.call(target, makeRay(0.31, 0.42, 0.5, 0.5), hits);
    const s = statsFn ? statsFn() : null;
    if (s && s.builds > 0 && s.fastRaycasts > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const warmStats = statsFn ? statsFn() : null;
  if (!warmStats || warmStats.builds === 0) return { error: 'BVH never built', stats: warmStats };

  const summarise = (hits) =>
    hits.map((h) => ({
      d: +h.distance.toFixed(5),
      p: [+h.point.x.toFixed(4), +h.point.y.toFixed(4), +h.point.z.toFixed(4)],
      fi: h.faceIndex,
      face: h.face ? [h.face.a, h.face.b, h.face.c] : null,
      n: h.face && h.face.normal
        ? [+h.face.normal.x.toFixed(4), +h.face.normal.y.toFixed(4), +h.face.normal.z.toFixed(4)]
        : null,
      uv: h.uv ? [+h.uv.x.toFixed(4), +h.uv.y.toFixed(4)] : null,
    }));

  const N = 500;
  let bothMiss = 0;
  let bothHit = 0;
  let slowTime = 0;
  let fastTime = 0;
  const mismatches = [];

  for (let i = 0; i < N; i++) {
    const u = (i * 0.6180339887498949) % 1;
    const v = (i * 0.7548776662466927) % 1;
    const ju = (i * 0.4142135623730951) % 1;
    const jv = (i * 0.2360679774997896) % 1;

    const slow = [];
    const fast = [];

    let t = performance.now();
    original.call(target, makeRay(u, v, ju, jv), slow);
    slowTime += performance.now() - t;

    t = performance.now();
    patched.call(target, makeRay(u, v, ju, jv), fast);
    fastTime += performance.now() - t;

    slow.sort((a, b) => a.distance - b.distance);
    fast.sort((a, b) => a.distance - b.distance);

    if (!slow.length && !fast.length) {
      bothMiss++;
      continue;
    }
    if (slow.length && fast.length) bothHit++;

    const A = JSON.stringify(summarise(slow));
    const B = JSON.stringify(summarise(fast));
    if (A !== B && mismatches.length < 5) {
      mismatches.push({
        ray: i,
        slowCount: slow.length,
        fastCount: fast.length,
        slow: A.slice(0, 400),
        fast: B.slice(0, 400),
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    targetTriangles: maxTris,
    raysCompared: N,
    bothHit,
    bothMiss,
    mismatchCount: mismatches.length,
    mismatches,
    originalTotalMs: +slowTime.toFixed(1),
    acceleratedTotalMs: +fastTime.toFixed(1),
    speedup: +(slowTime / Math.max(fastTime, 0.0001)).toFixed(1),
    stats: statsFn ? statsFn() : null,
  };
})();
