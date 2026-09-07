// Persistence surface for both environments. In Electron it goes through the
// IPC bridge (native save dialogs + fs in userData); in a plain browser it uses
// localStorage (session memory) and downloads (presets / export sidecars).
//
//   - session blob : the last-used view per dataset, so reopening an experiment
//                    restores where you left off (see src/app/session.ts).
//   - saveExport   : writes the figure AND a sidecar `.maplet.json` preset next
//                    to it, so the exact view can be reproduced later.
//   - save/loadPreset : explicit "Save preset" / "Load preset".

import { PRESET_EXT } from '../model/preset';

const SESSION_KEY = 'maplet.session.v1';

function api() {
  return typeof window !== 'undefined' ? window.maplet : undefined;
}

function triggerDownload(href: string, filename: string): void {
  const el = document.createElement('a');
  el.href = href;
  el.download = filename;
  document.body.appendChild(el);
  el.click();
  el.remove();
}

// ---- session blob ---------------------------------------------------------

export async function readSessionRaw(): Promise<string | null> {
  const a = api();
  if (a?.sessionGet) return a.sessionGet();
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export async function writeSessionRaw(json: string): Promise<void> {
  const a = api();
  if (a?.sessionSet) {
    await a.sessionSet(json);
    return;
  }
  try {
    localStorage.setItem(SESSION_KEY, json);
  } catch {
    /* private mode / quota — session restore is a convenience only */
  }
}

// ---- export (figure + sidecar preset) -------------------------------------

export interface ExportPayload {
  format: 'png' | 'svg';
  pngDataUrl?: string;
  svgText?: string;
  suggestedName: string; // e.g. "cells_2026-07-10.png"
  presetJson: string;
}

export interface SaveResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export async function saveExport(p: ExportPayload): Promise<SaveResult> {
  const a = api();
  if (a?.saveExport) {
    const dataBase64 = p.format === 'png' ? (p.pngDataUrl ?? '').replace(/^data:image\/png;base64,/, '') : undefined;
    return a.saveExport({
      format: p.format,
      dataBase64,
      text: p.svgText,
      suggestedName: p.suggestedName,
      presetJson: p.presetJson,
    });
  }
  // Browser: download the image, then the sidecar preset next to it.
  if (p.format === 'png' && p.pngDataUrl) {
    triggerDownload(p.pngDataUrl, p.suggestedName);
  } else if (p.format === 'svg' && p.svgText != null) {
    const url = URL.createObjectURL(new Blob([p.svgText], { type: 'image/svg+xml' }));
    triggerDownload(url, p.suggestedName);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  // A sidecar preset is only written when one is supplied (the multi-panel export
  // skips it — the image is the deliverable).
  if (p.presetJson) {
    const presetName = p.suggestedName.replace(/\.(png|svg)$/i, '') + PRESET_EXT;
    const purl = URL.createObjectURL(new Blob([p.presetJson], { type: 'application/json' }));
    triggerDownload(purl, presetName);
    setTimeout(() => URL.revokeObjectURL(purl), 4000);
  }
  return { ok: true };
}

// ---- explicit preset save / load ------------------------------------------

export async function savePreset(text: string, suggestedName: string, mime = 'application/json'): Promise<SaveResult> {
  const a = api();
  if (a?.savePreset) return a.savePreset({ json: text, suggestedName });
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  triggerDownload(url, suggestedName);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { ok: true };
}

export async function loadPresetFile(accept = '.json,.yml,.yaml,application/json'): Promise<{ text: string; path?: string } | null> {
  const a = api();
  if (a?.loadPreset) {
    const res = await a.loadPreset();
    if (!res || res.canceled || !res.text) return null;
    return { text: res.text, path: res.path };
  }
  // Browser: a plain file picker, resolving null on cancel (never hang).
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let done = false;
    const finish = (v: { text: string; path?: string } | null) => {
      if (done) return;
      done = true;
      window.removeEventListener('focus', onFocus);
      resolve(v);
    };
    input.onchange = async () => {
      const f = input.files?.[0];
      finish(f ? { text: await f.text(), path: f.name } : null);
    };
    input.oncancel = () => finish(null);
    const onFocus = () => setTimeout(() => finish(null), 350);
    window.addEventListener('focus', onFocus);
    input.click();
  });
}
