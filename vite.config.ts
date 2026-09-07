import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// base './' keeps asset paths relative so the production bundle loads the same
// whether opened by Electron (file://) or served as a plain web page. The
// single-file build inlines everything, including the sample dataset — which is a
// plain TS module (src/platform/sampleData.ts, a typed CSV/TSV string) — so the
// standalone HTML opens with a demo dataset under file:// with no fetch.
export default defineConfig(({ mode }) => {
  const single = mode === 'singlefile';
  return {
    base: './',
    plugins: [react(), tailwindcss(), ...(single ? [viteSingleFile()] : [])],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: single
      ? {
          outDir: 'dist-web',
          emptyOutDir: true,
          target: 'es2022',
          cssCodeSplit: false,
          assetsInlineLimit: 100_000_000, // inline fonts as data URIs
          chunkSizeWarningLimit: 100_000,
        }
      : { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  };
});
