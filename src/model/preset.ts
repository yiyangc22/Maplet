// A saved visualization comes in two forms:
//
//   • "maplet-view"   — a reproducible description of what the user is looking at
//                       (which dataset by RELOAD PATH, the whole ViewState, the
//                       panel layout, and the camera). Small, but it only works
//                       while the original data file is still reachable.
//   • "maplet-bundle" — the same, but with the ENTIRE dataset embedded (the points
//                       table + manifest), so it reopens anywhere, even after the
//                       original CSV/TSV is moved or deleted. Larger, standalone.
//
// Both are written as `.maplet.json`; `kind` tells them apart on load.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { PanelTarget, ViewState } from './viewstate';

export interface SavedCamera {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov?: number; // vertical field of view, degrees — narrower = magnified (3-D deep zoom); absent = default
}

// Which target each viewport was showing, so "the same view" restores the same
// panels. `mainTarget` is the current form (a full PanelTarget — a coordinate map or
// a custom X/Y/Z axis assignment); `mainMap` is the pre-axes form, still read on load
// for backward compatibility. Written with `mainTarget`.
export interface SavedLayout {
  mainTarget?: PanelTarget;
  mainMap?: number; // legacy (pre per-axis panels)
  panels: PanelTarget[];
}

export interface SavedView {
  kind: 'maplet-view';
  version: 1;
  savedAt: string; // ISO timestamp
  source: string; // reload path/id of the dataset (Electron folder/file path)
  sourceName?: string; // display name (e.g. "points.tsv")
  points?: number; // point count when saved (a sanity hint on restore)
  view: ViewState;
  layout?: SavedLayout; // which map/dot-plot each panel showed
  camera?: SavedCamera | null;
}

// The embedded dataset in a standalone bundle — exactly the bytes the loader needs
// to rebuild it, so no original file is required.
export interface SavedData {
  pointsTable?: string | null; // flat CSV/TSV table (the usual form)
  pointsJsonl?: string | null; // bundle form: newline-delimited point JSON
  manifestJson: string; // dataset meta + image overlays ("{}" when table-only)
}

export interface SavedBundle {
  kind: 'maplet-bundle';
  version: 1;
  savedAt: string;
  sourceName?: string;
  points?: number;
  data: SavedData;
  view: ViewState;
  layout?: SavedLayout;
  camera?: SavedCamera | null;
}

export type SavedFile = SavedView | SavedBundle;

export const PRESET_EXT = '.maplet.json';

export function isSavedView(v: unknown): v is SavedView {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.kind === 'maplet-view' && typeof o.source === 'string' && !!o.view && typeof o.view === 'object';
}

export function isSavedBundle(v: unknown): v is SavedBundle {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.kind === 'maplet-bundle' && !!o.data && typeof o.data === 'object' && !!o.view && typeof o.view === 'object';
}

/** Parse a saved-visualization file (either form); throws a friendly error otherwise. */
export function parseSavedFile(text: string): SavedFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  if (isSavedBundle(parsed)) return parsed as SavedBundle;
  if (isSavedView(parsed)) return parsed as SavedView;
  throw new Error('Not a Maplet visualization file (missing kind/view).');
}

/** Back-compat alias: parse and require the view-only form. */
export function parsePreset(text: string): SavedView {
  const f = parseSavedFile(text);
  if (f.kind !== 'maplet-view') throw new Error('Expected a view preset, got a standalone bundle.');
  return f;
}

/** A short, filesystem-safe default filename for a saved visualization. */
export function presetFilename(sourceName: string | undefined, stamp: string, bundle = false): string {
  const base = (sourceName ?? 'maplet').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'maplet';
  return `${base}${bundle ? '_standalone' : ''}_${stamp}${PRESET_EXT}`;
}

function baseFilename(sourceName: string | undefined): string {
  return (sourceName ?? 'maplet').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'maplet';
}

// --- the two user-facing file formats ---------------------------------------
// A "perspective" (view + filters + layout + camera, no data) is written as
// human-readable YAML (.yml); a standalone "bundle" (everything, data embedded)
// is JSON (.json). Different extensions make the purpose obvious at a glance.

export const PERSPECTIVE_EXT = '.yml';
export const BUNDLE_EXT = '.json';

export function perspectiveFilename(sourceName: string | undefined, stamp: string): string {
  return `${baseFilename(sourceName)}_${stamp}${PERSPECTIVE_EXT}`;
}
export function bundleFilename(sourceName: string | undefined, stamp: string): string {
  return `${baseFilename(sourceName)}_${stamp}${BUNDLE_EXT}`;
}

/** Serialize a perspective to YAML text. */
export function stringifyPerspective(v: SavedView): string {
  return stringifyYaml(v, { lineWidth: 0 }); // no line wrapping — keep arrays/values intact
}

/** Parse a perspective YAML file; throws a friendly error if it isn't one. */
export function parsePerspective(text: string): SavedView {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    throw new Error(`Not valid YAML: ${(e as Error).message}`);
  }
  if (!isSavedView(parsed)) throw new Error('Not a Maplet perspective (.yml) — missing kind/view.');
  return parsed as SavedView;
}

/** Serialize a standalone bundle to JSON text. */
export function stringifyBundle(b: SavedBundle): string {
  return JSON.stringify(b);
}

/** Parse a standalone bundle JSON file; throws a friendly error otherwise. */
export function parseBundle(text: string): SavedBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!isSavedBundle(parsed)) throw new Error('Not a Maplet bundle (.json) — missing kind/data/view.');
  return parsed as SavedBundle;
}
