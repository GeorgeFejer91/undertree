import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: { license: { fileName: 'THIRD-PARTY-JAVASCRIPT.json' }, rollupOptions: { input: { workspace: resolve('index.html'), manuscript: resolve('manuscript.html') } } },
});
