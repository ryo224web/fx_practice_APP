// チャートに描く図形（水平線・垂直線・トレンドライン・ポリライン・チャネル・長方形・フィボナッチ・フィボナッチ・エクスパンション）。
// 位置は時刻（UTC）と価格で持つので、時間足を切り替えても同じ場所に残る。
// 操作は MT4 と同じ: ツールを選んでチャートをドラッグ（またはクリック 2 回）で描く。
// ポリラインはクリックで点を足していき、ダブルクリック・Enter・Esc で終わる。
// エクスパンションは A→B をドラッグ（クリック 2 回）した後、もう 1 回クリックして C を置く。
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

export type DrawingKind = 'hline' | 'vline' | 'trend' | 'poly' | 'channel' | 'rect' | 'fibo' | 'fiboexp';

export interface Drawing {
  id: string;
  kind: DrawingKind;
  /** 時刻（UTC ミリ秒）と価格。水平線・垂直線は 1 点、チャネルは 3 点（3 点目は平行線の位置）、エクスパンションは 3 点（A・B・C）、ポリラインは 2 点以上、ほかは 2 点 */
  points: { t: number; p: number }[];
  /** 描いた時間足以外のとき（以前の保存）の色 */
  color: string;
  /** 描いた時間足。色はこの時間足の色になる（「図形の色」で時間足ごとに決める） */
  tf?: string;
  /** 右へ延ばすか（レイ。MT4 と同じ）。トレンドラインとチャネルだけ。無ければチャネルは延ばす・トレンドラインは延ばさない。右上の欄の R で切り替える（チャネルはダブルクリックでも） */
  ray?: boolean;
  /** この図形の線の太さ（1〜4）。無ければ種類ごとの太さ（「色」で決める） */
  width?: number;
  /** この図形の線の種類。無ければ実線 */
  style?: LineKind;
  /** この図形だけの色（右上の欄の登録した色から選ぶ）。無ければ描いた時間足の色 */
  custom?: string;
  /** ロック（右上の欄の 🔒）。動かす・大きさを変える・消すができない（選んで太さ・色などを変えるのはできる）。全消去でも残す */
  locked?: boolean;
}

/** 右上の欄に並べる色（初期値。「＋」で足し、右クリックで消す） */
export const DEFAULT_PALETTE = ['#f85149', '#3fb950', '#4493f8', '#e5a50a', '#a371f7', '#ffffff'];

/** レイ（右へ延ばす）を切り替えられる図形 */
export const hasRay = (kind: DrawingKind) => kind === 'trend' || kind === 'channel';
/** 右へ延ばしているか（決めていなければ、チャネルは延ばす・トレンドラインは延ばさない） */
export const rayOn = (d: Drawing) => d.ray ?? d.kind === 'channel';

/** 線の種類（図形を選んだときに右上の欄で変える） */
export type LineKind = 'solid' | 'dotted' | 'dashed';
export const LINE_KINDS: LineKind[] = ['solid', 'dotted', 'dashed'];
/** 線の種類の点線の間隔（太さに合わせて伸ばす） */
export function lineDash(kind: LineKind | undefined, width: number): number[] {
  if (kind === 'dotted') return [width, width * 2];
  if (kind === 'dashed') return [width * 4, width * 3];
  return [];
}

/** 図形の線の太さ（初期値） */
export const DEFAULT_LINE_WIDTH = 2;

/** 時間足ごとの図形の色（初期値） */
export const DEFAULT_TF_COLORS: Record<string, string> = {
  M1: '#9a9a9a',
  M5: '#3fb950',
  M15: '#4493f8',
  M30: '#39c5cf',
  H1: '#a371f7',
  H4: '#f85149',
  D1: '#e5a50a',
  W1: '#db61a2',
  MN: '#d29922',
};

export const DRAWING_LABELS: Record<DrawingKind, string> = {
  hline: '水平線',
  vline: '垂直線',
  trend: 'トレンドライン',
  poly: 'ポリライン',
  channel: 'チャネル',
  rect: '長方形',
  fibo: 'フィボナッチ',
  fiboexp: 'フィボナッチ・エクスパンション',
};

