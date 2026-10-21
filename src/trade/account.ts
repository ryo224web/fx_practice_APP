// 仮想口座。MT4 と同じく、買いは Ask で建てて Bid で決済、売りは Bid で建てて Ask で決済する。
//
// 巻き戻しに対応するため、口座の状態は「利用者の操作の記録（actions）」と価格データから
// 毎回同じように計算し直せる形にしている。操作は 1 分足の終わり（その足の終値の時点）に行われたものとする。

import type { Bar } from '../core/candles';
import type { SymbolSpec } from '../core/symbols';

export type Side = 'buy' | 'sell';
export type PendingType = 'buylimit' | 'selllimit' | 'buystop' | 'sellstop';
export type OrderType = Side | PendingType;

export interface Position {
  ticket: number;
  symbol: string;
  side: Side;
  lots: number;
  openTime: number;
  openPrice: number;
  sl: number | null;
  tp: number | null;
  comment: string;
  /**
   * 建ててから一番有利・不利だった決済側の価格（買いは Bid、売りは Ask）。MAE・MFE に使う。
   * 建てた足（約定の前の値動きを含む）と決済した足（決済の後の値動きを含む）は入れない
   */
  best?: number;
  worst?: number;
}

export interface PendingOrder {
  ticket: number;
  symbol: string;
  type: PendingType;
  lots: number;
  price: number;
  sl: number | null;
  tp: number | null;
  placedTime: number;
}

export type CloseReason = 'manual' | 'sl' | 'tp';

/** 口座履歴の 1 行 */
export type HistoryRow =
  | { kind: 'balance'; ticket: number; time: number; amount: number; comment: string }
  | {
      kind: 'trade';
      ticket: number;
      symbol: string;
      side: Side;
      lots: number;
      openTime: number;
      openPrice: number;
      sl: number | null;
      tp: number | null;
      closeTime: number;
      closePrice: number;
      profit: number;
      reason: CloseReason;
      comment: string;
      /** 保有中に一番不利・有利だった値幅（価格。含み損は 0 以下、含み益は 0 以上） */
      mae?: number;
      mfe?: number;
    }
  | {
      kind: 'cancelled';
      ticket: number;
      symbol: string;
      type: PendingType;
      lots: number;
      price: number;
      sl: number | null;
      tp: number | null;
      placedTime: number;
      closeTime: number;
    };

export type Action =
  | { t: number; kind: 'market'; side: Side; lots: number; sl: number | null; tp: number | null }
  | { t: number; kind: 'pending'; type: PendingType; price: number; lots: number; sl: number | null; tp: number | null }
  | { t: number; kind: 'modify'; ticket: number; sl: number | null; tp: number | null; price?: number }
  | { t: number; kind: 'close'; ticket: number; lots?: number }
  | { t: number; kind: 'cancel'; ticket: number };

/** 時刻を付ける前の操作（画面から作るとき用） */
export type NewAction = Action extends infer A ? (A extends Action ? Omit<A, 't'> : never) : never;

/** 検証の開始時点の口座（銘柄を切り替えたときもここから続ける） */
export interface Baseline {
  time: number;
  balance: number;
  history: HistoryRow[];
  nextTicket: number;
}

export interface AccountSettings {
  leverage: number;
}

/** 価格データ。添字は 1 分足の位置 */
export interface PriceFeed {
  bid: readonly Bar[];
  ask: readonly Bar[];
  /** 決済通貨 → 円の換算レート（その足の時点）。換算できなければ NaN */
  jpyRate(index: number): number;
}

/** 足の中で起きたこと（一時停止や表示に使う） */
export interface FillEvent {
  kind: 'open' | 'sl' | 'tp';
  ticket: number;
  time: number;
}

/** 足の中で価格が通る順番。陽線は 始値→安値→高値→終値、陰線は 始値→高値→安値→終値 とみなす */
function lowFirst(b: Bar): boolean {
  return b.c >= b.o;
}

export class Account {
  balance: number;
  positions: Position[] = [];
  orders: PendingOrder[] = [];
  history: HistoryRow[];
  nextTicket: number;
  /** 最後に処理した 1 分足の時刻 */
  time: number;

