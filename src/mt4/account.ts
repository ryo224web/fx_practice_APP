// MT4 の取引を口座にする（「新しい検証」で口座を「MT4 の取引」にしたとき）。
// 記録の時刻に建ち、記録の時刻・価格・損益（損益 + スワップ + 手数料）で決済する。計算し直さない（R2）。
// 保有中の含み損益だけは、口座（Account）がチャートの価格で計算する。

import type { SymbolSpec } from '../core/symbols';
import { Account, type AccountSettings } from '../trade/account';
import type { Mt4Trade } from './history';

export interface Mt4AccountOptions {
  /** 検証を始めた時刻（UTC）。これより前に決済した取引は入れない */
  start: number;
  /** 初期資金（円） */
  balance: number;
  /** 今の時刻（UTC）。これより前に建った取引が入り、これより前に決済した取引は口座履歴に入る */
  now: number;
  /** 今の銘柄（小文字）。保有中の取引はこの銘柄だけ（含み損益をチャートの価格で計算するため） */
  symbol: string;
  /** サーバー時刻 → UTC（銘柄ごとの時刻のずれも含む） */
  toUtc: (server: number) => number;
  pipOf: (symbol: string) => number;
}

export function buildMt4Account(spec: SymbolSpec, settings: AccountSettings, trades: readonly Mt4Trade[], o: Mt4AccountOptions): Account {
  const a = new Account(spec, settings, {
    time: o.start,
    balance: o.balance,
    history: [{ kind: 'balance', ticket: 1, time: o.start, amount: o.balance, comment: 'Deposit' }],
    nextTicket: 2,
  });
  const list = trades
    .map((x) => ({ x, open: o.toUtc(x.openServer), close: x.closeServer === null ? null : o.toUtc(x.closeServer) }))
    .sort((p, q) => (p.close ?? Infinity) - (q.close ?? Infinity) || p.x.ticket - q.x.ticket);
  for (const { x, open, close } of list) {
    // 検証を始める前に決済した取引と、まだ建っていない取引は入れない
    if ((close !== null && close < o.start) || open >= o.now) continue;
    const symbol = x.symbol.toLowerCase();
    if (close !== null && close < o.now && x.closePrice !== null) {
      const profit = x.profit + x.swap + x.commission;
      const pip = o.pipOf(x.symbol);
      a.balance += profit;
      a.history.push({
        kind: 'trade',
        ticket: x.ticket,
        symbol,
        side: x.side,
        lots: x.lots,
        openTime: open,
        openPrice: x.openPrice,
        sl: x.sl,
        tp: x.tp,
        closeTime: close,
        closePrice: x.closePrice,
        profit,
        // MT4 の履歴には決済の理由が無いので、記録の価格が S/L・T/P と同じかで見分ける
        reason: x.sl !== null && Math.abs(x.closePrice - x.sl) < pip * 0.5 ? 'sl' : x.tp !== null && Math.abs(x.closePrice - x.tp) < pip * 0.5 ? 'tp' : 'manual',
        comment: x.comment || 'MT4',
      });
    } else if (symbol === o.symbol) {
      a.positions.push({ ticket: x.ticket, symbol, side: x.side, lots: x.lots, openTime: open, openPrice: x.openPrice, sl: x.sl, tp: x.tp, comment: x.comment || 'MT4' });
    }
  }
  return a;
}
