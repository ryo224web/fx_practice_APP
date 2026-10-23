// チャート上の注文表示（MT4 と同じ見た目と操作）
// - 保有中のポジション・待機注文・S/L・T/P を価格線で表示し、ドラッグで変更できる
// - ポジションの線をドラッグすると、動かした向きに応じて S/L か T/P を新しく置ける
// - 決済済みの取引は、建てた所と決済した所を矢印と点線で結ぶ
// - EasyOrder の S/L・T/P・エントリーの線（発注前）もドラッグで動かせる
// - 読み込んだ MT4 の取引は紫で表示する（記録のままなので動かせない）

import {
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesPrimitive,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
} from 'lightweight-charts';
import type { HistoryRow, PendingOrder, Position } from '../trade/account';
import type { TimeMapper } from './mapper';

const BUY = '#4493f8';
const SELL = '#f85149';
const SL = '#f85149';
const TP = '#3fb950';
// EasyOrder の線の色
const EO_ENTRY = '#3fb950';
const EO_TP = '#38bdf8';
const EO_SL = '#f85149';
const MT4 = '#d2a8ff';
const PREVIEW = '#9a9a9a';
const HIT = 5;

/** EasyOrder で発注する前の線 */
export interface OrderPreview {
  side: 'buy' | 'sell';
  /** 指値・逆指値の価格。成行なら null */
  entry: number | null;
  sl: number | null;
  tp: number | null;
  labels: { entry: string; sl: string; tp: string };
}

/** 読み込んだ MT4 の取引のうち、今の時刻で保有中のもの */
export interface ImportedOpen {
  ticket: number;
  side: 'buy' | 'sell';
  lots: number;
  openTime: number;
  openPrice: number;
  sl: number | null;
  tp: number | null;
}

export interface TradeView {
  positions: Position[];
  orders: PendingOrder[];
  history: HistoryRow[];
  ask: number | null;
  askEstimated: boolean;
  digits: number;
  preview?: OrderPreview | null;
  imported?: { open: ImportedOpen[]; closed: HistoryRow[] } | null;
}

/** ドラッグで変えた内容 */
export type LineEdit =
  | { ticket: number; field: 'sl' | 'tp'; price: number | null }
  | { ticket: number; field: 'price'; price: number };

type PreviewField = 'entry' | 'sl' | 'tp';

interface LineInfo {
  key: string;
  ticket: number;
  role: 'entry' | 'pending' | 'sl' | 'tp' | 'eo-entry' | 'eo-sl' | 'eo-tp';
  price: number;
}

type WantedLine = LineInfo & { color: string; title: string; style: LineStyle; width?: 1 | 2; fixed?: boolean; noAxisLabel?: boolean };

