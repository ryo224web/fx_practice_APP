// MT4（TitanFX）の 1 分足を、共有フォルダ（Dropbox）から自動で取り込む（開発サーバーに組み込む）。
// Windows 機の MT4 で scripts/mt4/R_ExportBarsHistory.mq4（EA）を動かすと、1 時間ごと（終わった 1 時間までの分）
//   <dir>/USDJPY/USDJPY_2026.10.csv 銘柄のフォルダに、サーバー時刻の月ごと（time,open,high,low,close,volume。時刻はサーバー時刻）
//   <dir>/_status.csv               MT4 のサーバー時刻と GMT の差など
// が書き換わる（月ごとのファイルは 1 日 1 回で昨日まで、今日の分は 1 時間ごとに USDJPY_2026.10.30.csv。
// 小さいので Dropbox の負担が軽い。それより前の月のファイルはそのまま残る。2026-10-30）。
// EA は 1 秒ごとに今の価格と直近の 1 分足を、Dropbox を通さず直接ここへ送る（startTickReceiver。ライブ用）。
// 送れない間は、1 分ごとに直近 2 時間の 1 分足だけを <dir>/USDJPY/USDJPY_live.csv に書く。
// 月・日のファイルは最初の足〜最後の足の範囲を、直近のファイルと直接届いた足はその足の範囲を、届いたものどおりに置き換える。
// ここではフォルダを 15 秒ごとに見て、変わったファイルを
//   public/data/<銘柄>/titan/<YYYY-MM>.bin   （UTC の月ごと。形式は Dukascopy と同じ。Ask は無し = 0）
// に入れ、manifest.json の titan に範囲を書く。共有フォルダから消えたファイルも、取り込んだ分は残る。
// チャートは、TitanFX の足がある期間は TitanFX、その前（後）は Dukascopy を使う（src/data/store.ts）。
// フォルダは環境変数 FXP_BARS_DIR で変えられる。

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';
import { DEFAULT_SERVER_RULE, serverOffsetMinutes, serverToUtc } from '../src/core/time.ts';
import { normalizeSymbol } from '../src/mt4/history.ts';

/** MT4 のデータフォルダは Dropbox の MT4 にある（MSI・T580 で共有）。EA はその MQL4\\Files\\fxp_bars に書く */
export const DEFAULT_BARS_DIR = '/Users/ryo/Library/CloudStorage/Dropbox/MT4/MQL4/Files/fxp_bars';

/** 銘柄と価格の小数桁数（scripts/import-csv.mjs と同じ） */
export const SYMBOL_DIGITS: Record<string, number> = {
  usdjpy: 3,
  eurusd: 5,
  gbpusd: 5,
  audusd: 5,
  usdchf: 5,
  usdcad: 5,
  nzdusd: 5,
  eurjpy: 3,
  gbpjpy: 3,
  xauusd: 3,
  btcusd: 2,
  jp225: 1,
};

const FIELDS = 9;
const DAY = 86_400_000;
const rule = DEFAULT_SERVER_RULE;

export interface RawBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * "USDJPY.a_2026.10.csv" → { symbol: 'usdjpy', start, end }（そのファイルが受け持つ期間。サーバー時刻の月の初め〜次の月の初め、
 * UTC 形式のミリ秒）。日ごとの "USDJPY_2026.10.22.csv" も読む
 */
export function parseBarFileName(name: string): { symbol: string; start: number; end: number } | null {
  const m = /^(.+)_(\d{4})\.(\d{2})(?:\.(\d{2}))?\.csv$/i.exec(name);
  if (!m) return null;
  const symbol = normalizeSymbol(m[1]).toLowerCase();
  if (!(symbol in SYMBOL_DIGITS)) return null;
  const [y, mo] = [Number(m[2]), Number(m[3]) - 1];
  if (m[4]) {
    const start = Date.UTC(y, mo, Number(m[4]));
    return { symbol, start, end: start + DAY };
  }
  return { symbol, start: Date.UTC(y, mo, 1), end: Date.UTC(y, mo + 1, 1) };
}

