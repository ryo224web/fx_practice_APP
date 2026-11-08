// 「T/P を S/L の幅の何倍にしていたら」の試算（成績タブ）。
// 実際の取引の建値・S/L はそのまま、T/P だけを建値から S/L の幅 × k の所に置き直して、1 分足でどちらに先に届くかを見る。
// 手で早く決済した取引も、S/L か新しい T/P に届くまで持っていたとみなす（ルールどおりに持ち続けたら、を見るため）。
// 約定の決まりは口座と同じ: 買いは Bid、売りは Ask（Bid + スプレッド）で決済。足の始値がもう越えていれば始値で決済。
// 同じ足で両方に届いたら、陽線は安値が先・陰線は高値が先とみなす。建てた足の中は見ない（成行は足の終値で建つため）。

import type { Bar } from '../core/candles';
import type { TradeRecord } from './analysis';

/** 試算する T/P（S/L の幅の何倍か） */
export const TP_MULTIPLES = [1, 1.5, 2, 2.5, 3];

/**
 * 1 回の取引の結果（R）。bars は時刻順の Bid の 1 分足（建てた後の足を含むもの）。
 * S/L が無い・建値と同じか有利な側にある取引は null。どちらにも届かないうちに足が尽きたら 'open'
 */
export function simulateTp(t: Pick<TradeRecord, 'side' | 'openTime' | 'openPrice' | 'sl'>, bars: readonly Bar[], spread: number, k: number): number | 'open' | null {
  if (t.sl === null) return null;
  const dir = t.side === 'buy' ? 1 : -1;
  const risk = (t.openPrice - t.sl) * dir;
  if (!(risk > t.openPrice * 1e-6)) return null;
  const tp = t.openPrice + dir * risk * k;
  const sl = t.sl;
  const r = (exit: number) => ((exit - t.openPrice) * dir) / risk;
  // 建てた足の次から
  let i = lowerBound(bars, t.openTime + 1);
  for (; i < bars.length; i++) {
    const b = bars[i];
    // 決済に使う側の値（売りは Ask）
    const sp = dir > 0 ? 0 : spread;
    const o = b.o + sp;
    const h = b.h + sp;
    const l = b.l + sp;
    if (dir > 0) {
      if (o <= sl) return r(o);
      if (o >= tp) return r(o);
      const hitSl = l <= sl;
      const hitTp = h >= tp;
      if (hitSl && hitTp) return b.c >= b.o ? r(sl) : r(tp); // 陽線は安値が先
      if (hitSl) return r(sl);
      if (hitTp) return r(tp);
    } else {
      if (o >= sl) return r(o);
      if (o <= tp) return r(o);
      const hitSl = h >= sl;
      const hitTp = l <= tp;
      if (hitSl && hitTp) return b.c >= b.o ? r(tp) : r(sl); // 陽線は安値が先 = 売りは T/P が先
      if (hitSl) return r(sl);
      if (hitTp) return r(tp);
    }
  }
  return 'open';
}

/** t 以上の時刻の最初の足の位置 */
function lowerBound(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].t < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export interface TpSimRow {
  k: number;
  /** 決まった回数（S/L か T/P に届いた） */
  trades: number;
  wins: number;
  losses: number;
  /** 足が尽きて決まらなかった回数 */
  open: number;
  winRate: number;
  totalR: number;
  avgR: number;
  maxDrawdownR: number;
}

/** 決まった順（決済した順ではなく、建てた順）に R を並べて集計する */
export function summarizeTp(k: number, results: readonly (number | 'open' | null)[]): TpSimRow {
  let wins = 0;
  let losses = 0;
  let open = 0;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const x of results) {
    if (x === null) continue;
    if (x === 'open') {
      open++;
      continue;
    }
    if (x > 0) wins++;
    else losses++;
    cum += x;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const n = wins + losses;
  return { k, trades: n, wins, losses, open, winRate: n ? (wins / n) * 100 : NaN, totalR: cum, avgR: n ? cum / n : NaN, maxDrawdownR: dd };
}
