// Kindle に出す画面（2026-11-26）。横向き 1024×758 の白黒。
//   上: 日付 / 左: 今の天気（雪が降る・積もっているときは「朝 9 時までに 8cm ・ 積雪 32cm」）/ 右: 次の ★★★ までのカウントダウン
//   中: 今から 12 時間の天気 / 今週の日曜〜土曜の天気（降水確率つき。過ぎた日は薄く）
//   下: 月〜金の指標（終わった日は細く、★★★ だけ）
// サーバーで HTML を作る。古い Kindle のブラウザでも出るよう、JavaScript を使わず、並べるのは table で。5 分ごとに読み直す。
//
// 画面を作るだけ。取ってくる・画像にする・Kindle からの入口は server/kindleServer.ts（FX Practice とは別に動かすサーバー）

import { blockedWindows, jaTitle, type EconEvent, type Impact } from './econCalendar.ts';
import type { Battery } from './kindleImage.ts';
import { pixelIcon, pixelText, popDots } from './pixel.ts';
import { iconImg as lineIcon, KIND_JA, kindOf, snowSummary, type Weather } from './weather.ts';

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
  /** 電池の残量の横に出す絵（img の src。data: など）。ケーブルが挿さっている間（充電を止めている間も）は charging（無ければ充電中だけ「充電中」と字で）、ふだんは normal（無ければ出さない） */
  chargingIcon?: string | null;
  normalIcon?: string | null;
  /** 大きい数字と天気のマークをドット（腕時計の液晶のような点）で描く */
  pixel?: boolean;
  /** 出ている気象警報・注意報の名前（一番上の行に出す） */
  warnings?: string[] | null;
  /** 白黒を反転する（黒地に白。絵は反転しない） */
  dark?: boolean;
}

