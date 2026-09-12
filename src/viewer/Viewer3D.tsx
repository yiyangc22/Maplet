// The 3D viewport. Three.js is driven imperatively (no react-three-fiber) so a
// large point cloud stays fast and we control every buffer upload. React only
// owns the container element; everything inside is plain Three, subscribed to
// the store for color / visibility / selection / hover / settings updates.

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore, type PanelTarget } from '../model/store';
import { resolveTargetMap, type AxisFrame, type CoordMap, type Dataset } from '../format/maplet';
import { viewerControls, viewports, type ExportBackground, type ExportOptions } from './controls';
import { CanvasPen, SvgPen, type Pen } from './axisPen';
import type { SavedCamera } from '../model/preset';
import { attachPointAttributes, makePointMaterial, POINT_FRAG, POINT_VERT } from './pointShader';
import { createLasso, pointInPolygon } from './lasso';
import { saveExport } from '../platform/persist';

// One coordinate-map viewport. `isMain` gets the full feature set (image overlays,
// selection outline / alternative-location rings, and the toolbar camera commands
// wired through viewerControls); the small bottom panels are lean (points + hover /
// select / lasso only). Every panel shares the store's colour / visibility /
// selection buffers, so an action in one is reflected in all. `viewportId` keys
// this viewport in the per-viewport controls registry, so its own right-click menu
// can drive its camera + projection independently of the others.
export default function MapView({
  target,
  isMain = false,
  viewportId,
}: {
  target: PanelTarget;
  isMain?: boolean;
  viewportId: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dataset = useStore((s) => s.dataset);
  // Resolve the panel's target to a coordinate map: a real one, or a synthetic map
  // built from the per-axis assignment (any variable / map-axis on X/Y/Z). Memoised
  // so the scene rebuilds only when the target (not every render) changes.
  const tkey = JSON.stringify(target);
  const map = useMemo<CoordMap | null>(() => {
    if (!dataset) return null;
    return resolveTargetMap(dataset, target) ?? dataset.maps[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataset, tkey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !dataset || !map) return;
    return setupScene(container, dataset, map, isMain, viewportId);
  }, [dataset, map, isMain, viewportId]);

  return <div ref={containerRef} className="absolute inset-0" />;
}

function setupScene(container: HTMLElement, dataset: Dataset, map: CoordMap, isMain: boolean, viewportId: string): () => void {
  const store = useStore;
  const { n } = dataset;
  const { bounds, dims } = map;
  // A multi-frame (animated) map renders a PRIVATE copy of the position buffer that
  // we mutate to the current frame; picking / lasso / bbox / axes all read this
  // buffer, so they follow the animation with no extra bookkeeping. A static map
  // renders its single buffer directly.
  const framePositions = map.framePositions && map.framePositions.length > 1 ? map.framePositions : null;
  const positions = framePositions ? new Float32Array(map.positions) : map.positions;
  // Selection outline + alternative-location rings live in map 0's coordinate
  // space (the physical tissue), so they only make sense on that map.
  const spatialOverlays = map.index === 0;
  const withImages = isMain && map.index === 0 && dataset.images.length > 0;
  // Per-point coordinate for this map (undefined where the point isn't placed here).
  const coordOf = (point: Dataset['points'][number]) => point.coords[map.index];

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.outline = 'none';

  // A 2-D canvas layered over the WebGL view for the scientific-style axes (gray
  // lines, numbered decade ticks). Drawn in screen space each frame from the live
  // camera, so ticks track pan / zoom / rotate. Never eats pointer events.
  const axisCanvas = document.createElement('canvas');
  Object.assign(axisCanvas.style, { position: 'absolute', inset: '0', display: 'block', pointerEvents: 'none' });
  container.appendChild(axisCanvas);
  const axisCtx = axisCanvas.getContext('2d');

  // The lens's resting field of view. 3-D zoom narrows it past the dolly floor
  // (magnification — see zoomAt); every "fit" / reset restores it.
  const DEFAULT_FOV = 50;
  const camera = new THREE.PerspectiveCamera(
    DEFAULT_FOV,
    container.clientWidth / Math.max(1, container.clientHeight),
    bounds.radius * 0.002,
    bounds.radius * 60,
  );
  const focal = bounds.radius * 2.4;
  const fullCenter = new THREE.Vector3(...bounds.center);
  // Default (and reset) view looks straight down the z axis onto the xy plane —
  // a top-down view, the natural default for this spatial data (orbit to tilt).
  const defaultDir = new THREE.Vector3(0, 0, 1).normalize();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.rotateSpeed = 0.9;
  controls.zoomToCursor = true;
  // Left-drag PANS (moves the view), right-drag ROTATES — most people reach for
  // left-drag to move, so that is the default. A 2D map has nothing to rotate, so
  // both drags pan and rotation is disabled.
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: dims === 2 ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
  };
  // Zoom is ours (see zoomAt below), not OrbitControls' — its dolly walks the camera
  // toward a FIXED target, which runs out of room; ours scales the whole view about
  // the cursor, so it never bottoms out or tops out.
  controls.enableZoom = false;
  // Rotation is ours too (see the turntable below): OrbitControls' orbit is pinned to
  // a pole, so it can't tilt past straight-over-the-top and drags stop following the
  // mouse once `up` isn't the screen's vertical.
  controls.enableRotate = false;
  // Let the app know when the perspective changed so the session can be saved
  // (only the main viewer drives the session autosave).
  const emitCameraMoved = () => {
    if (isMain) viewerControls.onCameraMoved?.();
  };
  controls.addEventListener('end', emitCameraMoved);

  // --- zoom ----------------------------------------------------------------
  // Zooming scales the camera AND the orbit target about the point under the cursor
  // (on the plane through the target), so one wheel notch always changes the view by
  // the same FACTOR. Distance shrinks/grows geometrically and is never clamped, so
  // zoom is unlimited in both directions and feels identical at every scale — the
  // clip planes follow the distance (updateClipPlanes), so nothing gets cut away.
  //
  // In 3-D, flying the camera forward runs out: dots are a fixed pixel size, so once
  // the camera nears the point it's zooming toward, the view converges on "standing
  // at that point" and further zooming changes nothing. So past a floor distance (the
  // reset framing distance, camera still outside the cloud) zoom-in MAGNIFIES instead
  // — narrowing the field of view, like a telephoto lens — which never runs out and
  // never clips anything away. Zooming out first undoes the magnification, then flies
  // back out. A 2-D map is flat, so flying in IS magnifying: it keeps the plain dolly.
  const ZOOM_STEP = 1.15; // per wheel notch
  const DOLLY_FLOOR = focal;
  const tanHalf = (fovDeg: number) => Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  const tmpDir = new THREE.Vector3();
  const tmpView = new THREE.Vector3();
  const tmpAnchor = new THREE.Vector3();
  const tmpOff = new THREE.Vector3();
  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height || !(factor > 0) || !Number.isFinite(factor)) return;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    camera.updateMatrixWorld(); // unproject reads matrixWorld — it's stale between frames
    // The world point under the cursor, on the plane through the target facing the
    // camera. Scaling about it keeps whatever is under the cursor exactly in place.
    tmpView.subVectors(controls.target, camera.position);
    const dist = tmpView.length();
    if (!(dist > 0)) return;
    tmpDir.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
    const cos = tmpDir.dot(tmpView.normalize());
    tmpAnchor.copy(cos > 1e-3 ? camera.position.clone().addScaledVector(tmpDir, dist / cos) : controls.target);
    // Each offset must be measured BEFORE its vector is overwritten (`copy()` runs
    // before the argument is evaluated), so scale first, then place.
    // Split the factor into a dolly part (move camera + target) and a lens part
    // (field of view). `factor` < 1 zooms in.
    let dolly = factor;
    let lens = 1;
    if (dims === 3) {
      if (factor < 1) {
        dolly = dist > DOLLY_FLOOR ? Math.max(factor, DOLLY_FLOOR / dist) : 1;
        lens = factor / dolly;
      } else {
        lens = Math.max(1, Math.min(factor, tanHalf(DEFAULT_FOV) / tanHalf(camera.fov)));
        dolly = factor / lens;
      }
    }
    if (dolly !== 1) {
      tmpOff.subVectors(camera.position, tmpAnchor).multiplyScalar(dolly);
      camera.position.copy(tmpAnchor).add(tmpOff);
      tmpOff.subVectors(controls.target, tmpAnchor).multiplyScalar(dolly);
      controls.target.copy(tmpAnchor).add(tmpOff);
    }
    if (lens !== 1) {
      // The visible half-height scales by `lens`; sliding the target (and camera) so
      // the anchor's offset from it scales the same way keeps the anchor under the cursor.
      tmpOff.subVectors(controls.target, tmpAnchor).multiplyScalar(lens).add(tmpAnchor).sub(controls.target);
      controls.target.add(tmpOff);
      camera.position.add(tmpOff);
      const t = tanHalf(camera.fov) * lens;
      // Back at (or rounding-close to) the resting lens → exactly the default.
      camera.fov = t >= tanHalf(DEFAULT_FOV) * (1 - 1e-9) ? DEFAULT_FOV : THREE.MathUtils.radToDeg(2 * Math.atan(t));
      camera.updateProjectionMatrix();
    }
    updateClipPlanes(true);
    controls.update();
    emitCameraMoved();
  }
  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    cancelTween(); // the user took over
    // deltaMode 1 = lines, 2 = pages. Cap one event at a few notches so a coarse
    // wheel (or a trackpad fling) can't jump the view.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const notches = Math.min(4, (Math.abs(e.deltaY) * unit) / 100 || 1);
    zoomAt(e.clientX, e.clientY, Math.pow(ZOOM_STEP, Math.sign(e.deltaY) * notches));
  }
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

  // --- rotate (turntable) ----------------------------------------------------
  // Blender's turntable: a right-drag sideways spins the view about the world Z axis,
  // up/down tilts it about the screen's horizontal axis — with no limit, so you can
  // keep going over the top. The camera's `up` turns with it (it stays the screen's
  // vertical), which also keeps OrbitControls' own per-frame update from clamping.
  const WORLD_UP = new THREE.Vector3(0, 0, 1);
  const tmpQ = new THREE.Quaternion();
  const tmpAxis = new THREE.Vector3();
  let rotating: { x: number; y: number; yawSign: number } | null = null;
  function rotateBy(dx: number, dy: number, yawSign: number): void {
    const k = ((2 * Math.PI) / (renderer.domElement.clientHeight || 1)) * 0.9;
    const offset = tmpOff.subVectors(camera.position, controls.target);
    const dist = offset.length();
    if (!(dist > 0)) return;
    const up = camera.up;
    const turn = (axis: THREE.Vector3, angle: number) => {
      tmpQ.setFromAxisAngle(axis, angle);
      offset.applyQuaternion(tmpQ);
      up.applyQuaternion(tmpQ);
    };
    turn(WORLD_UP, -dx * k * yawSign); // sideways: spin about world Z
    tmpAxis.crossVectors(up, offset).normalize(); // the screen's horizontal (camera right)
    if (tmpAxis.lengthSq() > 0.5) turn(tmpAxis, -dy * k); // up/down: tilt over the top and beyond
    // Re-square `up` against the view direction so rounding never accumulates.
    offset.setLength(dist);
    up.addScaledVector(offset, -up.dot(offset) / (dist * dist)).normalize();
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
    refreshControlsUp();
    controls.update();
  }
  function onRotateDown(e: PointerEvent): void {
    if (dims === 2 || e.button !== 2 || store.getState().lassoMode) return;
    // Like Blender, a view that starts upside-down flips the sideways direction so the
    // picture still follows the mouse. Latched per drag, so it can't reverse mid-drag.
    const screenUpZ = camera.up.z;
    rotating = { x: e.clientX, y: e.clientY, yawSign: screenUpZ < -1e-3 ? -1 : 1 };
  }
  function onRotateMove(e: PointerEvent): void {
    if (!rotating) return;
    if (!(e.buttons & 2)) {
      // The release was lost (e.g. swallowed by the context menu) — end the drag.
      rotating = null;
      emitCameraMoved();
      return;
    }
    const dx = e.clientX - rotating.x;
    const dy = e.clientY - rotating.y;
    rotating.x = e.clientX;
    rotating.y = e.clientY;
    if (dx || dy) rotateBy(dx, dy, rotating.yawSign);
  }
  function onRotateUp(e: PointerEvent): void {
    if (!rotating || e.button !== 2) return;
    rotating = null;
    emitCameraMoved();
  }
  renderer.domElement.addEventListener('pointerdown', onRotateDown);
  window.addEventListener('pointermove', onRotateMove);
  window.addEventListener('pointerup', onRotateUp);

  // Orthographic (parallel-projection) camera for accurate flattened export. It
  // MIRRORS the perspective camera's pose every frame; OrbitControls always drives
  // the perspective camera (so orbit / pan / zoom feel identical) and we derive
  // the ortho frustum from its distance. Only the active camera is rendered/picked.
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, bounds.radius * 0.002, bounds.radius * 60);
  // Projection is per-viewport. The MAIN viewer follows the (undoable, exported)
  // `orthographic` setting; each bottom panel keeps its OWN flag, toggled only via
  // its right-click menu, so panels can differ.
  let ortho = isMain ? store.getState().settings.orthographic ?? false : false;
  const activeCam = (): THREE.Camera => (ortho ? orthoCam : camera);
  const centerDist = () => camera.position.distanceTo(controls.target);
  function syncOrtho(): void {
    orthoCam.position.copy(camera.position);
    orthoCam.quaternion.copy(camera.quaternion);
    orthoCam.up.copy(camera.up);
    const vHalf = Math.max(1e-12, Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * centerDist());
    orthoCam.top = vHalf;
    orthoCam.bottom = -vHalf;
    orthoCam.left = -vHalf * camera.aspect;
    orthoCam.right = vHalf * camera.aspect;
    orthoCam.near = camera.near;
    orthoCam.far = camera.far;
    orthoCam.zoom = 1;
    orthoCam.updateProjectionMatrix();
  }

  // Restore an exact camera pose (preset / session), used both on mount and via
  // viewerControls.setCamera.
  function setCameraPose(cam: SavedCamera): void {
    camera.up.set(cam.up[0], cam.up[1], cam.up[2]);
    camera.fov = cam.fov != null && cam.fov > 0 && cam.fov <= DEFAULT_FOV ? cam.fov : DEFAULT_FOV;
    camera.position.set(cam.position[0], cam.position[1], cam.position[2]);
    controls.target.set(cam.target[0], cam.target[1], cam.target[2]);
    camera.updateProjectionMatrix();
    refreshControlsUp();
    controls.update();
  }

  function fitDistance(radius: number): number {
    camera.fov = DEFAULT_FOV; // every fit frames through the resting lens (drops any magnification)
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    return (Math.max(radius / Math.sin(vfov / 2), radius / Math.sin(hfov / 2)) || focal) * 1.1;
  }

  function frameBounds() {
    controls.target.copy(fullCenter);
    camera.fov = DEFAULT_FOV;
    camera.up.set(0, 1, 0);
    camera.position.copy(fullCenter).addScaledVector(defaultDir, focal);
    camera.updateProjectionMatrix();
    refreshControlsUp();
    controls.update();
    emitCameraMoved();
  }
  frameBounds();
  // A preset / session restore may have queued an exact camera pose — apply it
  // instead of the default framing (main viewer only; it owns the saved camera).
  const initialCam = isMain ? store.getState().pendingCamera : null;
  if (initialCam) {
    setCameraPose(initialCam);
    store.setState({ pendingCamera: null });
  }

  // --- point cloud ---------------------------------------------------------
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const { aColor, aVisible, aSelected, aHover, aSize, aBlip } = attachPointAttributes(
    geom,
    n,
    store.getState().colors ?? undefined,
    store.getState().sizes ?? undefined,
  );
  geom.computeBoundingSphere();
  // For an animated map, pin the bounding sphere to the whole-track bounds so
  // raycast picking never culls points that have moved outside frame 0's sphere.
  if (framePositions) {
    geom.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(bounds.center[0], bounds.center[1], bounds.center[2]),
      bounds.radius + 1e-3,
    );
  }

  const s0 = store.getState().settings;
  const material = makePointMaterial({
    sizePx: 3.0 * s0.pointSize,
    pixelRatio: renderer.getPixelRatio(),
    focal,
    opacity: s0.pointOpacity,
    ghostOpacity: s0.ghostMode ? s0.ghostOpacity : 0.0,
  });

  // Switch render camera between perspective and orthographic (driven by the
  // `orthographic` setting via the store subscription below).
  function setProjection(on: boolean): void {
    if (ortho === on) return;
    ortho = on;
    material.uniforms.uOrtho.value = on ? 1 : 0;
    if (on) {
      syncOrtho();
      material.uniforms.uOrthoDist.value = centerDist();
    }
  }
  if (ortho) {
    material.uniforms.uOrtho.value = 1;
    syncOrtho();
    material.uniforms.uOrthoDist.value = centerDist();
  }

  const points = new THREE.Points(geom, material);
  points.frustumCulled = false;
  scene.add(points);

  // A second pass that redraws ONLY the selected/hovered points, with depth-test
  // off and a high render order, so their highlight is never hidden behind an
  // adjacent point drawn later in the buffer. It shares the main material's uniform
  // objects (so size/opacity/projection stay in lock-step) apart from uOverlayOnly.
  const overlayMat = new THREE.ShaderMaterial({
    uniforms: { ...material.uniforms, uOverlayOnly: { value: 1 } },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
  });
  const overlayPoints = new THREE.Points(geom, overlayMat);
  overlayPoints.frustumCulled = false;
  overlayPoints.renderOrder = 4;
  scene.add(overlayPoints);

  // Filtered-out ("ghost") points render in their OWN pass with depthWrite OFF, so they
  // never write depth and thus never occlude the real cloud — which is what made them a
  // solid near-black wall when you orbited behind the volume (they still depth-TEST, so a
  // ghost behind real data stays hidden; one in front shows faintly). Shares the main
  // material's uniform objects (opacity/ghost/size/projection stay in lock-step) apart
  // from uGhostPass. Drawn after the main (depth-writing) pass so it tests against it.
  const ghostMat = new THREE.ShaderMaterial({
    uniforms: { ...material.uniforms, uGhostPass: { value: 1 } },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });
  const ghostPoints = new THREE.Points(geom, ghostMat);
  ghostPoints.frustumCulled = false;
  ghostPoints.renderOrder = 1;
  scene.add(ghostPoints);

  // --- traces (per-point path across frames) -------------------------------
  // For an animated map, each point's full track is drawn as a static polyline
  // (for orbits, the orbit itself). Grey when unselected, the point's colour when
  // selected, dim when filtered out; toggled by settings via `showTraces`. Skipped
  // for a variable dot-plot (no meaningful path) and single-frame maps.
  let traces: THREE.LineSegments | null = null;
  let traceVertPoint: Int32Array | null = null; // vertex index → point index (for colouring)
  if (framePositions && !map.variableKey) {
    const F = framePositions.length;
    const segPos: number[] = [];
    const segPt: number[] = [];
    for (let i = 0; i < n; i++) {
      let prev: [number, number, number] | null = null;
      for (let f = 0; f < F; f++) {
        const b = framePositions[f];
        const x = b[i * 3];
        const y = b[i * 3 + 1];
        const z = b[i * 3 + 2];
        if (Number.isFinite(x) && Number.isFinite(y)) {
          if (prev) {
            segPos.push(prev[0], prev[1], prev[2], x, y, z);
            segPt.push(i, i);
          }
          prev = [x, y, z];
        } else {
          prev = null; // a gap (hidden frame) breaks the trail
        }
      }
    }
    if (segPt.length) {
      const tgeom = new THREE.BufferGeometry();
      tgeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segPos), 3));
      tgeom.setAttribute('aTraceColor', new THREE.BufferAttribute(new Float32Array(segPt.length * 3).fill(0.3), 3));
      tgeom.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(segPt.length), 1));
      traceVertPoint = new Int32Array(segPt);
      // Custom line shader: per-vertex colour AND alpha, so a point's trace can be
      // shown/hidden individually (persistent `tracedPoints`) even when the global
      // "traces for visible points" toggle is off.
      const tmat = new THREE.ShaderMaterial({
        vertexShader: `attribute vec3 aTraceColor; attribute float aAlpha; varying vec3 vC; varying float vA;
          void main(){ vC = aTraceColor; vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `precision mediump float; varying vec3 vC; varying float vA;
          void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(vC, vA); }`,
        transparent: true,
        depthWrite: false,
      });
      traces = new THREE.LineSegments(tgeom, tmat);
      traces.frustumCulled = false;
      traces.renderOrder = -1; // behind the points, so dots sit on their trails
      scene.add(traces);
    }
  }
  // Set each segment's colour + alpha from the current selection / per-point traces
  // / global toggle / filters. A trace shows if the point is individually traced OR
  // (the global toggle is on AND the point is visible); it highlights (data colour)
  // when individually traced or selected, else grey.
  const GREY = 0.34; // regular trace (global "traces for visible points")
  const PREVIEW = 0.72; // hover / selection preview — greyer-white than a regular trace
  function updateTraceColors(): void {
    if (!traces || !traceVertPoint) return;
    const st = store.getState();
    const colors = st.colors;
    const sel = st.selectedMask;
    const vis = st.visible;
    const traced = st.tracedPoints;
    const showAll = st.settings.showTraces;
    const hover = st.hover;
    const cAttr = traces.geometry.getAttribute('aTraceColor') as THREE.BufferAttribute;
    const aAttr = traces.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    const carr = cAttr.array as Float32Array;
    const aarr = aAttr.array as Float32Array;
    let anyShown = false;
    for (let v = 0; v < traceVertPoint.length; v++) {
      const i = traceVertPoint[v];
      const isTraced = traced.has(i);
      const isPreview = (!!sel && sel[i] > 0.5) || hover === i; // hover/selection previews the path
      const visibleI = !vis || vis[i] !== 0;
      const show = isTraced || isPreview || (showAll && visibleI);
      let r = GREY;
      let g = GREY;
      let b = GREY;
      let a = 0;
      if (isTraced) {
        // committed per-point trace → the point's data colour
        r = colors ? colors[i * 3] : 1;
        g = colors ? colors[i * 3 + 1] : 1;
        b = colors ? colors[i * 3 + 2] : 1;
        a = 0.9;
      } else if (isPreview) {
        r = g = b = PREVIEW; // grey-white preview
        a = 0.75;
      } else if (show) {
        a = 0.5; // regular grey trace
      }
      carr[v * 3] = r;
      carr[v * 3 + 1] = g;
      carr[v * 3 + 2] = b;
      aarr[v] = a;
      if (a > 0) anyShown = true;
    }
    cAttr.needsUpdate = true;
    aAttr.needsUpdate = true;
    traces.visible = anyShown;
  }
  updateTraceColors();

  // --- axes + grid (independent) ------------------------------------------
  // 3D panels draw gray axis lines along the data bounding box (the x/y/z letters
  // and numbers come from the 2-D overlay); flat panels (2D / dot plot) get their
  // whole axis from the overlay, so nothing is added to the scene here.
  let axes3d: THREE.LineSegments | null = null;
  if (dims === 3) {
    const [mnx, mny, mnz] = bounds.min;
    const [mxx, mxy, mxz] = bounds.max;
    const ag = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(mnx, mny, mnz), new THREE.Vector3(mxx, mny, mnz),
      new THREE.Vector3(mnx, mny, mnz), new THREE.Vector3(mnx, mxy, mnz),
      new THREE.Vector3(mnx, mny, mnz), new THREE.Vector3(mnx, mny, mxz),
    ]);
    axes3d = new THREE.LineSegments(ag, new THREE.LineBasicMaterial({ color: 0x707070 }));
    axes3d.frustumCulled = false;
    axes3d.visible = s0.showAxes;
    scene.add(axes3d);
  }

  // The reference grid is no longer a fixed 3D mesh — it's drawn on the axis
  // overlay each frame at power-of-ten intervals that always line up with the axis
  // numbers and adapt as you zoom (see paintGrid). A dot plot has no world grid.

  // --- selection outline ---------------------------------------------------
  let outline: THREE.LineLoop | null = null;
  function clearOutline() {
    if (outline) {
      scene.remove(outline);
      outline.geometry.dispose();
      (outline.material as THREE.Material).dispose();
      outline = null;
    }
  }
  function updateOutline() {
    clearOutline();
    const st = store.getState();
    if (!spatialOverlays || st.primary == null) return; // the selected point's boundary is always drawn
    const point = dataset.points[st.primary];
    if (!point?.outline || point.outline.length < 2) return;
    const c0 = coordOf(point);
    const z = c0 && c0.length >= 3 ? (c0[2] as number) : 0;
    const pts = point.outline.map(([x, y]) => new THREE.Vector3(x, y, z));
    const og = new THREE.BufferGeometry().setFromPoints(pts);
    outline = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: 0xffb000 }));
    outline.frustumCulled = false;
    scene.add(outline);
  }
  updateOutline();

  // --- multichannel image overlays ----------------------------------------
  const imageGroup = new THREE.Group();
  scene.add(imageGroup);
  interface ImgMesh {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    tex: THREE.Texture;
    layer: number;
    baseOpacity: number;
  }
  const imgMeshes: ImgMesh[] = [];
  const imgGeoms: THREE.BufferGeometry[] = [];
  const texLoader = new THREE.TextureLoader();

  // Image overlays are drawn only in the main viewer's map-0 (physical) view.
  if (withImages) dataset.images.forEach((layer, li) => {
    const [x0, y0, x1, y1] = layer.extent;
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    if (w <= 0 || h <= 0) return;
    const g2 = new THREE.PlaneGeometry(w, h);
    imgGeoms.push(g2);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const z = layer.z ?? 0;
    const baseOpacity = layer.opacity ?? 1;
    for (const ch of layer.channels ?? []) {
      if (!ch?.src) continue;
      const tex = texLoader.load(ch.src);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      if (layer.flip?.[0]) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.repeat.x = -1;
      }
      if (layer.flip?.[1]) {
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.y = -1;
      }
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: new THREE.Color(ch.color ?? '#ffffff'),
        transparent: true,
        blending: layer.blend === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(g2, mat);
      mesh.position.set(cx, cy, z);
      mesh.renderOrder = -1;
      mesh.userData.layer = li;
      imageGroup.add(mesh);
      imgMeshes.push({ mesh, mat, tex, layer: li, baseOpacity });
    }
  });

  function applyImageSettings() {
    const set = store.getState().settings;
    const hidden = new Set(set.hiddenImages);
    imageGroup.visible = withImages && set.showImages && dataset.images.length > 0;
    for (const im of imgMeshes) {
      im.mesh.visible = !hidden.has(im.layer);
      im.mat.opacity = im.baseOpacity * set.imageOpacity;
    }
  }
  applyImageSettings();

  const imgBorders: THREE.LineLoop[] = [];
  function updateImageSelection() {
    for (const b of imgBorders) {
      scene.remove(b);
      b.geometry.dispose();
      (b.material as THREE.Material).dispose();
    }
    imgBorders.length = 0;
    if (!withImages) return;
    const sel = store.getState().selectedImages;
    for (const li of sel) {
      const layer = dataset.images[li];
      if (!layer) continue;
      const [x0, y0, x1, y1] = layer.extent;
      const z = layer.z ?? 0;
      const pts = [
        new THREE.Vector3(x0, y0, z),
        new THREE.Vector3(x1, y0, z),
        new THREE.Vector3(x1, y1, z),
        new THREE.Vector3(x0, y1, z),
      ];
      const bg = new THREE.BufferGeometry().setFromPoints(pts);
      const loop = new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: 0x00e0ff }));
      loop.frustumCulled = false;
      loop.renderOrder = 2;
      scene.add(loop);
      imgBorders.push(loop);
    }
  }
  updateImageSelection();

  // --- store subscriptions -------------------------------------------------
  const unsubs: (() => void)[] = [];
  let lastHover = -1;

  // Seed visibility / selection / hover from the CURRENT store state. The
  // subscriptions below only fire on CHANGE, and attachPointAttributes seeds only
  // colours + sizes — so a panel (re)mounted while a filter or selection is already
  // active (e.g. right after you switch its axes) must copy that state in now, or it
  // would render every point visible and none selected until the next change. This
  // is what made filtering / colouring look out of sync across panels.
  {
    const st0 = store.getState();
    if (st0.visible) {
      const a = aVisible.array as Float32Array;
      for (let i = 0; i < n; i++) a[i] = st0.visible[i];
      aVisible.needsUpdate = true;
    }
    if (st0.selectedMask) {
      const a = aSelected.array as Float32Array;
      const m = st0.selectedMask;
      for (let i = 0; i < n; i++) a[i] = m[i];
      aSelected.needsUpdate = true;
    }
    if (st0.hover != null && st0.hover >= 0 && st0.hover < n) {
      (aHover.array as Float32Array)[st0.hover] = 1;
      aHover.needsUpdate = true;
      lastHover = st0.hover;
    }
    updateTraceColors();
  }

  // True once a DIFFERENT dataset is installed in the store: zustand fires subscribers
  // synchronously inside the load's set(), before React tears this stale viewer down and
  // remounts — so a stale viewer must ignore updates sized for the new dataset (e.g.
  // copying 100k new colors into a 6k-point buffer → "offset out of bounds").
  const isStale = () => store.getState().dataset !== dataset;

  unsubs.push(
    store.subscribe((s, prev) => {
      if (isStale()) return;
      if (s.colors && s.colors !== prev.colors) {
        (aColor.array as Float32Array).set(s.colors);
        aColor.needsUpdate = true;
        updateTraceColors();
      }
    }),
  );
  unsubs.push(
    store.subscribe((s, prev) => {
      if (isStale()) return;
      if (s.visible && s.visible !== prev.visible) {
        const arr = aVisible.array as Float32Array;
        for (let i = 0; i < n; i++) arr[i] = s.visible[i];
        aVisible.needsUpdate = true;
        updateTraceColors();
      }
    }),
  );
  unsubs.push(
    store.subscribe((s, prev) => {
      if (isStale()) return;
      if (s.selectedMask !== prev.selectedMask) {
        const arr = aSelected.array as Float32Array;
        const mask = s.selectedMask;
        for (let i = 0; i < n; i++) arr[i] = mask ? mask[i] : 0;
        aSelected.needsUpdate = true;
        updateTraceColors();
      }
      if (s.primary !== prev.primary) updateOutline();
      if (s.selectedImages !== prev.selectedImages) updateImageSelection();
    }),
  );
  unsubs.push(
    store.subscribe((s, prev) => {
      if (isStale()) return;
      if (s.hover === prev.hover) return;
      const arr = aHover.array as Float32Array;
      if (lastHover >= 0 && lastHover < n) arr[lastHover] = 0;
      if (s.hover != null && s.hover >= 0 && s.hover < n) arr[s.hover] = 1;
      lastHover = s.hover ?? -1;
      aHover.needsUpdate = true;
      updateTraceColors(); // hovering a point previews its trace
    }),
  );
  // "Size by" a variable → per-point size multiplier; per-point traces set change.
  unsubs.push(
    store.subscribe((s, prev) => {
      if (isStale()) return;
      if (s.sizes !== prev.sizes) {
        const arr = aSize.array as Float32Array;
        if (s.sizes) arr.set(s.sizes);
        else arr.fill(1);
        aSize.needsUpdate = true;
      }
      if (s.tracedPoints !== prev.tracedPoints) updateTraceColors();
    }),
  );
  unsubs.push(
    store.subscribe((s, prev) => {
      if (s.lassoMode !== prev.lassoMode) {
        controls.enabled = !s.lassoMode; // pause orbit/pan while drawing a boundary
        updateCursor(null);
      }
      if (s.settings === prev.settings) return;
      const set = s.settings;
      const p = prev.settings;
      material.uniforms.uSizePx.value = 3.0 * set.pointSize;
      material.uniforms.uOpacity.value = set.pointOpacity;
      material.uniforms.uGhostOpacity.value = set.ghostMode ? set.ghostOpacity : 0.0;
      // The global `orthographic` setting drives only the main viewer; bottom
      // panels manage their own projection via their right-click menu.
      if (isMain && set.orthographic !== p.orthographic) setProjection(set.orthographic);
      if (axes3d) axes3d.visible = set.showAxes; // the overlay axes read showAxes each frame
      // showGrid is read each frame by paintGrid; no mesh to toggle anymore.
      if (set.showTraces !== p.showTraces) updateTraceColors();
      applyImageSettings();
    }),
  );

  // Multi-frame animation: HOLD each point at its most recent sample at or before
  // the current time (step; no interpolation). The continuous render loop + shared
  // geometry mean the scatter, on-top overlay, picking and axes all follow. When a
  // point's position actually changes at a crossed sample, fire a fading "blip".
  const BLIP_LIFE = 0.7; // seconds for a radar ping to fade
  let decayBlips: () => void = () => {};
  if (framePositions) {
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const frameTimes = dataset.frames;
    const F = framePositions.length;
    const blipArr = aBlip.array as Float32Array;
    const blipActive = new Set<number>();
    let lastK = -1;
    let lastBlipTs = performance.now();
    // Largest sample index with frameTimes[k] <= t (clamped to the ends).
    const indexAt = (t: number): number => {
      let lo = 0;
      let hi = F - 1;
      if (t <= frameTimes[0]) return 0;
      if (t >= frameTimes[hi]) return hi;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (frameTimes[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const applyTime = (t: number) => {
      const k = indexAt(t);
      positions.set(framePositions[k]);
      posAttr.needsUpdate = true;
      // Blip the points whose position changed (or (dis)appeared) since the last
      // shown sample — an optional aid when updates are staggered across points.
      if (store.getState().settings.showBlips && lastK >= 0 && k !== lastK) {
        const from = framePositions[lastK];
        const to = framePositions[k];
        for (let i = 0; i < n; i++) {
          const ax = from[i * 3];
          const bx = to[i * 3];
          const fa = ax === ax; // not NaN → placed
          const fb = bx === bx;
          const changed = fa !== fb || (fb && (ax !== bx || from[i * 3 + 1] !== to[i * 3 + 1] || from[i * 3 + 2] !== to[i * 3 + 2]));
          if (changed) {
            blipArr[i] = 1;
            blipActive.add(i);
          }
        }
        aBlip.needsUpdate = true;
      }
      lastK = k;
    };
    decayBlips = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastBlipTs) / 1000);
      lastBlipTs = now;
      if (blipActive.size === 0) return;
      const rate = dt / BLIP_LIFE;
      for (const i of [...blipActive]) {
        const v = blipArr[i] - rate;
        if (v <= 0) {
          blipArr[i] = 0;
          blipActive.delete(i);
        } else blipArr[i] = v;
      }
      aBlip.needsUpdate = true;
    };
    applyTime(store.getState().currentTime ?? frameTimes[0] ?? 0);
    unsubs.push(
      store.subscribe((s, prev) => {
        if (s.currentTime !== prev.currentTime) applyTime(s.currentTime);
      }),
    );
  }

  // --- picking + hover -----------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downX = 0;
  let downY = 0;
  let downTime = 0;

  function setNdc(clientX: number, clientY: number) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }
  function pickCell(clientX: number, clientY: number): number | null {
    setNdc(clientX, clientY);
    raycaster.setFromCamera(ndc, activeCam());
    // A fixed on-screen pick radius: scales with distance AND with any lens magnification.
    raycaster.params.Points!.threshold = controls.getDistance() * 0.012 * (tanHalf(camera.fov) / tanHalf(DEFAULT_FOV));
    const hits = raycaster.intersectObject(points, false);
    const vis = store.getState().visible;
    for (const h of hits) {
      const idx = h.index ?? -1;
      // Skip points absent from this map (NaN slot) — they don't render here.
      if (idx >= 0 && Number.isFinite(positions[idx * 3]) && (!vis || vis[idx])) return idx;
    }
    return null;
  }
  function pickImageLayer(clientX: number, clientY: number): number | null {
    setNdc(clientX, clientY);
    raycaster.setFromCamera(ndc, activeCam());
    const meshes = imgMeshes.filter((m) => m.mesh.visible && imageGroup.visible).map((m) => m.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    return hits.length ? (hits[0].object.userData.layer as number) : null;
  }
  function updateCursor(hoverIdx: number | null) {
    renderer.domElement.style.cursor = store.getState().lassoMode
      ? 'crosshair'
      : hoverIdx == null
        ? 'grab'
        : 'pointer';
  }

  function onPointerDown(e: PointerEvent) {
    cancelTween(); // a drag takes over from a running snap
    downX = e.clientX;
    downY = e.clientY;
    downTime = performance.now();
  }
  function onPointerUp(e: PointerEvent) {
    if (e.button !== 0) return;
    const st = store.getState();
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    const wasClick = moved <= 5 && performance.now() - downTime <= 500;
    const additive = e.ctrlKey || e.metaKey; // Ctrl = add-to-selection modifier

    // Lasso mode (pinned via the menu, or held via Shift): a drag draws the boundary
    // (handled by the overlay). A plain click clears the current selection — a quick
    // way to start over without leaving the tool.
    if (st.lassoMode) {
      if (wasClick && !additive && st.selection.size > 0) st.clearSelection();
      return;
    }
    if (!wasClick) return; // a drag was an orbit / pan

    // Alt-click picks a microscopy image overlay layer (only when images are loaded).
    if (e.altKey && (st.dataset?.images.length ?? 0) > 0) {
      const layer = pickImageLayer(e.clientX, e.clientY);
      if (layer == null) st.clearImageSelect();
      else st.toggleImageSelect(layer, true);
      return;
    }

    const idx = pickCell(e.clientX, e.clientY);
    if (idx == null) {
      if (!additive) st.clearSelection(); // Ctrl-click on empty space keeps the selection
      return;
    }
    if (additive) st.toggleSelect(idx); // Ctrl-click = multi-select (add/remove this point)
    else st.selectOnly(idx);
  }

  let hoverPending = false;
  let lastHoverEvent: PointerEvent | null = null;
  function onPointerMove(e: PointerEvent) {
    if (n > 400_000 || store.getState().lassoMode) return;
    lastHoverEvent = e;
    if (hoverPending) return;
    hoverPending = true;
    requestAnimationFrame(() => {
      hoverPending = false;
      const ev = lastHoverEvent;
      if (!ev) return;
      const idx = pickCell(ev.clientX, ev.clientY);
      const st = store.getState();
      if (idx !== st.hover) st.setHover(idx);
      updateCursor(idx);
    });
  }

  // Double-click while the lasso tool is active turns it off (a quick escape).
  function onDblClick() {
    if (store.getState().lassoMode) store.getState().setLassoMode(false);
  }
  // Leaving the canvas clears the hover — otherwise a label picked near an edge
  // stays stuck after the cursor exits the panel (no more pointermove events fire).
  function onPointerLeave() {
    if (store.getState().hover !== null) store.getState().setHover(null);
    updateCursor(null);
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('dblclick', onDblClick);
  renderer.domElement.addEventListener('pointerleave', onPointerLeave);
  updateCursor(null);

  // --- lasso selection -----------------------------------------------------
  function selectInLasso(poly: [number, number][], additive: boolean) {
    const rect = renderer.domElement.getBoundingClientRect();
    const vis = store.getState().visible;
    const v = new THREE.Vector3();
    const picked: number[] = [];
    for (let i = 0; i < n; i++) {
      if (vis && !vis[i]) continue;
      if (!Number.isFinite(positions[i * 3])) continue; // not placed in this map
      v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).project(activeCam());
      if (v.z < -1 || v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (1 - (v.y * 0.5 + 0.5)) * rect.height;
      if (pointInPolygon(sx, sy, poly)) picked.push(i);
    }
    store.getState().commitSelection(picked, additive);
  }
  const disposeLasso = createLasso({
    container,
    dom: renderer.domElement,
    isActive: () => store.getState().lassoMode,
    onSelect: selectInLasso,
  });

  // --- camera commands -----------------------------------------------------
  function fitTo(center: THREE.Vector3, radius: number, keepDir: boolean) {
    const dir = keepDir ? new THREE.Vector3().subVectors(camera.position, controls.target).normalize() : defaultDir.clone();
    if (dir.lengthSq() < 1e-6) dir.copy(defaultDir);
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, fitDistance(radius));
    camera.updateProjectionMatrix();
    controls.update();
    emitCameraMoved();
  }
  function bboxOf(scope: 'all' | 'visible'): { center: THREE.Vector3; radius: number } {
    const box = new THREE.Box3();
    const vis = store.getState().visible;
    for (let i = 0; i < n; i++) {
      if (scope === 'visible' && vis && !vis[i]) continue;
      if (!Number.isFinite(positions[i * 3])) continue; // not placed in this map
      box.expandByPoint(new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
    }
    if (box.isEmpty()) return { center: fullCenter.clone(), radius: bounds.radius };
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.radius * 0.02, box.getSize(new THREE.Vector3()).length() * 0.5);
    return { center, radius };
  }

  // Per-viewport camera actions. Each panel drives ITS OWN camera — the right-click
  // menu calls these for whichever panel it was opened over.
  function doReset(): void {
    frameBounds();
  }
  function doFit(scope: 'all' | 'visible'): void {
    const { center, radius } = bboxOf(scope);
    fitTo(center, radius, true);
  }
  function doFrameSelection(): void {
    const st = store.getState();
    if (!st.selection.size) {
      doFit('visible');
      return;
    }
    const box = new THREE.Box3();
    for (const i of st.selection) {
      if (!Number.isFinite(positions[i * 3])) continue;
      box.expandByPoint(new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(bounds.radius * 0.02, box.getSize(new THREE.Vector3()).length() * 0.5);
    fitTo(center, radius, true);
  }
  // OrbitControls snapshots `camera.up` into a quaternion ONCE, when it's constructed
  // — so after we change `up` (snapping to an axis, or rolling) its orbit frame is
  // stale and dragging would rotate about the old vertical. Refresh that pair.
  function refreshControlsUp(): void {
    const c = controls as unknown as { _quat?: THREE.Quaternion; _quatInverse?: THREE.Quaternion };
    c._quat?.setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
    if (c._quat && c._quatInverse) c._quatInverse.copy(c._quat).invert();
  }
  // --- animated camera moves ------------------------------------------------
  // A snap ROTATES into its new orientation over a short arc rather than cutting, so
  // it stays obvious how the new view relates to the old one. The tween is stepped
  // from `tick`; any wheel / drag cancels it.
  const SNAP_MS = 380;
  // Must be a CAMERA: `lookAt` aims a camera's −z at the target but a plain Object3D's
  // +z, which would mirror every pose (applyPose assumes camera convention) — the snap
  // would land on the opposite side of the ball you clicked.
  const poseDummy = new THREE.PerspectiveCamera();
  let camTween: {
    q0: THREE.Quaternion;
    q1: THREE.Quaternion;
    d0: number;
    d1: number;
    target: THREE.Vector3;
    t0: number;
  } | null = null;
  const cancelTween = (): void => {
    camTween = null;
  };
  // The camera orientation that looks at `target` from `pos` with `up`.
  function poseQuat(pos: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
    poseDummy.up.copy(up);
    poseDummy.position.copy(pos);
    poseDummy.lookAt(target);
    return poseDummy.quaternion.clone();
  }
  // Place the camera at `dist` from `target` in the orientation `q` (up included, so
  // an interpolated roll shows).
  function applyPose(q: THREE.Quaternion, dist: number, target: THREE.Vector3): void {
    camera.up.set(0, 1, 0).applyQuaternion(q);
    camera.position.copy(target).addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(q), -dist);
    refreshControlsUp();
    camera.updateProjectionMatrix();
    controls.update();
  }
  function animateTo(toPos: THREE.Vector3, toUp: THREE.Vector3): void {
    const target = controls.target.clone();
    const q0 = poseQuat(camera.position, target, camera.up);
    const q1 = poseQuat(toPos, target, toUp);
    const d0 = camera.position.distanceTo(target);
    const d1 = toPos.distanceTo(target);
    if (!(d0 > 0) || !(d1 > 0)) return;
    if (q0.angleTo(q1) < 1e-4 && Math.abs(d1 - d0) < d0 * 1e-4) return; // already there
    camTween = { q0, q1, d0, d1, target, t0: performance.now() };
  }
  function stepTween(): void {
    if (!camTween) return;
    const s = Math.min(1, (performance.now() - camTween.t0) / SNAP_MS);
    const e = s < 0.5 ? 2 * s * s : 1 - Math.pow(-2 * s + 2, 2) / 2; // ease in / out
    applyPose(camTween.q0.clone().slerp(camTween.q1, e), camTween.d0 + (camTween.d1 - camTween.d0) * e, camTween.target);
    updateClipPlanes(true);
    if (s >= 1) {
      camTween = null;
      emitCameraMoved();
    }
  }

  // Look straight down one axis (the gizmo's balls), keeping the current target and
  // distance — an orientation change only, so you stay where you were looking.
  // Clicking the axis you're ALREADY looking down flips to the opposite side, so the
  // same ball toggles +x / −x (as in Blender).
  function doSnapAxis(axis: 0 | 1 | 2, sign: 1 | -1): void {
    const d = centerDist() || fitDistance(bounds.radius);
    const axisVec = (s: number) => new THREE.Vector3(axis === 0 ? s : 0, axis === 1 ? s : 0, axis === 2 ? s : 0);
    const current = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    const s: 1 | -1 = current.dot(axisVec(sign)) > 0.999 ? ((-sign) as 1 | -1) : sign;
    animateTo(controls.target.clone().addScaledVector(axisVec(s), d), new THREE.Vector3(0, axis === 2 ? 1 : 0, axis === 2 ? 0 : 1));
  }
  // Roll the view a quarter turn in the screen plane (the picture spins; the side
  // you're looking from doesn't change).
  function doRoll(): void {
    const dir = new THREE.Vector3().subVectors(controls.target, camera.position);
    if (dir.lengthSq() < 1e-12) return;
    animateTo(camera.position.clone(), camera.up.clone().applyAxisAngle(dir.normalize(), Math.PI / 2).normalize());
  }
  function doSnap(plane: 'xy' | 'yz' | 'xz'): void {
    // A 2D map has no depth to snap through — just re-frame it flat.
    if (dims === 2) {
      frameBounds();
      return;
    }
    const { center, radius } = bboxOf('all');
    const d = fitDistance(radius);
    controls.target.copy(center);
    if (plane === 'xy') {
      camera.up.set(0, 1, 0);
      camera.position.set(center.x, center.y, center.z + d);
    } else if (plane === 'xz') {
      camera.up.set(0, 0, 1);
      camera.position.set(center.x, center.y + d, center.z);
    } else {
      camera.up.set(0, 0, 1);
      camera.position.set(center.x + d, center.y, center.z);
    }
    camera.updateProjectionMatrix();
    refreshControlsUp();
    controls.update();
    emitCameraMoved();
  }

  // Register this viewport so its right-click menu drives it independently. Ortho
  // for the main viewer routes through the store (undoable, exported); a bottom
  // panel flips its own local projection.
  viewports.register(viewportId, {
    resetView: doReset,
    fit: doFit,
    snapToPlane: doSnap,
    roll: doRoll,
    frameSelection: doFrameSelection,
    getOrtho: isMain ? () => store.getState().settings.orthographic : () => ortho,
    setOrtho: isMain ? (on) => store.getState().setOrthographic(on) : (on) => setProjection(on),
    is3D: () => dims === 3,
    container,
    stillPng: (w, h, bg) => exportPng({ format: 'png', width: w, height: h, background: bg }),
    sceneSvg: (w, h, bg) => sceneSvgInner(w, h, bg),
    axesToCanvas: (ctx, w, h) => {
      ensureCameraCurrent();
      const pen = new CanvasPen(ctx);
      paintGrid(pen, w, h);
      paintAxes(pen, w, h);
      paintLabels(pen, w, h);
    },
    axesToSvg: (w, h) => {
      ensureCameraCurrent();
      const pen = new SvgPen();
      paintGrid(pen, w, h);
      paintAxes(pen, w, h);
      paintLabels(pen, w, h);
      return pen.markup();
    },
  });

  // The main viewer also backs the shared handle used by the menu bar, console,
  // image export, and session-camera autosave.
  if (isMain) {
    viewerControls.resetView = doReset;
    viewerControls.fit = doFit;
    viewerControls.frameSelection = doFrameSelection;
    viewerControls.snapToPlane = doSnap;
    viewerControls.exportImage = (opts) => exportImage(opts);
    viewerControls.getCamera = () => ({
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      up: [camera.up.x, camera.up.y, camera.up.z],
      ...(camera.fov !== DEFAULT_FOV ? { fov: camera.fov } : {}),
    });
    viewerControls.setCamera = setCameraPose;
  }

  // --- export --------------------------------------------------------------
  function bgColor(bg: ExportOptions['background']): THREE.Color | null {
    return bg === 'white' ? new THREE.Color(0xffffff) : bg === 'dark' ? new THREE.Color(0x050505) : null;
  }
  async function exportImage(opts: ExportOptions): Promise<{ ok: boolean; error?: string; path?: string }> {
    try {
      const st = store.getState();
      const base = (st.dataset?.sourceName ?? 'maplet').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'maplet';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${base}_${stamp}.${opts.format}`;
      // Save the exact view alongside the figure so it can be reproduced later.
      const presetJson = JSON.stringify(st.buildSavedView(), null, 2);
      const payload =
        opts.format === 'png'
          ? { format: 'png' as const, pngDataUrl: exportPng(opts), suggestedName: filename, presetJson }
          : { format: 'svg' as const, svgText: exportSvg(opts), suggestedName: filename, presetJson };
      const res = await saveExport(payload);
      if (res.canceled) {
        st.logMsg('info', 'Export canceled.');
        return { ok: false };
      }
      if (!res.ok) throw new Error(res.error ?? 'save failed');
      st.logMsg(
        'ok',
        `Exported ${opts.format.toUpperCase()} ${opts.width}×${opts.height} (${opts.background})${res.path ? ` → ${res.path}` : ''}. View preset saved alongside.`,
      );
      return { ok: true, path: res.path };
    } catch (e) {
      const msg = (e as Error).message;
      store.getState().logMsg('error', `Export failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }
  function exportCamera(w: number, h: number): THREE.Camera {
    if (ortho) {
      // Match the current ortho framing at the export aspect ratio.
      const c = orthoCam.clone();
      const vHalf = orthoCam.top;
      const aspect = w / h;
      c.left = -vHalf * aspect;
      c.right = vHalf * aspect;
      c.top = vHalf;
      c.bottom = -vHalf;
      c.updateProjectionMatrix();
      return c;
    }
    const cam = camera.clone();
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    return cam;
  }
  // Bring the active camera's world/inverse matrices up to date so the export's
  // manual projections work even if no frame has been rendered yet (the render loop
  // is what normally refreshes matrixWorldInverse).
  function ensureCameraCurrent(): void {
    if (ortho) syncOrtho();
    const cam = activeCam();
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  }
  function exportPng(opts: ExportOptions): string {
    ensureCameraCurrent();
    const { width, height } = opts;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: opts.background === 'transparent', preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(width, height, false);
    scene.background = bgColor(opts.background);
    if (opts.background === 'transparent') r.setClearColor(0x000000, 0);
    const savedPR = material.uniforms.uPixelRatio.value;
    material.uniforms.uPixelRatio.value = height / Math.max(1, container.clientHeight);
    const cam = exportCamera(width, height);
    r.render(scene, cam);
    const url = r.domElement.toDataURL('image/png');
    material.uniforms.uPixelRatio.value = savedPR;
    scene.background = new THREE.Color(0x050505);
    r.dispose();
    return url;
  }
  function projectVec(v: THREE.Vector3, cam: THREE.Camera, w: number, h: number) {
    const p = v.clone().project(cam);
    if (p.z < -1 || p.z > 1) return null;
    return { x: (p.x * 0.5 + 0.5) * w, y: (1 - (p.y * 0.5 + 0.5)) * h };
  }
  // The scene as SVG INNER markup (background + images + points as circles), with
  // no <svg> wrapper — so it composes into a multi-panel export. `exportSvg` wraps it.
  function sceneSvgInner(width: number, height: number, bg: ExportBackground): string {
    ensureCameraCurrent();
    const cam = exportCamera(width, height);
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    const vis = store.getState().visible;
    const colors = store.getState().colors;
    const sizes = store.getState().sizes;
    const set = store.getState().settings;
    const sizeScale = height / Math.max(1, container.clientHeight);
    const parts: string[] = [];
    if (bg !== 'transparent') {
      parts.push(`<rect width="${width}" height="${height}" fill="${bg === 'white' ? '#ffffff' : '#050505'}"/>`);
    }
    if (set.showImages && withImages) {
      const hidden = new Set(set.hiddenImages);
      dataset.images.forEach((layer, li) => {
        if (hidden.has(li)) return;
        const [x0, y0, x1, y1] = layer.extent;
        const z = layer.z ?? 0;
        const tl = projectVec(new THREE.Vector3(x0, y1, z), cam, width, height);
        const tr = projectVec(new THREE.Vector3(x1, y1, z), cam, width, height);
        const bl = projectVec(new THREE.Vector3(x0, y0, z), cam, width, height);
        if (!tl || !tr || !bl) return;
        const mat = `matrix(${tr.x - tl.x} ${tr.y - tl.y} ${bl.x - tl.x} ${bl.y - tl.y} ${tl.x} ${tl.y})`;
        for (const ch of layer.channels ?? []) {
          if (!ch?.src) continue;
          parts.push(
            `<image href="${ch.src}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" transform="${mat}" opacity="${(layer.opacity ?? 1) * set.imageOpacity}" style="mix-blend-mode:screen"/>`,
          );
        }
      });
    }
    // Traces (paths across frames) under the points, matching the live rules.
    if (framePositions) {
      const st = store.getState();
      const traced = st.tracedPoints;
      const sel = st.selectedMask;
      const F = framePositions.length;
      const tv = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const isTraced = traced.has(i);
        const isSelected = !!sel && sel[i] > 0.5;
        const visibleI = !vis || vis[i] !== 0;
        if (!(isTraced || isSelected || (set.showTraces && visibleI))) continue;
        // committed trace → data colour; selection → grey-white preview; else grey.
        let col = set.showTraces && visibleI ? '#575757' : '#b8b8b8';
        let opacity = 0.5;
        if (isTraced && colors) {
          col = `rgb(${Math.round(colors[i * 3] * 255)},${Math.round(colors[i * 3 + 1] * 255)},${Math.round(colors[i * 3 + 2] * 255)})`;
          opacity = 0.9;
        } else if (isSelected) {
          col = '#b8b8b8';
          opacity = 0.75;
        }
        let d = '';
        let started = false;
        for (let f = 0; f < F; f++) {
          const b = framePositions[f];
          const x = b[i * 3];
          const y = b[i * 3 + 1];
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            started = false;
            continue;
          }
          const p = projectVec(tv.set(x, y, b[i * 3 + 2]), cam, width, height);
          if (!p) {
            started = false;
            continue;
          }
          d += `${started ? ' L' : ' M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
          started = true;
        }
        if (d) parts.push(`<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="1" opacity="${opacity}"/>`);
      }
    }
    const pts: { x: number; y: number; r: number; dist: number; col: string }[] = [];
    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      if (vis && !vis[i]) continue;
      tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      const p = projectVec(tmp, cam, width, height);
      if (!p) continue;
      // View-independent dot size: a fixed screen size (scaled only to the export
      // resolution), matching the live shader — no camera-distance falloff.
      const rad = Math.min(64, Math.max(0.4, 1.5 * set.pointSize * sizeScale * (sizes ? sizes[i] : 1)));
      const cr = colors ? Math.round(colors[i * 3] * 255) : 150;
      const cg = colors ? Math.round(colors[i * 3 + 1] * 255) : 150;
      const cb = colors ? Math.round(colors[i * 3 + 2] * 255) : 150;
      // Keep true depth for painter's-order sorting (dot size itself is depth-independent).
      pts.push({ x: p.x, y: p.y, r: rad, dist: cam.position.distanceTo(tmp), col: `rgb(${cr},${cg},${cb})` });
    }
    pts.sort((u, v) => v.dist - u.dist);
    for (const pt of pts) parts.push(`<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${pt.r.toFixed(2)}" fill="${pt.col}"/>`);
    return parts.join('');
  }
  function exportSvg(opts: ExportOptions): string {
    const { width, height } = opts;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${sceneSvgInner(width, height, opts.background)}\n</svg>`;
  }

  // --- scientific axes overlay --------------------------------------------
  // Gray axis lines + numbered decade ticks drawn in screen space over the WebGL
  // view each frame, so ticks track pan / zoom / rotate. Flat panels (dims 2 /
  // dot plot) get L-shaped edge axes with labels along the outside; 3D panels get
  // x / y / z letters + numbers projected onto the in-scene bounding-box axes.
  const AXIS_LINE = '#707070';
  const AXIS_TEXT = '#9a9a9a';
  // Reference-grid lines: faint, with the 0 line a touch stronger (like Desmos).
  const GRID_LINE = 'rgba(130,130,130,0.14)';
  const GRID_AXIS = 'rgba(140,140,140,0.32)';
  const axProj = new THREE.Vector3();
  const axRay = new THREE.Raycaster();
  const axPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const axHit = new THREE.Vector3();

  function frameFor(axis: number): AxisFrame {
    return map.frames?.[axis] ?? { label: map.axes[axis] ?? ['x', 'y', 'z'][axis] ?? '', scale: 1, offset: 0 };
  }
  // World point → pixel position within a viewport of size (vw, vh).
  function worldToScreen(x: number, y: number, z: number, vw: number, vh: number): { x: number; y: number; z: number } {
    axProj.set(x, y, z).project(activeCam());
    return { x: (axProj.x * 0.5 + 0.5) * vw, y: (1 - (axProj.y * 0.5 + 0.5)) * vh, z: axProj.z };
  }
  // Screen pixel → world point on the data plane z=0 (to read the visible range).
  function screenToPlane(sx: number, sy: number, vw: number, vh: number): THREE.Vector3 | null {
    const ndcX = (sx / Math.max(1, vw)) * 2 - 1;
    const ndcY = -(sy / Math.max(1, vh)) * 2 + 1;
    axRay.setFromCamera(new THREE.Vector2(ndcX, ndcY), activeCam());
    return axRay.ray.intersectPlane(axPlane, axHit) ? axHit.clone() : null;
  }
  // The 3D grid / tick decade step, chosen from on-screen density (≈ one line per
  // ~70 px) so it subdivides as you zoom. Derived from the camera distance + FOV
  // (the ortho frustum is built from the same distance), NOT a ground-plane raycast
  // — so it stays stable at grazing angles, where corner rays shoot off to the
  // horizon. The grid is then bounded to the data box (see paintGrid3D), so it never
  // extends past the dataset's min/max coordinates.
  function viewStep(H: number): number | null {
    const dist = centerDist();
    if (!(dist > 0) || !Number.isFinite(dist)) return null;
    const worldPerPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, H);
    const desired = 70 * worldPerPx;
    if (!(desired > 0) || !Number.isFinite(desired)) return null;
    return Math.pow(10, Math.round(Math.log10(desired)));
  }
  function ticksInRange(lo: number, hi: number, step: number): number[] {
    if (hi < lo) [lo, hi] = [hi, lo];
    const out: number[] = [];
    for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9 && out.length < 500; k++) out.push(k * step);
    return out;
  }
  // {step, ticks} over [lo,hi]: the view-density step when it's finite, else the
  // range's own decade step (fallback for a degenerate camera).
  function axisTicks(lo: number, hi: number, step: number | null): { step: number; ticks: number[] } {
    return step ? { step, ticks: ticksInRange(lo, hi, step) } : decadeTicks(lo, hi);
  }
  // Power-of-ten tick values spanning [lo, hi], plus the step chosen (one decade
  // finer when a whole decade would give too few ticks).
  function decadeTicks(lo: number, hi: number): { step: number; ticks: number[] } {
    if (hi < lo) [lo, hi] = [hi, lo];
    const range = hi - lo;
    if (!(range > 0) || !Number.isFinite(range)) return { step: 1, ticks: [] };
    let step = Math.pow(10, Math.floor(Math.log10(range)));
    if (range / step < 3) step /= 10;
    const ticks: number[] = [];
    for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9 && ticks.length < 400; k++) {
      ticks.push(k * step);
    }
    return { step, ticks };
  }
  function tickLabel(step: number): (v: number) => string {
    const decimals = step < 1 ? Math.min(8, Math.round(-Math.log10(step))) : 0;
    return (v) => (Math.abs(v) >= 1e6 ? v.toExponential(0) : v.toFixed(decimals));
  }

  // Paint the axis overlay onto any Pen (live canvas, PNG-export canvas, or SVG),
  // for a viewport rendered at size (W, H).
  function paintAxes(pen: Pen, W: number, H: number): void {
    if (!store.getState().settings.showAxes || W < 60 || H < 40) return;
    if (dims === 3) paintAxes3D(pen, W, H);
    else paintAxes2D(pen, W, H);
  }

  // The reference grid, drawn on the overlay at the SAME power-of-ten values as the
  // axis ticks — so lines always meet the numbers and get finer/coarser as you
  // zoom, with no fixed spacing to set. Flat maps AND 1-D dot plots get a full-
  // viewport graph-paper grid; 3D maps get an adaptive ground-plane grid.
  const isZeroTick = (v: number, step: number) => Math.abs(v) < step * 1e-6;
  function paintGrid(pen: Pen, W: number, H: number): void {
    if (!store.getState().settings.showGrid || W < 60 || H < 40) return;
    if (dims === 3) paintGrid3D(pen, W, H);
    else paintGrid2D(pen, W, H);
  }
  function paintGrid2D(pen: Pen, W: number, H: number): void {
    const corners = [screenToPlane(0, 0, W, H), screenToPlane(W, 0, W, H), screenToPlane(0, H, W, H), screenToPlane(W, H, W, H)];
    if (corners.some((c) => !c)) return;
    const xs = corners.map((c) => c!.x);
    const ys = corners.map((c) => c!.y);
    const wl = Math.min(...xs);
    const wr = Math.max(...xs);
    const wb = Math.min(...ys);
    const wt = Math.max(...ys);
    const midX = (wl + wr) / 2;
    const midY = (wb + wt) / 2;
    const fx = frameFor(0);
    const fy = frameFor(1);
    // Clip the grid to the plot rectangle bounded by the L-axes (same margins as
    // paintAxes2D) so lines don't spill into the tick-label gutters / past the axes.
    // With axes hidden there's no box to clip to, so fill the viewport.
    const axes = store.getState().settings.showAxes;
    const x0 = axes ? 46 : 0;
    const x1 = axes ? W - 8 : W;
    const y0 = axes ? 30 : 0;
    const y1 = axes ? H - 26 : H;
    const xt = decadeTicks(wl * fx.scale + fx.offset, wr * fx.scale + fx.offset);
    for (const d of xt.ticks) {
      const sx = worldToScreen((d - fx.offset) / fx.scale, midY, 0, W, H).x;
      if (sx < x0 || sx > x1) continue;
      pen.color(isZeroTick(d, xt.step) ? GRID_AXIS : GRID_LINE);
      pen.line(sx, y0, sx, y1);
    }
    const yt = decadeTicks(wb * fy.scale + fy.offset, wt * fy.scale + fy.offset);
    for (const d of yt.ticks) {
      const sy = worldToScreen(midX, (d - fy.offset) / fy.scale, 0, W, H).y;
      if (sy < y0 || sy > y1) continue;
      pen.color(isZeroTick(d, yt.step) ? GRID_AXIS : GRID_LINE);
      pen.line(x0, sy, x1, sy);
    }
  }
  function paintGrid3D(pen: Pen, W: number, H: number): void {
    // Grid on the data floor, bounded to the dataset's x/y extent, at the
    // view-density step — so it subdivides on zoom but never runs off to the
    // horizon (which is what shifted / dropped lines at grazing angles).
    const [mnx, mny, mnz] = bounds.min;
    const [mxx, mxy] = bounds.max;
    const step = viewStep(H);
    const xt = axisTicks(mnx, mxx, step);
    for (const x of xt.ticks) {
      const a = worldToScreen(x, mny, mnz, W, H);
      const b = worldToScreen(x, mxy, mnz, W, H);
      if (a.z > 1 || b.z > 1) continue;
      pen.color(isZeroTick(x, xt.step) ? GRID_AXIS : GRID_LINE);
      pen.line(a.x, a.y, b.x, b.y);
    }
    const yt = axisTicks(mny, mxy, step);
    for (const y of yt.ticks) {
      const a = worldToScreen(mnx, y, mnz, W, H);
      const b = worldToScreen(mxx, y, mnz, W, H);
      if (a.z > 1 || b.z > 1) continue;
      pen.color(isZeroTick(y, yt.step) ? GRID_AXIS : GRID_LINE);
      pen.line(a.x, a.y, b.x, b.y);
    }
  }

  // Name labels above points. `labeledPoints` is the persistent per-point set;
  // `labelAll` adds every VISIBLE point. Both are DE-OVERLAPPED into a screen grid:
  // at most one label per cell, and the NEAREST point (smallest NDC depth) wins the
  // cell — so a label never shows through a point in front of it (z-occlusion), a
  // dense pile collapses to the single top label, and a lone far-off point keeps its
  // own cell. When more cells are occupied than LABEL_CAP, the grid is COARSENED
  // (uniformly larger cells) until ~cap labels remain, so the survivors spread evenly
  // across the whole view instead of clustering at the front. Projected each frame so
  // they track the animation; shared by the live overlay + PNG/SVG export.
  const LABEL_CAP = 100; // max labels drawn at once
  const CX0 = 46; // minimum readable label cell (px) for de-overlap
  const CY0 = 13;
  type ScreenLabel = { x: number; y: number; z: number; text: string };
  function labeledScreenPoints(W: number, H: number): ScreenLabel[] {
    const st = store.getState();
    const labeled = st.labeledPoints;
    const labelAll = st.settings.labelAll;
    // Labels show in every view (2D/3D maps AND 1-D dot-plots); only traces are map-only.
    if (!labelAll && labeled.size === 0) return [];
    const vis = st.visible;
    // Collapse labels onto a screen grid of cell size (cx, cy); the nearest (frontmost)
    // point wins each cell. Larger cells → fewer, more widely-separated labels.
    const bucket = (items: Iterable<ScreenLabel>, cx: number, cy: number): ScreenLabel[] => {
      const cells = new Map<string, ScreenLabel>();
      for (const p of items) {
        const key = `${Math.round(p.x / cx)}:${Math.round(p.y / cy)}`;
        const cur = cells.get(key);
        if (!cur || p.z < cur.z) cells.set(key, p);
      }
      return [...cells.values()];
    };
    // Fine pass: project every candidate once, collapsed to one per readable cell.
    const fine = new Map<string, ScreenLabel>();
    const consider = (i: number): void => {
      if (!Number.isFinite(positions[i * 3])) return; // hidden this frame
      const s = worldToScreen(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], W, H);
      if (s.z > 1 || s.x < -8 || s.x > W + 8 || s.y < 0 || s.y > H) return; // off-screen / behind camera
      const key = `${Math.round(s.x / CX0)}:${Math.round(s.y / CY0)}`;
      const cur = fine.get(key);
      if (!cur || s.z < cur.z) fine.set(key, { x: s.x, y: s.y - 6, z: s.z, text: dataset.points[i].id });
    };
    // Explicit per-point labels always compete; labelAll adds every visible point.
    for (const i of labeled) consider(i);
    if (labelAll) {
      for (let i = 0; i < n; i++) {
        if (labeled.has(i) || (vis && vis[i] === 0)) continue;
        consider(i);
      }
    }
    let out = [...fine.values()];
    if (out.length <= LABEL_CAP) return out;
    // Over budget: grow the grid toward ~cap occupied cells so the kept labels spread
    // across the view. Damped (≤1.5×/pass) so a clustered set doesn't overshoot far
    // under the cap in one step; the final z-slice trims any residual on an even view.
    let cx = CX0;
    let cy = CY0;
    for (let pass = 0; pass < 10 && out.length > LABEL_CAP; pass++) {
      const f = Math.min(1.5, Math.sqrt(out.length / LABEL_CAP));
      cx *= f;
      cy *= f;
      out = bucket(out, cx, cy);
    }
    if (out.length > LABEL_CAP) {
      out.sort((a, b) => a.z - b.z);
      out.length = LABEL_CAP;
    }
    return out;
  }
  // Live overlay: grey text with a dark outline so labels stay legible over the scene.
  function drawLabels(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    const pts = labeledScreenPoints(W, H);
    if (!pts.length) return;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (const p of pts) {
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle = '#c6c6c6';
      ctx.fillText(p.text, p.x, p.y);
    }
  }
  // Export: same labels via the Pen (grey fill) so PNG/SVG include them.
  function paintLabels(pen: Pen, W: number, H: number): void {
    const pts = labeledScreenPoints(W, H);
    if (!pts.length) return;
    pen.font(10);
    pen.color('#c6c6c6');
    for (const p of pts) pen.text(p.text, p.x, p.y, 'center', 'bottom');
  }

  // --- orientation gizmo (3-D viewports only) -------------------------------
  // A Blender-style axis cross in the top-right corner: six balls — +x/+y/+z solid
  // and lettered, −x/−y/−z hollow — each snapping the camera to look down that axis
  // (clicking the axis you're on flips to its other side). It's painted on the axis
  // overlay (live canvas only, never in exports) and hit-tested from a capture-phase
  // listener on the container, so a click on it never reaches picking / orbit.
  const GIZMO_PAD = 12; // gap from the top-right corner
  const GIZMO_R = 30; // arm length, CSS px
  const BALL_R = 7;
  const AXIS_COLORS = ['#e8615a', '#7fc24a', '#4c9ef0']; // x, y, z
  interface GizmoBall {
    axis: 0 | 1 | 2;
    sign: 1 | -1;
    x: number;
    y: number;
    depth: number; // camera-space z: larger = nearer the viewer
  }
  const gizmoOrigin = (W: number) => ({ cx: W - GIZMO_PAD - GIZMO_R, cy: GIZMO_PAD + GIZMO_R });
  function gizmoBalls(W: number): GizmoBall[] {
    const { cx, cy } = gizmoOrigin(W);
    const inv = camera.quaternion.clone().invert(); // world direction → camera space
    const out: GizmoBall[] = [];
    for (const axis of [0, 1, 2] as const) {
      for (const sign of [1, -1] as const) {
        const v = new THREE.Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0).applyQuaternion(inv);
        out.push({ axis, sign, x: cx + v.x * (GIZMO_R - BALL_R), y: cy - v.y * (GIZMO_R - BALL_R), depth: v.z });
      }
    }
    return out;
  }
  function drawGizmo(pen: Pen, W: number): void {
    if (dims !== 3 || W < 160) return;
    const { cx, cy } = gizmoOrigin(W);
    for (const b of gizmoBalls(W).sort((p, q) => p.depth - q.depth)) {
      // Far balls first, so the near ones overlap them (the depth cue).
      pen.color(AXIS_COLORS[b.axis]);
      if (b.sign === 1) {
        pen.line(cx, cy, b.x, b.y);
        pen.circle(b.x, b.y, BALL_R, true);
        pen.font(9, true);
        pen.color('#101010');
        pen.text(['x', 'y', 'z'][b.axis], b.x, b.y, 'center', 'middle');
      } else {
        // A dark disc under the ring, so a negative ball facing you HIDES the positive
        // ball straight behind it — otherwise looking down −x still reads as +x.
        pen.color('#161616');
        pen.circle(b.x, b.y, BALL_R, true);
        pen.color(AXIS_COLORS[b.axis]);
        pen.circle(b.x, b.y, BALL_R - 1, false);
      }
    }
  }
  function onGizmoPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || dims !== 3) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const W = rect.width;
    if (W < 160) return;
    let hit: GizmoBall | null = null;
    for (const b of gizmoBalls(W)) {
      if (Math.hypot(x - b.x, y - b.y) <= BALL_R + 2 && (!hit || b.depth > hit.depth)) hit = b;
    }
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    doSnapAxis(hit.axis, hit.sign);
  }
  container.addEventListener('pointerdown', onGizmoPointerDown, true);

  function drawAxes(): void {
    const ctx = axisCtx;
    if (!ctx) return;
    const W = container.clientWidth;
    const H = container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (axisCanvas.width !== Math.round(W * dpr) || axisCanvas.height !== Math.round(H * dpr)) {
      axisCanvas.width = Math.round(W * dpr);
      axisCanvas.height = Math.round(H * dpr);
      axisCanvas.style.width = `${W}px`;
      axisCanvas.style.height = `${H}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pen = new CanvasPen(ctx);
    paintGrid(pen, W, H); // grid first, so axis lines / ticks sit on top
    paintAxes(pen, W, H);
    drawGizmo(pen, W);
    drawLabels(ctx, W, H);
  }

  function paintAxes2D(pen: Pen, W: number, H: number): void {
    const leftX = 46;
    const bottomY = H - 26;
    const padR = 8;
    // The panel's map dropdown + buttons sit at the top-left; keep the y-axis (line,
    // ticks, title) below them so the numbers are never hidden behind the controls.
    const clearTop = 30;
    const corners = [screenToPlane(0, 0, W, H), screenToPlane(W, 0, W, H), screenToPlane(0, H, W, H), screenToPlane(W, H, W, H)];
    if (corners.some((c) => !c)) return;
    const xs = corners.map((c) => c!.x);
    const ys = corners.map((c) => c!.y);
    const wl = Math.min(...xs);
    const wr = Math.max(...xs);
    const wb = Math.min(...ys);
    const wt = Math.max(...ys);
    const midX = (wl + wr) / 2;
    const midY = (wb + wt) / 2;
    const fx = frameFor(0);
    const fy = frameFor(1);

    pen.font(10);
    pen.color(AXIS_LINE);
    pen.line(leftX, clearTop, leftX, bottomY);
    pen.line(leftX, bottomY, W - padR, bottomY);

    // x ticks along the bottom
    const xt = decadeTicks(wl * fx.scale + fx.offset, wr * fx.scale + fx.offset);
    const fmtX = tickLabel(xt.step);
    let lastX = -1e9;
    for (const d of xt.ticks) {
      const sx = worldToScreen((d - fx.offset) / fx.scale, midY, 0, W, H).x;
      if (sx < leftX || sx > W - padR) continue;
      pen.color(AXIS_LINE);
      pen.line(sx, bottomY, sx, bottomY + 4);
      if (sx - lastX > 36) {
        pen.color(AXIS_TEXT);
        pen.text(fmtX(d), sx, bottomY + 6, 'center', 'top');
        lastX = sx;
      }
    }

    // y ticks up the left
    const yt = decadeTicks(wb * fy.scale + fy.offset, wt * fy.scale + fy.offset);
    const fmtY = tickLabel(yt.step);
    let lastY = 1e9;
    for (const d of yt.ticks) {
      const sy = worldToScreen(midX, (d - fy.offset) / fy.scale, 0, W, H).y;
      if (sy < clearTop || sy > bottomY) continue;
      pen.color(AXIS_LINE);
      pen.line(leftX - 4, sy, leftX, sy);
      if (lastY - sy > 15) {
        pen.color(AXIS_TEXT);
        pen.text(fmtY(d), leftX - 6, sy, 'right', 'middle');
        lastY = sy;
      }
    }

    // axis titles
    pen.color(AXIS_TEXT);
    pen.text(fx.unit ? `${fx.label} (${fx.unit})` : fx.label, W - padR, H - 2, 'right', 'bottom');
    pen.textRotated(fy.unit ? `${fy.label} (${fy.unit})` : fy.label, 11, (clearTop + bottomY) / 2, -Math.PI / 2, 'center', 'top');
  }

  function paintAxes3D(pen: Pen, W: number, H: number): void {
    const [mnx, mny, mnz] = bounds.min;
    const [mxx, mxy, mxz] = bounds.max;
    // Numbers ride the data-box edges (fixed world positions → stable at any angle),
    // at the same view-density step as the grid, so they subdivide together on zoom.
    const step = viewStep(H);
    pen.font(10);
    pen.color(AXIS_TEXT);
    const drawTicks = (
      values: number[],
      s0: number,
      at: (v: number) => { x: number; y: number; z: number },
      minGap: number,
    ) => {
      const fmt = tickLabel(s0);
      let last: { x: number; y: number } | null = null;
      for (const t of values) {
        const s = at(t);
        if (s.z > 1 || s.x < 2 || s.x > W - 2 || s.y < 2 || s.y > H - 2) continue;
        if (last && Math.hypot(s.x - last.x, s.y - last.y) < minGap) continue;
        pen.text(fmt(t), s.x, s.y, 'center', 'middle');
        last = { x: s.x, y: s.y };
      }
    };
    const xt = axisTicks(mnx, mxx, step);
    drawTicks(xt.ticks, xt.step, (x) => worldToScreen(x, mny, mnz, W, H), 26);
    const yt = axisTicks(mny, mxy, step);
    drawTicks(yt.ticks, yt.step, (y) => worldToScreen(mnx, y, mnz, W, H), 26);
    const zt = axisTicks(mnz, mxz, step);
    drawTicks(zt.ticks, zt.step, (z) => worldToScreen(mnx, mny, z, W, H), 24);

    // x / y / z letters at the far ends of the data box (orientation cue).
    const ends: [number, number, number][] = [
      [mxx, mny, mnz],
      [mnx, mxy, mnz],
      [mnx, mny, mxz],
    ];
    const letters = ['x', 'y', 'z'];
    pen.font(12, true);
    for (let a = 0; a < 3; a++) {
      const s = worldToScreen(ends[a][0], ends[a][1], ends[a][2], W, H);
      if (s.z > 1) continue;
      pen.text(letters[a], s.x, s.y, 'center', 'middle');
    }
  }

  // --- resize + render loop ------------------------------------------------
  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    material.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  // Clip planes follow the camera, so there's no zoom limit: fixed planes (sized to
  // the data) used to cut the points away when zooming far in or out. The near plane
  // stays proportional to the distance (depth precision at any scale); the far plane
  // always reaches past the far side of the whole cloud, wherever the camera is, so
  // no point is ever clipped away behind what you're looking at. `force` re-applies
  // them immediately after a zoom step.
  let lastNear = -1;
  let lastFar = -1;
  function updateClipPlanes(force = false): void {
    const d = centerDist();
    if (!(d > 0) || !Number.isFinite(d)) return;
    const near = d * 0.01;
    const far = Math.max(d, camera.position.distanceTo(fullCenter)) + 2 * bounds.radius;
    if (!Number.isFinite(far)) return;
    if (!force && Math.abs(near - lastNear) <= lastNear * 0.01 && Math.abs(far - lastFar) <= lastFar * 0.01) return;
    lastNear = near;
    lastFar = far;
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }

  let raf = 0;
  const tick = () => {
    stepTween();
    controls.update();
    updateClipPlanes();
    if (ortho) {
      syncOrtho();
      material.uniforms.uOrthoDist.value = centerDist();
    }
    decayBlips();
    // A 2-D plot clips its points to the box inside the L-axes (the same rectangle as
    // paintAxes2D / paintGrid2D), so dots never spill over the axis lines or ticks.
    const W = container.clientWidth;
    const H = container.clientHeight;
    const clip2D = dims === 2 && store.getState().settings.showAxes && W >= 60 && H >= 40;
    if (clip2D) {
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.setScissor(46, 26, W - 46 - 8, H - 26 - 30); // (x, y-from-bottom, w, h) in CSS px
      renderer.setScissorTest(true);
    }
    renderer.render(scene, activeCam());
    if (clip2D) renderer.setScissorTest(false);
    drawAxes();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  // --- teardown ------------------------------------------------------------
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    disposeLasso();
    controls.removeEventListener('end', emitCameraMoved);
    clearOutline();
    for (const u of unsubs) u();
    renderer.domElement.removeEventListener('wheel', onWheel);
    renderer.domElement.removeEventListener('pointerdown', onRotateDown);
    window.removeEventListener('pointermove', onRotateMove);
    window.removeEventListener('pointerup', onRotateUp);
    container.removeEventListener('pointerdown', onGizmoPointerDown, true);
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    renderer.domElement.removeEventListener('pointermove', onPointerMove);
    renderer.domElement.removeEventListener('dblclick', onDblClick);
    renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
    viewports.unregister(viewportId);
    if (isMain) {
      viewerControls.resetView = undefined;
      viewerControls.frameSelection = undefined;
      viewerControls.snapToPlane = undefined;
      viewerControls.fit = undefined;
      viewerControls.exportImage = undefined;
      viewerControls.getCamera = undefined;
      viewerControls.setCamera = undefined;
    }
    clearOutline();
    for (const b of imgBorders) {
      scene.remove(b);
      b.geometry.dispose();
      (b.material as THREE.Material).dispose();
    }
    scene.remove(imageGroup);
    for (const im of imgMeshes) {
      im.tex.dispose();
      im.mat.dispose();
    }
    for (const g of imgGeoms) g.dispose();
    controls.dispose();
    geom.dispose();
    material.dispose();
    overlayMat.dispose();
    ghostMat.dispose();
    if (traces) {
      scene.remove(traces);
      traces.geometry.dispose();
      (traces.material as THREE.Material).dispose();
    }
    if (axes3d) {
      axes3d.geometry.dispose();
      (axes3d.material as THREE.Material).dispose();
    }
    renderer.dispose();
    if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement);
    if (axisCanvas.parentElement === container) container.removeChild(axisCanvas);
  };
}
