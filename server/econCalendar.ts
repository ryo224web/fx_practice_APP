// 経済指標カレンダー（2026-11-26）。Kindle などに「触らない時間」を出すため。
//
// 取ってくる先: ForexFactory の週間カレンダーの JSON（https://nfs.faireconomy.media/ff_calendar_thisweek.json）。
//   鍵は要らない。今週（日曜〜土曜）の分だけで、来週分は無い。結果（actual）は入らない。
//   公式の API ではなく、規約は転載・再配布を禁じているので、自分で見るだけにし、取りに行くのは 1 時間に 1 回まで。
// 届いた週は Dropbox の Claude/kindle_dashboard/calendar/<週の初めの日付>.json に残す（KINDLE_DIR）（あとでチャートに指標を出すときにも使えるように）。
//
// 画面は server/kindle.ts。

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const FETCH_EVERY_MS = 60 * 60_000;

export type Impact = 'High' | 'Medium' | 'Low' | 'Holiday';

export interface EconEvent {
  title: string;
  /** 通貨（USD・JPY…） */
  cur: string;
  /** 発表の時刻（UTC のミリ秒） */
  at: number;
  impact: Impact;
  forecast: string;
  previous: string;
}

interface FfRow {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
}

export const IMPACTS: Impact[] = ['High', 'Medium', 'Low', 'Holiday'];