/** "USDJPY_live.csv" → 'usdjpy'（直近の 1 分足だけのファイル。期間は中の足で決まる） */
export function parseLiveFileName(name: string): string | null {
  const m = /^(.+)_live\.csv$/i.exec(name);
  if (!m) return null;
  const symbol = normalizeSymbol(m[1]).toLowerCase();
  return symbol in SYMBOL_DIGITS ? symbol : null;
}

/** CSV を読む。時刻はサーバー時刻のまま（UTC 形式のミリ秒）。読めない行は飛ばす */
export function parseBarCsv(text: string): RawBar[] {
  const out: RawBar[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}),([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(line);
    if (!m) continue;
    const [o, h, l, c] = [m[6], m[7], m[8], m[9]].map(Number);
    if (!(h >= l && o > 0)) continue;
    out.push({ t: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]), o, h, l, c });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** サーバー時刻の期間を UTC の範囲にする（[from, to)） */
export function rangeUtc(start: number, end: number): [number, number] {
  return [serverToUtc(start, rule), serverToUtc(end, rule)];
}

export function encodeBars(bars: readonly RawBar[], digits: number): Uint8Array {
  const scale = 10 ** digits;
  const out = new Int32Array(bars.length * FIELDS);
  bars.forEach((b, i) => {
    const o = i * FIELDS;
    out[o] = Math.round(b.t / 60_000);
    out[o + 1] = Math.round(b.o * scale);
    out[o + 2] = Math.round(b.h * scale);
    out[o + 3] = Math.round(b.l * scale);
    out[o + 4] = Math.round(b.c * scale);
    // Ask は無い（0）。固定スプレッドで Ask = Bid + スプレッド にする
  });
  return new Uint8Array(out.buffer);
}

export function decodeBars(buf: Uint8Array, digits: number): RawBar[] {
  const v = new Int32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const scale = 10 ** digits;
  const out: RawBar[] = [];
  for (let o = 0; o + FIELDS <= v.length; o += FIELDS) out.push({ t: v[o] * 60_000, o: v[o + 1] / scale, h: v[o + 2] / scale, l: v[o + 3] / scale, c: v[o + 4] / scale });
  return out;
}

const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);

/**
 * 取り込み済みの足（UTC の時刻順）に、ファイルの足を入れる。
 * そのファイルの期間にあった足は捨てて、ファイルの足に置き換える（MT4 が足を直したときも、ファイルどおりになる）
 */
export function mergeFiles(existing: readonly RawBar[], files: { range: [number, number]; bars: RawBar[] }[]): RawBar[] {
  const inChanged = (t: number) => files.some(({ range: [a, b] }) => t >= a && t < b);
  const out = existing.filter((b) => !inChanged(b.t));
  for (const d of files) for (const b of d.bars) if (b.t >= d.range[0] && b.t < d.range[1]) out.push(b);
  out.sort((a, b) => a.t - b.t);
  // 同じ時刻が 2 本あれば後の方（念のため）
  return out.filter((b, i) => i + 1 >= out.length || out[i + 1].t !== b.t);
}

/** 直接届いた今の価格（銘柄ごと。時刻は UTC） */
export interface LiveTick {
  /** Mac が受け取った時刻 */
  at: number;
  /** 最後の価格の時刻 */
  time: number;
  bid: number;
  ask: number;
  /** できかけの 1 分足 */
  bar: RawBar | null;
  /** 終わった 1 分足（古い順） */
  done: RawBar[];
}

/**
 * EA が送る本文を読む（時刻はサーバー時刻の秒）
 *   Q,<銘柄>,<時刻>,<Bid>,<Ask>
 *   B,<銘柄>,<足の時刻>,<始値>,<高値>,<安値>,<終値>   直近 3 本。最後の 1 本はできかけ
 */
