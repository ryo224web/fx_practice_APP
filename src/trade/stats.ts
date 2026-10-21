import type { HistoryRow } from './account';

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  net: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  maxWin: number;
  maxLoss: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  /** 決済ベースの最大ドローダウン（円と %） */
  maxDrawdown: number;
  maxDrawdownPct: number;
}

export function computeStats(history: readonly HistoryRow[]): Stats {
  const trades = history.filter((h) => h.kind === 'trade').sort((a, b) => a.closeTime - b.closeTime);
  let balance = 0;
  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;
  let cw = 0;
  let cl = 0;
  const s: Stats = {
    trades: trades.length,
    wins: 0,
    losses: 0,
    winRate: NaN,
    grossProfit: 0,
    grossLoss: 0,
    net: 0,
    profitFactor: NaN,
    avgWin: NaN,
    avgLoss: NaN,
    expectancy: NaN,
    maxWin: 0,
    maxLoss: 0,
    maxConsecWins: 0,
    maxConsecLosses: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
  };
  // 入金を残高の起点にする
  const events = history
    .map((h) => ({ t: h.kind === 'balance' ? h.time : h.kind === 'trade' ? h.closeTime : Infinity, h }))
    .filter((e) => e.t !== Infinity)
    .sort((a, b) => a.t - b.t);
  for (const { h } of events) {
    if (h.kind === 'balance') {
      balance += h.amount;
      peak = Math.max(peak, balance);
      continue;
    }
    if (h.kind !== 'trade') continue;
    const p = h.profit;
    balance += p;
    if (p > 0) {
      s.wins++;
      s.grossProfit += p;
      s.maxWin = Math.max(s.maxWin, p);
      cw++;
      cl = 0;
    } else {
      s.losses++;
      s.grossLoss += p;
      s.maxLoss = Math.min(s.maxLoss, p);
      cl++;
      cw = 0;
    }
    s.maxConsecWins = Math.max(s.maxConsecWins, cw);
    s.maxConsecLosses = Math.max(s.maxConsecLosses, cl);
    peak = Math.max(peak, balance);
    const dd = peak - balance;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }
  s.net = s.grossProfit + s.grossLoss;
  if (s.trades) {
    s.winRate = (s.wins / s.trades) * 100;
    s.expectancy = s.net / s.trades;
  }
  if (s.wins) s.avgWin = s.grossProfit / s.wins;
  if (s.losses) s.avgLoss = s.grossLoss / s.losses;
  s.profitFactor = s.grossLoss < 0 ? s.grossProfit / -s.grossLoss : s.grossProfit > 0 ? Infinity : NaN;
  s.maxDrawdown = maxDd;
  s.maxDrawdownPct = maxDdPct * 100;
  return s;
}
