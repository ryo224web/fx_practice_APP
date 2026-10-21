// チャートに描く図形（水平線・垂直線・トレンドライン・長方形・フィボナッチ）。
// 位置は時刻（UTC）と価格で持つので、時間足を切り替えても同じ場所に残る。
// 操作は MT4 と同じ: ツールを選んでチャートをドラッグ（またはクリック 2 回）で描く。
// 描いた後はクリックで選択、ドラッグで移動、端の四角で形を変える、Delete キーか右クリックで消す。

import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { TimeMapper } from './mapper';

export type DrawingKind = 'hline' | 'vline' | 'trend' | 'rect' | 'fibo';

export interface Drawing {
  id: string;
  kind: DrawingKind;
  /** 時刻（UTC ミリ秒）と価格。水平線・垂直線は 1 点、ほかは 2 点 */
  points: { t: number; p: number }[];
  color: string;
}

export const DRAWING_LABELS: Record<DrawingKind, string> = {
  hline: '水平線',
  vline: '垂直線',
  trend: 'トレンドライン',
  rect: '長方形',
  fibo: 'フィボナッチ',
};

const COLORS: Record<DrawingKind, string> = {
  hline: '#e5a50a',
  vline: '#9a9a9a',
  trend: '#4493f8',
  rect: '#a371f7',
  fibo: '#e5a50a',
};

/** MT4 の既定と同じ。0 が 2 点目、100 が 1 点目 */
export const FIBO_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 1, 1.618];

const HIT = 6;
const HANDLE = 4;

interface Px {
  x: number;
  y: number;
}

function onePoint(kind: DrawingKind) {
  return kind === 'hline' || kind === 'vline';
}

