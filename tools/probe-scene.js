/**
 * Locates the react-three-fiber store by crawling the React fiber tree.
 *
 * The bundle exposes no THREE global and no canvas.__r3f handle, so React's
 * internals are the only way in: every DOM node carries a __reactFiber$* key.
 * Finding the store yields the scene, camera, raycaster and gl objects, and
 * through them the three.js prototypes we need in order to install a faster
 * raycast.
 *
 * Returns a report; sets window.__mp3dState when successful.
 */
(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { error: 'no canvas' };

  const fiberKey = Object.getOwnPropertyNames(canvas).find((k) => k.startsWith('__reactFiber$'));
  if (!fiberKey) return { error: 'no react fiber key' };

  let root = canvas[fiberKey];
  while (root.return) root = root.return;

  const isState = (v) =>
    v && typeof v === 'object' && v.scene && v.scene.isScene === true && v.camera && v.raycaster;

  let state = null;
  let via = null;
  let anyMesh = null;
  let fibersVisited = 0;
  let objectsScanned = 0;

  const seenObj = new Set();

  // Breadth-limited scan of a plain object for the store or a mesh.
  const scan = (start, label) => {
    const stack = [[start, label, 0]];
    while (stack.length) {
      const [obj, lbl, depth] = stack.pop();
      if (!obj || typeof obj !== 'object' || depth > 4) continue;
      if (seenObj.has(obj)) continue;
      seenObj.add(obj);
      objectsScanned++;

      if (!anyMesh && obj.isMesh === true && obj.geometry) anyMesh = obj;

      if (isState(obj)) {
        state = obj;
        via = lbl;
        return true;
      }
      if (typeof obj.getState === 'function') {
        try {
          const s = obj.getState();
          if (isState(s)) {
            state = s;
            via = lbl + '.getState()';
            return true;
          }
        } catch (e) {}
      }

      let keys;
      try {
        keys = Object.keys(obj);
      } catch (e) {
        continue;
      }
      for (const k of keys) {
        let v;
        try {
          v = obj[k];
        } catch (e) {
          continue;
        }
        if (v && typeof v === 'object') stack.push([v, lbl + '.' + k, depth + 1]);
      }
    }
    return false;
  };

  // Iterative fiber walk over child / sibling / return / alternate.
  const seenFiber = new Set();
  const fibers = [root];
  while (fibers.length && !state) {
    const f = fibers.pop();
    if (!f || seenFiber.has(f)) continue;
    seenFiber.add(f);
    fibersVisited++;

    // A context provider's fiber.type is the context object itself.
    const t = f.type;
    if (t && typeof t === 'object') {
      if (t._currentValue !== undefined && scan(t._currentValue, 'ctx._currentValue')) break;
      if (t._context && scan(t._context._currentValue, 'ctx._context._currentValue')) break;
    }

    if (scan(f.memoizedProps, 'memoizedProps')) break;

    let hook = f.memoizedState;
    let guard = 0;
    while (hook && typeof hook === 'object' && guard++ < 200) {
      if (scan(hook.memoizedState, 'hook.memoizedState')) break;
      if (scan(hook.baseState, 'hook.baseState')) break;
      hook = hook.next;
    }
    if (state) break;

    if (scan(f.stateNode, 'stateNode')) break;

    // dependencies chain holds contexts this fiber reads
    let dep = f.dependencies && f.dependencies.firstContext;
    let dguard = 0;
    while (dep && dguard++ < 50) {
      if (dep.context && scan(dep.context._currentValue, 'dep.context')) break;
      dep = dep.next;
    }
    if (state) break;

    for (const link of [f.child, f.sibling, f.return, f.alternate]) {
      if (link && !seenFiber.has(link)) fibers.push(link);
    }
  }

  const report = { fibersVisited, objectsScanned, threeRevision: window.__THREE__ };

  if (!state) {
    report.error = 'store not found';
    report.foundLooseMesh = !!anyMesh;
    if (anyMesh) {
      window.__mp3dMesh = anyMesh;
      report.meshCtor = Object.getPrototypeOf(anyMesh).constructor.name;
    }
    return report;
  }

  window.__mp3dState = state;

  let meshCount = 0;
  let totalTris = 0;
  let maxTris = 0;
  let big = null;
  state.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    meshCount++;
    const g = o.geometry;
    const count = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
    const tris = Math.floor(count / 3);
    totalTris += tris;
    if (tris > maxTris) {
      maxTris = tris;
      big = o;
    }
  });

  Object.assign(report, {
    ok: true,
    via,
    meshCount,
    totalTris,
    maxTris,
    biggestMeshName: big ? big.name || '(unnamed)' : null,
    indexed: big ? !!big.geometry.index : null,
    meshCtor: big ? Object.getPrototypeOf(big).constructor.name : null,
    raycasterCtor: Object.getPrototypeOf(state.raycaster).constructor.name,
    hasGl: !!state.gl,
    pixelRatio: state.gl ? state.gl.getPixelRatio() : null,
    frameloop: state.frameloop,
  });
  return report;
})();
