// チャート 1 枚（画面を分けたときの 1 区画）。
// 時間足とインジケーターはチャートごと。リプレイの時刻・注文・図形はすべてのチャートで共通。

import { CandlestickSeries, CrosshairMode, createChart, type CandlestickData, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { mergeBars, TIMEFRAMES, type Aggregated, type Bar, type Timeframe } from '../core/candles';
import { DrawingManager } from './drawings';
import { IndicatorLayer, type IndicatorConfig } from './indicators';
import { TimeMapper } from './mapper';
import { TradeOverlay } from './trades';

/** 時間足ごとに作った足（main.ts で作って全チャートで使い回す） */
export interface AggEntry {
  agg: Aggregated;
  times: number[];
  closes: Float64Array;
  chartTimes: Time[];
}

/** チャートが使う共通のデータ */
export interface PaneHost {
  agg(tf: Timeframe): AggEntry;
  dataVersion(): number;
  /** 最後に見えている 1 分足の添字 */
  cursor(): number;
  bid(): readonly Bar[];
  toChart(b: Bar): CandlestickData;
  symbol(): string;
  digits(): number;
  /** このチャートをクリックした（操作の対象にする） */
  activate(pane: ChartPane): void;
  /** 左端まで表示した（前の月を読み込む） */
  nearLeftEdge(pane: ChartPane): void;
  /** 右の余白（足の本数）を三角のつまみで変えた */
  setRightOffset(bars: number): void;
  /** 表示の範囲が変わった（スクロール・拡大縮小）。ほかのチャートを合わせるのに使う */
  rangeChanged(pane: ChartPane): void;
  /** マウスがこのチャートに入った（このチャートの動きにほかを合わせる） */
  lead(pane: ChartPane): void;
  /** マウスの真ん中のボタンを押している間だけ十字線を出す（on: 押した / off: 離した） */
  holdCrosshair(on: boolean): void;
  /** 1 pip の値幅（測るときに使う） */
  pip(): number;
}

/**
 * 1 枚のチャートに渡す足の本数の上限。何年分も読み込んだときに M1 などで重くならないように、
 * 今の足から古い方へこの本数だけ渡す（左端まで動かすと、さらに古い足を足す）
 */
const CHART_MAX_BARS = 30_000;
const UP_COLOR = '#a5d6a7';
const DOWN_COLOR = '#de7a7a';

function crosshairTime(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 足 1 本の幅（px）の初期値。ライブラリの初期値と同じ */
const DEFAULT_BAR_SPACING = 6;

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 昇順の配列で、v 以下の最後の位置 */
export function lastLE(arr: readonly number[], v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class ChartPane {
  readonly chart: IChartApi;
  readonly series: ISeriesApi<'Candlestick'>;
  readonly mapper = new TimeMapper();
  readonly overlay: TradeOverlay;
  readonly drawings: DrawingManager;
  readonly indicators: IndicatorLayer;
  private readonly legend: HTMLElement;
  /** MT4 の「チャートの右端をずらす」三角のつまみ */
  private readonly shiftHandle: HTMLElement;
  private shown = { tf: '' as Timeframe | '', k: -1, version: -1, start: -1 };
  /** 左端まで動かして足した、古い足の本数 */
  private extraBars = 0;
  /**
   * 今の足 1 本の幅。マウスホイールで変えた分は設定値に入らないので、表示の範囲が変わるたびに
   * 見えている本数から求め直す（＋・－ を続けて押しても 1 回ずつ効くように、ここで覚えておく）
   */
  private spacing = DEFAULT_BAR_SPACING;
  private hovering = false;

  constructor(
    readonly index: number,
    readonly el: HTMLElement,
    private readonly host: PaneHost,
    public tf: Timeframe,
    indicators: IndicatorConfig,
  ) {
    const box = document.createElement('div');
    box.className = 'pane-chart';
    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    this.shiftHandle = document.createElement('div');
    this.shiftHandle.className = 'shift-handle';
    this.shiftHandle.title = 'ドラッグして右側の余白を変える';
    el.append(box, this.legend, this.shiftHandle);

    this.chart = createChart(box, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--fg') },
      // 背景のグリッドは出さない（見やすさのため）
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 12, shiftVisibleRangeOnNewBar: true },
      // 十字線はふだん出さない（MT4 と同じく、真ん中のボタンで出す）
      crosshair: { mode: CrosshairMode.Hidden },
      // ホイール・ピンチの拡大は自分でする（チャートの部品はマウスの位置を中心に拡大するが、TradingView のように右端を動かさない）
      handleScale: { mouseWheel: false, pinch: false },
      // 十字線の日時は MT4 と同じ「2026.10.08 05:00」。チャートの時刻は表示の時刻帯にずらした値なので UTC として読む
      localization: { locale: 'ja-JP', timeFormatter: (t: Time) => crosshairTime(t as number) },
    });
    // ローソク足の色: 陽線は淡い緑、陰線は淡い赤（2026-10-23 に指定された画面の色に合わせた）
    this.series = this.chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    });
    // 縦の目盛りの上下の余白は TradingView くらいに狭く（初期値は上 20%・下 10% で、ローソク足が潰れて見えた）
    this.series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });
    // 注文の線のドラッグを図形より優先するため、先に登録する
    this.overlay = new TradeOverlay(box, this.mapper);
    this.series.attachPrimitive(this.overlay);
    this.drawings = new DrawingManager(box, this.mapper);
    this.series.attachPrimitive(this.drawings);
    this.indicators = new IndicatorLayer(this.chart);
    this.indicators.setConfig(indicators);

    el.addEventListener('mousedown', () => host.activate(this), true);
    el.addEventListener('mouseenter', () => host.lead(this));
    // 真ん中のボタン（ホイールを押す）を押している間だけ十字線を出し、押した所から今のマウスの所までを測る（MT4 と同じ。
    // 本数 / pips / 価格）。離すと消える。ブラウザの自動スクロールは止める
    this.measureEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.measureEl.classList.add('measure');
    box.append(this.measureEl);
    el.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        const p = this.pointAt(e);
        if (!p) return;
        this.measureFrom = p;
        host.holdCrosshair(true);
        this.drawMeasure(p);
      },
      true,
    );
    window.addEventListener('mousemove', (e) => {
      if (!this.measureFrom) return;
      const p = this.pointAt(e);
      if (p) this.drawMeasure(p);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 1 || !this.measureFrom) return;
      this.measureFrom = null;
      this.measureEl.innerHTML = '';
      host.holdCrosshair(false);
    });
    el.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
    // ホイール（縦）とトラックパッドのピンチ（ctrl 付きのホイールとして届く）で拡大・縮小。右端（最新の足の側）は動かさない。
    // 横のスクロール（トラックパッドの左右）はチャートの部品に任せる（時間を動かす）
    el.addEventListener(
      'wheel',
      (e) => {
        const vertical = Math.abs(e.deltaY) > Math.abs(e.deltaX);
        if (!e.ctrlKey && !vertical) return;
        e.preventDefault();
        e.stopPropagation();
        const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        // ピンチは細かく届くので強めに。ホイール 1 目盛り（約 100）で 2 割ほど
        this.zoom(Math.exp(-px * (e.ctrlKey ? 0.01 : 0.002)));
      },
      { capture: true, passive: false },
    );
    let edgeCheck = 0;
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      // 左端に来たかは次のフレームで、その時の範囲で見る（描き直した直後は、古い時間足の位置のまま一瞬だけ
      // 遠い過去を指すことがあり、それに反応すると要らない足やデータを読み込んで重くなる）
      if (r && r.from < 30 && !edgeCheck) {
        edgeCheck = requestAnimationFrame(() => {
          edgeCheck = 0;
          const now = this.chart.timeScale().getVisibleLogicalRange();
          if (!now || now.from >= 30) return;
          // 省いていた古い足があれば足す。無ければ前の月を読み込む
          if (this.shown.start > 0) {
            this.extraBars += CHART_MAX_BARS;
            this.render(true, true);
          } else host.nearLeftEdge(this);
        });
      }
      this.placeShiftHandle();
      const w = this.chart.timeScale().width();
      if (r && r.to > r.from && w > 0) this.spacing = w / (r.to - r.from);
      host.rangeChanged(this);
    });
    this.shiftHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const ts = this.chart.timeScale();
      const move = (ev: MouseEvent) => {
        const x = Math.max(40, Math.min(ts.width(), ev.clientX - box.getBoundingClientRect().left));
        host.setRightOffset(Math.round((ts.width() - x) / ts.options().barSpacing));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.chart.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(this.series) as CandlestickData | undefined;
      this.hovering = !!(p.time && d);
      this.renderLegend(this.hovering && d ? d : null);
    });
  }

  setDigits(digits: number) {
    this.series.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } });
    this.drawings.digits = digits;
  }

  /** 今の時刻までの足を表示する。reset なら全部描き直す（keepView なら見えている範囲を保つ） */
  render(reset = false, keepView = false) {
    if (this.el.hidden) return;
    // 描き直す前の見え方（右端の時刻と足の幅）。足を渡し直したあと、これに戻す
    const before = this.shown.k >= 0 ? this.viewState() : null;
    const { agg, times, closes, chartTimes } = this.host.agg(this.tf);
    const bar = (j: number) => this.host.toChart(agg.bars[j]);
    const cursor = this.host.cursor();
    const version = this.host.dataVersion();
    this.mapper.times = times;
    this.mapper.size = TIMEFRAMES[this.tf] * 60_000;
    this.drawings.tf = this.tf;
    const k = lastLE(agg.starts, cursor);
    const partial = this.host.toChart(mergeBars(this.host.bid(), agg.starts[k], cursor, agg.bars[k].t));
    if (this.shown.tf !== this.tf || this.shown.version !== version) this.extraBars = 0;
    // 渡すのは今の足から古い方へ CHART_MAX_BARS 本（＋左へ動かして足した分）まで。再生中は始まりを動かさない
    let start = Math.max(0, k - CHART_MAX_BARS - this.extraBars);
    const same = !reset && this.shown.tf === this.tf && this.shown.version === version && k >= this.shown.k;
    if (same && this.shown.start >= 0 && start > this.shown.start) start = this.shown.start;
    this.mapper.offset = start;
    if (!same || start !== this.shown.start) {
      const keep = before && (keepView || (same && start !== this.shown.start));
      const list: CandlestickData[] = [];
      for (let j = start; j < k; j++) list.push(bar(j));
      list.push(partial);
      this.series.setData(list);
      if (keep) this.restoreView(before, k - start);
    } else {
      for (let j = this.shown.k; j < k; j++) this.series.update(bar(j));
      this.series.update(partial);
    }
    this.shown = { tf: this.tf, k, version, start };
    this.indicators.render({ key: `${this.tf}:${version}`, closes, times: chartTimes, k, partialClose: partial.close, offset: start });
    this.drawings.refresh();
    if (!this.hovering) this.renderLegend(null);
  }

  private renderLegend(bar: { open: number; high: number; low: number; close: number } | null) {
    if (this.el.hidden) return;
    let b = bar;
    if (!b) {
      const { agg } = this.host.agg(this.tf);
      const cursor = this.host.cursor();
      const k = lastLE(agg.starts, cursor);
      const m = mergeBars(this.host.bid(), agg.starts[k], cursor, agg.bars[k].t);
      b = { open: m.o, high: m.h, low: m.l, close: m.c };
    }
    const f = (p: number) => p.toFixed(this.host.digits());
    this.legend.innerHTML = `<b>${this.host.symbol().toUpperCase()},${this.tf}</b>　${f(b.open)} ${f(b.high)} ${f(b.low)} <b>${f(b.close)}</b>`;
  }

  /**
   * 連動の目印の時刻: 右の余白を除いた右端（最新の足を表示しているなら、その足の時刻）。
   * 時間足が違っても、この時刻をそろえれば同じ場面を見られる
   */
  anchorTime(): number | null {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    return r ? this.mapper.toTime(r.to - ts.options().rightOffset) : null;
  }

  /** 目印の時刻が同じ位置に来るように動かす（表示する本数＝拡大率はそのまま） */
  alignTo(time: number) {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const to = this.mapper.toLogical(time) + ts.options().rightOffset;
    if (Math.abs(to - r.to) < 0.01) return;
    ts.setVisibleLogicalRange({ from: to - (r.to - r.from), to });
  }

  /**
   * from〜to（UTC）が真ん中に来るように表示を動かす。拡大率はそのまま
   * （取引の期間が画面に収まらないときだけ、収まるまで縮小する）
   */
  showTimeRange(from: number, to: number) {
    const ts = this.chart.timeScale();
    const a = this.mapper.toLogical(from);
    const b = this.mapper.toLogical(to);
    const r = ts.getVisibleLogicalRange();
    const width = Math.max(r ? r.to - r.from : 0, (b - a) * 1.2 + 10);
    const mid = (a + b) / 2;
    ts.setVisibleLogicalRange({ from: mid - width / 2, to: mid + width / 2 });
  }

  /** 最新の足が右端（右の余白の手前）に来るようにする。動かす途中で止まらないよう、動きは付けない */
  scrollToNow() {
    const ts = this.chart.timeScale();
    ts.scrollToPosition(ts.options().rightOffset, false);
  }

  /** ローソク足の欄に見えている価格の幅（上端 − 下端）。描く前は null */
  visiblePriceSpan(): number | null {
    const h = this.chart.panes()[0]?.getHeight() ?? 0;
    const top = this.series.coordinateToPrice(0);
    const bottom = this.series.coordinateToPrice(h);
    return h > 0 && top !== null && bottom !== null ? Math.abs(top - bottom) : null;
  }

  /** 最新の足（今の時刻）が右端に見えているか（右の余白の分は除く） */
  isAtNow(): boolean {
    const ts = this.chart.timeScale();
    return ts.scrollPosition() >= ts.options().rightOffset - 1;
  }

  /**
   * time（UTC。anchorTime と同じ、右の余白を除いた右端の時刻）が右端に来るように全部描き直す（null なら最新の足）。
   * 時間足を変えたときに使う。遠い過去を見ていたら、そこまでの足をチャートに渡す。
   * 足の幅（拡大率）は変えない（描き直した直後は前の時間足の位置のままなので、新しい時間足の足の数を超えていると
   * チャートが範囲を縮めてしまう。その幅を使うと勝手に拡大される）
   */
  renderAt(time: number | null) {
    const spacing = this.chart.timeScale().options().barSpacing;
    this.render(true);
    const { agg, times } = this.host.agg(this.tf);
    const k = lastLE(agg.starts, this.host.cursor());
    if (time !== null) {
      const need = k - lastLE(times, time) + 500 - CHART_MAX_BARS;
      if (need > 0) {
        this.extraBars = need;
        this.render(true);
      }
    }
    this.restoreView({ anchor: time, spacing }, k - this.mapper.offset);
  }

  /** restoreView で決めて、チャートにまだ反映されていない見え方（チャートは位置の変更を次のフレームで反映する） */
  private pendingView: { anchor: number | null; spacing: number } | null = null;

  /** 右端の時刻（最新の足を見ていれば null）。描き直した直後でも、決めた位置を返す */
  currentAnchor(): number | null {
    return this.viewState().anchor;
  }

  /** 今の見え方: 右端の時刻（最新の足を見ていれば null）と足の幅 */
  private viewState(): { anchor: number | null; spacing: number } {
    if (this.pendingView) return this.pendingView;
    return { anchor: this.isAtNow() ? null : this.anchorTime(), spacing: this.chart.timeScale().options().barSpacing };
  }

  /**
   * 足の幅を戻し、右端の位置は「最新の足（last 番目）から何本分か」で決める
   * （見えている時刻の範囲や本数で戻すと、描き直した直後の一瞬の範囲に引きずられて勝手に拡大されたり、1 本分ずつずれたりする）
   */
  private restoreView(v: { anchor: number | null; spacing: number }, last: number) {
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: v.spacing });
    const at = v.anchor === null ? last : Math.min(last, this.mapper.toLogical(v.anchor));
    ts.scrollToPosition(at - last + ts.options().rightOffset, false);
    this.spacing = v.spacing;
    this.pendingView = v;
    requestAnimationFrame(() => requestAnimationFrame(() => (this.pendingView = null)));
  }

  /** 右の余白（足の本数）。最新の足が見えている位置に戻す */
  setRightOffset(bars: number) {
    this.chart.timeScale().applyOptions({ rightOffset: bars });
    this.scrollToNow();
    this.placeShiftHandle();
  }

  /** つまみは「最新の足の右端 = 余白の始まり」に置く */
  private placeShiftHandle() {
    const ts = this.chart.timeScale();
    const o = ts.options();
    this.shiftHandle.style.left = `${ts.width() - o.rightOffset * o.barSpacing}px`;
  }

  /**
   * 拡大縮小と価格の目盛り（ドラッグで伸ばした分）を初めの状態に戻す。
   * 見ている場所はそのまま（右端の位置を変えずに、足の幅だけ初めの大きさにする）
   */
  resetZoom() {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    this.spacing = DEFAULT_BAR_SPACING;
    if (r && ts.width() > 0) ts.setVisibleLogicalRange({ from: r.to - ts.width() / DEFAULT_BAR_SPACING, to: r.to });
    else ts.applyOptions({ barSpacing: DEFAULT_BAR_SPACING });
    for (const pane of this.chart.panes()) for (const s of pane.getSeries()) s.priceScale().applyOptions({ autoScale: true });
  }

  /** zoom で決めて、まだチャートに反映されていない範囲（ホイールは 1 フレームに何回も届くので、続けて重ねる） */
  private zoomRange: { from: number; to: number } | null = null;

  /**
   * 拡大・縮小。右端（右の余白込みの右端）を動かさずに、見える本数を変える（TradingView と同じ。
   * チャートの部品の barSpacing の設定は、続けて変えると効かないことがあるので、見える範囲で決める）
   */
  zoom(factor: number) {
    const ts = this.chart.timeScale();
    const r = this.zoomRange ?? ts.getVisibleLogicalRange();
    const w = ts.width();
    if (!r || w <= 0) return;
    // 足の幅は 1〜60px の間
    const bars = Math.max(w / 60, Math.min(w, (r.to - r.from) / factor));
    const next = { from: r.to - bars, to: r.to };
    ts.setVisibleLogicalRange(next);
    this.spacing = w / bars;
    if (!this.zoomRange) requestAnimationFrame(() => (this.zoomRange = null));
    this.zoomRange = next;
  }

  /** 真ん中のボタンで測るときの始まり（押した所） */
  private measureFrom: { x: number; y: number; logical: number; price: number } | null = null;
  private measureEl: SVGSVGElement;

  /** マウスの所（ローソク足の欄の中での位置と、足の位置・価格） */
  private pointAt(e: MouseEvent): { x: number; y: number; logical: number; price: number } | null {
    const r = this.el.getBoundingClientRect();
    const x = Math.max(0, Math.min(this.chart.timeScale().width(), e.clientX - r.left));
    const y = Math.max(0, Math.min(this.chart.panes()[0]?.getHeight() ?? r.height, e.clientY - r.top));
    const logical = this.chart.timeScale().coordinateToLogical(x);
    const price = this.series.coordinateToPrice(y);
    return logical === null || price === null ? null : { x, y, logical, price };
  }

  /** 押した所から p までの点線と「本数 / pips / 価格」を描く */
  private drawMeasure(p: { x: number; y: number; logical: number; price: number }) {
    const a = this.measureFrom!;
    const bars = Math.round(p.logical) - Math.round(a.logical);
    const pips = (p.price - a.price) / this.host.pip();
    const text = `${bars} 本 / ${pips.toFixed(1)} pips / ${p.price.toFixed(this.host.digits())}`;
    const w = this.chart.timeScale().width();
    // 札はマウスの右下。端からはみ出すときは反対側へ
    const tw = text.length * 7 + 12;
    const lx = p.x + 14 + tw > w ? p.x - 14 - tw : p.x + 14;
    const ly = p.y + 30 > (this.chart.panes()[0]?.getHeight() ?? 0) ? p.y - 30 : p.y + 10;
    const color = pips >= 0 ? '#38bdf8' : '#de7a7a';
    this.measureEl.innerHTML = `<line x1="${a.x}" y1="${a.y}" x2="${p.x}" y2="${p.y}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 4" />
      <circle cx="${a.x}" cy="${a.y}" r="3" fill="${color}" />
      <rect x="${lx}" y="${ly}" width="${tw}" height="20" rx="4" fill="#161b22" stroke="${color}" />
      <text x="${lx + 6}" y="${ly + 14}" fill="#e6edf3" font-size="12" font-family="system-ui, sans-serif">${text}</text>`;
  }

  setCrosshair(on: boolean) {
    this.chart.applyOptions({ crosshair: { mode: on ? CrosshairMode.Normal : CrosshairMode.Hidden } });
  }

  setActive(on: boolean) {
    this.el.classList.toggle('active', on);
  }
}
