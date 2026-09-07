// Shared point-cloud shader for the 3D viewer and the UMAP viewer. Per-point
// color / visibility / selection / hover; selected points get an amber ring,
// hovered points a larger white ring. A NaN-position guard hides points that lack
// a coordinate (e.g. points with no UMAP embedding).

import * as THREE from 'three';

export const POINT_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aVisible;
  attribute float aSelected;
  attribute float aHover;
  attribute float aSize;    // per-point size multiplier (1.0 = uniform; "size by" a variable)
  attribute float aBlip;    // 0..1 radar ping when the point's position just updated (fades to 0)
  uniform float uSizePx;
  uniform float uPixelRatio;
  uniform float uFocal;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uOpacity;
  uniform float uGhostOpacity;
  uniform float uOrtho;      // 1.0 = orthographic (parallel) projection
  uniform float uOrthoDist;  // camera->target distance, used for ortho point sizing
  uniform float uOverlayOnly; // 1.0 = draw ONLY selected/hovered points (the on-top pass)
  uniform float uGhostPass;   // 1.0 = draw ONLY filtered-out "ghost" points (depthWrite-off pass)
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSelected;
  varying float vHover;
  varying float vBlip;
  void main() {
    vColor = aColor;
    vSelected = aSelected;
    vHover = aHover;
    vBlip = aBlip;
    if (!(position.x == position.x)) { // NaN guard: no coordinate -> offscreen
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    bool selHover = (aSelected > 0.5 || aHover > 0.5);
    bool ghost = (aVisible < 0.5) && !selHover; // filtered-out and not highlighted
    // Each pass draws a different subset of the SAME geometry: the overlay pass draws
    // only selected/hovered points; the ghost pass draws only ghosts (its own draw has
    // depthWrite OFF so ghosts never occlude the real cloud); the main pass draws
    // everything EXCEPT ghosts (it writes depth for correct occlusion).
    bool cull = (uOverlayOnly > 0.5) ? !selHover : (uGhostPass > 0.5) ? !ghost : ghost;
    if (cull) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float alpha = aVisible > 0.5 ? uOpacity : uGhostOpacity;
    if (selHover) alpha = 1.0;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Perspective: size falls off with each point's own depth. Orthographic: use
    // the single camera->target distance so on-screen size is constant across
    // depth (grows only when zooming) — the true, undistorted flattened look.
    float dist = (uOrtho > 0.5) ? uOrthoDist : max(0.0001, -mv.z);
    float size = uSizePx * uPixelRatio * (uFocal / dist) * aSize;
    if (aSelected > 0.5) size *= 1.9;
    if (aHover > 0.5) size *= 2.3;
    size *= 1.0 + aBlip * 1.7; // a fresh update briefly enlarges the point (radar ping)
    gl_PointSize = clamp(size, uMinPx, uMaxPx);
    gl_Position = projectionMatrix * mv;
  }
`;

export const POINT_FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vSelected;
  varying float vHover;
  varying float vBlip;
  const vec3 AMBER = vec3(1.0, 0.69, 0.0);
  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float r = length(uv);
    if (r > 0.5) discard;
    if (vAlpha < 0.003) discard; // only drop truly-zero alpha (ghost mode off); keep low ghost opacities
    float edge = smoothstep(0.5, 0.42, r);
    vec3 color = vColor;
    float alpha = vAlpha * edge;
    if (vSelected > 0.5) {
      // selected points get a WHITE boundary (distinct from data / UMAP colors)
      float ring = smoothstep(0.30, 0.38, r) * (1.0 - smoothstep(0.44, 0.5, r));
      color = mix(color, vec3(1.0), ring);
      alpha = max(alpha, ring);
    }
    if (vHover > 0.5) {
      // hovered point gets an amber ring (transient, single point)
      float ring = smoothstep(0.34, 0.42, r) * (1.0 - smoothstep(0.47, 0.5, r));
      color = mix(color, AMBER, ring);
      alpha = max(alpha, ring);
    }
    if (vBlip > 0.002) {
      // radar ping: a bright ring that expands outward and fades as vBlip -> 0
      float rr = (1.0 - vBlip) * 0.46;
      float ring = smoothstep(0.07, 0.0, abs(r - rr)) * vBlip;
      color = mix(color, vec3(1.0), ring);
      alpha = max(alpha, ring);
    }
    gl_FragColor = vec4(color, alpha);
  }
`;

export interface PointMaterialOpts {
  sizePx: number;
  pixelRatio: number;
  focal: number;
  opacity: number;
  ghostOpacity: number;
  minPx?: number;
  maxPx?: number;
}

export function makePointMaterial(o: PointMaterialOpts): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSizePx: { value: o.sizePx },
      uPixelRatio: { value: o.pixelRatio },
      uFocal: { value: o.focal },
      uMinPx: { value: o.minPx ?? 1.0 },
      uMaxPx: { value: o.maxPx ?? 64.0 },
      uOpacity: { value: o.opacity },
      uGhostOpacity: { value: o.ghostOpacity },
      uOrtho: { value: 0.0 },
      uOrthoDist: { value: o.focal },
      uOverlayOnly: { value: 0.0 },
      uGhostPass: { value: 0.0 },
    },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    // depthWrite ON so nearer points occlude farther ones through the depth buffer,
    // instead of occlusion being decided by draw (buffer) order — which made distant
    // points paint over near ones. Kept `transparent` so the round anti-aliased edge
    // and ghost/opacity blending still work; the opaque core writes depth.
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NormalBlending,
  });
}

// Attach empty aColor/aVisible/aSelected/aHover/aSize attributes to a geometry.
export function attachPointAttributes(
  geom: THREE.BufferGeometry,
  n: number,
  initColors?: Float32Array,
  initSizes?: Float32Array,
): {
  aColor: THREE.BufferAttribute;
  aVisible: THREE.BufferAttribute;
  aSelected: THREE.BufferAttribute;
  aHover: THREE.BufferAttribute;
  aSize: THREE.BufferAttribute;
  aBlip: THREE.BufferAttribute;
} {
  const aColor = new THREE.BufferAttribute(initColors ? new Float32Array(initColors) : new Float32Array(n * 3).fill(0.6), 3);
  const aVisible = new THREE.BufferAttribute(new Float32Array(n).fill(1), 1);
  const aSelected = new THREE.BufferAttribute(new Float32Array(n), 1);
  const aHover = new THREE.BufferAttribute(new Float32Array(n), 1);
  const aSize = new THREE.BufferAttribute(initSizes ? new Float32Array(initSizes) : new Float32Array(n).fill(1), 1);
  const aBlip = new THREE.BufferAttribute(new Float32Array(n), 1);
  geom.setAttribute('aColor', aColor);
  geom.setAttribute('aVisible', aVisible);
  geom.setAttribute('aSelected', aSelected);
  geom.setAttribute('aHover', aHover);
  geom.setAttribute('aSize', aSize);
  geom.setAttribute('aBlip', aBlip);
  return { aColor, aVisible, aSelected, aHover, aSize, aBlip };
}
