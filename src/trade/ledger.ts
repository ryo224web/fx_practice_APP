// 長い検証（10 年など）のための仕組み。
// - 月が変わるたびに口座の状態を「区切り（checkpoint）」として覚えておく
// - 巻き戻しや開き直しは、検証の最初からではなく、手前の区切りから計算し直す
// - 価格データは一部の期間しか読み込んでいなくてよい（読み込んだ範囲ごとに、続きから計算できる）
// 区切りから計算し直しても、最初から計算したのと同じ結果になる（tests/ledger.test.ts で確かめている）。

import type { SymbolSpec } from '../core/symbols';
import { Account, type AccountSettings, type Action, type Baseline, type FillEvent, type HistoryRow, type PendingOrder, type Position, type PriceFeed } from './account';

/** 計算のしかたを変えたら上げる。保存した区切りと版が違えば、最初から計算し直す */
export const CALC_VERSION = 1;

/** ある時刻（その 1 分足を処理し、その足の操作も済んだ後）の口座 */
export interface Checkpoint {
  time: number;
  balance: number;
  positions: Position[];
  orders: PendingOrder[];
  nextTicket: number;
  /** その時点の口座履歴の件数（履歴は後ろに足していくだけなので、先頭からこの件数がその時点の履歴） */
  historyLen: number;
}

/** プロジェクトに保存する計算結果（操作の記録から作り直せるが、長い検証では時間がかかるので残す） */
export interface Ledger {
  version: number;
  baselineTime: number;
  /** 保存した時点の操作の数と最後の操作の時刻（変わっていれば使わない） */
  actionsCount: number;
  lastActionT: number | null;
  history: HistoryRow[];
  checkpoints: Checkpoint[];
}

const monthKey = (t: number) => {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};

const clonePositions = (ps: Position[]) => ps.map((p) => ({ ...p }));
const cloneOrders = (os: PendingOrder[]) => os.map((o) => ({ ...o }));

export function snapshot(a: Account): Checkpoint {
  return {
    time: a.time,
    balance: a.balance,
    positions: clonePositions(a.positions),
    orders: cloneOrders(a.orders),
    nextTicket: a.nextTicket,
    historyLen: a.history.length,
  };
}

/** 区切り（無ければ検証の出発点）から口座を作る */
export function restoreAccount(
  spec: SymbolSpec,
  settings: AccountSettings,
  baseline: Baseline,
  history: readonly HistoryRow[],
  cp: Checkpoint | null,
): Account {
  if (!cp) return new Account(spec, settings, baseline);
  const a = new Account(spec, settings, { time: cp.time, balance: cp.balance, history: history.slice(0, cp.historyLen), nextTicket: cp.nextTicket });
  a.positions = clonePositions(cp.positions);
  a.orders = cloneOrders(cp.orders);
  return a;
}

/** time 以前で一番新しい区切り（無ければ null = 検証の出発点から） */
export function checkpointAtOrBefore(cps: readonly Checkpoint[], time: number): Checkpoint | null {
  let best: Checkpoint | null = null;
  for (const c of cps) if (c.time <= time && (!best || c.time > best.time)) best = c;
  return best;
}

/**
 * 1 分足を順に処理する。足ごとに約定・決済を処理し、その足の時刻までの操作を当て、
 * 月が変わるところで区切りを残す。
 */
export class Runner {
  /** 次に当てる操作の位置 */
  private k: number;

  constructor(
    public account: Account,
    /** 時刻の順に並べた操作（この Runner が持ち、live の操作も足していく） */
    public actions: Action[],
    public checkpoints: Checkpoint[],
    /**
     * 口座の時刻と同じ時刻の足も処理するか。検証の出発点から始めるときだけ true
     * （出発点の足でした操作を当てるため。区切りから続けるときは、その足は処理済み）
     */
    private includeCurrentBar = false,
  ) {
    this.k = actions.findIndex((a) => a.t > account.time);
    if (this.k < 0) this.k = actions.length;
  }

  /**
   * feed の from〜to 番目の足を処理する。stopAt は処理した足ごとに呼び（ev はその足の約定・決済）、
   * true を返したらそこで止める。
   * 失敗した操作（決済済みの注文の変更など）は記録から除く。最後に処理した足の位置を返す。
   */
  run(feed: PriceFeed, from: number, to: number, stopAt?: (ev: FillEvent[], i: number) => boolean): number {
    const a = this.account;
    for (let i = from; i <= to; i++) {
      const t = feed.bid[i].t;
      // 処理済みの足は飛ばす（読み込んだ範囲が重なっていても二重に処理しない）
      if (t < a.time || (t === a.time && !this.includeCurrentBar)) continue;
      this.includeCurrentBar = false;
      // 月が変わる前の状態（前の月の最後の足の操作まで済んだもの）を区切りとして残す
      const last = this.checkpoints[this.checkpoints.length - 1];
      if (monthKey(t) !== monthKey(a.time) && (!last || last.time < a.time)) this.checkpoints.push(snapshot(a));
      const ev = a.processBar(feed, i);
      while (this.k < this.actions.length && this.actions[this.k].t <= t) {
        if (a.apply(feed, i, this.actions[this.k]) === null) this.k++;
        else this.actions.splice(this.k, 1);
      }
      if (stopAt && stopAt(ev, i)) return i;
    }
    return to;
  }

  /** 今の足で行った操作を記録する（当てるのは呼び出し側）。この時刻以降の区切りは古くなるので消す */
  record(action: Action) {
    this.actions.push(action);
    this.k = this.actions.length;
    this.checkpoints = this.checkpoints.filter((c) => c.time < action.t);
  }

  ledger(baselineTime: number): Ledger {
    const last = this.actions[this.actions.length - 1];
    return {
      version: CALC_VERSION,
      baselineTime,
      actionsCount: this.actions.length,
      lastActionT: last ? last.t : null,
      history: this.account.history,
      checkpoints: this.checkpoints,
    };
  }
}

/** 保存した計算結果が、今の操作の記録・検証の出発点・計算のしかたと合っているか */
export function ledgerMatches(l: Ledger | undefined, baselineTime: number, actions: readonly Action[]): l is Ledger {
  if (!l || l.version !== CALC_VERSION || l.baselineTime !== baselineTime) return false;
  const last = actions[actions.length - 1];
  return l.actionsCount === actions.length && l.lastActionT === (last ? last.t : null);
}
