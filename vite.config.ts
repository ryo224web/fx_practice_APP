import { defineConfig } from 'vite';
import { mt4Bars } from './server/mt4Bars.ts';
import { projectStore } from './server/projectStore.ts';

export default defineConfig({
  plugins: [projectStore(), mt4Bars()],
});
