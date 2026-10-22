import type { Bar } from '../core/candles';
import { loadMonths } from '../data/store';

/**
 * 1 銘柄分の 1 分足（Bid と Ask）。読み込むのは必要な月だけで、
 * 前後の月は後から足していく（20 年分を一度に読むと遅いため。R1）。
 *
 * Ask の作り方は 2 通り:
 * - 固定スプレッド（fixedSpread を決めたとき。Forex Tester と同じ）: Ask = Bid + 固定スプレッド。データの Ask は使わない
 * - データの Ask（以前の検証）: データ元で欠けている（ファイルでは null）・Bid より安い足は、
 *   直前のスプレッドを Bid に足した推定値で埋め、askEstimated に印を付ける
 */
/** "2026-10" → その月の 1 日 0:00（UTC） */
function monthStart(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, 1);
}

function monthEnd(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(y, m, 1);
}

export class MarketData {
  bid: Bar[] = [];
  ask: Bar[] = [];
  askEstimated = new Uint8Array(0);
  /** 固定スプレッド（価格の差）。null ならデータの Ask を使う */
  private fixedSpread: number | null = null;
  /** ファイルから読んだままの Ask（固定スプレッドと切り替えるために残す） */
  private rawAsk: (Bar | null)[] = [];
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

  /** 読み込み済みの範囲を months[from..to] まで広げる（今読み込んでいる月は残す） */
  async loadRange(from: number, to: number): Promise<void> {
    while (this.loading) await this.loading;
    await this.setWindow(this.lo < 0 ? from : Math.min(from, this.lo), this.hi < 0 ? to : Math.max(to, this.hi));
  }

  /**
   * 読み込む月をちょうど months[from..to] にする。範囲の外の月は捨て（メモリを空ける）、
   * 重なる月は読み直さない。長い検証で、今の時刻の辺りだけを持っておくのに使う
   */
  async setWindow(from: number, to: number): Promise<void> {
    while (this.loading) await this.loading;
    from = Math.max(0, from);
    to = Math.min(this.months.length - 1, to);
    if (from === this.lo && to === this.hi) return;
    this.loading = (async () => {
      const start = monthStart(this.months[from]);
      const end = monthEnd(this.months[to]);
      // 残す月（時刻順に並んでいるので、範囲の両端を探して切り出す）
      const a = this.firstAtOrAfter(start);
      const b = this.firstAtOrAfter(end);
      const keepBid = this.bid.slice(a, b);
      const keepAsk = this.rawAsk.slice(a, b);
      const need = this.months.slice(from, to + 1).filter((_, k) => this.lo < 0 || from + k < this.lo || from + k > this.hi);
      const { bid, ask } = await loadMonths(this.symbol, need, this.digits);
      // 読み込んだ月は月の順に並んでいるので、残す分の前と後ろに分けてつなぐ
      const keepStart = keepBid.length ? keepBid[0].t : Infinity;
      const cut = bid.findIndex((x) => x.t >= keepStart);
      const n = cut < 0 ? bid.length : cut;
      this.setData([...bid.slice(0, n), ...keepBid, ...bid.slice(n)], [...ask.slice(0, n), ...keepAsk, ...ask.slice(n)]);
      this.lo = from;
      this.hi = to;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** 読み込んでいる月の数 */
  get windowMonths(): number {
    return this.lo < 0 ? 0 : this.hi - this.lo + 1;
  }

  /** 読み込んでいる範囲の最初・最後の月の位置（months の何番目か） */
  get windowRange(): [number, number] {
    return [this.lo, this.hi];
  }

  /** t を含む月が months の何番目か（無ければ一番近い月） */
  monthIndexOf(t: number): number {
    const key = new Date(t).toISOString().slice(0, 7);
    const i = this.months.findIndex((m) => m >= key);
    if (i < 0) return this.months.length - 1;
    return this.months[i] === key || i === 0 ? i : i - 1;
  }

  /** t 以降で最初の 1 分足の位置（無ければ本数） */
  private firstAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.bid.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.bid[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 新しく届いた足を後ろに足す（MT4 から書き出した直近の足）。今の範囲が最後の月まで読み込んでいるときだけ。
   * すでに持っている足は変えない（添字が変わると、リプレイの位置や口座の計算がずれるため。直した足は次に開いたときに入る）。
   * 足した本数を返す
   */
  async appendLatest(months: readonly string[]): Promise<number> {
    while (this.loading) await this.loading;
    const atEnd = this.hi >= 0 && this.hi === this.months.length - 1;
    const last = this.months[this.months.length - 1];
    for (const m of months) if (!last || m > last) (this.months as string[]).push(m);
    if (!atEnd || !this.bid.length) return 0;
    let added = 0;
    this.loading = (async () => {
      const to = this.months.length - 1;
      const { bid, ask } = await loadMonths(this.symbol, this.months.slice(this.hi, to + 1), this.digits);
      const end = this.bid[this.bid.length - 1].t;
      const k = bid.findIndex((b) => b.t > end);
      this.hi = to;
      if (k < 0) return;
      this.setData([...this.bid, ...bid.slice(k)], [...this.rawAsk, ...ask.slice(k)]);
      added = bid.length - k;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
    return added;
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

  /** 固定スプレッド（価格の差）にする。null ならデータの Ask に戻す */
  setFixedSpread(spread: number | null) {
    this.fixedSpread = spread;
    this.setData(this.bid, this.rawAsk);
  }

  get spreadIsFixed(): boolean {
    return this.fixedSpread !== null;
  }

  private setData(bid: Bar[], ask: (Bar | null)[], fallbackSpread?: number) {
    this.bid = bid;
    this.rawAsk = ask;
    this.askEstimated = new Uint8Array(bid.length);
    // Bid にスプレッドを足した値は小数の誤差が出るので丸める（0.25 pips などのため、価格の桁より 1 桁多く残す）
    const scale = 10 ** (this.digits + 1);
    const add = (p: number, d: number) => Math.round((p + d) * scale) / scale;
    const fixed = this.fixedSpread;
    if (fixed !== null) {
      this.ask = bid.map((b) => ({ t: b.t, o: add(b.o, fixed), h: add(b.h, fixed), l: add(b.l, fixed), c: add(b.c, fixed) }));
      return;
    }
    // 推定に使うスプレッド: 直前の実データの値。先頭が欠けていれば最初の実データの値
    const firstReal = ask.findIndex((a, k) => a && a.c >= bid[k].c && a.l >= bid[k].l);
    let spread = firstReal >= 0 ? ask[firstReal]!.c - bid[firstReal].c : (fallbackSpread ?? 10 ** -(this.digits - 1));
    this.ask = bid.map((b, k) => {
      // Bid より安い Ask はありえないので、データの誤りとして推定に回す
      const a = ask[k] && ask[k]!.c >= b.c && ask[k]!.l >= b.l ? ask[k] : null;
      if (a) {
        spread = a.c - b.c;
        return a;
      }
      this.askEstimated[k] = 1;
      return { t: b.t, o: add(b.o, spread), h: add(b.h, spread), l: add(b.l, spread), c: add(b.c, spread) };
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