export function parseTickBody(text: string, at: number): Map<string, LiveTick> {
  const out = new Map<string, LiveTick>();
  const get = (raw: string) => {
    const symbol = normalizeSymbol(raw).toLowerCase();
    if (!(symbol in SYMBOL_DIGITS)) return null;
    if (!out.has(symbol)) out.set(symbol, { at, time: 0, bid: 0, ask: 0, bar: null, done: [] });
    return out.get(symbol)!;
  };
  const bars = new Map<string, RawBar[]>();
  for (const line of text.split(/\r?\n/)) {
    const f = line.split(',');
    if (f[0] === 'Q' && f.length >= 5) {
      const e = get(f[1]);
      const [t, bid, ask] = [Number(f[2]), Number(f[3]), Number(f[4])];
      if (!e || !(t > 0 && bid > 0)) continue;
      e.time = serverToUtc(t * 1000, rule);
      e.bid = bid;
      e.ask = ask;
    } else if (f[0] === 'B' && f.length >= 7) {
      const e = get(f[1]);
      const [t, o, h, l, c] = f.slice(2, 7).map(Number);
      if (!e || !(t > 0 && o > 0 && h >= l)) continue;
      const sym = normalizeSymbol(f[1]).toLowerCase();
      if (!bars.has(sym)) bars.set(sym, []);
      bars.get(sym)!.push({ t: serverToUtc(t * 1000, rule), o, h, l, c });
    }
  }
  for (const [sym, list] of bars) {
    const e = out.get(sym)!;
    list.sort((a, b) => a.t - b.t);
    e.bar = list.at(-1) ?? null;
    e.done = list.slice(0, -1);
  }
  for (const [sym, e] of out) if (!e.bid) out.delete(sym);
  return out;
}

interface TitanInfo {
  months: string[];
  /** 最初と最後の足の時刻（UTC） */
  from: number;
  to: number;
}

interface Manifest {
  symbols: Record<string, { digits: number; months: string[]; titan?: TitanInfo }>;
}

export interface BarsStatus {
  dir: string;
  /** 共有フォルダが見つかったか */
  found: boolean;
  lastSync: number | null;
  error: string | null;
  /** 銘柄ごとの TitanFX の足の最後の時刻（UTC） */
  latest: Record<string, number>;
  /** MT4 が書いたサーバー時刻と GMT の差（分）と、アプリの決まり（ny-close）での差 */
  offset: { mt4: number; app: number; at: number } | null;
  /** 最後に価格が直接届いた時刻（Mac の時計） */
  liveAt: number | null;
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** 共有フォルダを 1 回見て、変わった日を取り込む */
export class BarsSync {
  /** ファイル名 → 前回見た mtime と大きさ */
  private seen = new Map<string, string>();
  private running = false;
  /** 取り込みは 1 つずつ（フォルダの取り込みと直接届いた足が同じファイルを書くため） */
  private chain: Promise<unknown> = Promise.resolve();
  /** 銘柄 → 直接届いた今の価格 */
  readonly ticks = new Map<string, LiveTick>();
  /** 価格が届いた・終わった足を取り込んだときに呼ぶ（/api/mt4/stream で FP へ流す） */
  readonly listeners = new Set<(symbol: string) => void>();
  /** 銘柄 → 直接届いた終わった足のうち、取り込んだ最後の時刻 */
  private directUntil = new Map<string, number>();
  status: BarsStatus;

