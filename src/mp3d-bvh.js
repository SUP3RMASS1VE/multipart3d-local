/**
 * Raycast acceleration for the local Multipart3D build.
 *
 * Why this exists
 * ---------------
 * A CPU profile of a plain orbit on a ~500k triangle model showed ~45% of all
 * main-thread time inside three.js ray/triangle intersection
 * (checkIntersection / getVertexPosition / _computeIntersections), while the
 * GPU sat almost idle. three.js Mesh.raycast() has no acceleration structure:
 * every pointer move tests every triangle. That is the lag.
 *
 * What it does
 * ------------
 * Builds a bounding volume hierarchy per geometry and uses it as a *broad
 * phase* only: the BVH narrows millions of triangles down to a handful of
 * candidates, and then three.js's own untouched intersection code runs on just
 * those. Hit records (distance, point, face, uv, normal) are therefore
 * produced by three.js exactly as before, which matters because the cut tools
 * depend on that data being exact.
 *
 * The narrow phase is reached by temporarily pointing geometry.index at a
 * scratch buffer holding only the candidate triangles and setting drawRange to
 * match, then restoring both. Vertex indices written into the scratch buffer
 * are the original ones, so face.a/b/c stay correct; only faceIndex needs
 * remapping, and the candidate list gives us that mapping.
 *
 * Anything unusual (morph targets, skinning, instancing, multi-material
 * groups, small meshes) falls through to the original implementation.
 */

const LEAF_SIZE = 8;
const MAX_DEPTH = 40;
const MIN_TRIS = 20000; // below this, brute force is already fast enough

const bvhCache = new WeakMap();
const scratchCache = new WeakMap();
const building = new WeakSet();

const stats = {
  installed: false,
  builds: 0,
  buildMs: 0,
  fastRaycasts: 0,
  slowRaycasts: 0,
  fallbacks: 0,
  candidatesTotal: 0,
  trianglesTotal: 0,
};

/* ------------------------------------------------------------------ *
 * BVH construction
 * ------------------------------------------------------------------ */

function triangleCount(geometry) {
  const index = geometry.index;
  const pos = geometry.attributes.position;
  if (!pos) return 0;
  return Math.floor((index ? index.count : pos.count) / 3);
}