  constructor(
    readonly spec: SymbolSpec,
    readonly settings: AccountSettings,
    baseline: Baseline,
  ) {
    this.balance = baseline.balance;
    this.history = baseline.history.slice();
    this.nextTicket = baseline.nextTicket;
    this.time = baseline.time;
  }

  private units(lots: number) {
    return lots * this.spec.contract;
  }

  /** 決済したときの損益（円） */
  profitOf(p: Position, closePrice: number, rate: number): number {
    const dir = p.side === 'buy' ? 1 : -1;
    return (closePrice - p.openPrice) * dir * this.units(p.lots) * rate;
  }

  /** i 番目の 1 分足で、指値・逆指値の約定と SL・TP を処理する */
  processBar(feed: PriceFeed, i: number): FillEvent[] {
    const B = feed.bid[i];
    const A = feed.ask[i];
    const events: FillEvent[] = [];
    const rate = feed.jpyRate(i);

    for (const o of this.orders.slice()) {
      const fill = triggerPrice(o, B, A);
      if (fill === null) continue;
      this.orders = this.orders.filter((x) => x !== o);
      this.positions.push({
        ticket: o.ticket,
        symbol: o.symbol,
        side: o.type.startsWith('buy') ? 'buy' : 'sell',
        lots: o.lots,
        openTime: B.t,
        openPrice: fill,
        sl: o.sl,
        tp: o.tp,
        comment: '',
      });
      events.push({ kind: 'open', ticket: o.ticket, time: B.t });
    }

    const filledNow = new Set(events.map((e) => e.ticket));
    for (const p of this.positions.slice()) {
      // この足で約定したポジションの S/L・T/P は次の足から見る。1 分足では約定の前か後か分からず、
      // 約定より前の安値・高値・始値で決済してしまうことがあるため
      if (filledNow.has(p.ticket)) continue;
      const hit = stopHit(p, B, A);
      if (!hit) {
        // 決済しなかった足は、足の値幅を含み損益の最大・最小に入れる（決済した足は決済の価格だけを入れる）
        const bar = p.side === 'buy' ? B : A;
        const [good, bad] = p.side === 'buy' ? [bar.h, bar.l] : [bar.l, bar.h];
        const dir = p.side === 'buy' ? 1 : -1;
        if (p.best === undefined || (good - p.best) * dir > 0) p.best = good;
        if (p.worst === undefined || (bad - p.worst) * dir < 0) p.worst = bad;
        continue;
      }
      this.closePosition(p, p.lots, hit.price, B.t, hit.reason, rate);
      events.push({ kind: hit.reason, ticket: p.ticket, time: B.t });
    }
    this.time = B.t;
    return events;
  }

