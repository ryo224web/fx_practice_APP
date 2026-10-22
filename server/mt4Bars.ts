// MT4（TitanFX）の 1 分足を、共有フォルダ（Dropbox）から自動で取り込む（開発サーバーに組み込む）。
// Windows 機の MT4 で scripts/mt4/ExportBars.mq4（EA）を動かすと、1 日 1 回（前日までの分）
//   <dir>/USDJPY/USDJPY_2026.10.csv 銘柄のフォルダに、サーバー時刻の月ごと（time,open,high,low,close,volume。時刻はサーバー時刻）
//   <dir>/_status.csv               MT4 のサーバー時刻と GMT の差など
// が書き換わる（今月と先月だけ。それより前の月のファイルはそのまま残る）。
// ここではフォルダを 15 秒ごとに見て、変わったファイルを
//   public/data/<銘柄>/titan/<YYYY-MM>.bin   （UTC の月ごと。形式は Dukascopy と同じ。Ask は無し = 0）
// に入れ、manifest.json の titan に範囲を書く。共有フォルダから消えたファイルも、取り込んだ分は残る。
// チャートは、TitanFX の足がある期間は TitanFX、その前（後）は Dukascopy を使う（src/data/store.ts）。
// フォルダは環境変数 FXP_BARS_DIR で変えられる。

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { DEFAULT_SERVER_RULE, serverOffsetMinutes, serverToUtc } from '../src/core/time.ts';
import { normalizeSymbol } from '../src/mt4/history.ts';
import { DEFAULT_PROJECT_DIR } from './projectStore.ts';

export const DEFAULT_BARS_DIR = path.join(DEFAULT_PROJECT_DIR, 'mt4_bars');

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
  status: BarsStatus;

  constructor(
    readonly dir: string,
    readonly dataDir: string,
  ) {
    this.status = { dir, found: false, lastSync: null, error: null, latest: {}, offset: null };
  }

  async sync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.syncOnce();
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
    const changed = new Map<string, { name: string; start: number; end: number; sig: string }[]>();
    for (const name of files) {
      const p = parseBarFileName(path.basename(name));
      if (!p) continue;
      const st = await stat(path.join(this.dir, name)).catch(() => null);
      if (!st) continue;
      const sig = `${st.mtimeMs}/${st.size}`;
      if (this.seen.get(name) === sig) continue;
      if (!changed.has(p.symbol)) changed.set(p.symbol, []);
      changed.get(p.symbol)!.push({ name, start: p.start, end: p.end, sig });
    }
    if (!changed.size) return;

    const manifestFile = path.join(this.dataDir, 'manifest.json');
    const manifest: Manifest = (await exists(manifestFile)) ? JSON.parse(await readFile(manifestFile, 'utf8')) : { symbols: {} };
    for (const [symbol, files] of changed) await this.importSymbol(symbol, files, manifest);
    // 取り込めたものだけ「見た」にする（途中で失敗したら次の回にもう一度）
    for (const files of changed.values()) for (const f of files) this.seen.set(f.name, f.sig);
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

  private async importSymbol(symbol: string, files: { name: string; start: number; end: number }[], manifest: Manifest) {
    const digits = SYMBOL_DIGITS[symbol];
    const parsed = await Promise.all(
      files.map(async (f) => {
        const range = rangeUtc(f.start, f.end);
        const bars = parseBarCsv(await readFile(path.join(this.dir, f.name), 'utf8')).map((b) => ({ ...b, t: serverToUtc(b.t, rule) }));
        return { range, bars };
      }),
    );
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
      server.httpServer?.on('close', () => clearInterval(timer));
      server.middlewares.use('/api/bars/status', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(sync.status));
      });
    },
  };
}
