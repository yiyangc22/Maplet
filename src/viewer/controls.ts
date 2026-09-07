// Imperative handle to the Three viewer, populated by Viewer3D on mount and
// called by the store's action commands (camera + export). Kept in its own
// module so the store/commands don't import the heavy viewer (no cycle).

import type { SavedCamera } from '../model/preset';

export interface ExportOptions {
  format: 'png' | 'svg';
  width: number;
  height: number;
  background: 'dark' | 'white' | 'transparent';
}

export interface ViewerControls {
  snapToPlane?(plane: 'xy' | 'yz' | 'xz'): void;
  resetView?(): void;
  fit?(scope: 'all' | 'visible'): void;
  frameSelection?(): void;
  exportImage?(opts: ExportOptions): Promise<{ ok: boolean; error?: string; path?: string }>;
  // Camera pose, for saving/restoring an exact perspective in a preset.
  getCamera?(): SavedCamera | null;
  setCamera?(cam: SavedCamera): void;
  // Optional hook the app sets to be notified when the user finishes moving the
  // camera (so the session autosave can capture the latest perspective).
  onCameraMoved?: () => void;
}

export const viewerControls: ViewerControls = {};

// Per-viewport imperative controls. Every mounted map viewport (the main viewer
// AND each bottom panel) registers its own handle here under a viewport id, so a
// panel's right-click menu can reset / fit / snap / toggle orthographic for THAT
// panel alone. `viewerControls` above always tracks the main viewport (menu,
// console, export, session-camera autosave); this registry is what makes each
// panel independent.
export type ExportBackground = ExportOptions['background'];

export interface ViewportControls {
  resetView(): void;
  fit(scope: 'all' | 'visible'): void;
  snapToPlane(plane: 'xy' | 'yz' | 'xz'): void;
  frameSelection(): void;
  getOrtho(): boolean;
  setOrtho(on: boolean): void;
  is3D(): boolean; // a 2D map has no depth to snap through / no perspective to flatten
  // For the multi-panel "Export as": the panel's DOM box (for layout), and the
  // scene + axes rendered at an arbitrary size to compose into one image.
  container: HTMLElement;
  stillPng(width: number, height: number, bg: ExportBackground): string; // scene → PNG data URL
  sceneSvg(width: number, height: number, bg: ExportBackground): string; // scene → SVG inner markup (no <svg> wrapper)
  axesToCanvas(ctx: CanvasRenderingContext2D, width: number, height: number): void; // paint the axis overlay
  axesToSvg(width: number, height: number): string; // axis overlay → SVG markup
}

const viewportRegistry = new Map<string, ViewportControls>();

export const viewports = {
  register(id: string, c: ViewportControls): void {
    viewportRegistry.set(id, c);
  },
  unregister(id: string): void {
    viewportRegistry.delete(id);
  },
  get(id: string): ViewportControls | undefined {
    return viewportRegistry.get(id);
  },
};
