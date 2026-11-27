// Kindle に出す画面（2026-11-26）。横向き 1024×758 の白黒。
//   上: 日付 / 左: 今の天気（雪が降る・積もっているときは「朝 9 時までに 8cm ・ 積雪 32cm」）/ 右: 次の ★★★ までのカウントダウン
//   中: 今から 12 時間の天気 / 今週の日曜〜土曜の天気（降水確率つき。過ぎた日は薄く）
//   下: 月〜金の指標（終わった日は細く、★★★ だけ）
// サーバーで HTML を作る。古い Kindle のブラウザでも出るよう、JavaScript を使わず、並べるのは table で。5 分ごとに読み直す。
//
//   GET /kindle
//     ?cur=USD,JPY  通貨を絞る（初めは FP の銘柄の通貨）   ?before=30&after=30  触らない時間（分）
//     ?impact=High,Medium  週の欄に出す重要度（触らない時間は High だけ）   ?w=1024&h=758  画面の大きさ（px）
//     ?at=2026-11-25T22:20+09:00  その時刻の画面（確かめる用）
//   GET /api/calendar   残している指標（今日の 2 日前〜）を JSON で
//   GET /kindle.png     Kindle に送る画像（縦向き 758×1024・白黒。?rot=270 で逆向き）。家のネットワークの 8090 番でも出す（server/kindleImage.ts）

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';
import { blockedWindows, EconCalendar, FETCH_EVERY_MS, IMPACTS, jaTitle, type EconEvent, type Impact } from './econCalendar.ts';
import { chargingIcon, KINDLE_DIR, KindleImage, startKindleServer, type Battery } from './kindleImage.ts';
import { iconImg, KIND_JA, kindOf, snowSummary, WeatherSource, type Weather } from './weather.ts';

const JST = 9 * 3600_000;
const DAY = 86400_000;
const HOUR = 3600_000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 日本時間のその日の 0:00（UTC のミリ秒） */
export const jstDayStart = (at: number) => Math.floor((at + JST) / DAY) * DAY - JST;
const jstDay = (at: number) => new Date(at + JST).getUTCDay();
const two = (n: number) => String(n).padStart(2, '0');
function hm(at: number) {
  const d = new Date(at + JST);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}