const COLORS: Record<DrawingKind, string> = {
  hline: '#e5a50a',
  vline: '#9a9a9a',
  trend: '#4493f8',
  poly: '#4493f8',
  channel: '#3fb950',
  rect: '#a371f7',
  fibo: '#e5a50a',
  fiboexp: '#e5a50a',
};

/** MT4 の既定と同じ。0 が 2 点目、100 が 1 点目（「水準」で変えられる。これは初期値） */
export const FIBO_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 1, 1.618];

/** エクスパンションの水準の初期値（MT4 の既定と同じ）。C から A→B の値幅 × 水準だけ B の向きに進んだ価格 */
export const FIBO_EXP_LEVELS = [0.618, 1, 1.618];

/**
 * 画面で入れた水準（% の値。61.8 など）を、図形に使う割合（0.618）にする。
 * 数でないもの・重なるものは除き、小さい順に並べる
 */
export function levelsFromPercents(values: readonly number[]): number[] {
  const out = values.filter((v) => Number.isFinite(v)).map((v) => Math.round(v * 1e4) / 1e6);
  return [...new Set(out)].sort((x, y) => x - y);
}

/** エクスパンションの水準の価格 */
export function fiboExpPrice(a: number, b: number, c: number, level: number): number {
  return c + (b - a) * level;
}

const HIT = 6;
const HANDLE = 4;

interface Px {
  x: number;
  y: number;
}

function onePoint(kind: DrawingKind) {
  return kind === 'hline' || kind === 'vline';
}

/** つまみの位置。長方形は 4 隅（2 = A の時刻・B の価格、3 = B の時刻・A の価格）、ほかは点そのもの */
function handlesOf(kind: DrawingKind, pts: Px[]): Px[] {
  if (kind !== 'rect' || pts.length < 2) return pts;
  const [a, b] = pts;
  return [a, b, { x: a.x, y: b.y }, { x: b.x, y: a.y }];
}

function distToSegment(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const u = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
}

/** a→b の直線を画面の右端（b が左なら左端）まで延ばした点 */
function rayEnd(a: Px, b: Px, w: number): Px {
  if (b.x === a.x) return b;
  const x = b.x > a.x ? w : 0;
  return { x, y: a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) };
}

/** 描いている途中（A→B をドラッグしている間）のチャネルの平行線の位置。描き終えたときと同じ、基準線の 40px 下 */
const CHANNEL_PREVIEW_DY = 40;

/** チャネルの平行線の、基準線からの縦のずれ（px）。C がまだ無ければ（描いている途中）決まった幅 */
function channelOffset(a: Px, b: Px, c: Px | null | undefined): number {
  if (!c) return CHANNEL_PREVIEW_DY;
  const base = b.x === a.x ? a.y : a.y + ((b.y - a.y) * (c.x - a.x)) / (b.x - a.x);
  return c.y - base;
}

export class DrawingManager implements ISeriesPrimitive<Time> {
  drawings: Drawing[] = [];
  selectedId: string | null = null;
  /** 選んでいるツール。null は通常のカーソル */
  tool: DrawingKind | null = null;
  digits = 3;
  /** このチャートの時間足（新しく描いた図形に記録する） */
  tf = 'M15';
  /** 図形の色（時間足ごとの色を main.ts で決める） */
  colorOf: (d: Drawing) => string = (d) => (d.tf ? (DEFAULT_TF_COLORS[d.tf] ?? d.color) : d.color);
  /** 図形の種類ごとの線の太さ（「色・太さ」で決める。選んでいるときは 1 太くする） */
  widthOf: (kind: DrawingKind) => number = () => DEFAULT_LINE_WIDTH;
  /** 描き直すたびに呼ぶ（選んでいる図形が変わったら、右上の太さ・線の種類の欄を出す・消すため） */
  onRefresh: () => void = () => {};