export function renderKindle(all: EconEvent[], o: KindleOptions): string {
  const iconImg = o.pixel ? pixelIcon : lineIcon;
  // 大きい数字（ドットのときは点で描く。黒地のときは白い点）
  const big = (t: string, white = false) => (o.pixel ? pixelText(t, 72, white ? '#fff' : '#000') : t);
  const curs = new Set(o.currencies);
  const mine = all.filter((e) => curs.has(e.cur));
  const known = all.length ? all[all.length - 1].at : 0;
  const w = o.weather;
  const today = jstDayStart(o.now);

  // ---- 上: 日付（ドットのときは数字を SUUNTO 風に。2026-11-27）----
  const stale: string[] = [];
  if (!o.calendarAt || o.now - o.calendarAt > 6 * HOUR) stale.push('⚠ 指標が古い');
  if (!w || o.now - w.fetchedAt > 3 * HOUR) stale.push('⚠ 天気が古い');
  const d = new Date(o.now + JST);
  const b = o.battery && o.now - o.battery.at < 30 * 60_000 ? o.battery : null;
  // 電池: 残量は日付と同じ大きさのドットの数字、横に絵（ケーブルが挿さっている間は充電中の絵）。2026-11-27
  const icon = b ? (b.charging || b.plugged ? o.chargingIcon : o.normalIcon) : null;
  const batt = b
    ? `<span class="bt${b.level <= 20 && !b.charging ? ' low' : ''}">${o.pixel ? pixelText(String(b.level), 48, '#000', 3 / 4) : b.level}<span class="pc">%</span>${icon ? `<img class="chg" src="${icon}" alt="">` : b.charging ? ' 充電中' : ''}${b.level <= 20 && !b.charging && !b.plugged ? '<span class="pc"> 充電して</span>' : ''}</span>`
    : '';
  // 真ん中: 今年あと何日・出ている警報と注意報
  const y = d.getUTCFullYear();
  const left = Math.round((Date.UTC(y + 1, 0, 1) - JST - jstDayStart(o.now)) / DAY) - 1;
  const warns = (o.warnings ?? []).map((n) => `<span class="wn">⚠ ${esc(n)}</span>`).join(' ');
  const middle = `<td class="mdl"><div class="yr">今年あと ${left} 日</div>${warns ? `<div>${warns}</div>` : ''}</td>`;
  const head = `<table class="head"><tr><td class="date">${o.pixel ? pixelText(`${d.getUTCMonth() + 1}月${d.getUTCDate()}日`, 48, '#000', 3 / 4) : `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`}(${WEEKDAYS[d.getUTCDay()]})</td>${middle}<td class="upd">${batt}<div class="ut">${stale.join(' ')} ${hm(o.now)} 更新</div></td></tr></table>`;

  // ---- 左: 今の天気（天気の字と「降水」の字は出さない。マークと % で分かるため。2026-11-27）----
  let now = '<td class="wxnow">天気を取れていません</td>';
  if (w) {
    const t = w.daily.find((x) => x.at === today) ?? w.daily[0];
    const next = w.hourly.find((h) => h.at > o.now && kindOf(h.code) !== kindOf(w.current.code) && ['rain', 'snow', 'sleet', 'thunder'].includes(kindOf(h.code)) && h.at < o.now + 12 * HOUR);
    // 雪（翌朝 9 時までの降雪・今の積雪）。無ければ出さない
    const sn = snowSummary(w, o.now);
    const snowLine = sn
      ? `<br><span class="snow">${[sn.cm >= 1 ? `朝 9 時までに ${sn.cm}cm` : '', sn.depth ? `積雪 ${sn.depth}cm` : ''].filter(Boolean).join(' ・ ')}</span>`
      : '';
    now = `<td class="wxnow"><table><tr><td>${iconImg(w.current.code, w.current.isDay, 84)}</td><td class="temp">${big(String(Math.round(w.current.temp)))}<span>℃</span></td><td class="sub"><span class="tmax">${deg(t.max)}</span> / <span class="tmin">${deg(t.min)}</span><br>${t.pop ?? '-'}%${next ? `<br>${new Date(next.at + JST).getUTCHours()}時から${KIND_JA[kindOf(next.code)]}` : ''}${snowLine}</td></tr></table></td>`;
  }

  // ---- 右: カウントダウン ----
  const c = countdown(mine, o.now, o.beforeMin, o.afterMin);
  const name = (e: EconEvent) => `${hm(e.at)} ${e.cur} ${esc(jaTitle(e.title))}`;
  let cd: string;
  if (c.mode === 'pre') cd = `<td class="cd block"><div class="lbl">発表まで</div><div class="big">${big(`${Math.ceil(c.ms / 60_000)} 分`, true)}</div><div class="sub">${name(c.event)}</div></td>`;
  else if (c.mode === 'post') cd = `<td class="cd block"><div class="lbl">発表から ${Math.floor(c.ms / 60_000)} 分</div><div class="big">${big(`あと ${Math.ceil(c.left / 60_000)} 分`, true)}</div><div class="sub">触らない。${name(c.event)}</div></td>`;
  else if (c.mode === 'next') cd = `<td class="cd"><div class="lbl">次の ★★★ まで</div><div class="big">${big(span(c.ms))}</div><div class="sub">${md(c.event.at)} ${name(c.event)}</div></td>`;
  else cd = `<td class="cd"><div class="lbl">次の ★★★</div><div class="mid">${known > o.now ? '今週はもう無し' : 'まだ出ていません'}</div></td>`;
  const top = `<table class="top"><tr>${now}${cd}</tr></table>`;

  // ---- 中: 12 時間・週間の天気 ----
  let mid = '';
  if (w) {
    const start = Math.floor(o.now / HOUR) * HOUR;
    // 降水確率は数字でなく棒（確率のぶんだけ黒く塗る）。数字を読まなくても雨の時間が分かるように（2026-11-27）
    // ドットのときは 10 個の点（10% ごとに 1 点を黒く）。SUUNTO 風に（2026-11-27）
    const bar = (pop: number | null, w = 70) => (o.pixel ? popDots(pop, w) : `<div class="bar"><div style="width:${Math.max(0, Math.min(100, pop ?? 0))}%"></div></div>`);
    // 今から 18 時間を 3 時間ずつ 6 マス（12 マスだと小さくて見にくかった。2026-11-27）。マークと気温はその 3 時間の初め、降水確率は 3 時間の一番高い値
    const hcells = [0, 1, 2, 3, 4, 5]
      .map((k) => {
        const from = start + k * 3 * HOUR;
        const block = w.hourly.filter((h) => h.at >= from && h.at < from + 3 * HOUR);
        const h = block[0];
        if (!h) return '<td></td>';
        const pop = block.reduce<number | null>((m, x) => (x.pop == null ? m : Math.max(m ?? 0, x.pop)), null);
        // マークは、その 3 時間でいちばん降水確率の高い時刻の天気（雨が 3 時間の途中から降るときも出るように）
        const wx = block.reduce((m, x) => ((x.pop ?? -1) > (m.pop ?? -1) ? x : m), h);
        // 時刻は「18」のように数字だけ（「時」の字は要らない。2026-11-27）
        return `<td><div class="h">${new Date(h.at + JST).getUTCHours()}</div>${iconImg(wx.code, wx.isDay, o.pixel ? 48 : 44)}<div class="t">${deg(h.temp)}</div>${bar(pop)}</td>`;
      })
      .join('');
    // 週間は今週の日曜〜土曜で固定（過ぎた日は薄く。今日は枠）
    const sunday = today - jstDay(today) * DAY;
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => w.daily.find((x) => x.at === sunday + i * DAY) ?? { at: sunday + i * DAY, code: -1, max: NaN, min: NaN, pop: null });
    const dcells = days
      .map((x) => {
        const cls = x.at === today ? ' class="today"' : x.at < today ? ' class="gone"' : '';
        // 今日は枠で分かるので「今日」の字は付けない（2026-11-27）
        const label = WEEKDAYS[jstDay(x.at)];
        if (x.code < 0) return `<td${cls}><div class="h">${label}</div></td>`;
        return `<td${cls}><div class="h">${label}</div>${iconImg(x.code, true, o.pixel ? 40 : 36)}<div class="t">${deg(x.max)}</div><div class="lo">${deg(x.min)}</div>${bar(x.pop, 50)}</td>`;
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
  const MAX_ROWS = 5;
  const cells = cols
    .map((day) => {
      const past = doneDay(day);
      const rows = mine.filter((e) => e.at >= day && e.at < day + DAY);
      const hol = rows.filter((e) => e.impact === 'Holiday').map((e) => e.cur);
      // 終わった日は ★★★ だけ。今日から先は ★★ も 1 行で小さく出す（2026-11-27）
      let evs = rows.filter((e) => e.impact !== 'Holiday' && o.impacts.includes(e.impact) && (e.impact === 'High' || !past));
      let s = `<div class="dh">${md(day)}${day === today ? ' 今日' : ''}</div>${hol.length ? `<div class="hol">祝日 ${hol.join('・')}</div>` : ''}`;
      if (day > known) s += '<div class="none">まだ出ていません</div>';
      else if (!evs.length) s += `<div class="none">${past ? '' : '重要な指標なし'}</div>`;
      else {
        // 同じ時刻・同じ通貨・同じ重要度の指標はまとめる（時刻は 1 回だけ。09:30 の豪 CPI が 3 つ並んではみ出した。2026-11-27）
        type Group = { at: number; cur: string; impact: Impact; titles: string[] };
        let groups: Group[] = [];
        // 同じ時刻の中では ★★★ を先に、通貨ごとに並べてからまとめる（★★ が間に入ると分かれてしまう）
        const rank = (e: EconEvent) => (e.impact === 'High' ? 0 : 1);
        evs = [...evs].sort((a, b) => a.at - b.at || rank(a) - rank(b) || a.cur.localeCompare(b.cur));
        for (const e of evs) {
          const g = groups[groups.length - 1];
          if (g && g.at === e.at && g.cur === e.cur && g.impact === e.impact) g.titles.push(jaTitle(e.title));
          else groups.push({ at: e.at, cur: e.cur, impact: e.impact, titles: [jaTitle(e.title)] });
        }
        // 多いときは終わったものから省く
        const gdone = (g: Group) => g.at + o.afterMin * 60_000 <= o.now;
        if (groups.length > MAX_ROWS) groups = groups.filter((g) => !gdone(g));
        const more = groups.length - MAX_ROWS;
        for (const g of groups.slice(0, MAX_ROWS)) {
          // 終わったものは灰色（取り消し線も試したが、灰色の方がよいと言われた。2026-11-27）
          const cls = `${g.impact === 'High' ? 'hi' : 'md'}${gdone(g) ? ' gone' : ''}`;
          const names = g.titles.map(esc).join('<br>');
          s += past
            ? `<div class="ev ${cls}">${hm(g.at)} ${g.titles.map(esc).join('・')}</div>`
            : g.impact === 'High'
              ? `<div class="ev ${cls}"><div class="tm">${o.pixel ? pixelText(hm(g.at), 36, '#000', 3 / 4) : hm(g.at)}<span class="cur">${g.cur}</span></div>${names}</div>`
              : `<div class="ev ${cls}">${hm(g.at)} ★★ ${g.cur} ${g.titles.map(esc).join('・')}</div>`;
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
.page{width:${o.width}px;height:${o.height}px;padding:8px 18px;overflow:hidden}
table{border-collapse:collapse;width:100%}
td{padding:0;vertical-align:top}
img{display:block;margin:0 auto}
.head{border-bottom:2px solid #000}
.head .date{font-size:30px;font-weight:bold;padding:0 0 4px 10px}
.head .mdl{vertical-align:middle;padding:0 12px}
.head .yr{font-size:20px;font-weight:bold}
.head .wn{display:inline-block;font-size:20px;font-weight:bold;border:2px solid #000;padding:0 6px;margin-top:2px}
.head .upd{text-align:right;vertical-align:bottom;padding-bottom:4px;white-space:nowrap}
.head .bt{font-size:24px;font-weight:bold}
.head .bt .pc{font-size:22px}
.head .bt img.chg{display:inline-block;height:50px;vertical-align:bottom;margin:0 0 0 6px}
.head .ut{font-size:14px}
.top{margin-top:4px}
.wxnow{width:52%;vertical-align:middle}
.wxnow td{vertical-align:middle;padding-right:12px}
.wxnow .temp{font-size:64px;font-weight:bold;line-height:1;white-space:nowrap}
.wxnow .temp span{font-size:24px;font-weight:normal}
.wxnow .sub{font-size:16px;line-height:1.45}
.wxnow .tmax{font-size:28px;font-weight:bold}
.wxnow .tmin{font-size:22px;font-weight:bold}
.wxnow .snow{font-weight:bold}
.cd{border-left:3px solid #000;padding:2px 0 4px 16px;vertical-align:middle}
.cd .lbl{font-size:18px}
.cd .big{font-size:64px;font-weight:bold;line-height:1.05}
.cd .mid{font-size:34px;font-weight:bold}
.cd .sub{font-size:17px}
.cd.block{background:#000;color:#fff;border-left-color:#000}
.mid{margin-top:4px;border-top:1px solid #000;border-bottom:2px solid #000}
.mid > tbody > tr > td{padding:4px 0}
.hourly{width:55%;padding-right:12px !important}
.weekly{border-left:1px solid #000;padding-left:10px !important}
.cells td{text-align:center;font-size:14px;line-height:1.2}
.cells .h{font-size:15px}
.cells .t{font-weight:bold;font-size:18px}
.cells .lo{font-size:15px;color:#444}
.weekly .gone{opacity:.45}
.hourly .cells .h{font-size:18px}
.weekly .cells .h{font-size:17px}
.weekly .cells .t{font-size:22px}
.weekly .cells .lo{font-size:18px}
.hourly .cells .t{font-size:24px}
.bar{height:9px;border:1px solid #000;margin:3px auto 0;width:78%}
.bar div{height:100%;background:#000}
.weekly .today{border:2px solid #000}
.week{table-layout:fixed;margin-top:4px}
.week td{padding:2px 8px 0;border-left:1px solid #999}
.week td:first-child{border-left:none}
.week td.today{border:3px solid #000}
.dh{font-size:21px;font-weight:bold;border-bottom:1px solid #000;margin-bottom:4px;white-space:nowrap;overflow:hidden}
.hol{display:inline-block;font-size:16px;border:1px solid #000;padding:0 4px;margin-bottom:4px}
.ev{font-size:16px;line-height:1.3;margin-bottom:6px}
.ev.hi{font-size:21px;font-weight:bold;margin-bottom:12px}
.ev .tm{white-space:nowrap;margin-bottom:2px}
.ev .cur{font-size:20px;font-weight:bold;margin-left:4px}
.ev.gone{color:#999}
.ev.gone img{opacity:.45}
.past{color:#888}
.past .dh{font-size:15px;border-bottom-color:#999}
.past .ev{font-size:14px;font-weight:normal;margin-bottom:4px}
.none{font-size:17px;color:#777}
${o.dark ? 'html{background:#000}body{filter:invert(1)}img.chg{filter:invert(1)}' : ''}
</style></head><body><div class="page">
${head}${top}${mid}${ev}
</div></body></html>`;
}

/** FP の銘柄に出てくる通貨（XAUUSD・BTCUSD は USD、JP225 は JPY） */
export const DEFAULT_CURRENCIES = ['USD', 'JPY', 'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF'];