function md(at: number) {
  const d = new Date(at + JST);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]})`;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const deg = (t: number) => `${Math.round(t)}°`;

/** 指標の欄に出す月〜金。土曜の朝 8 時（NY の金曜の終わり）を過ぎたら来週 */
export function weekDays(now: number): number[] {
  const base = jstDayStart(now - 8 * HOUR);
  const wd = jstDay(base);
  const monday = wd === 0 ? base + DAY : wd === 6 ? base + 2 * DAY : base - (wd - 1) * DAY;
  return [0, 1, 2, 3, 4].map((i) => monday + i * DAY);
}

export type Countdown =
  | { mode: 'next'; event: EconEvent; ms: number; from: number; to: number }
  | { mode: 'pre'; event: EconEvent; ms: number; to: number }
  | { mode: 'post'; event: EconEvent; ms: number; left: number }
  | { mode: 'none' };

/** 次の ★★★ まで。触らない時間の中なら「発表まで」「発表から」 */
export function countdown(events: EconEvent[], now: number, beforeMin: number, afterMin: number): Countdown {
  const windows = blockedWindows(events, beforeMin, afterMin);
  const inside = windows.find((w) => w.from <= now && now < w.to);
  if (inside) {
    const next = inside.events.find((e) => e.at > now);
    if (next) return { mode: 'pre', event: next, ms: next.at - now, to: inside.to };
    const last = [...inside.events].reverse().find((e) => e.at <= now)!;
    return { mode: 'post', event: last, ms: now - last.at, left: inside.to - now };
  }
  const w = windows.find((x) => x.from > now);
  if (!w) return { mode: 'none' };
  return { mode: 'next', event: w.events[0], ms: w.events[0].at - now, from: w.from, to: w.to };
}

function span(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60_000));
  if (m >= 24 * 60) return `${Math.floor(m / 1440)}日 ${Math.floor((m % 1440) / 60)}時間`;
  return `${Math.floor(m / 60)}:${two(m % 60)}`;
}

export interface KindleOptions {
  now: number;
  currencies: string[];
  impacts: Impact[];
  beforeMin: number;
  afterMin: number;
  width: number;
  height: number;
  /** 指標を最後に取ってきた時刻 */
  calendarAt: number | null;
  weather: Weather | null;
  /** Kindle が画像を取りに来たときに伝えた電池の残量（30 分より古ければ出さない） */
  battery?: Battery | null;
  /** 充電中に電池の残量の横に出すマーク（img の src。data: など）。無ければ「充電中」と字で出す */
  chargingIcon?: string | null;
}

export function renderKindle(all: EconEvent[], o: KindleOptions): string {
  const curs = new Set(o.currencies);
  const mine = all.filter((e) => curs.has(e.cur));
  const known = all.length ? all[all.length - 1].at : 0;
  const w = o.weather;
  const today = jstDayStart(o.now);

  // ---- 上: 日付 ----
  const stale: string[] = [];
  if (!o.calendarAt || o.now - o.calendarAt > 6 * HOUR) stale.push('⚠ 指標が古い');
  if (!w || o.now - w.fetchedAt > 3 * HOUR) stale.push('⚠ 天気が古い');
  const d = new Date(o.now + JST);
  const b = o.battery && o.now - o.battery.at < 30 * 60_000 ? o.battery : null;
  const batt = b ? `<span class="${b.level <= 20 && !b.charging ? 'low' : ''}">電池 ${b.level}%${b.charging ? (o.chargingIcon ? ` <img class="chg" src="${o.chargingIcon}" alt="充電中">` : ' 充電中') : b.level <= 20 && !b.held ? ' 充電して' : ''}</span>　` : '';
  const head = `<table class="head"><tr><td class="date">${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${WEEKDAYS[d.getUTCDay()]})</td><td class="upd">${stale.join(' ')} ${batt}${hm(o.now)} 更新</td></tr></table>`;

  // ---- 左: 今の天気 ----
  let now = '<td class="wxnow">天気を取れていません</td>';
  if (w) {
    const t = w.daily.find((x) => x.at === today) ?? w.daily[0];
    const next = w.hourly.find((h) => h.at > o.now && kindOf(h.code) !== kindOf(w.current.code) && ['rain', 'snow', 'sleet', 'thunder'].includes(kindOf(h.code)) && h.at < o.now + 12 * HOUR);
    // 雪（翌朝 9 時までの降雪・今の積雪）。無ければ出さない
    const sn = snowSummary(w, o.now);
    const snowLine = sn
      ? `<br><span class="snow">${[sn.cm >= 1 ? `朝 9 時までに ${sn.cm}cm` : '', sn.depth ? `積雪 ${sn.depth}cm` : ''].filter(Boolean).join(' ・ ')}</span>`
      : '';
    now = `<td class="wxnow"><table><tr><td>${iconImg(w.current.code, w.current.isDay, 84)}</td><td class="temp">${Math.round(w.current.temp)}<span>℃</span></td><td class="sub">${KIND_JA[kindOf(w.current.code)]}<br>今日 ${deg(t.max)} / ${deg(t.min)}<br>降水 ${t.pop ?? '-'}%${next ? `<br>${new Date(next.at + JST).getUTCHours()}時から${KIND_JA[kindOf(next.code)]}` : ''}${snowLine}</td></tr></table></td>`;
  }

  // ---- 右: カウントダウン ----
  const c = countdown(mine, o.now, o.beforeMin, o.afterMin);
  const name = (e: EconEvent) => `${hm(e.at)} ${e.cur} ${esc(jaTitle(e.title))}`;
  let cd: string;
  if (c.mode === 'pre') cd = `<td class="cd block"><div class="lbl">発表まで</div><div class="big">${Math.ceil(c.ms / 60_000)} 分</div><div class="sub">${name(c.event)}</div></td>`;
  else if (c.mode === 'post') cd = `<td class="cd block"><div class="lbl">発表から ${Math.floor(c.ms / 60_000)} 分</div><div class="big">あと ${Math.ceil(c.left / 60_000)} 分</div><div class="sub">触らない。${name(c.event)}</div></td>`;
  else if (c.mode === 'next') cd = `<td class="cd"><div class="lbl">次の ★★★ まで</div><div class="big">${span(c.ms)}</div><div class="sub">${md(c.event.at)} ${name(c.event)}</div></td>`;
  else cd = `<td class="cd"><div class="lbl">次の ★★★</div><div class="mid">${known > o.now ? '今週はもう無し' : 'まだ出ていません'}</div></td>`;
  const top = `<table class="top"><tr>${now}${cd}</tr></table>`;

  // ---- 中: 12 時間・週間の天気 ----
  let mid = '';
  if (w) {
    const start = Math.floor(o.now / HOUR) * HOUR;
    const hours = w.hourly.filter((h) => h.at >= start).slice(0, 12);
    const hcells = hours
      .map((h) => `<td><div class="h">${new Date(h.at + JST).getUTCHours()}時</div>${iconImg(h.code, h.isDay, 30)}<div class="t">${deg(h.temp)}</div><div class="p">${h.pop ?? '-'}%</div></td>`)
      .join('');
    // 週間は今週の日曜〜土曜で固定（過ぎた日は薄く）
    const sunday = today - jstDay(today) * DAY;
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => w.daily.find((x) => x.at === sunday + i * DAY) ?? { at: sunday + i * DAY, code: -1, max: NaN, min: NaN, pop: null });
    const dcells = days
      .map((x) => {
        const cls = x.at === today ? ' class="today"' : x.at < today ? ' class="gone"' : '';
        const label = `${WEEKDAYS[jstDay(x.at)]}${x.at === today ? ' 今日' : ''}`;
        if (x.code < 0) return `<td${cls}><div class="h">${label}</div><div class="p">-</div></td>`;
        return `<td${cls}><div class="h">${label}</div>${iconImg(x.code, true, 30)}<div class="t">${deg(x.max)}</div><div class="lo">${deg(x.min)}</div><div class="p">${x.pop ?? '-'}%</div></td>`;
      })
      .join('');
    mid = `<table class="mid"><tr><td class="hourly"><table class="cells"><tr>${hcells}</tr></table></td><td class="weekly"><table class="cells"><tr>${dcells}</tr></table></td></tr></table>`;
  }

  // ---- 下: 月〜金の指標 ----
  const cols = weekDays(o.now);
  const doneDay = (at: number) => at + DAY <= today;
  const wide = cols.filter((at) => !doneDay(at)).length;
  const narrowPct = 11;
  const widePct = wide ? (100 - narrowPct * (5 - wide)) / wide : 0;
  const done = (e: EconEvent) => e.at + o.afterMin * 60_000 <= o.now;
  const MAX_ROWS = 7;
  const cells = cols
    .map((day) => {
      const past = doneDay(day);
      const rows = mine.filter((e) => e.at >= day && e.at < day + DAY);
      const hol = rows.filter((e) => e.impact === 'Holiday').map((e) => e.cur);
      let evs = rows.filter((e) => e.impact !== 'Holiday' && o.impacts.includes(e.impact) && (!past || e.impact === 'High'));
      let s = `<div class="dh">${md(day)}${day === today ? ' 今日' : ''}</div>${hol.length ? `<div class="hol">祝日 ${hol.join('・')}</div>` : ''}`;
      if (day > known) s += '<div class="none">まだ出ていません</div>';
      else if (!evs.length) s += `<div class="none">${past ? '' : '重要な指標なし'}</div>`;
      else {
        // 多いときは終わったものから省く
        if (evs.length > MAX_ROWS) evs = evs.filter((e) => !done(e));
        const more = evs.length - MAX_ROWS;
        for (const e of evs.slice(0, MAX_ROWS)) {
          const cls = `${e.impact === 'High' ? 'hi' : 'md'}${!past && done(e) ? ' gone' : ''}`;
          s += past
            ? `<div class="ev ${cls}">${hm(e.at)} ${esc(jaTitle(e.title))}</div>`
            : `<div class="ev ${cls}"><b>${hm(e.at)}</b> ${e.impact === 'High' ? '★★★' : '★★'} ${e.cur}<br>${esc(jaTitle(e.title))}</div>`;
        }
        if (more > 0) s += `<div class="none">ほか ${more} 件</div>`;
      }
      return `<td class="${past ? 'past' : ''}${day === today ? ' today' : ''}" style="width:${(past ? narrowPct : widePct).toFixed(1)}%">${s}</td>`;
    })
    .join('');
  const ev = `<table class="week"><tr>${cells}</tr></table>`;

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Kindle</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#000;font-family:"Hiragino Sans","Noto Sans JP",sans-serif;font-size:16px}
.page{width:${o.width}px;height:${o.height}px;padding:12px 18px;overflow:hidden}
table{border-collapse:collapse;width:100%}
td{padding:0;vertical-align:top}
img{display:block;margin:0 auto}
.head{border-bottom:2px solid #000}
.head .date{font-size:30px;font-weight:bold;padding-bottom:4px}
.head .upd{text-align:right;vertical-align:bottom;font-size:14px;color:#555;padding-bottom:6px}
.head .upd .low{color:#000;font-weight:bold;font-size:18px}
.head .upd img.chg{display:inline-block;height:30px;vertical-align:middle;margin:0 0 0 2px}
.top{margin-top:8px}
.wxnow{width:52%;vertical-align:middle}
.wxnow td{vertical-align:middle;padding-right:12px}
.wxnow .temp{font-size:64px;font-weight:bold;line-height:1;white-space:nowrap}
.wxnow .temp span{font-size:24px;font-weight:normal}
.wxnow .sub{font-size:16px;line-height:1.45}
.wxnow .snow{font-weight:bold}
.cd{border-left:3px solid #000;padding:2px 0 4px 16px;vertical-align:middle}
.cd .lbl{font-size:18px}
.cd .big{font-size:64px;font-weight:bold;line-height:1.05}
.cd .mid{font-size:34px;font-weight:bold}
.cd .sub{font-size:17px}
.cd.block{background:#000;color:#fff;border-left-color:#000}
.mid{margin-top:8px;border-top:1px solid #000;border-bottom:2px solid #000}
.mid > tbody > tr > td{padding:6px 0}
.hourly{width:60%;padding-right:12px !important}
.weekly{border-left:1px solid #000;padding-left:10px !important}
.cells td{text-align:center;font-size:14px;line-height:1.2}
.cells .h{font-size:13px}
.cells .t{font-weight:bold;font-size:17px}
.cells .lo{font-size:14px;color:#444}
.cells .p{font-size:14px;color:#444}
.weekly .today{border:2px solid #000}
.weekly .gone{opacity:.45}
.week{table-layout:fixed;margin-top:6px}
.week td{padding:2px 8px 0;border-left:1px solid #999}
.week td:first-child{border-left:none}
.week td.today{border:3px solid #000}
.dh{font-size:21px;font-weight:bold;border-bottom:1px solid #000;margin-bottom:4px;white-space:nowrap;overflow:hidden}
.hol{display:inline-block;font-size:16px;border:1px solid #000;padding:0 4px;margin-bottom:4px}
.ev{font-size:18px;line-height:1.3;margin-bottom:8px}
.ev.hi{font-size:22px;font-weight:bold}
.ev.hi b{font-size:24px}
.ev.gone{color:#999}
.past{color:#888}
.past .dh{font-size:14px;border-bottom-color:#999}
.past .ev{font-size:14px;font-weight:normal;margin-bottom:3px}
.none{font-size:16px;color:#777}
</style></head><body><div class="page">
${head}${top}${mid}${ev}
</div></body></html>`;
}