  constructor(
    readonly dir: string,
    readonly dataDir: string,
  ) {
    this.status = { dir, found: false, lastSync: null, error: null, latest: {}, offset: null, liveAt: null };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** EA から直接届いた本文。今の価格を覚え、新しく終わった 1 分足があれば取り込む */
  async receive(text: string, at = Date.now()): Promise<void> {
    const got = parseTickBody(text, at);
    if (!got.size) return;
    this.status.liveAt = at;
    const fresh: [string, { range: [number, number]; bars: RawBar[] }][] = [];
    for (const [symbol, tick] of got) {
      this.ticks.set(symbol, tick);
      for (const l of this.listeners) l(symbol);
      const last = tick.done.at(-1);
      // 今日の足をまとめて送ってきたとき（EA が送り始めた直後）は、取り込み済みの時刻まででも入れ直す（抜けていた足を埋める）
      if (!last || (last.t <= (this.directUntil.get(symbol) ?? -Infinity) && tick.done.length <= 2)) continue;
      fresh.push([symbol, { range: [tick.done[0].t, last.t + 60_000], bars: tick.done }]);
    }
    if (!fresh.length) return;
    await this.serial(async () => {
      const manifest = await this.readManifest();
      for (const [symbol, d] of fresh) {
        await this.importSymbol(symbol, [d], manifest);
        this.directUntil.set(symbol, d.range[1] - 60_000);
      }
      await this.writeManifest(manifest);
    });
    // 終わった足を足したことも知らせる（FP がすぐ読み込む）
    for (const [symbol] of fresh) for (const l of this.listeners) l(symbol);
  }

  async sync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.serial(() => this.syncOnce());
      this.status.error = null;
    } catch (e) {
      this.status.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.status.lastSync = Date.now();
      this.running = false;
    }
  }

  private async syncOnce() {
    this.status.found = await exists(this.dir);
    if (!this.status.found) return;
    const names = await readdir(this.dir);
    await this.readStatus(names);
    // 銘柄ごとのフォルダ（USDJPY/USDJPY_2026.10.csv）の中も見る。じかに置いたファイルも読む
    const files: string[] = [];
    for (const name of names) {
      const st = await stat(path.join(this.dir, name)).catch(() => null);
      if (st?.isDirectory()) for (const sub of await readdir(path.join(this.dir, name)).catch(() => [])) files.push(path.join(name, sub));
      else files.push(name);
    }
    /** 銘柄 → 変わったファイル */
    const changed = new Map<string, { name: string; start: number; end: number; sig: string; live?: boolean }[]>();
    for (const name of files) {
      const liveSymbol = parseLiveFileName(path.basename(name));
      const p = liveSymbol ? { symbol: liveSymbol, start: 0, end: 0, live: true } : parseBarFileName(path.basename(name));
      if (!p) continue;
      const st = await stat(path.join(this.dir, name)).catch(() => null);
      if (!st) continue;
      const sig = `${st.mtimeMs}/${st.size}`;
      if (this.seen.get(name) === sig) continue;
      if (!changed.has(p.symbol)) changed.set(p.symbol, []);
      changed.get(p.symbol)!.push({ name, start: p.start, end: p.end, sig, live: 'live' in p });
    }
    // 直近のファイルは月ごとのファイルの後に入れる（重なる所は、新しい方 = 直近のファイルの足にする）
    for (const list of changed.values()) list.sort((a, b) => Number(!!a.live) - Number(!!b.live));
    if (!changed.size) return;

    const manifest = await this.readManifest();
    for (const [symbol, files] of changed) await this.importSymbol(symbol, await this.readFiles(files), manifest);
    // 取り込めたものだけ「見た」にする（途中で失敗したら次の回にもう一度）
    for (const files of changed.values()) for (const f of files) this.seen.set(f.name, f.sig);
    await this.writeManifest(manifest);
  }

  private async readManifest(): Promise<Manifest> {
    const manifestFile = path.join(this.dataDir, 'manifest.json');
    return (await exists(manifestFile)) ? JSON.parse(await readFile(manifestFile, 'utf8')) : { symbols: {} };
  }

  private async writeManifest(manifest: Manifest) {
    const manifestFile = path.join(this.dataDir, 'manifest.json');
    await mkdir(this.dataDir, { recursive: true });
    // npm run import-data が同時に書いた分を消さないよう、書く直前に読み直して titan と months だけ入れる
    const latest: Manifest = (await exists(manifestFile)) ? JSON.parse(await readFile(manifestFile, 'utf8')) : { symbols: {} };
    for (const [symbol, e] of Object.entries(manifest.symbols)) {
      if (!e.titan) continue;
      const cur = (latest.symbols[symbol] ??= { digits: e.digits, months: [] });
      cur.titan = e.titan;
      cur.months = [...new Set([...cur.months, ...e.titan.months])].sort();
    }
    await writeAtomic(manifestFile, JSON.stringify(latest, null, 2));
  }

