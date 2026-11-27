import { defineConfig } from 'vite';
import { kindleDash } from './server/kindle.ts';
import { mt4Bars } from './server/mt4Bars.ts';
import { projectStore } from './server/projectStore.ts';

export default defineConfig({
  plugins: [projectStore(), mt4Bars(), kindleDash()],
  // iPad などから Tailscale（tailscale serve → https://rs-mini.<tailnet>.ts.net）で開くため。
  // サーバー自体は今までどおり Mac mini の中（localhost）だけで待ち、Tailscale が中継する
  server: { allowedHosts: ['.ts.net'] },
});
