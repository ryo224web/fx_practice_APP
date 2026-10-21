import { defineConfig } from 'vite';
import { projectStore } from './server/projectStore';

export default defineConfig({
  plugins: [projectStore()],
});