  /** 共有フォルダのファイルを読む。受け持つ範囲は、月・日のファイルはその期間の初め〜最後の足、直近のファイルは中の最初の足〜最後の足 */
  private async readFiles(files: { name: string; start: number; end: number; live?: boolean }[]) {
    return Promise.all(
      files.map(async (f) => {
        const bars = parseBarCsv(await readFile(path.join(this.dir, f.name), 'utf8')).map((b) => ({ ...b, t: serverToUtc(b.t, rule) }));
        // 最後の足より後は消さない（直接届いた今日の足を、昨日までの月のファイルで消さないように）
        const end = (bars.at(-1)?.t ?? -Infinity) + 60_000;
        const range: [number, number] = f.live ? [bars[0]?.t ?? 0, end] : [rangeUtc(f.start, f.end)[0], Math.min(rangeUtc(f.start, f.end)[1], end)];
        return { range, bars };
      }),
    );
  }

  private async importSymbol(symbol: string, all: { range: [number, number]; bars: RawBar[] }[], manifest: Manifest) {
    const digits = SYMBOL_DIGITS[symbol];
    const parsed = all.filter((d) => d.range[1] > d.range[0]);
    if (!parsed.length) return;
    // 変わったファイルがかかる UTC の月ごとに、取り込み済みの足と合わせて書き直す
    // （サーバー時刻の月は、UTC では前の月の終わりの数時間から始まるので 2 か月にかかる）
    const months = new Set<string>();
    for (const d of parsed) {
      months.add(monthKey(d.range[0]));
      months.add(monthKey(d.range[1] - 1));
    }
    const outDir = path.join(this.dataDir, symbol, 'titan');
    await mkdir(outDir, { recursive: true });
    const entry = (manifest.symbols[symbol] ??= { digits, months: [] });
    const info: TitanInfo = entry.titan ?? { months: [], from: Infinity, to: -Infinity };
    for (const key of months) {
      const file = path.join(outDir, `${key}.bin`);
      const old = (await exists(file)) ? decodeBars(await readFile(file), digits) : [];
      const merged = mergeFiles(old, parsed).filter((b) => monthKey(b.t) === key);
      if (!merged.length) continue;
      const bytes = encodeBars(merged, digits);
      const prev = (await exists(file)) ? await readFile(file) : null;
      if (!prev || Buffer.compare(prev, bytes) !== 0) await writeAtomic(file, bytes);
      if (!info.months.includes(key)) info.months.push(key);
      info.from = Math.min(info.from, merged[0].t);
      info.to = Math.max(info.to, merged[merged.length - 1].t);
    }
    if (!info.months.length) return;
    info.months.sort();
    entry.titan = info;
    this.status.latest[symbol] = info.to;
  }

  private async readStatus(names: string[]) {
    if (!names.includes('_status.csv')) return;
    const text = await readFile(path.join(this.dir, '_status.csv'), 'utf8').catch(() => '');
    const row = text.split(/\r?\n/)[1]?.split(',');
    const m = row && /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2})/.exec(row[1] ?? '');
    const off = row ? Number(row[2]) : NaN;
    if (!m || !Number.isFinite(off)) return;
    const gmt = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    this.status.offset = { mt4: Math.round(off / 60), app: serverOffsetMinutes(rule, gmt), at: gmt };
  }

  /** 起動時: 取り込み済みの最後の時刻を manifest から読む */
  async loadLatest() {
    const manifestFile = path.join(this.dataDir, 'manifest.json');
    if (!(await exists(manifestFile))) return;
    const manifest: Manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    for (const [symbol, e] of Object.entries(manifest.symbols)) if (e.titan) this.status.latest[symbol] = e.titan.to;
  }
}