  /** 選んでいる図形（無ければ null） */
  selected(): Drawing | null {
    return this.drawings.find((x) => x.id === this.selectedId) ?? null;
  }

  /** 図形の線の太さ（その図形で決めていなければ種類ごとの太さ） */
  lineWidthOf(d: Drawing): number {
    return d.width ?? this.widthOf(d.kind);
  }
  /** フィボナッチ・エクスパンションの水準（main.ts で「水準」の設定を渡す） */
  levelsOf: (kind: 'fibo' | 'fiboexp') => readonly number[] = (k) => (k === 'fibo' ? FIBO_LEVELS : FIBO_EXP_LEVELS);
  /** フィボナッチの図形をダブルクリックしたとき（水準の設定を開く） */
  onEditLevels: (kind: 'fibo' | 'fiboexp') => void = () => {};
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
  /** 描いている途中のポリライン（最後の点はマウスに付いてくる仮の点） */
  private polyId: string | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly mapper: TimeMapper,
  ) {
    el.addEventListener('mousedown', (e) => this.onDown(e), true);
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    el.addEventListener('contextmenu', (e) => this.onContext(e), true);
    el.addEventListener('dblclick', (e) => this.onDouble(e), true);
  }

  private onDouble(e: MouseEvent) {
    if (this.polyId) {
      this.finishPoly();
      return;
    }
    const m = this.tool ? null : this.mouse(e);
    const hit = m && this.hitDrawing(m.px);
    const d = hit && this.drawings.find((x) => x.id === hit.id);
    if (d && (d.kind === 'fibo' || d.kind === 'fiboexp')) {
      e.stopPropagation();
      this.onEditLevels(d.kind);
    }
    // チャネルはダブルクリックでレイ（右へ延ばす）を切り替える
    if (d && d.kind === 'channel') {
      e.stopPropagation();
      d.ray = !rayOn(d);
      this.onChange();
      this.refresh();
    }
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
          backColor: () => this.colorOf(d),
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
    if (this.polyId) this.endPoly();
    this.tool = tool;
    this.placing = null;
    this.el.style.cursor = tool ? 'crosshair' : '';
    this.onToolChange(tool);
  }

  /** 描いている途中のポリラインを終える（Enter キー用）。途中でなければ false */
  finishPoly(): boolean {
    if (!this.polyId) return false;
    this.endPoly();
    this.setTool(null);
    return true;
  }

  /**
   * 仮の点と、ダブルクリックで重なった点を取り除いて確定する。2 点に満たなければ消す。
   * 確定した線は 1 本ずつ独立したトレンドラインにする（余計な 1 本だけを消せるように。2026-10-23）
   */
  private endPoly() {
    const d = this.drawings.find((x) => x.id === this.polyId);
    this.polyId = null;
    if (!d) return;
    d.points.pop();
    const pts: Drawing['points'] = [];
    for (const pt of d.points) {
      const last = pts[pts.length - 1];
      const a = last && this.toPx(last);
      const b = this.toPx(pt);
      if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < 3) continue;
      pts.push(pt);
    }
    const segments: Drawing[] = [];
    for (let k = 1; k < pts.length; k++) segments.push({ id: crypto.randomUUID(), kind: 'trend', points: [pts[k - 1], pts[k]], color: COLORS.trend, tf: d.tf });
    const at = this.drawings.indexOf(d);
    this.drawings = [...this.drawings.slice(0, at), ...segments, ...this.drawings.slice(at + 1)];
    // 描き終えたら何も選ばない（最後の 1 本が選ばれたままだと気になるため。2026-10-26）
    this.selectedId = null;
    this.onChange();
    this.refresh();
  }

  /** ポリラインを描いている途中なら、最後に置いた点（＝最後の 1 本）を取り消す。点が無くなれば描くのをやめる */
  undoPolyPoint(): boolean {
    const d = this.drawings.find((x) => x.id === this.polyId);
    if (!d) return false;
    // 最後の点はマウスに付いてくる仮の点。その手前の、置いた点を消す
    d.points.splice(d.points.length - 2, 1);
    if (d.points.length < 2) {
      this.drawings = this.drawings.filter((x) => x !== d);
      this.polyId = null;
      this.setTool(null);
    }
    this.refresh();
    return true;
  }

  deleteSelected(): boolean {
    if (!this.selectedId || this.selected()?.locked) return false;
    this.drawings = this.drawings.filter((d) => d.id !== this.selectedId);
    this.selectedId = null;
    this.onChange();
    this.refresh();
    return true;
  }

  /** ロックした図形は残す */
  clearAll() {
    this.drawings = this.drawings.filter((d) => d.locked);
    this.selectedId = null;
    this.onChange();
    this.refresh();
  }

  refresh() {
    this.requestUpdate();
    this.onRefresh();
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
    // 価格の目盛り・時間の目盛り・RCI などのサブウィンドウの上は対象外
    const paneHeight = this.chart.panes()[0]?.getHeight() ?? this.el.clientHeight - this.chart.timeScale().height();
    if (px.x > this.chart.timeScale().width() || px.y > paneHeight) return null;
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
        const hs = handlesOf(d.kind, pts as Px[]);
        for (let h = 0; h < hs.length; h++) if (Math.hypot(px.x - hs[h].x, px.y - hs[h].y) <= HIT) return { id: d.id, handle: h };
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
          hit = distToSegment(px, a, rayOn(d) ? rayEnd(a, b, w) : b) <= HIT;
          break;
        case 'poly':
          for (let q = 1; q < pts.length; q++) if (distToSegment(px, pts[q - 1]!, pts[q]!) <= HIT) hit = true;
          break;
        case 'channel': {
          const dy = channelOffset(a, b, pts[2]);
          const end = rayOn(d) ? rayEnd(a, b, w) : b;
          hit = [0, dy / 2, dy].some((o) => distToSegment(px, { x: a.x, y: a.y + o }, { x: end.x, y: end.y + o }) <= HIT);
          break;
        }
        case 'rect': {
          const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
          const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
          // 枠の線の上だけ（中をクリックしても選ばない。中にある足やほかの線を触れるように）
          const inX = px.x >= x1 - HIT && px.x <= x2 + HIT;
          const inY = px.y >= y1 - HIT && px.y <= y2 + HIT;
          hit = (inY && (Math.abs(px.x - x1) <= HIT || Math.abs(px.x - x2) <= HIT)) || (inX && (Math.abs(px.y - y1) <= HIT || Math.abs(px.y - y2) <= HIT));
          break;
        }
        case 'fibo': {
          hit = distToSegment(px, a, b) <= HIT;
          for (const lv of this.levelsOf('fibo')) {
            const y = b.y + (a.y - b.y) * lv;
            if (Math.abs(px.y - y) <= HIT && px.x >= Math.min(a.x, b.x) - HIT && px.x <= w) hit = true;
          }
          break;
        }
        case 'fiboexp': {
          // 描いている途中（C を置く前に Esc など）は C = B とみなす
          const c = pts[2] ?? b;
          hit = distToSegment(px, a, b) <= HIT || distToSegment(px, b, c) <= HIT;
          for (const lv of this.levelsOf('fiboexp')) {
            const y = c.y + (b.y - a.y) * lv;
            if (Math.abs(px.y - y) <= HIT && px.x >= c.x - HIT && px.x <= w) hit = true;
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

    if (this.tool === 'poly') {
      const pt = { t: this.mapper.toTime(m.l), p: m.p };
      const d = this.drawings.find((x) => x.id === this.polyId);
      // 描いている途中のポリラインの、もう引いた線（か点）をクリックしたら終わる（最後の仮の線は除く）
      if (d) {
        const fixed = d.points.slice(0, -1).map((pt) => this.toPx(pt));
        const onLine = fixed.some((q, i) => q && (Math.hypot(m.px.x - q.x, m.px.y - q.y) <= HIT || (i > 0 && fixed[i - 1] && distToSegment(m.px, fixed[i - 1]!, q) <= HIT)));
        if (onLine) {
          this.finishPoly();
          e.stopPropagation();
          e.preventDefault();
          this.refresh();
          return;
        }
      }
      if (d) {
        // 仮の点をここに固定して、次の仮の点を足す
        d.points[d.points.length - 1] = pt;
        d.points.push({ ...pt });
      } else {
        const nd: Drawing = { id: crypto.randomUUID(), kind: 'poly', points: [pt, { ...pt }], color: COLORS.poly, tf: this.tf };
        this.drawings.push(nd);
        this.selectedId = nd.id;
        this.polyId = nd.id;
      }
      e.stopPropagation();
      e.preventDefault();
      this.refresh();
      return;
    }

    if (this.tool) {
      const d: Drawing = {
        id: crypto.randomUUID(),
        kind: this.tool,
        points: onePoint(this.tool) ? [{ t: this.mapper.toTime(m.l), p: m.p }] : [0, 1].map(() => ({ t: this.mapper.toTime(m.l), p: m.p })),
        color: COLORS[this.tool],
        tf: this.tf,
      };
      this.drawings.push(d);
      this.selectedId = d.id;
      // 水平線・垂直線は押している間マウスに付いてきて、離した所に置く。ほかは 2 点目（B）を動かす
      const handle = onePoint(d.kind) ? 0 : 1;
      this.drag = { id: d.id, handle, start: { l: m.l, p: m.p }, orig: d.points.map(() => ({ l: m.l, p: m.p })), moved: false, creating: true };
      e.stopPropagation();
      e.preventDefault();
      this.refresh();
      return;
    }

    const hit = this.hitDrawing(m.px);
    const before = this.selectedId;
    this.selectedId = hit?.id ?? null;
    const d = hit ? this.drawings.find((x) => x.id === hit.id)! : null;
    // ロックした図形は選ぶだけ（動かさない。ドラッグはチャートを動かす）
    if (hit && d && !d.locked) {
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
    const id = this.drag?.id ?? this.placing ?? this.polyId;
    if (!id) return;
    const m = this.mouse(e);
    if (!m) return;
    const d = this.drawings.find((x) => x.id === id);
    if (!d) return;
    if (!this.drag && this.polyId) {
      d.points[d.points.length - 1] = { t: this.mapper.toTime(m.l), p: m.p };
      this.refresh();
      return;
    }
    if (this.placing) {
      d.points[d.points.length - 1] = { t: this.mapper.toTime(m.l), p: m.p };
      this.refresh();
      return;
    }
    const drag = this.drag!;
    const dl = m.l - drag.start.l;
    const dp = m.p - drag.start.p;
    if (Math.abs(dl) > 0 || Math.abs(dp) > 0) drag.moved = true;
    d.points = drag.orig.map((o, k) => {
      if (drag.handle === -1) return { t: this.mapper.toTime(o.l + dl), p: o.p + dp };
      // 長方形の残りの 2 隅: 2 = (A の時刻, B の価格)、3 = (B の時刻, A の価格)
      if (d.kind === 'rect' && drag.handle >= 2) {
        const timeOf = drag.handle === 2 ? 0 : 1;
        return { t: this.mapper.toTime(k === timeOf ? m.l : o.l), p: k === timeOf ? o.p : m.p };
      }
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
      const d = this.drawings.find((x) => x.id === drag.id);
      if (d && onePoint(d.kind)) {
        this.finishCreate();
        return;
      }
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
    const d = this.drawings.find((x) => x.id === this.selectedId);
    if (d?.kind === 'channel' && d.points.length === 2 && this.series) {
      // 平行線は、とりあえず基準線の 40px 下に置く（描いている間に見せていた所。後からドラッグで動かす）
      const y = this.series.priceToCoordinate(d.points[0].p);
      const p = y === null ? null : this.series.coordinateToPrice(y + CHANNEL_PREVIEW_DY);
      d.points.push({ t: d.points[0].t, p: p ?? d.points[0].p });
    }
    if (d?.kind === 'fiboexp' && d.points.length === 2) {
      // A・B を置いたら、C はマウスに付いてきて、次のクリックで決まる
      d.points.push({ ...d.points[1] });
      this.placing = d.id;
      this.refresh();
      return;
    }
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
    const color = this.colorOf(d);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    // 太さは図形ごと（決めていなければ種類ごと。初期値 2。1 だと薄く暗く見えることがある）。選んでいるときは 1 太くする
    const width = this.lineWidthOf(d);
    ctx.lineWidth = sel ? width + 1 : width;
    // 線の種類（実線・点線・破線）。フィボの A→B の補助線とチャネルの中央線は、これとは別にいつも細かい点線
    const dash = lineDash(d.style, width);
    ctx.setLineDash(dash);
    ctx.font = '11px system-ui, sans-serif';
    const [a, b] = pts;
    // フィボの水準の数値は、線の右端（価格の目盛りの手前）に、線のすぐ上に書く
    const rightLabel = (text: string, y: number) => ctx.fillText(text, w - ctx.measureText(text).width - 6, y - 3);
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
      case 'trend': {
        const end = rayOn(d) ? rayEnd(a, b, w) : b;
        line(a.x, a.y, end.x, end.y);
        break;
      }
      case 'poly':
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        break;
      case 'channel': {
        // 描いている途中（C がまだ無い）も、描き終えたときと同じ形で見せる
        const dy = channelOffset(a, b, pts[2]);
        // レイを外していれば B まで（右へ延ばさない）
        const end = rayOn(d) ? rayEnd(a, b, w) : b;
        ctx.globalAlpha = 0.08;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(end.x, end.y);
        ctx.lineTo(end.x, end.y + dy);
        ctx.lineTo(a.x, a.y + dy);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        line(a.x, a.y, end.x, end.y);
        line(a.x, a.y + dy, end.x, end.y + dy);
        // 中央線（2 本のちょうど真ん中。点線）
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        line(a.x, a.y + dy / 2, end.x, end.y + dy / 2);
        ctx.restore();
        break;
      }
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
        ctx.setLineDash(dash);
        const x0 = Math.min(a.x, b.x);
        for (const lv of this.levelsOf('fibo')) {
          const y = b.y + (a.y - b.y) * lv;
          const price = d.points[1].p + (d.points[0].p - d.points[1].p) * lv;
          line(x0, y, w, y);
          rightLabel(`${(lv * 100).toFixed(1)}  ${price.toFixed(this.digits)}`, y);
        }
        break;
      }
      case 'fiboexp': {
        const c = pts[2] ?? b;
        const [pa, pb] = [d.points[0].p, d.points[1].p];
        const pc = d.points[2]?.p ?? pb;
        ctx.setLineDash([4, 3]);
        line(a.x, a.y, b.x, b.y);
        line(b.x, b.y, c.x, c.y);
        ctx.setLineDash(dash);
        for (const lv of this.levelsOf('fiboexp')) {
          const y = c.y + (b.y - a.y) * lv;
          line(c.x, y, w, y);
          rightLabel(`FE ${(lv * 100).toFixed(1)}  ${fiboExpPrice(pa, pb, pc, lv).toFixed(this.digits)}`, y);
        }
        break;
      }
    }
    // ロックした図形には、つまみを出さない（動かせないので）
    if (sel && !onePoint(d.kind) && !d.locked) {
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      for (const p of handlesOf(d.kind, pts)) {
        ctx.fillRect(p.x - HANDLE, p.y - HANDLE, HANDLE * 2, HANDLE * 2);
        ctx.strokeRect(p.x - HANDLE, p.y - HANDLE, HANDLE * 2, HANDLE * 2);
      }
    }
    ctx.restore();
  }
}