function buildBVH(geometry) {
  const t0 = performance.now();

  const pos = geometry.attributes.position;
  const posArray = pos.array;
  const index = geometry.index;
  const indexArray = index ? index.array : null;
  const triCount = triangleCount(geometry);

  // Vertex indices of triangle t.
  const vi = (t, corner) => (indexArray ? indexArray[t * 3 + corner] : t * 3 + corner);

  const triIdx = new Uint32Array(triCount);
  for (let i = 0; i < triCount; i++) triIdx[i] = i;

  const centroids = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const a = vi(t, 0) * 3;
    const b = vi(t, 1) * 3;
    const c = vi(t, 2) * 3;
    centroids[t * 3] = (posArray[a] + posArray[b] + posArray[c]) / 3;
    centroids[t * 3 + 1] = (posArray[a + 1] + posArray[b + 1] + posArray[c + 1]) / 3;
    centroids[t * 3 + 2] = (posArray[a + 2] + posArray[b + 2] + posArray[c + 2]) / 3;
  }

  const maxNodes = Math.max(64, 4 * Math.ceil(triCount / LEAF_SIZE) + 64);
  const bounds = new Float32Array(maxNodes * 6);
  const left = new Int32Array(maxNodes).fill(-1);
  const start = new Int32Array(maxNodes);
  const count = new Int32Array(maxNodes);
  let nodeCount = 1;

  const computeBounds = (node, s, n) => {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = s; i < s + n; i++) {
      const t = triIdx[i];
      for (let corner = 0; corner < 3; corner++) {
        const p = vi(t, corner) * 3;
        const x = posArray[p];
        const y = posArray[p + 1];
        const z = posArray[p + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    const o = node * 6;
    bounds[o] = minX;
    bounds[o + 1] = minY;
    bounds[o + 2] = minZ;
    bounds[o + 3] = maxX;
    bounds[o + 4] = maxY;
    bounds[o + 5] = maxZ;
  };

  start[0] = 0;
  count[0] = triCount;
  computeBounds(0, 0, triCount);

  // Explicit stack: [node, depth]
  const stack = [0, 0];

  while (stack.length) {
    const depth = stack.pop();
    const node = stack.pop();
    const s = start[node];
    const n = count[node];

    if (n <= LEAF_SIZE || depth >= MAX_DEPTH || nodeCount + 2 > maxNodes) continue;

    // Split on the longest axis of the centroid bounds.
    let cMinX = Infinity;
    let cMinY = Infinity;
    let cMinZ = Infinity;
    let cMaxX = -Infinity;
    let cMaxY = -Infinity;
    let cMaxZ = -Infinity;
    for (let i = s; i < s + n; i++) {
      const t3 = triIdx[i] * 3;
      const x = centroids[t3];
      const y = centroids[t3 + 1];
      const z = centroids[t3 + 2];
      if (x < cMinX) cMinX = x;
      if (y < cMinY) cMinY = y;
      if (z < cMinZ) cMinZ = z;
      if (x > cMaxX) cMaxX = x;
      if (y > cMaxY) cMaxY = y;
      if (z > cMaxZ) cMaxZ = z;
    }

    const ex = cMaxX - cMinX;
    const ey = cMaxY - cMinY;
    const ez = cMaxZ - cMinZ;
    let axis = 0;
    let extent = ex;
    if (ey > extent) {
      axis = 1;
      extent = ey;
    }
    if (ez > extent) {
      axis = 2;
      extent = ez;
    }
    if (!(extent > 0)) continue; // all centroids coincide: leave as leaf

    const mid = axis === 0 ? (cMinX + cMaxX) / 2 : axis === 1 ? (cMinY + cMaxY) / 2 : (cMinZ + cMaxZ) / 2;

    // In-place partition by centroid position.
    let i = s;
    let j = s + n - 1;
    while (i <= j) {
      if (centroids[triIdx[i] * 3 + axis] < mid) {
        i++;
      } else {
        const tmp = triIdx[i];
        triIdx[i] = triIdx[j];
        triIdx[j] = tmp;
        j--;
      }
    }
    let leftCount = i - s;
    // Degenerate split: fall back to halving the range.
    if (leftCount === 0 || leftCount === n) leftCount = n >> 1;

    const l = nodeCount++;
    const r = nodeCount++;
    left[node] = l;
    start[l] = s;
    count[l] = leftCount;
    start[r] = s + leftCount;
    count[r] = n - leftCount;
    computeBounds(l, start[l], count[l]);
    computeBounds(r, start[r], count[r]);

    stack.push(l, depth + 1, r, depth + 1);
  }

  const bvh = {
    triIdx,
    bounds,
    left,
    start,
    count,
    nodeCount,
    triCount,
    positionVersion: pos.version,
    indexVersion: index ? index.version : -1,
  };

  stats.builds++;
  stats.buildMs += performance.now() - t0;
  return bvh;
}

/* ------------------------------------------------------------------ *
 * Traversal
 * ------------------------------------------------------------------ */

/**
 * Slab test. Deliberately ignores raycaster.near/far: the ray here is in the
 * mesh's local space while near/far are world units, so clamping could wrongly
 * reject. Being generous only costs a few extra narrow-phase triangles.
 *
 * NaN from 0 * Infinity (ray origin exactly on a slab plane, axis-parallel
 * direction) makes every comparison false, which leaves that axis unbounded.
 * That is conservative, so it is safe.
 */
function rayHitsBox(ox, oy, oz, idx, idy, idz, b, o) {
  let tmin = 0;
  let tmax = Infinity;

  let t1 = (b[o] - ox) * idx;
  let t2 = (b[o + 3] - ox) * idx;
  if (t1 > t2) {
    const t = t1;
    t1 = t2;
    t2 = t;
  }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return false;

  t1 = (b[o + 1] - oy) * idy;
  t2 = (b[o + 4] - oy) * idy;
  if (t1 > t2) {
    const t = t1;
    t1 = t2;
    t2 = t;
  }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return false;

  t1 = (b[o + 2] - oz) * idz;
  t2 = (b[o + 5] - oz) * idz;
  if (t1 > t2) {
    const t = t1;
    t1 = t2;
    t2 = t;
  }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  return tmin <= tmax;
}

const traverseStack = new Int32Array(256);

function collectCandidates(bvh, ray, out) {
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const idx = 1 / ray.direction.x;
  const idy = 1 / ray.direction.y;
  const idz = 1 / ray.direction.z;

  const { bounds, left, start, count, triIdx } = bvh;
  let sp = 0;
  traverseStack[sp++] = 0;
  let n = 0;

  while (sp > 0) {
    const node = traverseStack[--sp];
    if (!rayHitsBox(ox, oy, oz, idx, idy, idz, bounds, node * 6)) continue;

    const l = left[node];
    if (l < 0) {
      const s = start[node];
      const c = count[node];
      for (let i = 0; i < c; i++) out[n++] = triIdx[s + i];
      continue;
    }
    if (sp + 2 >= traverseStack.length) {
      // Stack exhausted (pathological tree): treat as a miss of the fast path.
      return -1;
    }
    traverseStack[sp++] = l;
    traverseStack[sp++] = l + 1;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * Installation
 * ------------------------------------------------------------------ */

function eligible(mesh) {
  const g = mesh.geometry;
  if (!g || !g.attributes || !g.attributes.position) return false;
  if (mesh.isSkinnedMesh || mesh.isInstancedMesh || mesh.isBatchedMesh) return false;
  if (Array.isArray(mesh.material)) return false;
  if (g.groups && g.groups.length > 1) return false;
  if (g.morphAttributes && g.morphAttributes.position) return false;
  if (mesh.count !== undefined && mesh.count !== 1) return false;
  return triangleCount(g) >= MIN_TRIS;
}

function getScratch(geometry, BufferAttributeCtor, capacityTris) {
  let s = scratchCache.get(geometry);
  const needed = capacityTris * 3;
  if (!s || s.array.length < needed) {
    const array = new Uint32Array(Math.max(needed, 3072));
    s = { array, attribute: new BufferAttributeCtor(array, 1) };
    scratchCache.set(geometry, s);
  }
  return s;
}

export function install(options = {}) {
  const verbose = !!options.verbose;

  const findMesh = () => globalThis.__mp3dMesh;

  const tryInstall = () => {
    const sample = findMesh();
    if (!sample) return false;

    // Walk up to whichever prototype actually owns raycast: that is Mesh.prototype.
    let proto = Object.getPrototypeOf(sample);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, 'raycast')) {
      proto = Object.getPrototypeOf(proto);
    }
    if (!proto) return false;

    const originalRaycast = proto.raycast;
    if (originalRaycast.__mp3dPatched) return true;

    // three.js classes, taken from live instances rather than an import.
    // Note the captured sample is simply the first Mesh the app constructs,
    // which is typically one with the default empty BufferGeometry, so only
    // matrixWorld is safe to read here. BufferAttribute is picked up later
    // from whichever geometry is actually raycast.
    const Matrix4 = sample.matrixWorld.constructor;
    const inverseMatrix = new Matrix4();
    let BufferAttribute = null;
    let RayCtor = null;
    let localRay = null;

    const candidateBuffer = new Uint32Array(65536);

    function patchedRaycast(raycaster, intersects) {
      const geometry = this.geometry;

      if (!eligible(this)) {
        stats.slowRaycasts++;
        return originalRaycast.call(this, raycaster, intersects);
      }

      // Published for tools/verify-raycast.js: the captured __mp3dMesh is the
      // first Mesh the app builds (an empty helper), not the model.
      globalThis.__mp3dLastTarget = this;

      let bvh = bvhCache.get(geometry);
      const pos = geometry.attributes.position;
      const stale =
        bvh &&
        (bvh.positionVersion !== pos.version ||
          bvh.indexVersion !== (geometry.index ? geometry.index.version : -1) ||
          bvh.triCount !== triangleCount(geometry));

      if (stale) {
        bvhCache.delete(geometry);
        bvh = undefined;
      }

      if (!bvh) {
        // Build off the interaction path so the first hover never stalls.
        if (!building.has(geometry)) {
          building.add(geometry);
          const build = () => {
            try {
              bvhCache.set(geometry, buildBVH(geometry));
            } catch (err) {
              if (verbose) console.warn('[mp3d-bvh] build failed', err);
            } finally {
              building.delete(geometry);
            }
          };
          if (typeof requestIdleCallback === 'function') requestIdleCallback(build, { timeout: 500 });
          else setTimeout(build, 0);
        }
        stats.slowRaycasts++;
        return originalRaycast.call(this, raycaster, intersects);
      }

      // Local-space ray.
      if (!RayCtor) {
        RayCtor = raycaster.ray.constructor;
        localRay = new RayCtor();
        // Published so tools/verify-raycast.js can build real raycasters
        // instead of stand-ins when comparing against the original.
        globalThis.__mp3dRayCtor = RayCtor;
        globalThis.__mp3dRaycasterCtor = Object.getPrototypeOf(raycaster).constructor;
      }
      inverseMatrix.copy(this.matrixWorld).invert();
      localRay.copy(raycaster.ray).applyMatrix4(inverseMatrix);

      const n = collectCandidates(bvh, localRay, candidateBuffer);
      if (n < 0) {
        stats.fallbacks++;
        return originalRaycast.call(this, raycaster, intersects);
      }

      stats.fastRaycasts++;
      stats.candidatesTotal += n;
      stats.trianglesTotal += bvh.triCount;

      if (n === 0) return; // ray misses every leaf box

      if (n * 3 > candidateBuffer.length) {
        stats.fallbacks++;
        return originalRaycast.call(this, raycaster, intersects);
      }

      // Narrow phase: hand three.js only the candidate triangles.
      const index = geometry.index;
      const indexArray = index ? index.array : null;
      if (!BufferAttribute) BufferAttribute = (index || geometry.attributes.position).constructor;
      const scratch = getScratch(geometry, BufferAttribute, n);
      const sa = scratch.array;

      for (let i = 0; i < n; i++) {
        const t = candidateBuffer[i];
        const base = t * 3;
        if (indexArray) {
          sa[i * 3] = indexArray[base];
          sa[i * 3 + 1] = indexArray[base + 1];
          sa[i * 3 + 2] = indexArray[base + 2];
        } else {
          sa[i * 3] = base;
          sa[i * 3 + 1] = base + 1;
          sa[i * 3 + 2] = base + 2;
        }
      }

      const savedIndex = index;
      const savedRange = geometry.drawRange;
      const before = intersects.length;

      scratch.attribute.count = n * 3;
      scratch.attribute.needsUpdate = false;
      geometry.index = scratch.attribute;
      geometry.drawRange = { start: 0, count: n * 3 };

      try {
        originalRaycast.call(this, raycaster, intersects);
      } finally {
        geometry.index = savedIndex;
        geometry.drawRange = savedRange;
      }

      // faceIndex came out relative to the scratch buffer; map it back.
      for (let i = before; i < intersects.length; i++) {
        const hit = intersects[i];
        if (hit && hit.faceIndex !== undefined && hit.faceIndex !== null) {
          const local = hit.faceIndex;
          if (local >= 0 && local < n) hit.faceIndex = candidateBuffer[local];
        }
      }
    }

    patchedRaycast.__mp3dPatched = true;
    proto.raycast = patchedRaycast;
    stats.installed = true;
    globalThis.__mp3dBvhStats = () => ({
      ...stats,
      avgCandidates: stats.fastRaycasts ? +(stats.candidatesTotal / stats.fastRaycasts).toFixed(1) : 0,
      avgTriangles: stats.fastRaycasts ? Math.round(stats.trianglesTotal / stats.fastRaycasts) : 0,
    });
    globalThis.__mp3dOriginalRaycast = originalRaycast;
    globalThis.__mp3dPatchedRaycast = patchedRaycast;
    if (verbose) console.log('[mp3d-bvh] raycast acceleration installed');
    return true;
  };

  if (tryInstall()) return;

  // The first Mesh may not exist until a model is loaded.
  let tries = 0;
  const timer = setInterval(() => {
    if (tryInstall() || ++tries > 600) clearInterval(timer);
  }, 100);
}
