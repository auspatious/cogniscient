import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // @developmentseed/geotiff's COG decoder pool constructs its worker via
    // new Worker(new URL('./worker.js', import.meta.url), {type:'module'}),
    // which Vite's dev-time dependency pre-bundler can't rewrite cleanly —
    // excluding it forces Vite to serve the pre-built ESM directly instead,
    // preserving the worker URL. (maplibre-gl v5 needed the same kind of
    // exclusion on v6; v5 bundles its worker as an inline blob URL itself,
    // so it isn't needed here.)
    exclude: ['@developmentseed/geotiff'],
    // Dev-server dep pre-bundling defaults to an older esbuild target than
    // `build.target` — a deck.gl-geotiff transitive dep
    // (@developmentseed/lzw-tiff-decoder) uses top-level await, which needs
    // ES2022+. Match it to the production target instead of drifting.
    esbuildOptions: { target: 'es2022' },
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
  },
});