/** ForexFactory の JSON を読む。時刻は時差つき（"2026-11-25T08:30:00-05:00"）なのでそのまま UTC にできる */
export function parseFf(rows: unknown): EconEvent[] {
  if (!Array.isArray(rows)) return [];
  const out: EconEvent[] = [];
  for (const r of rows as FfRow[]) {
    const at = Date.parse(r.date ?? '');
    const impact = IMPACTS.find((i) => i === r.impact);
    if (!r.title || !r.country || !Number.isFinite(at) || !impact) continue;
    out.push({ title: r.title, cur: r.country, at, impact, forecast: r.forecast ?? '', previous: r.previous ?? '' });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 週の初め（日曜 0:00 UTC）の日付。ファイル名に使う */
export function weekKey(at: number): string {
  const d = new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

// ---- 日本語の名前 ----

// 週の欄に並べるので短く（「前月比」などは最後に読み替える）
const NAMES: [RegExp, string][] = [
  [/^Non-Farm Employment Change$/, '雇用統計'],
  [/^ADP Non-Farm Employment Change$/, 'ADP 雇用'],
  [/^Unemployment Rate$/, '失業率'],
  [/^Unemployment Claims$/, '失業保険申請'],
  [/^Average Hourly Earnings/, '平均時給'],
  [/^JOLTS Job Openings$/, 'JOLTS 求人'],
  [/^Employment Change$/, '雇用者数'],
  [/^Claimant Count Change$/, '失業保険申請'],
  [/^Trimmed Mean CPI/, 'トリム平均 CPI'],
  [/^Tokyo Core CPI/, '東京 CPI'],
  [/^National Core CPI/, '全国 CPI'],
  [/^German Prelim CPI/, '独 CPI 速報'],
  [/^Core PCE Price Index/, 'PCE コア'],
  [/^Prelim GDP Price Index/, 'GDP 物価 改定'],
  [/^Core Retail Sales/, '小売 コア'],
  [/^Retail Sales/, '小売売上高'],
  [/^Advance GDP/, 'GDP 速報'],
  [/^Prelim GDP/, 'GDP 改定'],
  [/^Final GDP/, 'GDP 確定'],
  [/^ISM Manufacturing PMI$/, 'ISM 製造業'],
  [/^ISM Services PMI$/, 'ISM 非製造業'],
  [/^German Flash (Manufacturing|Services) PMI$/, '独 PMI 速報'],
  [/^French Flash (Manufacturing|Services) PMI$/, '仏 PMI 速報'],
  [/^Flash Manufacturing PMI$/, 'PMI 製造業 速報'],
  [/^Flash Services PMI$/, 'PMI サービス 速報'],
  [/^CB Consumer Confidence$/, 'CB 消費者信頼感'],
  [/^Prelim UoM Consumer Sentiment$/, 'ミシガン大 速報'],
  [/^Federal Funds Rate$/, 'FOMC 政策金利'],
  [/^FOMC Statement$/, 'FOMC 声明'],
  [/^FOMC Press Conference$/, 'FOMC 会見'],
  [/^FOMC Meeting Minutes$/, 'FOMC 議事録'],
  [/^FOMC Economic Projections$/, 'FOMC 見通し'],
  [/^Fed Chair (.+) (Speaks|Testifies)$/, 'FRB $1 議長'],
  [/^BOJ Policy Rate$/, '日銀 政策金利'],
  [/^BOJ Press Conference$/, '日銀 会見'],
  [/^BOJ Gov (.+) Speaks$/, '日銀 $1 総裁'],
  [/^Monetary Policy Statement$/, '政策の声明'],
  [/^Monetary Policy Report Hearings$/, '政策報告 公聴会'],
  [/^Main Refinancing Rate$/, 'ECB 政策金利'],
  [/^ECB Press Conference$/, 'ECB 会見'],
  [/^ECB President (.+) Speaks$/, 'ECB $1 総裁'],
  [/^Official Bank Rate$/, '英中銀 政策金利'],
  [/^BOE Gov (.+) Speaks$/, '英中銀 $1 総裁'],
  [/^Cash Rate$/, '豪中銀 政策金利'],
  [/^Official Cash Rate$/, 'NZ 中銀 政策金利'],
  [/^Overnight Rate$/, '加中銀 政策金利'],
  [/^BOC Gov (.+) Speaks$/, '加中銀 $1 総裁'],
  [/^SNB Policy Rate$/, 'スイス中銀 政策金利'],
  [/^Crude Oil Inventories$/, '原油在庫'],
  [/^Bank Holiday$/, '祝日'],
  [/^Core CPI/, 'コア CPI'],
  [/^CPI/, 'CPI'],
  [/^PPI/, 'PPI'],
  [/^Core PPI/, 'コア PPI'],
];

const SUFFIX: [RegExp, string][] = [
  [/ m\/m$/, ' 前月比'],
  [/ y\/y$/, ' 前年比'],
  [/ q\/q$/, ' 前期比'],
];

export function jaTitle(title: string): string {
  // 名前の頭を読み替え、後ろに残る m/m などを付け直す（「Core PCE Price Index m/m」→「PCE コア 前月比」）
  const hit = NAMES.find(([re]) => re.test(title));
  let out = hit ? title.replace(hit[0], hit[1]) : title;
  for (const [re, ja] of SUFFIX) out = out.replace(re, ja);
  return out;
}

// ---- 触らない時間 ----

export interface Window {
  from: number;
  to: number;
  events: EconEvent[];
}

/** 重要度 High の発表の前後を、重なりをまとめて返す */
export function blockedWindows(events: EconEvent[], beforeMin: number, afterMin: number): Window[] {
  const out: Window[] = [];
  for (const e of events) {
    if (e.impact !== 'High') continue;
    const from = e.at - beforeMin * 60_000;
    const to = e.at + afterMin * 60_000;
    const last = out[out.length - 1];
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to);
      last.events.push(e);
    } else out.push({ from, to, events: [e] });
  }
  return out;
}

// ---- 保存と取得 ----

export class EconCalendar {
  events: EconEvent[] = [];
  fetchedAt: number | null = null;
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  /** 残している週を読む（新しい 3 週） */
  async load() {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(-3);
    } catch {
      return;
    }
    const byKey = new Map<string, EconEvent>();
    for (const n of names) {
      try {
        const f = JSON.parse(await readFile(path.join(this.dir, n), 'utf8')) as { fetchedAt: number; events: EconEvent[] };
        for (const e of f.events) byKey.set(`${e.at}|${e.cur}|${e.title}`, e);
        this.fetchedAt = Math.max(this.fetchedAt ?? 0, f.fetchedAt);
      } catch {
        /* 壊れたファイルは飛ばす */
      }
    }
    this.events = [...byKey.values()].sort((a, b) => a.at - b.at);
  }

  async fetch(now = Date.now()) {
    const res = await fetch(FF_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (personal calendar viewer)' } });
    if (!res.ok) throw new Error(`ForexFactory ${res.status}`);
    const evs = parseFf(await res.json());
    if (!evs.length) throw new Error('ForexFactory: 空');
    // 週ごとにファイルに書く（同じ週は届いたもので置き換える）
    const weeks = new Map<string, EconEvent[]>();
    for (const e of evs) {
      const k = weekKey(e.at);
      weeks.set(k, [...(weeks.get(k) ?? []), e]);
    }
    await mkdir(this.dir, { recursive: true });
    for (const [k, list] of weeks) await writeFile(path.join(this.dir, `${k}.json`), JSON.stringify({ fetchedAt: now, events: list }));
    await this.load();
    this.fetchedAt = now;
  }
}

