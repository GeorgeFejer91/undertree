import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: { rollupOptions: { input: { workspace: resolve('index.html'), manuscript: resolve('manuscript.html') } } },
});
