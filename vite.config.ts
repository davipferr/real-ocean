import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build works under any sub-path (e.g. GitHub Pages /real-ocean/).
  base: './',
  // three.js alone is ~600 kB minified; one bundle is fine for this app.
  build: { chunkSizeWarningLimit: 800 },
});
