// チャート上の注文表示（MT4 と同じ見た目と操作）
// - 保有中のポジション・待機注文・S/L・T/P を価格線で表示し、ドラッグで変更できる
// - ポジションの線をドラッグすると、動かした向きに応じて S/L か T/P を新しく置ける
// - 決済済みの取引は、建てた所と決済した所を矢印と点線で結ぶ

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
const HIT = 5;

export interface TradeView {
  positions: Position[];
  orders: PendingOrder[];
  history: HistoryRow[];
  ask: number | null;
  askEstimated: boolean;
  digits: number;
}

/** ドラッグで変えた内容 */
export type LineEdit =
  | { ticket: number; field: 'sl' | 'tp'; price: number | null }
  | { ticket: number; field: 'price'; price: number };

interface LineInfo {
  key: string;
  ticket: number;
  role: 'entry' | 'pending' | 'sl' | 'tp';
  price: number;
}

export class TradeOverlay implements ISeriesPrimitive<Time> {
  onEdit: (edit: LineEdit) => void = () => {};
  showHistory = true;

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

  update(view: TradeView) {
    this.view = view;
    if (!this.series) return;
    const want: (LineInfo & { color: string; title: string; style: LineStyle })[] = [];
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
    // ドラッグ中の線は、離すまで動かした位置に置いておく
    if (this.drag) {
      const d = this.drag;
      const key = d.info.role === 'entry' ? `drag${d.info.ticket}` : d.info.key;
      const isEntry = d.info.role === 'entry';
      const existing = want.find((w) => w.key === key);
      if (existing) existing.price = d.price;
      else if (isEntry) want.push({ ...d.info, key, price: d.price, color: '#9a9a9a', title: '', style: LineStyle.Dashed });
    }
    if (view.ask !== null) {
      want.push({ key: 'ask', ticket: 0, role: 'entry', price: view.ask, color: view.askEstimated ? '#d29922' : SELL, title: view.askEstimated ? 'Ask(推定)' : 'Ask', style: view.askEstimated ? LineStyle.Dashed : LineStyle.Solid });
    }

    const keep = new Set(want.map((w) => w.key));
    for (const [k, l] of this.lines) {
      if (!keep.has(k)) {
        this.series.removePriceLine(l);
        this.lines.delete(k);
      }
    }
    for (const w of want) {
      const opts = { price: w.price, color: w.color, title: w.title, lineStyle: w.style, lineWidth: 1 as const, axisLabelVisible: true };
      const l = this.lines.get(w.key);
      if (l) l.applyOptions(opts);
      else this.lines.set(w.key, this.series.createPriceLine(opts));
    }
    this.infos = want.filter((w) => w.key !== 'ask' && !w.key.startsWith('drag'));
    this.requestUpdate();
  }

  private priceAt(e: MouseEvent): { y: number; price: number } | null {
    if (!this.series || !this.chart) return null;
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x > this.chart.timeScale().width()) return null;
    const price = this.series.coordinateToPrice(y);
    return price === null ? null : { y, price };
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0 || !this.series) return;
    const m = this.priceAt(e);
    if (!m) return;
    // S/L・T/P を優先して拾う（建値と重なっていることがあるため）
    const order = { sl: 0, tp: 0, pending: 1, entry: 2 };
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
    this.drag.price = Math.round(m.price / step) * step;
    // クリックしただけ（動かしていない）なら何もしない
    this.drag.moved = Math.abs(this.drag.price - this.drag.info.price) >= step / 2;
    this.update(this.view);
  }

  private onUp(e: MouseEvent) {
    if (!this.drag) return;
    this.onMove(e);
    const d = this.drag;
    this.drag = null;
    this.el.style.cursor = '';
    if (d.moved && this.view) {
      const { info, price } = d;
      if (info.role === 'sl' || info.role === 'tp') this.onEdit({ ticket: info.ticket, field: info.role, price });
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
        target.useMediaCoordinateSpace(({ context: ctx }) => {
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
              ctx.strokeStyle = color;
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
        });
      },
    };
  }
}
