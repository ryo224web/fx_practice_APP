import { defineConfig } from 'vite';
import { projectStore } from './server/projectStore.ts';

export default defineConfig({
  plugins: [projectStore()],
});