/** FP の銘柄に出てくる通貨（XAUUSD・BTCUSD は USD、JP225 は JPY） */
export const DEFAULT_CURRENCIES = ['USD', 'JPY', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];

/** 成功したら okMs 後、失敗したら errMs 後にもう一度 */
function repeat(name: string, fn: () => Promise<void>, okMs: number, errMs: number, firstMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      await fn();
      timer = setTimeout(run, okMs);
    } catch (e) {
      console.warn(`[${name}]`, e instanceof Error ? e.message : e);
      timer = setTimeout(run, errMs);
    }
    timer.unref();
  };
  timer = setTimeout(run, Math.max(0, firstMs));
  timer.unref();
  return () => clearTimeout(timer);
}

/** データの置き場の config.json（{ "latlon": "緯度,経度" }）。住んでいる場所などはここに書き、リポジトリには入れない */
export function readConfig(dir: string): { latlon?: string } {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8')) as { latlon?: string };
  } catch {
    return {};
  }
}

export function kindleDash(dataDir = KINDLE_DIR): Plugin {
  return {
    name: 'fxp-kindle',
    configureServer(server) {
      if (process.env.VITEST) return;
      // 指標: 1 時間に 1 回（ForexFactory は続けて取ると 429 を返すので、断られたら 15 分後）
      const cal = new EconCalendar(path.join(dataDir, 'calendar'));
      // 天気: 30 分に 1 回
      const wx = new WeatherSource(path.join(dataDir, 'weather.json'), process.env.FXP_WEATHER_LATLON || readConfig(dataDir).latlon || '');
      const stops: (() => void)[] = [];
      void cal.load().then(() => {
        const age = cal.fetchedAt ? Date.now() - cal.fetchedAt : Infinity;
        stops.push(repeat('calendar', () => cal.fetch(), FETCH_EVERY_MS, 15 * 60_000, FETCH_EVERY_MS - age));
      });
      const WX_EVERY = 30 * 60_000;
      void wx.load().then(() => {
        const age = wx.data ? Date.now() - wx.data.fetchedAt : Infinity;
        stops.push(repeat('weather', () => wx.fetch(), WX_EVERY, 10 * 60_000, WX_EVERY - age));
      });
      server.httpServer?.on('close', () => stops.forEach((s) => s()));

      server.middlewares.use('/api/calendar', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const from = jstDayStart(Date.now()) - 2 * DAY;
        res.end(JSON.stringify({ fetchedAt: cal.fetchedAt, events: cal.events.filter((e) => e.at >= from) }));
      });
      // Kindle に送る画像（家のネットワークの 8090 番の GET /kindle.png。ここでも /kindle.png で見られる）
      const defaults = (now = Date.now()): KindleOptions => ({
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
        chargingIcon: chargingIcon(),
      });
      // 作業場所はプロジェクトの外（public の中に HTML を書くと、vite が開いている FP の画面を読み直してしまった。2026-11-27）
      const img = new KindleImage(path.join(os.tmpdir(), 'fxp-kindle'), () => renderKindle(cal.events, defaults()));
      const lan = startKindleServer(img);
      server.httpServer?.on('close', () => lan?.close());
      // /kindle より先に（/kindle は /kindle.png にも当たるため）
      server.middlewares.use('/kindle.png', (req, res) => {
        const rot = new URL(req.url ?? '', 'http://x').searchParams.get('rot') === '270' ? 270 : 90;
        img.png(rot).then(
          (buf) => {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'no-store');
            res.end(buf);
          },
          (e) => {
            res.statusCode = 500;
            res.end(e instanceof Error ? e.message : String(e));
          },
        );
      });
      server.middlewares.use('/kindle', (req, res) => {
        const q = new URL(req.url ?? '', 'http://x').searchParams;
        const num = (k: string, d: number) => {
          const v = Number(q.get(k));
          return Number.isFinite(v) && v > 0 ? v : d;
        };
        const list = (k: string) => q.get(k)?.split(',').map((s) => s.trim()).filter(Boolean);
        const html = renderKindle(cal.events, {
          now: Date.parse(q.get('at') ?? '') || Date.now(),
          currencies: list('cur')?.map((s) => s.toUpperCase()) ?? DEFAULT_CURRENCIES,
          impacts: (list('impact') ?? ['High', 'Medium']).filter((s): s is Impact => IMPACTS.includes(s as Impact)),
          beforeMin: num('before', 30),
          afterMin: num('after', 30),
          width: num('w', 1024),
          height: num('h', 758),
          calendarAt: cal.fetchedAt,
          weather: wx.data,
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(html);
      });
    },
  };
}