function distToSegment(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const u = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

export class DrawingManager implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = [];
  selectedId: string | null = null;
  /** 選んでいるツール。null は通常のカーソル */
  tool: DrawingKind | null = null;
  digits = 3;
  onChange: () => void = () => {};
  onToolChange: (tool: DrawingKind | null) => void = () => {};

  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: () => void = () => {};
  private drag: {
    id: string;
    handle: number;
    start: { l: number; p: number };
    orig: { l: number; p: number }[];
    moved: boolean;
    creating: boolean;
  } | null = null;
  /** クリック 2 回で描く途中（1 点目を置いた後） */
  private placing: string | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly mapper: TimeMapper,
  ) {
    el.addEventListener('mousedown', (e) => this.onDown(e), true);
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    el.addEventListener('contextmenu', (e) => this.onContext(e), true);
  }

  // ---- ISeriesPrimitive ----
  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<SeriesType>;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ renderer: () => this.renderer() }];
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    const views: ISeriesPrimitiveAxisView[] = [];
    for (const d of this.drawings) {
      if (d.kind !== 'hline' && d.id !== this.selectedId) continue;
      if (d.kind === 'vline') continue;
      for (const pt of d.kind === 'hline' ? d.points.slice(0, 1) : d.points) {
        const y = this.series?.priceToCoordinate(pt.p);
        if (y == null) continue;
        views.push({
          coordinate: () => y,
          text: () => pt.p.toFixed(this.digits),
          textColor: () => '#000',
          backColor: () => d.color,
          visible: () => true,
          tickVisible: () => true,
        });
      }
    }
    return views;
  }

  // ---- 公開 API ----
  setDrawings(list: Drawing[]) {
    this.drawings = list;
    this.selectedId = null;
    this.refresh();
  }

  setTool(tool: DrawingKind | null) {
    this.tool = tool;
    this.placing = null;
    this.el.style.cursor = tool ? 'crosshair' : '';
    this.onToolChange(tool);
  }

  deleteSelected(): boolean {
    if (!this.selectedId) return false;
    this.drawings = this.drawings.filter((d) => d.id !== this.selectedId);
    this.selectedId = null;
    this.onChange();
    this.refresh();
    return true;
  }

  clearAll() {
    this.drawings = [];
    this.selectedId = null;
    this.onChange();
    this.refresh();
  }

  refresh() {
    this.requestUpdate();
  }

  // ---- 座標変換 ----
  private toPx(pt: { t: number; p: number }): Px | null {
    if (!this.chart || !this.series) return null;
    const x = this.mapper.toX(this.chart.timeScale(), pt.t);
    const y = this.series.priceToCoordinate(pt.p);
    if (x === null || y === null) return null;
    return { x, y };
  }

  private mouse(e: MouseEvent): { px: Px; l: number; p: number } | null {
    if (!this.chart || !this.series) return null;
    const r = this.el.getBoundingClientRect();
    const px = { x: e.clientX - r.left, y: e.clientY - r.top };
    // 価格の目盛り・時間の目盛りの上は対象外
    if (px.x > this.chart.timeScale().width() || px.y > this.el.clientHeight - this.chart.timeScale().height()) return null;
    const l = this.chart.timeScale().coordinateToLogical(px.x);
    const p = this.series.coordinateToPrice(px.y);
    if (l === null || p === null) return null;
    return { px, l, p };
  }

  private hitDrawing(px: Px): { id: string; handle: number } | null {
    const w = this.chart?.timeScale().width() ?? 0;
    for (let k = this.drawings.length - 1; k >= 0; k--) {
      const d = this.drawings[k];
      const pts = d.points.map((pt) => this.toPx(pt));
      if (pts.some((p) => !p)) continue;
      const [a, b] = pts as Px[];
      if (d.id === this.selectedId && !onePoint(d.kind)) {
        for (let h = 0; h < pts.length; h++) if (Math.hypot(px.x - pts[h]!.x, px.y - pts[h]!.y) <= HIT) return { id: d.id, handle: h };
      }
      let hit = false;
      switch (d.kind) {
        case 'hline':
          hit = Math.abs(px.y - a.y) <= HIT;
          break;
        case 'vline':
          hit = Math.abs(px.x - a.x) <= HIT;
          break;
        case 'trend':
          hit = distToSegment(px, a, b) <= HIT;
          break;
        case 'rect': {
          const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
          const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
          hit = px.x >= x1 - HIT && px.x <= x2 + HIT && px.y >= y1 - HIT && px.y <= y2 + HIT;
          break;
        }
        case 'fibo': {
          hit = distToSegment(px, a, b) <= HIT;
          for (const lv of FIBO_LEVELS) {
            const y = b.y + (a.y - b.y) * lv;
            if (Math.abs(px.y - y) <= HIT && px.x >= Math.min(a.x, b.x) - HIT && px.x <= w) hit = true;
          }
          break;
        }
      }
      if (hit) return { id: d.id, handle: -1 };
    }
    return null;
  }

  // ---- マウス操作 ----
  private onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const m = this.mouse(e);
    if (!m) return;

    if (this.placing) {
      // クリック 2 回で描く場合の 2 点目
      this.placing = null;
      this.finishCreate();
      e.stopPropagation();
      return;
    }

    if (this.tool) {
      const d: Drawing = {
        id: crypto.randomUUID(),
        kind: this.tool,
        points: onePoint(this.tool) ? [{ t: this.mapper.toTime(m.l), p: m.p }] : [0, 1].map(() => ({ t: this.mapper.toTime(m.l), p: m.p })),
        color: COLORS[this.tool],
      };
      this.drawings.push(d);
      this.selectedId = d.id;
      if (onePoint(d.kind)) {
        this.finishCreate();
      } else {
        this.drag = { id: d.id, handle: 1, start: { l: m.l, p: m.p }, orig: d.points.map(() => ({ l: m.l, p: m.p })), moved: false, creating: true };
      }
      e.stopPropagation();
      e.preventDefault();
      this.refresh();
      return;
    }

    const hit = this.hitDrawing(m.px);
    const before = this.selectedId;
    this.selectedId = hit?.id ?? null;
    if (hit) {
      const d = this.drawings.find((x) => x.id === hit.id)!;
      this.drag = {
        id: d.id,
        handle: hit.handle,
        start: { l: m.l, p: m.p },
        orig: d.points.map((pt) => ({ l: this.mapper.toLogical(pt.t), p: pt.p })),
        moved: false,
        creating: false,
      };
      e.stopPropagation();
      e.preventDefault();
    }
    if (before !== this.selectedId) this.refresh();
  }

  private onMove(e: MouseEvent) {
    const id = this.drag?.id ?? this.placing;
    if (!id) return;
    const m = this.mouse(e);
    if (!m) return;
    const d = this.drawings.find((x) => x.id === id);
    if (!d) return;
    if (this.placing) {
      d.points[1] = { t: this.mapper.toTime(m.l), p: m.p };
      this.refresh();
      return;
    }
    const drag = this.drag!;
    const dl = m.l - drag.start.l;
    const dp = m.p - drag.start.p;
    if (Math.abs(dl) > 0 || Math.abs(dp) > 0) drag.moved = true;
    d.points = drag.orig.map((o, k) => {
      if (drag.handle === -1) return { t: this.mapper.toTime(o.l + dl), p: o.p + dp };
      if (k === drag.handle) return { t: this.mapper.toTime(m.l), p: m.p };
      return { t: this.mapper.toTime(o.l), p: o.p };
    });
    this.refresh();
  }

  private onUp(e: MouseEvent) {
    if (!this.drag) return;
    this.onMove(e);
    const drag = this.drag;
    this.drag = null;
    if (drag.creating) {
      if (!drag.moved) {
        // ドラッグせずに離した → もう 1 回クリックした所を 2 点目にする
        this.placing = drag.id;
        return;
      }
      this.finishCreate();
      return;
    }
    if (drag.moved) this.onChange();
  }

  private finishCreate() {
    this.setTool(null);
    this.onChange();
    this.refresh();
  }

  private onContext(e: MouseEvent) {
    const m = this.mouse(e);
    if (!m) return;
    const hit = this.hitDrawing(m.px);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    this.selectedId = hit.id;
    this.deleteSelected();
  }

  // ---- 描画 ----
  private renderer(): IPrimitivePaneRenderer {
    return {
      draw: (target) => {
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          for (const d of this.drawings) {
            const pts = d.points.map((pt) => this.toPx(pt));
            if (pts.some((p) => !p)) continue;
            this.drawOne(ctx, d, pts as Px[], mediaSize.width, mediaSize.height);
          }
        });
      },
    };
  }

  private drawOne(ctx: CanvasRenderingContext2D, d: Drawing, pts: Px[], w: number, h: number) {
    const sel = d.id === this.selectedId;
    ctx.save();
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.lineWidth = sel ? 2 : 1;
    ctx.font = '11px system-ui, sans-serif';
    const [a, b] = pts;
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    switch (d.kind) {
      case 'hline':
        line(0, a.y, w, a.y);
        break;
      case 'vline':
        line(a.x, 0, a.x, h);
        break;
      case 'trend':
        line(a.x, a.y, b.x, b.y);
        break;
      case 'rect': {
        ctx.globalAlpha = 0.15;
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.globalAlpha = 1;
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        break;
      }
      case 'fibo': {
        ctx.setLineDash([4, 3]);
        line(a.x, a.y, b.x, b.y);
        ctx.setLineDash([]);
        const x0 = Math.min(a.x, b.x);
        for (const lv of FIBO_LEVELS) {
          const y = b.y + (a.y - b.y) * lv;
          const price = d.points[1].p + (d.points[0].p - d.points[1].p) * lv;
          line(x0, y, w, y);
          ctx.fillText(`${(lv * 100).toFixed(1)}  ${price.toFixed(this.digits)}`, x0 + 4, y - 3);
        }
        break;
      }
    }
    if (sel && !onePoint(d.kind)) {
      ctx.fillStyle = '#fff';
      for (const p of pts) {
        ctx.fillRect(p.x - HANDLE, p.y - HANDLE, HANDLE * 2, HANDLE * 2);
        ctx.strokeRect(p.x - HANDLE, p.y - HANDLE, HANDLE * 2, HANDLE * 2);
      }
    }
    ctx.restore();
  }
}
