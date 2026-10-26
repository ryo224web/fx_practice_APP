// チャート 1 枚（画面を分けたときの 1 区画）。
// 時間足とインジケーターはチャートごと。リプレイの時刻・注文・図形はすべてのチャートで共通。

import { CandlestickSeries, CrosshairMode, createChart, type CandlestickData, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { mergeBars, TIMEFRAMES, type Aggregated, type Bar, type Timeframe } from '../core/candles';
import { DrawingManager, hasRay, LINE_KINDS, lineDash, rayOn, TEXT_SIZES, type LineKind } from './drawings';

const escAttr = (s: string) => s.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]!);
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
  /** マウスの真ん中のボタンで十字線を出す・消す */
  toggleCrosshair(): void;
  /** 十字線を出しているか */
  crosshairOn(): boolean;
  /** 1 pip の値幅（測るときに使う） */
  pip(): number;
  /** 図形の太さ・線の種類の欄を置いた場所（チャートの右端・上端からの距離。px）。動かしていなければ null */
  styleBarPos(): { right: number; top: number } | null;
  /** 図形の太さ・線の種類の欄を動かした（離したときに 1 回） */
  setStyleBarPos(pos: { right: number; top: number }): void;
  /** 図形の色を変えるときに並べる色（全部のプロジェクトで共通） */
  palette(): string[];
  setPalette(colors: string[]): void;
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
  /** 図形を選んでいるときに右上に出す、線の太さと種類の欄 */
  private readonly styleBar: HTMLElement;
  private styleBarKey = '';
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
    // 図形を選んでいる間だけ、右上（価格の目盛りの手前）に線の太さ（1〜4）と種類（実線・点線・破線）の欄を出す
    this.styleBar = document.createElement('div');
    this.styleBar.className = 'draw-style';
    this.styleBar.hidden = true;
    el.append(this.styleBar);
    // 欄を押しても、図形の選択が外れたりチャートが動いたりしないように。左端のつまみをつかむと欄を動かせる
    this.styleBar.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!(e.target as HTMLElement).closest('.grip')) return;
      const area = el.getBoundingClientRect();
      const start = this.styleBar.getBoundingClientRect();
      // つかんだ所から欄の右上までのずれ
      const dx = start.right - e.clientX;
      const dy = e.clientY - start.top;
      let pos = { right: area.right - start.right, top: start.top - area.top };
      const move = (m: MouseEvent) => {
        pos = { right: Math.round(area.right - (m.clientX + dx)), top: Math.round(m.clientY - dy - area.top) };
        this.placeStyleBar(pos);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        host.setStyleBarPos(pos);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.styleBar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      const d = this.drawings.selected();
      if (!b || !d) return;
      if (b.dataset.w) {
        d.width = Number(b.dataset.w);
        // テキストは丸 4 つが文字の大きさの段階（4 隅で変えた大きさより優先）
        if (d.kind === 'text') d.fontSize = TEXT_SIZES[d.width - 1];
      }
      if (b.dataset.s) d.style = b.dataset.s as LineKind;
      if (b.dataset.ray) d.ray = !rayOn(d);
      if (b.dataset.lock) d.locked = !d.locked;
      if (b.dataset.c !== undefined) {
        // 空なら描いた時間足の色に戻す
        if (b.dataset.c) d.custom = b.dataset.c;
        else delete d.custom;
      }
      if (b.dataset.add) {
        // 「＋」: 色を選んで登録し、この図形にも当てる
        const input = this.styleBar.querySelector<HTMLInputElement>('input[type=color]')!;
        input.value = d.custom ?? this.drawings.colorOf(d);
        input.onchange = () => {
          const c = input.value.toLowerCase();
          const list = this.host.palette();
          if (!list.includes(c)) this.host.setPalette([...list, c]);
          d.custom = c;
          this.styleBarKey = '';
          this.drawings.onChange();
          this.drawings.refresh();
        };
        input.click();
        return;
      }
      this.drawings.onChange();
      this.drawings.refresh();
    });
    // 登録した色を右クリックすると、一覧から消す
    this.styleBar.addEventListener('contextmenu', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-c]');
      e.preventDefault();
      if (!b?.dataset.c) return;
      this.host.setPalette(this.host.palette().filter((c) => c !== b.dataset.c));
      this.styleBarKey = '';
      this.renderStyleBar();
    });
    this.drawings.onRefresh = () => this.renderStyleBar();
    this.indicators = new IndicatorLayer(this.chart);
    this.indicators.setConfig(indicators);

    el.addEventListener('mousedown', () => host.activate(this), true);
    el.addEventListener('mouseenter', () => host.lead(this));
    // 真ん中のボタン（ホイールを押す）をクリックすると十字線を出す・消す（MT4 と同じ。ブラウザの自動スクロールは止める）。
    // 十字線を出している間は、左ボタンでドラッグすると押した所から今のマウスの所までを測る（MT4 と同じ。本数 / pips / 価格）。
    // そのドラッグではチャートを動かさない。離すと測った線も十字線も消える（MT4 と同じ）
    this.measureEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.measureEl.classList.add('measure');
    box.append(this.measureEl);
    el.addEventListener(
      'mousedown',
      (e) => {
        // テキストを打つ欄の中は、欄に任せる
        if ((e.target as Element | null)?.closest?.('.draw-text-edit')) return;
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          host.toggleCrosshair();
          return;
        }
        if (e.button !== 0 || !host.crosshairOn() || this.drawings.tool) return;
        const p = this.pointAt(e);
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        this.measureFrom = p;
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
      if (e.button !== 0 || !this.measureFrom) return;
      this.measureFrom = null;
      this.measureEl.innerHTML = '';
      // 測り終えたら十字線も消す（MT4 と同じ）
      if (host.crosshairOn()) host.toggleCrosshair();
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
   * 連動の目印の時刻: 画面の右端の足の「終わり」の時刻（次の足の始まり）。
   * 時間足が違っても、この時刻をそろえれば同じ場面を見られる。
   * - 始まりの時刻でそろえると、H1 の 10:00 の足（〜11:00）から M5 に変えたとき 10:00 の足までしか出ず、右端が 1 時間分ずれる
   * - 右の余白（三角のつまみ）の位置でそろえると、過去を見ているときは余白の所にも足が並んでいるので、
   *   余白が広いほど、長い時間足に変えたときに画面の右端が先へ延びる（余白 145 本で M1 → M5 なら約 10 時間）
   */
  anchorTime(): number | null {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    return r ? this.mapper.toTime(r.to + 1) : null;
  }

  /** 目印の時刻が画面の右端に来るように動かす（表示する本数＝拡大率はそのまま） */
  alignTo(time: number) {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const to = this.mapper.toLogical(time) - 1;
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

  /**
   * 最新の足（今の時刻）が画面に見えているか。右の余白の所まで来ていなくても、見えていれば最新を見ているとみなす
   * （余白が画面の幅より広いと、チャートは余白の所まで動かせないため）
   */
  isAtNow(): boolean {
    const ts = this.chart.timeScale();
    return ts.scrollPosition() >= Math.min(ts.options().rightOffset, 1) - 1;
  }

  /**
   * time（UTC。anchorTime と同じ、画面の右端の足の終わりの時刻）が右端に来るように全部描き直す（null なら最新の足）。
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
    // 右端の時刻（足の終わり）の直前を含む足を画面の右端に置く（長い時間足に変えたときも、その足が欠けないように）。
    // 最新の足が右の余白より左に来るほど先なら、最新の足を見ているのと同じにする
    const ro = ts.options().rightOffset;
    const edge = v.anchor === null ? Infinity : Math.ceil(this.mapper.toLogical(v.anchor) - 1 - 1e-6);
    ts.scrollToPosition(Math.min(edge - last, ro), false);
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

  /** 十字線を出しているときに、左ボタンで測る始まり（押した所） */
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

  private renderStyleBar() {
    const d = this.drawings.selected();
    // テキストは今の文字の大きさがどの段階か（4 隅で変えて段階に無ければ、どれも光らせない）
    const w = d ? (d.kind === 'text' ? TEXT_SIZES.indexOf(this.drawings.textSizeOf(d)) + 1 : this.drawings.lineWidthOf(d)) : 0;
    const st = d?.style ?? 'solid';
    const palette = this.host.palette();
    const key = d ? `${d.id}:${w}:${st}:${rayOn(d)}:${d.custom ?? ''}:${!!d.locked}:${palette.join()}` : '';
    if (key === this.styleBarKey) return;
    this.styleBarKey = key;
    this.styleBar.hidden = !d;
    if (!d) return;
    const names: Record<LineKind, string> = { solid: '実線', dotted: '点線', dashed: '破線' };
    const isText = d.kind === 'text';
    this.styleBar.innerHTML =
      '<b class="grip" title="つかんで欄を動かす">⋮⋮</b>' +
      [1, 2, 3, 4]
        .map((n) => `<button type="button" data-w="${n}" class="${n === w ? 'on' : ''}" title="${isText ? '文字の大きさ' : '線の太さ'} ${n}"><span style="width:${n * 2 + 3}px;height:${n * 2 + 3}px"></span></button>`)
        .join('') +
      // テキストには線の種類が無い（丸 4 つは文字の大きさ）
      (isText
        ? ''
        : '<i></i>' +
          LINE_KINDS.map(
            (k) =>
              `<button type="button" data-s="${k}" class="${k === st ? 'on' : ''}" title="${names[k]}"><svg width="30" height="10"><line x1="2" y1="5" x2="28" y2="5" stroke="currentColor" stroke-width="2" stroke-dasharray="${lineDash(k, 2).join(' ')}" /></svg></button>`,
          ).join('')) +
      (hasRay(d.kind)
        ? `<i></i><button type="button" data-ray="1" class="ray ${rayOn(d) ? 'on' : ''}" title="レイ（右へ延ばす）。押すたびに延ばす・延ばさないを切り替える">R</button>`
        : '') +
      '<i></i>' +
      palette
        .map((c) => `<button type="button" data-c="${escAttr(c)}" class="swatch ${d.custom === c ? 'on' : ''}" title="この色にする（右クリックで一覧から消す）"><span style="background:${escAttr(c)}"></span></button>`)
        .join('') +
      `<button type="button" data-c="" class="swatch ${d.custom ? '' : 'on'}" title="描いた時間足の色に戻す">↺</button>` +
      '<button type="button" data-add="1" title="色を選んで一覧に足す（この図形にも当てる）">＋</button><input type="color" hidden />' +
      `<i></i><button type="button" data-lock="1" class="${d.locked ? 'on' : ''}" title="${d.locked ? 'ロック中（動かせない・消せない）。押すと外す' : 'ロックする（動かせない・消せないようにする）'}">${d.locked ? '🔒' : '🔓'}</button>`;
    this.placeStyleBar(this.host.styleBarPos());
  }

  /** 欄を置く（チャートの右端・上端からの距離。決めていなければ価格の目盛りの手前の右上）。チャートからはみ出さないようにする */
  private placeStyleBar(pos: { right: number; top: number } | null) {
    const p = pos ?? { right: this.chart.priceScale('right').width() + 8, top: 6 };
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    const bw = this.styleBar.offsetWidth;
    const bh = this.styleBar.offsetHeight;
    this.styleBar.style.right = `${Math.max(0, Math.min(w - bw, p.right))}px`;
    this.styleBar.style.top = `${Math.max(0, Math.min(h - bh, p.top))}px`;
  }

  setCrosshair(on: boolean) {
    this.chart.applyOptions({ crosshair: { mode: on ? CrosshairMode.Normal : CrosshairMode.Hidden } });
  }

  setActive(on: boolean) {
    this.el.classList.toggle('active', on);
  }
}