  /** 操作を行う。i は操作した時点の 1 分足（その終値で約定）。うまくいかなければ理由を返す */
  apply(feed: PriceFeed, i: number, a: Action): string | null {
    const bid = feed.bid[i].c;
    const ask = feed.ask[i].c;
    const t = feed.bid[i].t;
    const rate = feed.jpyRate(i);
    switch (a.kind) {
      case 'market': {
        if (!(a.lots > 0)) return 'ロット数が正しくありません';
        const price = a.side === 'buy' ? ask : bid;
        const err = checkStops(a.side, a.side === 'buy' ? bid : ask, a.sl, a.tp);
        if (err) return err;
        if (!Number.isFinite(rate)) return `${this.spec.quote} を円に換算できないため取引できません（USDJPY のデータが必要です）`;
        this.positions.push({
          ticket: this.nextTicket++,
          symbol: this.spec.name,
          side: a.side,
          lots: a.lots,
          openTime: t,
          openPrice: price,
          sl: a.sl,
          tp: a.tp,
          comment: '',
        });
        return null;
      }
      case 'pending': {
        if (!(a.lots > 0)) return 'ロット数が正しくありません';
        if (!Number.isFinite(rate)) return `${this.spec.quote} を円に換算できないため取引できません（USDJPY のデータが必要です）`;
        const err = checkPending(a.type, a.price, bid, ask) ?? checkStops(a.type.startsWith('buy') ? 'buy' : 'sell', a.price, a.sl, a.tp);
        if (err) return err;
        this.orders.push({
          ticket: this.nextTicket++,
          symbol: this.spec.name,
          type: a.type,
          lots: a.lots,
          price: a.price,
          sl: a.sl,
          tp: a.tp,
          placedTime: t,
        });
        return null;
      }
      case 'modify': {
        const p = this.positions.find((x) => x.ticket === a.ticket);
        if (p) {
          const err = checkStops(p.side, p.side === 'buy' ? bid : ask, a.sl, a.tp);
          if (err) return err;
          p.sl = a.sl;
          p.tp = a.tp;
          return null;
        }
        const o = this.orders.find((x) => x.ticket === a.ticket);
        if (!o) return `#${a.ticket} が見つかりません`;
        const price = a.price ?? o.price;
        const err = checkPending(o.type, price, bid, ask) ?? checkStops(o.type.startsWith('buy') ? 'buy' : 'sell', price, a.sl, a.tp);
        if (err) return err;
        o.price = price;
        o.sl = a.sl;
        o.tp = a.tp;
        return null;
      }
      case 'close': {
        const p = this.positions.find((x) => x.ticket === a.ticket);
        if (!p) return `#${a.ticket} が見つかりません`;
        const lots = a.lots ?? p.lots;
        if (!(lots > 0) || lots > p.lots + 1e-9) return 'ロット数が正しくありません';
        this.closePosition(p, lots, p.side === 'buy' ? bid : ask, t, 'manual', rate);
        return null;
      }
      case 'cancel': {
        const o = this.orders.find((x) => x.ticket === a.ticket);
        if (!o) return `#${a.ticket} が見つかりません`;
        this.orders = this.orders.filter((x) => x !== o);
        this.history.push({ kind: 'cancelled', ...o, closeTime: t });
        return null;
      }
    }
  }

  private closePosition(p: Position, lots: number, price: number, t: number, reason: CloseReason, rate: number) {
    const part = { ...p, lots };
    const profit = this.profitOf(part, price, rate);
    const dir = p.side === 'buy' ? 1 : -1;
    const done = (price - p.openPrice) * dir;
    const mae = Math.min(0, done, p.worst === undefined ? 0 : (p.worst - p.openPrice) * dir);
    const mfe = Math.max(0, done, p.best === undefined ? 0 : (p.best - p.openPrice) * dir);
    this.balance += profit;
    this.history.push({
      kind: 'trade',
      ticket: p.ticket,
      symbol: p.symbol,
      side: p.side,
      lots,
      openTime: p.openTime,
      openPrice: p.openPrice,
      sl: p.sl,
      tp: p.tp,
      closeTime: t,
      closePrice: price,
      profit,
      reason,
      comment: p.comment,
      mae,
      mfe,
    });
    this.positions = this.positions.filter((x) => x !== p);
    // 一部決済は MT4 と同じく、残りを新しい注文番号で持ち続ける
    const rest = Math.round((p.lots - lots) * 100) / 100;
    if (rest > 0) this.positions.push({ ...p, ticket: this.nextTicket++, lots: rest, comment: `from #${p.ticket}` });
  }

  /** i 番目の足の終値で見た含み損益・証拠金など */
  summary(feed: PriceFeed, i: number) {
    const rate = feed.jpyRate(i);
    const bid = feed.bid[i]?.c ?? NaN;
    const ask = feed.ask[i]?.c ?? NaN;
    let floating = 0;
    let margin = 0;
    for (const p of this.positions) {
      floating += this.profitOf(p, p.side === 'buy' ? bid : ask, rate);
      margin += (this.units(p.lots) * p.openPrice * rate) / this.settings.leverage;
    }
    const equity = this.balance + floating;
    return { balance: this.balance, equity, margin, free: equity - margin, level: margin > 0 ? (equity / margin) * 100 : NaN, floating };
  }

  floatingOf(feed: PriceFeed, i: number, p: Position): number {
    return this.profitOf(p, p.side === 'buy' ? feed.bid[i].c : feed.ask[i].c, feed.jpyRate(i));
  }
}

