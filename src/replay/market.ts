import type { Bar } from '../core/candles';
import { loadMonths } from '../data/store';

/**
 * 1 銘柄分の 1 分足（Bid と Ask）。読み込むのは必要な月だけで、
 * 前後の月は後から足していく（20 年分を一度に読むと遅いため。R1）。
 *
 * Ask はデータ元で欠けることがある（ファイルでは null）。リプレイでは
 * 直前のスプレッドを Bid に足した推定値で埋め、askEstimated に印を付ける。
 */
export class MarketData {
  bid: Bar[] = [];
  ask: Bar[] = [];
  askEstimated = new Uint8Array(0);
  /** 読み込み済みの月（"2026-10"）。months の中の連続した範囲 */
  private lo = -1;
  private hi = -1;
  private loading: Promise<void> | null = null;

  constructor(
    readonly symbol: string,
    readonly digits: number,
    /** 使える月の一覧（古い順） */
    readonly months: string[],
  ) {}

  get loadedMonths(): string[] {
    return this.lo < 0 ? [] : this.months.slice(this.lo, this.hi + 1);
  }

  get hasEarlier(): boolean {
    return this.lo > 0;
  }

  get hasLater(): boolean {
    return this.hi >= 0 && this.hi < this.months.length - 1;
  }

  /** 実データの代わりに仮データを入れる（データ未取得時の動作確認用） */
  static fromBars(symbol: string, digits: number, bid: Bar[], spread: number): MarketData {
    const md = new MarketData(symbol, digits, []);
    md.setData(bid, bid.map(() => null), spread);
    return md;
  }

  /** time を含む月の前後（before か月前〜after か月後）を読み込む */
  async loadAround(time: number, before: number, after: number): Promise<void> {
    const key = new Date(time).toISOString().slice(0, 7);
    let i = this.months.findIndex((m) => m >= key);
    if (i < 0) i = this.months.length - 1;
    await this.loadRange(Math.max(0, i - before), Math.min(this.months.length - 1, i + after));
  }

  /** 読み込み済みの範囲を months[from..to] まで広げる */
  async loadRange(from: number, to: number): Promise<void> {
    while (this.loading) await this.loading;
    const lo = this.lo < 0 ? from : Math.min(from, this.lo);
    const hi = this.hi < 0 ? to : Math.max(to, this.hi);
    if (lo === this.lo && hi === this.hi) return;
    this.loading = (async () => {
      const need = this.months.slice(lo, hi + 1).filter((_, k) => lo + k < this.lo || lo + k > this.hi || this.lo < 0);
      const { bid, ask } = await loadMonths(this.symbol, need, this.digits);
      // 既存の分と合わせて時刻順に並べ直す
      const oldAsk: (Bar | null)[] = this.ask.map((a, k) => (this.askEstimated[k] ? null : a));
      const allBid = [...bid, ...this.bid];
      const allAsk = [...ask, ...oldAsk];
      const order = allBid.map((_, k) => k).sort((x, y) => allBid[x].t - allBid[y].t);
      this.setData(
        order.map((k) => allBid[k]),
        order.map((k) => allAsk[k]),
      );
      this.lo = lo;
      this.hi = hi;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** 前の months 個の月を足す */
  async loadEarlier(count: number): Promise<boolean> {
    if (!this.hasEarlier) return false;
    await this.loadRange(Math.max(0, this.lo - count), this.hi);
    return true;
  }

  async loadLater(count: number): Promise<boolean> {
    if (!this.hasLater) return false;
    await this.loadRange(this.lo, Math.min(this.months.length - 1, this.hi + count));
    return true;
  }

  private setData(bid: Bar[], ask: (Bar | null)[], fallbackSpread?: number) {
    this.bid = bid;
    this.askEstimated = new Uint8Array(bid.length);
    // 推定に使うスプレッド: 直前の実データの値。先頭が欠けていれば最初の実データの値
    const firstReal = ask.findIndex((a) => a);
    let spread = firstReal >= 0 ? ask[firstReal]!.c - bid[firstReal].c : (fallbackSpread ?? 10 ** -(this.digits - 1));
    this.ask = bid.map((b, k) => {
      const a = ask[k];
      if (a) {
        spread = a.c - b.c;
        return a;
      }
      this.askEstimated[k] = 1;
      return { t: b.t, o: b.o + spread, h: b.h + spread, l: b.l + spread, c: b.c + spread };
    });
  }

  /** t 以前で最後の 1 分足の添字。無ければ -1 */
  indexAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.bid.length - 1;
    if (hi < 0 || this.bid[0].t > t) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.bid[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