export class TradeOverlay implements ISeriesPrimitive<Time> {
  onEdit: (edit: LineEdit) => void = () => {};
  /** EasyOrder の線を動かした。live は動かしている途中（離す前。数値だけを先に変える） */
  onPreviewEdit: (field: PreviewField, price: number, live?: boolean) => void = () => {};
  showHistory = true;
  /** 口座履歴で選んだ取引。エントリーに縦線を引いて分かりやすくする */
  highlight: { openTime: number; closeTime: number } | null = null;

  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: () => void = () => {};
  private lines = new Map<string, IPriceLine>();
  private infos: LineInfo[] = [];
  private view: TradeView | null = null;
  private drag: { info: LineInfo; price: number; moved: boolean } | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly mapper: TimeMapper,
  ) {
    el.addEventListener('mousedown', (e) => this.onDown(e), true);
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<SeriesType>;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    for (const l of this.lines.values()) this.series?.removePriceLine(l);
    this.lines.clear();
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ renderer: () => this.renderer() }];
  }

  setHighlight(h: { openTime: number; closeTime: number } | null) {
    this.highlight = h;
    this.requestUpdate();
  }

  update(view: TradeView) {
    this.view = view;
    if (!this.series) return;
    const want: WantedLine[] = [];
    const lot = (n: number) => n.toFixed(2);
    for (const p of view.positions) {
      want.push({ key: `e${p.ticket}`, ticket: p.ticket, role: 'entry', price: p.openPrice, color: p.side === 'buy' ? BUY : SELL, title: `#${p.ticket} ${p.side} ${lot(p.lots)}`, style: LineStyle.Dashed });
      if (p.sl !== null) want.push({ key: `s${p.ticket}`, ticket: p.ticket, role: 'sl', price: p.sl, color: SL, title: `#${p.ticket} sl`, style: LineStyle.Dashed });
      if (p.tp !== null) want.push({ key: `t${p.ticket}`, ticket: p.ticket, role: 'tp', price: p.tp, color: TP, title: `#${p.ticket} tp`, style: LineStyle.Dashed });
    }
    for (const o of view.orders) {
      want.push({ key: `o${o.ticket}`, ticket: o.ticket, role: 'pending', price: o.price, color: o.type.startsWith('buy') ? BUY : SELL, title: `#${o.ticket} ${o.type} ${lot(o.lots)}`, style: LineStyle.Dotted });
      if (o.sl !== null) want.push({ key: `s${o.ticket}`, ticket: o.ticket, role: 'sl', price: o.sl, color: SL, title: `#${o.ticket} sl`, style: LineStyle.Dashed });
      if (o.tp !== null) want.push({ key: `t${o.ticket}`, ticket: o.ticket, role: 'tp', price: o.tp, color: TP, title: `#${o.ticket} tp`, style: LineStyle.Dashed });
    }
    const pv = view.preview;
    if (pv) {
      // EasyOrder の線: エントリーは緑、T/P はスカイブルー、S/L は赤
      if (pv.entry !== null) want.push({ key: 'pe', ticket: 0, role: 'eo-entry', price: pv.entry, color: EO_ENTRY, title: pv.labels.entry, style: LineStyle.Solid, width: 2 });
      if (pv.sl !== null) want.push({ key: 'ps', ticket: 0, role: 'eo-sl', price: pv.sl, color: EO_SL, title: pv.labels.sl, style: LineStyle.Solid, width: 2 });
      if (pv.tp !== null) want.push({ key: 'pt', ticket: 0, role: 'eo-tp', price: pv.tp, color: EO_TP, title: pv.labels.tp, style: LineStyle.Solid, width: 2 });
    }
    for (const m of view.imported?.open ?? []) {
      want.push({ key: `me${m.ticket}`, ticket: m.ticket, role: 'entry', price: m.openPrice, color: MT4, title: `MT4 #${m.ticket} ${m.side} ${lot(m.lots)}`, style: LineStyle.Dashed, fixed: true });
      if (m.sl !== null) want.push({ key: `ms${m.ticket}`, ticket: m.ticket, role: 'sl', price: m.sl, color: MT4, title: `MT4 #${m.ticket} sl`, style: LineStyle.Dotted, fixed: true });
      if (m.tp !== null) want.push({ key: `mt${m.ticket}`, ticket: m.ticket, role: 'tp', price: m.tp, color: MT4, title: `MT4 #${m.ticket} tp`, style: LineStyle.Dotted, fixed: true });
    }
    // ドラッグ中の線は、離すまで動かした位置に置いておく
    if (this.drag) {
      const d = this.drag;
      const key = d.info.role === 'entry' ? `drag${d.info.ticket}` : d.info.key;
      const isEntry = d.info.role === 'entry';
      const existing = want.find((w) => w.key === key);
      if (existing) existing.price = d.price;
      else if (isEntry) want.push({ ...d.info, key, price: d.price, color: PREVIEW, title: '', style: LineStyle.Dashed });
    }
    if (view.ask !== null) {
      // Ask は線だけ（目盛りには今の価格 = Bid だけを出す）。推定のときは黄色の破線
      want.push({ key: 'ask', ticket: 0, role: 'entry', price: view.ask, color: view.askEstimated ? '#d29922' : SELL, title: '', style: view.askEstimated ? LineStyle.Dashed : LineStyle.Solid, noAxisLabel: true });
    }

    const keep = new Set(want.map((w) => w.key));
    for (const [k, l] of this.lines) {
      if (!keep.has(k)) {
        this.series.removePriceLine(l);
        this.lines.delete(k);
      }
    }
    for (const w of want) {
      const opts = { price: w.price, color: w.color, title: w.title, lineStyle: w.style, lineWidth: w.width ?? 1, axisLabelVisible: !w.noAxisLabel };
      const l = this.lines.get(w.key);
      if (l) l.applyOptions(opts);
      else this.lines.set(w.key, this.series.createPriceLine(opts));
    }
    this.infos = want.filter((w) => w.key !== 'ask' && !w.key.startsWith('drag') && !w.fixed);
    this.requestUpdate();
  }

  private priceAt(e: MouseEvent): { y: number; price: number } | null {
    if (!this.series || !this.chart) return null;
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x > this.chart.timeScale().width() || y > (this.chart.panes()[0]?.getHeight() ?? Infinity)) return null;
    const price = this.series.coordinateToPrice(y);
    return price === null ? null : { y, price };
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0 || !this.series) return;
    const m = this.priceAt(e);
    if (!m) return;
    // S/L・T/P を優先して拾う（建値と重なっていることがあるため）
    const order = { 'eo-sl': 0, 'eo-tp': 0, 'eo-entry': 1, sl: 2, tp: 2, pending: 3, entry: 4 };
    const hits = this.infos
      .filter((i) => {
        const y = this.series!.priceToCoordinate(i.price);
        return y !== null && Math.abs(y - m.y) <= HIT;
      })
      .sort((a, b) => order[a.role] - order[b.role]);
    if (!hits.length) return;
    this.drag = { info: hits[0], price: hits[0].price, moved: false };
    this.el.style.cursor = 'ns-resize';
    e.stopImmediatePropagation();
    e.preventDefault();
  }

  private onMove(e: MouseEvent) {
    if (!this.drag || !this.view) return;
    const m = this.priceAt(e);
    if (!m) return;
    const step = 10 ** -this.view.digits;
    // 小数の誤差（158.87800000000001 など）を残さないように、桁数で丸める
    this.drag.price = Number((Math.round(m.price / step) * step).toFixed(this.view.digits));
    // クリックしただけ（動かしていない）なら何もしない
    this.drag.moved = Math.abs(this.drag.price - this.drag.info.price) >= step / 2;
    // EasyOrder の線は、動かしている間もロット・損益・RR を変える
    const { info } = this.drag;
    if (this.drag.moved && info.role.startsWith('eo-')) this.onPreviewEdit(info.role.slice(3) as PreviewField, this.drag.price, true);
    else this.update(this.view);
  }

  private onUp(e: MouseEvent) {
    if (!this.drag) return;
    this.onMove(e);
    const d = this.drag;
    this.drag = null;
    this.el.style.cursor = '';
    if (d.moved && this.view) {
      const { info, price } = d;
      if (info.role.startsWith('eo-')) this.onPreviewEdit(info.role.slice(3) as PreviewField, price);
      else if (info.role === 'sl' || info.role === 'tp') this.onEdit({ ticket: info.ticket, field: info.role, price });
      else if (info.role === 'pending') this.onEdit({ ticket: info.ticket, field: 'price', price });
      else {
        const p = this.view.positions.find((x) => x.ticket === info.ticket);
        if (p) {
          // 買いは下へ動かせば S/L、上へ動かせば T/P（売りは逆）
          const down = price < p.openPrice;
          const field = (p.side === 'buy') === down ? 'sl' : 'tp';
          this.onEdit({ ticket: p.ticket, field, price });
        }
      }
    }
    if (this.view) this.update(this.view);
  }

  private renderer(): IPrimitivePaneRenderer {
    return {
      draw: (target) => {
        const v = this.view;
        if (!v || !this.chart || !this.series || !this.showHistory) return;
        const ts = this.chart.timeScale();
        const pt = (t: number, p: number) => {
          const x = this.mapper.toX(ts, t);
          const y = this.series!.priceToCoordinate(p);
          return x === null || y === null ? null : { x, y };
        };
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          if (this.highlight) {
            const x = this.mapper.toX(ts, this.highlight.openTime);
            const x2 = this.mapper.toX(ts, this.highlight.closeTime);
            ctx.save();
            ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#fff';
            ctx.lineWidth = 1;
            if (x !== null) {
              ctx.beginPath();
              ctx.moveTo(x, 0);
              ctx.lineTo(x, mediaSize.height);
              ctx.stroke();
            }
            // 決済は点線
            if (x2 !== null) {
              ctx.globalAlpha = 0.5;
              ctx.setLineDash([3, 4]);
              ctx.beginPath();
              ctx.moveTo(x2, 0);
              ctx.lineTo(x2, mediaSize.height);
              ctx.stroke();
            }
            ctx.restore();
          }
          const arrow = (x: number, y: number, up: boolean, color: string) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            const s = up ? 1 : -1;
            ctx.moveTo(x - 9, y);
            ctx.lineTo(x - 15, y + 5 * s);
            ctx.lineTo(x - 15, y - 5 * s);
            ctx.closePath();
            ctx.fill();
          };
          for (const h of v.history) {
            if (h.kind !== 'trade') continue;
            const a = pt(h.openTime, h.openPrice);
            const b = pt(h.closeTime, h.closePrice);
            const color = h.side === 'buy' ? BUY : SELL;
            if (a && b) {
              // 建値と決済を結ぶ点線は、勝ちなら緑・負けなら赤
              ctx.strokeStyle = h.profit > 0 ? TP : SL;
              ctx.setLineDash([3, 3]);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
              ctx.setLineDash([]);
            }
            if (a) arrow(a.x, a.y, h.side === 'buy', color);
            if (b) arrow(b.x, b.y, h.side !== 'buy', '#d29922');
          }
          for (const p of v.positions) {
            const a = pt(p.openTime, p.openPrice);
            if (a) arrow(a.x, a.y, p.side === 'buy', p.side === 'buy' ? BUY : SELL);
          }
          // MT4 の取引（記録の時刻・価格のまま）
          for (const h of v.imported?.closed ?? []) {
            if (h.kind !== 'trade') continue;
            const a = pt(h.openTime, h.openPrice);
            const b = pt(h.closeTime, h.closePrice);
            if (a && b) {
              ctx.strokeStyle = MT4;
              ctx.setLineDash([2, 3]);
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
              ctx.setLineDash([]);
            }
            if (a) arrow(a.x, a.y, h.side === 'buy', MT4);
            if (b) arrow(b.x, b.y, h.side !== 'buy', '#d29922');
          }
          for (const m of v.imported?.open ?? []) {
            const a = pt(m.openTime, m.openPrice);
            if (a) arrow(a.x, a.y, m.side === 'buy', MT4);
          }
        });
      },
    };
  }
}