function triggerPrice(o: PendingOrder, B: Bar, A: Bar): number | null {
  switch (o.type) {
    case 'buylimit':
      return A.o <= o.price ? A.o : A.l <= o.price ? o.price : null;
    case 'buystop':
      return A.o >= o.price ? A.o : A.h >= o.price ? o.price : null;
    case 'selllimit':
      return B.o >= o.price ? B.o : B.h >= o.price ? o.price : null;
    case 'sellstop':
      return B.o <= o.price ? B.o : B.l <= o.price ? o.price : null;
  }
}

/** SL・TP に届いたか。窓を開けて飛び越えたときは始値で決済する */
function stopHit(p: Position, B: Bar, A: Bar): { price: number; reason: 'sl' | 'tp' } | null {
  if (p.side === 'buy') {
    // 買いの決済は Bid
    if (p.sl !== null && B.o <= p.sl) return { price: B.o, reason: 'sl' };
    if (p.tp !== null && B.o >= p.tp) return { price: B.o, reason: 'tp' };
    const sl = p.sl !== null && B.l <= p.sl;
    const tp = p.tp !== null && B.h >= p.tp;
    if (sl && tp) return lowFirst(B) ? { price: p.sl!, reason: 'sl' } : { price: p.tp!, reason: 'tp' };
    if (sl) return { price: p.sl!, reason: 'sl' };
    if (tp) return { price: p.tp!, reason: 'tp' };
    return null;
  }
  // 売りの決済は Ask
  if (p.sl !== null && A.o >= p.sl) return { price: A.o, reason: 'sl' };
  if (p.tp !== null && A.o <= p.tp) return { price: A.o, reason: 'tp' };
  const sl = p.sl !== null && A.h >= p.sl;
  const tp = p.tp !== null && A.l <= p.tp;
  if (sl && tp) return lowFirst(A) ? { price: p.tp!, reason: 'tp' } : { price: p.sl!, reason: 'sl' };
  if (sl) return { price: p.sl!, reason: 'sl' };
  if (tp) return { price: p.tp!, reason: 'tp' };
  return null;
}

/** SL・TP の位置が正しいか。ref は買いなら決済に使う Bid（指値注文なら注文価格） */
function checkStops(side: Side, ref: number, sl: number | null, tp: number | null): string | null {
  if (side === 'buy') {
    if (sl !== null && sl >= ref) return '買いの決済逆指値（S/L）は現在の Bid より下にしてください';
    if (tp !== null && tp <= ref) return '買いの決済指値（T/P）は現在の Bid より上にしてください';
  } else {
    if (sl !== null && sl <= ref) return '売りの決済逆指値（S/L）は現在の Ask より上にしてください';
    if (tp !== null && tp >= ref) return '売りの決済指値（T/P）は現在の Ask より下にしてください';
  }
  return null;
}

function checkPending(type: PendingType, price: number, bid: number, ask: number): string | null {
  if (!(price > 0)) return '価格が正しくありません';
  switch (type) {
    case 'buylimit':
      return price < ask ? null : 'Buy Limit は現在の Ask より下に置いてください';
    case 'buystop':
      return price > ask ? null : 'Buy Stop は現在の Ask より上に置いてください';
    case 'selllimit':
      return price > bid ? null : 'Sell Limit は現在の Bid より上に置いてください';
    case 'sellstop':
      return price < bid ? null : 'Sell Stop は現在の Bid より下に置いてください';
  }
}

/**
 * 記録した操作を最初から再生して、toIndex 番目の足の時点の口座を作る。
 * 巻き戻しやページの再読み込みのときに使う。失敗した操作は記録から除く。
 */
export function replayAccount(
  spec: SymbolSpec,
  settings: AccountSettings,
  baseline: Baseline,
  actions: Action[],
  feed: PriceFeed,
  fromIndex: number,
  toIndex: number,
): { account: Account; actions: Action[] } {
  const account = new Account(spec, settings, baseline);
  const kept: Action[] = [];
  let k = 0;
  const sorted = actions.slice().sort((a, b) => a.t - b.t);
  for (let i = Math.max(0, fromIndex); i <= toIndex; i++) {
    account.processBar(feed, i);
    const t = feed.bid[i].t;
    while (k < sorted.length && sorted[k].t <= t) {
      if (account.apply(feed, i, sorted[k]) === null) kept.push(sorted[k]);
      k++;
    }
  }
  return { account, actions: kept };
}
