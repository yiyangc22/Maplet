// Safe IPC bridge: exposes a small explicit API as window.maplet. The renderer
// gets no direct filesystem or Node access.

import { contextBridge, ipcRenderer } from 'electron';

const api = {
  platform: 'electron' as const,
  open: () => ipcRenderer.invoke('maplet:open'),
  browseSample: () => ipcRenderer.invoke('maplet:browseSample'),
  openFolder: () => ipcRenderer.invoke('maplet:openFolder'),
  openImages: () => ipcRenderer.invoke('maplet:openImages'),
  loadPath: (path: string) => ipcRenderer.invoke('maplet:loadPath', path),
  loadSample: (name: string) => ipcRenderer.invoke('maplet:loadSample', name),
  recent: () => ipcRenderer.invoke('maplet:recent'),
  clearRecent: () => ipcRenderer.invoke('maplet:clearRecent'),
  sessionGet: () => ipcRenderer.invoke('session:get'),
  sessionSet: (json: string) => ipcRenderer.invoke('session:set', json),
  saveExport: (p: unknown) => ipcRenderer.invoke('export:save', p),
  savePreset: (p: unknown) => ipcRenderer.invoke('preset:save', p),
  loadPreset: () => ipcRenderer.invoke('preset:load'),
};

contextBridge.exposeInMainWorld('maplet', api);
