/**
 * After Area Cut is open, finds the cut gizmo and projects its handles to
 * screen coordinates so the profiler can drag exactly what the user drags.
 *
 * Also reports the model's real world-space size. The MODEL INFO "DIMENSIONS"
 * text shows original file dimensions and never changes on rescale, which made
 * an earlier scale check report a false negative.
 */
(() => {
  const out = { steps: [] };
  try {
    const canvas = document.querySelector('canvas');
    const camera = globalThis.__mp3dCamera;
    const scene = globalThis.__mp3dScene;

    out.have = { canvas: !!canvas, camera: !!camera, scene: !!scene };
    if (!canvas || !camera || !scene) {
      out.error = 'missing handle';
      return out;
    }

    const rect = canvas.getBoundingClientRect();
    out.canvasRect = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };

    const Vector3 = camera.position.constructor;
    const project = (v) => {
      const p = v.clone().project(camera);
      return {
        x: Math.round(rect.left + ((p.x + 1) / 2) * rect.width),
        y: Math.round(rect.top + ((1 - p.y) / 2) * rect.height),
        onScreen: p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1,
      };
    };

    // Biggest mesh = the model.
    let model = null;
    let maxTris = 0;
    const meshes = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      const g = o.geometry;
      const tris = Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
      meshes.push({ name: o.name || o.type, tris, visible: o.visible });
      if (tris > maxTris) {
        maxTris = tris;
        model = o;
      }
    });
    out.meshCount = meshes.length;
    out.biggestMeshes = meshes.sort((a, b) => b.tris - a.tris).slice(0, 8);

    if (model) {
      model.updateWorldMatrix(true, false);
      model.geometry.computeBoundingBox();
      const bb = model.geometry.boundingBox.clone().applyMatrix4(model.matrixWorld);
      out.model = {
        triangles: maxTris,
        worldSize: [
          +(bb.max.x - bb.min.x).toFixed(1),
          +(bb.max.y - bb.min.y).toFixed(1),
          +(bb.max.z - bb.min.z).toFixed(1),
        ],
        scale: +model.scale.z.toFixed(4),
        centerScreen: project(bb.getCenter(new Vector3())),
      };
    }

    // Transform gizmo: three's TransformControls exposes .mode and .dragging.
    const gizmos = [];
    scene.traverse((o) => {
      const looksLikeGizmo =
        o.isTransformControls === true ||
        o.type === 'TransformControls' ||
        (typeof o.mode === 'string' && o.dragging !== undefined);
      if (!looksLikeGizmo) return;
      o.updateWorldMatrix(true, false);
      const handles = [];
      o.traverse((h) => {
        if (h === o || !h.name || handles.length >= 20) return;
        if (!h.visible) return;
        h.updateWorldMatrix(true, false);
        handles.push({ name: h.name, type: h.type, screen: project(h.getWorldPosition(new Vector3())) });
      });
      gizmos.push({
        type: o.type,
        mode: o.mode,
        visible: o.visible,
        screen: project(o.getWorldPosition(new Vector3())),
        handles,
      });
    });
    out.gizmoCount = gizmos.length;
    out.gizmos = gizmos.slice(0, 3);

    // Small meshes are the cut plane / window quad.
    const smalls = [];
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      const g = o.geometry;
      const tris = Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
      if (tris > 0 && tris <= 8 && o.visible) {
        o.updateWorldMatrix(true, false);
        smalls.push({
          name: o.name || o.type,
          tris,
          screen: project(o.getWorldPosition(new Vector3())),
        });
      }
    });
    out.smallMeshes = smalls.slice(0, 8);

    const zInput = [...document.querySelectorAll('input[type=number]')].find((el) => {
      const prev = el.previousElementSibling;
      const label = prev ? (prev.innerText || prev.textContent || '').trim() : '';
      const row =
        el.parentElement && el.parentElement.parentElement
          ? (el.parentElement.parentElement.innerText || '').replace(/\s+/g, ' ')
          : '';
      return label === 'Z' && row.includes('mm') && !row.includes('\u00b0');
    });
    out.zInputValue = zInput ? zInput.value : null;
    out.ok = true;
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
    out.stack = String(err && err.stack ? err.stack : '').slice(0, 400);
  }
  return out;
})();
