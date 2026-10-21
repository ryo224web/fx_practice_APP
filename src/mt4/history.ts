// MT4 の取引履歴の読み込み。次の 2 つの形式に対応する。
// - MT4 の「口座履歴」→ 右クリック →「詳細レポートの保存」で作る .htm
// - scripts/mt4/ExportHistory.mq4 で書き出す .csv（こちらの方が確実）
// 時刻は MT4 のサーバー時刻のまま読み、UTC への変換は呼び出し側で行う。
// 約定の価格・時刻は記録のまま使い、計算し直さない（R2）。

import type { Bar } from '../core/candles';

export interface Mt4Trade {
  ticket: number;
  side: 'buy' | 'sell';
  lots: number;
  /** "USDJPY" など。ブローカーの接尾辞（".a" など）は取り除く */
  symbol: string;
  /** サーバー時刻（壁時計の値を UTC 形式のミリ秒で表したもの） */
  openServer: number;
  openPrice: number;
  sl: number | null;
  tp: number | null;
  /** まだ決済していなければ null */
  closeServer: number | null;
  closePrice: number | null;
  commission: number;
  swap: number;
  profit: number;
  comment: string;
}

/** "2026.10.20 15:30:12" → サーバー時刻のミリ秒。読めなければ NaN */
export function parseMt4Time(s: string): number {
  const m = /(\d{4})\.(\d{2})\.(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

/** "1 234.56" や "1,234.56" も読む */
function num(s: string): number {
  const v = Number(s.replace(/[\s, ]/g, ''));
  return Number.isFinite(v) ? v : NaN;
}

function stopOrNull(s: string): number | null {
  const v = num(s);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function normalizeSymbol(s: string): string {
  const m = /[A-Za-z]{6}/.exec(s);
  return (m ? m[0] : s).toUpperCase();
}

function decode(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * 詳細レポート（.htm）を読む。表の行のうち、3 列目が buy / sell の行を取引とみなす。
 * 列の並び: 注文番号, 注文時間, 種別, 数量, 通貨ペア, 価格, S/L, T/P, 決済時間, 価格, 手数料, 税金, スワップ, 損益
 */
export function parseStatementHtml(html: string): Mt4Trade[] {
  const trades: Mt4Trade[] = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(decode);
    if (cells.length < 14) continue;
    const type = cells[2].toLowerCase();
    if (type !== 'buy' && type !== 'sell') continue;
    const ticket = num(cells[0]);
    const openServer = parseMt4Time(cells[1]);
    if (!Number.isFinite(ticket) || !Number.isFinite(openServer)) continue;
    const closeServer = parseMt4Time(cells[8]);
    const open = Number.isFinite(closeServer);
    trades.push({
      ticket,
      side: type,
      lots: num(cells[3]),
      symbol: normalizeSymbol(cells[4]),
      openServer,
      openPrice: num(cells[5]),
      sl: stopOrNull(cells[6]),
      tp: stopOrNull(cells[7]),
      closeServer: open ? closeServer : null,
      closePrice: open ? num(cells[9]) : null,
      commission: num(cells[10]) || 0,
      swap: num(cells[12]) || 0,
      profit: num(cells[13]) || 0,
      comment: '',
    });
  }
  return dedupe(trades);
}

/**
 * ExportHistory.mq4 の CSV を読む。1 行目は見出し。
 * ticket,open_time,type,lots,symbol,open_price,sl,tp,close_time,close_price,commission,swap,profit,comment
 */
export function parseHistoryCsv(text: string): Mt4Trade[] {
  const trades: Mt4Trade[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const c = line.split(',');
    if (c.length < 13) continue;
    const type = c[2].trim().toLowerCase();
    if (type !== 'buy' && type !== 'sell') continue;
    const closeServer = parseMt4Time(c[8]);
    const closed = Number.isFinite(closeServer);
    trades.push({
      ticket: num(c[0]),
      side: type,
      lots: num(c[3]),
      symbol: normalizeSymbol(c[4]),
      openServer: parseMt4Time(c[1]),
      openPrice: num(c[5]),
      sl: stopOrNull(c[6]),
      tp: stopOrNull(c[7]),
      closeServer: closed ? closeServer : null,
      closePrice: closed ? num(c[9]) : null,
      commission: num(c[10]) || 0,
      swap: num(c[11]) || 0,
      profit: num(c[12]) || 0,
      comment: c.slice(13).join(',').trim(),
    });
  }
  return dedupe(trades.filter((t) => Number.isFinite(t.ticket) && Number.isFinite(t.openServer)));
}

export function parseHistoryFile(name: string, text: string): Mt4Trade[] {
  return /\.csv$/i.test(name) || !/<tr/i.test(text) ? parseHistoryCsv(text) : parseStatementHtml(text);
}

function dedupe(trades: Mt4Trade[]): Mt4Trade[] {
  const byTicket = new Map<number, Mt4Trade>();
  for (const t of trades) byTicket.set(t.ticket, t);
  return [...byTicket.values()].sort((a, b) => a.openServer - b.openServer);
}

/** 価格データとの照合 */
export interface PriceLookup {
  /** UTC 時刻を含む 1 分足（無ければ null） */
  bar(utc: number): { bid: Bar; ask: Bar } | null;
}

export interface MatchResult {
  open: boolean | null;
  close: boolean | null;
}

/**
 * 記録の価格が、その時刻の 1 分足の値幅（買いの建値・売りの決済は Ask、逆は Bid）に収まるか。
 * データが無ければ null。tol は許すずれ（データ元が違うので少し余裕を持たせる）
 */
export function matchTrade(t: Mt4Trade, toUtc: (server: number) => number, prices: PriceLookup, tol: number): MatchResult {
  const check = (server: number, price: number, useAsk: boolean): boolean | null => {
    const b = prices.bar(toUtc(server));
    if (!b) return null;
    const bar = useAsk ? b.ask : b.bid;
    return price >= bar.l - tol && price <= bar.h + tol;
  };
  return {
    open: check(t.openServer, t.openPrice, t.side === 'buy'),
    close: t.closeServer === null || t.closePrice === null ? null : check(t.closeServer, t.closePrice, t.side === 'sell'),
  };
}

/**
 * 時刻のずれ（時間単位）を自動で見つける。-12〜+12 時間を試し、記録の価格が
 * その時刻の足に収まる件数が一番多いずれを選ぶ（同点なら 0 に近い方）。
 */
export function detectOffsetHours(
  trades: Mt4Trade[],
  toUtc: (server: number) => number,
  prices: PriceLookup,
  tol: number,
): { hours: number; matched: number; checked: number } {
  let best = { hours: 0, matched: -1, checked: 0 };
  for (let h = 0; h <= 12; h = h <= 0 ? -h + 1 : -h) {
    let matched = 0;
    let checked = 0;
    const shifted = (s: number) => toUtc(s) + h * 3_600_000;
    for (const t of trades) {
      const r = matchTrade(t, shifted, prices, tol);
      for (const v of [r.open, r.close]) {
        if (v === null) continue;
        checked++;
        if (v) matched++;
      }
    }
    if (matched > best.matched) best = { hours: h, matched, checked };
    if (h === -12) break;
  }
  return best;
}
