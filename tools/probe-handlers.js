/**
 * Lists scene objects that carry react-three-fiber pointer handlers, with their
 * projected screen positions. These are the things the user can actually grab,
 * which is how the profiler locates the cut-plane gizmo.
 */
(() => {
  const scene = globalThis.__mp3dScene;
  const camera = globalThis.__mp3dCamera;
  const canvas = document.querySelector('canvas');
  if (!scene || !camera || !canvas) return { error: 'missing handle' };

  const rect = canvas.getBoundingClientRect();
  const V = camera.position.constructor;
  const project = (v) => {
    const p = v.clone().project(camera);
    return {
      x: Math.round(rect.left + ((p.x + 1) / 2) * rect.width),
      y: Math.round(rect.top + ((1 - p.y) / 2) * rect.height),
      onScreen: p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1,
    };
  };

  const rows = [];
  scene.traverse((o) => {
    const r3f = o.__r3f;
    if (!r3f) return;
    const handlers = r3f.handlers || (r3f.eventCount !== undefined ? r3f : null);
    let names = [];
    if (r3f.handlers) names = Object.keys(r3f.handlers);
    else {
      // Newer r3f keeps props on __r3f.props
      const props = r3f.props || {};
      names = Object.keys(props).filter((k) => k.startsWith('onPointer') || k.startsWith('onClick'));
    }
    if (!names.length) return;
    o.updateWorldMatrix(true, false);
    const g = o.geometry;
    rows.push({
      name: o.name || o.type,
      type: o.type,
      visible: o.visible,
      tris: g && g.attributes && g.attributes.position
        ? Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3)
        : null,
      handlers: names,
      screen: project(o.getWorldPosition(new V())),
    });
  });

  return {
    ok: true,
    canvasRect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    },
    interactive: rows.slice(0, 40),
    count: rows.length,
  };
})();