/**
 * R_ExportBarsHistory（EA）が、起動したときと取引を建てた・決済したときに書く取引履歴（R_ExportHistory と同じ形式）。
 * 共有フォルダ（fxp_bars）の 1 つ上の MQL4/Files にある。環境変数 FXP_HISTORY_FILE で変えられる
 */
export const historyFileOf = (barsDir: string) => process.env.FXP_HISTORY_FILE ?? path.join(path.dirname(barsDir), 'fx_practice_history.csv');

export function mt4Bars(dir = process.env.FXP_BARS_DIR ?? DEFAULT_BARS_DIR, dataDir = path.resolve('public/data')): Plugin {
  return {
    name: 'fxp-mt4-bars',
    configureServer(server) {
      // テスト（vitest）も vite の設定を読むが、そこでは見張らない
      if (process.env.VITEST) return;
      const sync = new BarsSync(dir, dataDir);
      void sync.loadLatest().then(() => sync.sync());
      const timer = setInterval(() => void sync.sync(), 15_000);
      timer.unref();
      const receiver = startTickReceiver(sync);
      server.httpServer?.on('close', () => {
        clearInterval(timer);
        receiver?.close();
      });
      // ライブ: 直接届いた今の価格（?sym=usdjpy）。10 秒より古ければ届いていないとみなす
      const liveJson = (sym: string) => {
        const tick = sync.ticks.get(sym);
        return JSON.stringify({ tick: tick && Date.now() - tick.at < 10_000 ? { ...tick, done: undefined } : null, latest: sync.status.latest[sym] ?? null });
      };
      server.middlewares.use('/api/mt4/tick', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(liveJson(new URL(req.url ?? '', 'http://x').searchParams.get('sym') ?? ''));
      });
      // 同じものを、届いた瞬間に流し続ける（Server-Sent Events。FP はライブの間だけつなぐ）
      server.middlewares.use('/api/mt4/stream', (req, res) => {
        const sym = new URL(req.url ?? '', 'http://x').searchParams.get('sym') ?? '';
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const send = (s: string) => s === sym && res.write(`data: ${liveJson(sym)}\n\n`);
        send(sym);
        sync.listeners.add(send);
        // つながっているかを確かめるため、15 秒ごとに空の行を送る
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          sync.listeners.delete(send);
        });
      });
      server.middlewares.use('/api/bars/status', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(sync.status));
      });
      // 取引履歴: ?since=<前回の mtime> と同じなら中身は返さない（1 分ごとに見に来るため）
      server.middlewares.use('/api/mt4/history', async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        const file = historyFileOf(dir);
        const st = await stat(file).catch(() => null);
        if (!st) return res.end(JSON.stringify({ found: false, file }));
        const mtime = Math.round(st.mtimeMs);
        const since = Number(new URL(req.url ?? '', 'http://x').searchParams.get('since'));
        if (since === mtime) return res.end(JSON.stringify({ found: true, file, mtime }));
        const text = await readFile(file, 'utf8').catch(() => null);
        res.end(JSON.stringify(text === null ? { found: false, file } : { found: true, file, mtime, text }));
      });
    },
  };
}

/**
 * T580 の EA から 1 秒ごとに届く価格を受け取る（家のネットワークから。Dropbox は通さない）。
 * 受け付けるのは POST /fxp/tick だけ（プロジェクトなどの API は開かない）。番号は環境変数 FXP_TICK_PORT（初期値 80。0 で止める）
 */
export function startTickReceiver(sync: BarsSync, port = Number(process.env.FXP_TICK_PORT ?? 80)): Server | null {
  if (!port) return null;
  const srv = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/fxp/tick') {
      res.statusCode = 404;
      return res.end();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      res.end('ok');
      void sync.receive(Buffer.concat(chunks).toString('utf8')).catch((e) => (sync.status.error = e instanceof Error ? e.message : String(e)));
    });
  });
  srv.on('error', (e) => console.warn(`[fxp] 価格を受け取る ${port} 番を開けませんでした: ${e.message}`));
  srv.listen(port, '0.0.0.0');
  srv.unref();
  return srv;
}
