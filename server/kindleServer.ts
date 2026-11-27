// Kindle のダッシュボードのサーバー（2026-11-27）。FX Practice とは別に、Mac mini にログインしている間いつも動かしておく
// （launchd。scripts/mac/kindle-dashboard.sh install）。FX Practice を閉じていても Kindle の画面が新しくなるように。
// Mac mini が寝ている間は止まり、起きたら続きから動く（Kindle は 5 分ごとに取りに来るので、起きてから 5 分以内に新しくなる）。
//
//   node server/kindleServer.ts   （npm run kindle-server。ふだんは launchd が動かす）
//
// 家のネットワークの 8090 番（環境変数 FXP_KINDLE_PORT）で受け付けるのは次だけ:
//   GET /kindle.png      Kindle に送る画像（縦向き 758×1024・白黒。?rot=270 で逆向き。?batt=67&chg=1&hold=0 で電池の残量などを伝える）
//   GET /kindle_off.png  「Mac mini お休み中」の帯（?rot=270）
//   GET /kindle          画面の HTML（確かめる用。?cur=USD,JPY&before=30&after=30&impact=High,Medium&at=2026-11-25T22:20+09:00）
//   GET /api/calendar    取ってきた指標（今日の 2 日前〜）の JSON
// データの置き場は KINDLE_DIR（Dropbox の Claude/kindle_dashboard）。

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EconCalendar, FETCH_EVERY_MS, IMPACTS, type Impact } from './econCalendar.ts';
import { DEFAULT_CURRENCIES, jstDayStart, renderKindle, type KindleOptions } from './kindle.ts';
import { batteryIcon, KINDLE_DIR, KindleImage, type Rotation } from './kindleImage.ts';
import { WeatherSource } from './weather.ts';

const DAY = 86400_000;

/** データの置き場の config.json（{ "latlon": "緯度,経度" }）。住んでいる場所などはここに書き、リポジトリには入れない */
export function readConfig(dir: string): { latlon?: string } {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')) as { latlon?: string };
  } catch {
    return {};
  }
}

/** 成功したら okMs 後、失敗したら errMs 後にもう一度 */
function repeat(name: string, fn: () => Promise<void>, okMs: number, errMs: number, firstMs: number) {
  const run = async () => {
    try {
      await fn();
      setTimeout(run, okMs);
    } catch (e) {
      console.warn(`${new Date().toISOString()} [${name}]`, e instanceof Error ? e.message : e);
      setTimeout(run, errMs);
    }
  };
  setTimeout(run, Math.max(0, firstMs));
}

export async function startDashboard(dataDir = KINDLE_DIR, port = Number(process.env.FXP_KINDLE_PORT ?? 8090)) {
  // 指標: 1 時間に 1 回（ForexFactory は続けて取ると 429 を返すので、断られたら 15 分後）
  const cal = new EconCalendar(path.join(dataDir, 'calendar'));
  await cal.load();
  repeat('calendar', () => cal.fetch(), FETCH_EVERY_MS, 15 * 60_000, cal.fetchedAt ? FETCH_EVERY_MS - (Date.now() - cal.fetchedAt) : 0);
  // 天気: 30 分に 1 回
  const WX_EVERY = 30 * 60_000;
  const wx = new WeatherSource(path.join(dataDir, 'weather.json'), process.env.FXP_WEATHER_LATLON || readConfig(dataDir).latlon || '');
  await wx.load();
  repeat('weather', () => wx.fetch(), WX_EVERY, 10 * 60_000, wx.data ? WX_EVERY - (Date.now() - wx.data.fetchedAt) : 0);

  const options = (now = Date.now()): KindleOptions => ({
    now,
    currencies: DEFAULT_CURRENCIES,
    impacts: ['High', 'Medium'],
    beforeMin: 30,
    afterMin: 30,
    width: 1024,
    height: 758,
    calendarAt: cal.fetchedAt,
    weather: wx.data,
    battery: img.battery,
    chargingIcon: batteryIcon('charging', dataDir),
    normalIcon: batteryIcon('normal', dataDir),
  });
  // 作業場所はプロジェクトの外（OS の一時フォルダ）
  const img = new KindleImage(path.join(os.tmpdir(), 'fxp-kindle'), () => renderKindle(cal.events, options()));

  const png = (res: import('node:http').ServerResponse, p: Promise<Buffer>) =>
    p.then(
      (b) => {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(b);
      },
      (e) => {
        console.warn(`${new Date().toISOString()} [kindle]`, e instanceof Error ? e.message : e);
        res.statusCode = 500;
        res.end();
      },
    );

  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '', 'http://x');
    const q = u.searchParams;
    const rot: Rotation = q.get('rot') === '270' ? 270 : 90;
    if (req.method !== 'GET') {
      res.statusCode = 404;
      return res.end();
    }
    switch (u.pathname) {
      case '/kindle.png':
        return png(res, img.report(q).then(() => img.png(rot)));
      case '/kindle_off.png':
        return png(res, img.banner(rot));
      case '/kindle': {
        const num = (k: string, d: number) => {
          const v = Number(q.get(k));
          return Number.isFinite(v) && v > 0 ? v : d;
        };
        const list = (k: string) => q.get(k)?.split(',').map((s) => s.trim()).filter(Boolean);
        const html = renderKindle(cal.events, {
          ...options(Date.parse(q.get('at') ?? '') || Date.now()),
          currencies: list('cur')?.map((s) => s.toUpperCase()) ?? DEFAULT_CURRENCIES,
          impacts: (list('impact') ?? ['High', 'Medium']).filter((s): s is Impact => IMPACTS.includes(s as Impact)),
          beforeMin: num('before', 30),
          afterMin: num('after', 30),
          width: num('w', 1024),
          height: num('h', 758),
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(html);
      }
      case '/api/calendar': {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const from = jstDayStart(Date.now()) - 2 * DAY;
        return res.end(JSON.stringify({ fetchedAt: cal.fetchedAt, events: cal.events.filter((e) => e.at >= from) }));
      }
      default:
        res.statusCode = 404;
        return res.end();
    }
  });
  // launchd が起動し直した直後などで番号がまだ使われていたら、3 秒おきに開き直す
  let tries = 0;
  srv.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE' && tries++ < 100) {
      setTimeout(() => srv.listen(port, '0.0.0.0'), 3000);
      return;
    }
    console.error(`${new Date().toISOString()} [kindle] ${port} 番を開けませんでした: ${e.message}`);
    process.exit(1);
  });
  srv.listen(port, '0.0.0.0', () => console.log(`${new Date().toISOString()} [kindle] listening on ${port} (data: ${dataDir})`));
  return srv;
}

// このファイルを直接動かしたとき
if (import.meta.url === `file://${process.argv[1]}`) {
  void startDashboard();
}
