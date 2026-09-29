/**
 * Renderer diagnostics, evaluated inside the page by main.js (MP3D_DIAG=1).
 *
 * Reports what the GPU is actually being asked to do each frame, then samples
 * frame times while dragging the camera so we can tell a fill-rate problem
 * (too many pixels) from a geometry problem (too many triangles).
 *
 * Returns a plain object.
 */
(async () => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { error: 'no canvas: model not loaded?' };

  // react-three-fiber hangs its store off the canvas element.
  const root = canvas.__r3f && (canvas.__r3f.root || canvas.__r3f.store);
  const state = root && typeof root.getState === 'function' ? root.getState() : null;
  const gl = state && state.gl;
  const scene = state && state.scene;

  const info = {
    devicePixelRatio: window.devicePixelRatio,
    cssSize: [canvas.clientWidth, canvas.clientHeight],
    drawingBuffer: [canvas.width, canvas.height],
    megapixelsPerFrame: +((canvas.width * canvas.height) / 1e6).toFixed(2),
    r3fFound: !!state,
  };

  if (gl) {
    info.pixelRatio = gl.getPixelRatio();
    info.shadowsEnabled = gl.shadowMap.enabled;
    info.shadowType = gl.shadowMap.type;
    info.toneMapping = gl.toneMapping;
    info.outputColorSpace = gl.outputColorSpace;
    const ctx = gl.getContext();
    const attrs = ctx.getContextAttributes ? ctx.getContextAttributes() : {};
    info.contextAttributes = {
      antialias: attrs.antialias,
      powerPreference: attrs.powerPreference,
      alpha: attrs.alpha,
      depth: attrs.depth,
      stencil: attrs.stencil,
      preserveDrawingBuffer: attrs.preserveDrawingBuffer,
    };
    const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    if (dbg) info.glRenderer = ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
    info.maxSamples = ctx.getParameter(ctx.MAX_SAMPLES || 0x8d57);
  }

  if (scene) {
    let meshes = 0;
    let triangles = 0;
    let shadowCasters = 0;
    let lights = 0;
    const byName = [];
    scene.traverse((o) => {
      if (o.isLight) {
        lights++;
        if (o.castShadow) {
          shadowCasters++;
          const s = o.shadow && o.shadow.mapSize;
          byName.push(`light:${o.type} shadowMap:${s ? s.width + 'x' + s.height : 'n/a'}`);
        }
      }
      if (!o.isMesh || !o.geometry) return;
      meshes++;
      const g = o.geometry;
      const count = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
      const tris = Math.floor(count / 3);
      triangles += tris;
      if (tris > 5000) byName.push(`${o.name || o.type}:${tris}tris`);
    });
    info.meshes = meshes;
    info.sceneTriangles = triangles;
    info.lights = lights;
    info.shadowCastingLights = shadowCasters;
    info.notable = byName.slice(0, 12);
  }

  // ---- frame timing while orbiting -------------------------------------
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const ev = (type, x, y, extra) =>
    canvas.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        pointerType: 'mouse',
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        ...extra,
      })
    );

  if (gl) gl.info.autoReset = false;
  if (gl) gl.info.reset();

  const frames = [];
  let last = performance.now();
  let i = 0;

  ev('pointerdown', cx, cy);

  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      // Drag in a circle to force continuous re-render.
      const a = i * 0.06;
      ev('pointermove', cx + Math.cos(a) * 180, cy + Math.sin(a) * 90);
      if (++i < 200) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });

  ev('pointerup', cx, cy);

  if (gl) {
    info.drawCallsPerFrame = +(gl.info.render.calls / frames.length).toFixed(1);
    info.trianglesDrawnPerFrame = Math.round(gl.info.render.triangles / frames.length);
    info.programs = gl.info.programs ? gl.info.programs.length : null;
    info.textures = gl.info.memory.textures;
    info.geometries = gl.info.memory.geometries;
    gl.info.autoReset = true;
  }

  const sorted = frames.slice(4).sort((a, b) => a - b);
  const pct = (p) => +sorted[Math.floor(sorted.length * p)].toFixed(1);
  info.frameMs = { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: +sorted[sorted.length - 1].toFixed(1) };
  info.fps = +(1000 / info.frameMs.p50).toFixed(1);

  return info;
})();
