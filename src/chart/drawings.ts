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

export type DrawingKind = 'hline' | 'vline' | 'trend' | 'poly' | 'channel' | 'rect' | 'fibo' | 'fiboexp' | 'text';

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
  /** テキストの中身（改行も入る）。点は文字の左上 */
  text?: string;
  /** テキストの文字の大きさ（px）。4 隅のつまみで拡大・縮小する。無ければ太さ 1〜4 から（TEXT_SIZES） */
  fontSize?: number;
  /** テキストの枠の幅・高さ（px）。左右・上下の辺のつまみで決める。幅を決めると、その幅で折り返す */
  boxW?: number;
  boxH?: number;
  /** テキストを吹き出しにする（右上の欄の 💬）。しっぽの先は 2 つ目の点（時刻と価格） */
  callout?: boolean;
  /**
   * 吹き出しの本体（文字の左上）の位置を、しっぽの先からの画面の距離（px）で持つ。時間足を変えても形が変わらない
   * （本体も時刻と価格で持つと、M1 と H1 で本体としっぽの先の離れ方が何十倍も変わるため。2026-10-27）
   */
  offset?: { x: number; y: number };
  /** 描いた日時（UTC ミリ秒。リプレイの時刻ではなく本当の日時）。テキストはマウスを乗せると右下にうっすら出す */
  created?: number;
}

/** テキストの枠の線と文字の間（px） */
const TEXT_PAD = 3;
/** 吹き出しの塗りの色（初め。欄の色を選ぶとその色）と、吹き出しの縁と文字の間・角の丸み（px） */
const CALLOUT_FILL = '#f3efe0';
const CALLOUT_PAD = 8;
const CALLOUT_RADIUS = 8;
const textPad = (d: Drawing) => (d.callout ? CALLOUT_PAD : TEXT_PAD);

/** 色が明るいか（吹き出しの文字を黒にするか白にするか決める） */
function isLight(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return true;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.6;
}

/**
 * 吹き出しのしっぽの付け根の 2 点。四角（x0〜x1・y0〜y1）の辺のうち、先（tip）に一番近い辺の上に置く。
 * 先が四角の中なら null（しっぽを描かない）
 */
function calloutTail(x0: number, y0: number, x1: number, y1: number, tip: Px): [Px, Px] | null {
  const r = CALLOUT_RADIUS;
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
  if (tip.y > y1 || tip.y < y0) {
    const y = tip.y > y1 ? y1 : y0;
    const hw = Math.min(10, (x1 - x0) / 4);
    const cx = clamp(tip.x, x0 + r + hw, x1 - r - hw);
    return [{ x: cx - hw, y }, { x: cx + hw, y }];
  }
  if (tip.x > x1 || tip.x < x0) {
    const x = tip.x > x1 ? x1 : x0;
    const hw = Math.min(10, (y1 - y0) / 4);
    const cy = clamp(tip.y, y0 + r + hw, y1 - r - hw);
    return [{ x, y: cy - hw }, { x, y: cy + hw }];
  }
  return null;
}

/** text を幅 maxW で折り返した行（maxW が無ければ改行だけで分ける）。日本語に合わせて 1 文字ずつ折り返す */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number | undefined): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    if (!maxW) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const ch of para) {
      if (line && ctx.measureText(line + ch).width > maxW) {
        out.push(line);
        line = ch;
      } else line += ch;
    }
    out.push(line);
  }
  return out;
}

/** テキストの文字の大きさ（px）。線の太さ 1〜4 をこの大きさにする（右上の欄の丸 4 つで選ぶ） */
export const TEXT_SIZES = [11, 13, 16, 20];
const textSize = (width: number) => TEXT_SIZES[Math.max(1, Math.min(4, width)) - 1];

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
/** 図形の種類ごとの線の太さの初期値（フィボは水準の線が多いので細く。2026-10-26） */
export const defaultLineWidth = (kind: DrawingKind) => (kind === 'fibo' || kind === 'fiboexp' ? 1 : DEFAULT_LINE_WIDTH);

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
  text: 'テキスト',
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
  text: '#e6edf3',
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
/** マグネットが吸い付く距離（px） */
const MAGNET = 15;

interface Px {
  x: number;
  y: number;
}

function onePoint(kind: DrawingKind) {
  return kind === 'hline' || kind === 'vline' || kind === 'text';
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
  widthOf: (kind: DrawingKind) => number = defaultLineWidth;
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
    /** テキストのつまみをつかんだときの枠（px）と文字の大きさ */
    text?: { x: number; y: number; w: number; h: number; size: number; boxW?: number; boxH?: number; mx: number; my: number };
  } | null = null;
  /** クリック 2 回で描く途中（1 点目を置いた後） */
  private placing: string | null = null;
  /** 描いている途中のポリライン（最後の点はマウスに付いてくる仮の点） */
  private polyId: string | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly mapper: TimeMapper,
  ) {
    // テキストを打つ欄の中のクリック・ダブルクリック・右クリックは、欄にそのまま任せる（図形をつかむ処理に回すと、
    // 既定の動きが止まって、欄の中にカーソルを置けなくなる）
    const inEditor = (e: Event) => !!(e.target as Element | null)?.closest?.('.draw-text-edit');
    el.addEventListener('mousedown', (e) => !inEditor(e) && this.onDown(e), true);
    window.addEventListener('mousemove', (e) => this.onMove(e));
    // テキストにマウスを乗せている間は、描いた日付を出す
    el.addEventListener('mousemove', (e) => this.onHover(e));
    el.addEventListener('mouseleave', () => this.setHover(null));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    el.addEventListener('contextmenu', (e) => !inEditor(e) && this.onContext(e), true);
    el.addEventListener('dblclick', (e) => !inEditor(e) && this.onDouble(e), true);
  }

  /** マウスを乗せているテキスト（描いた日付を出す） */
  private hoverId: string | null = null;

  private setHover(id: string | null) {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.refresh();
  }

  private onHover(e: MouseEvent) {
    if (this.drag || this.placing || this.polyId || this.editingId) return this.setHover(null);
    const r = this.el.getBoundingClientRect();
    const hit = this.hitDrawing({ x: e.clientX - r.left, y: e.clientY - r.top });
    const d = hit && this.drawings.find((x) => x.id === hit.id);
    this.setHover(d && d.kind === 'text' && d.created ? d.id : null);
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
    // テキストはダブルクリックで打ち直す
    if (d && d.kind === 'text' && !d.locked) {
      e.stopPropagation();
      this.editText(d);
      return;
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

  /** 時間の目盛りに出す札の時刻の書き方（十字線と同じ「2026.10.08 05:00」。表示の時刻帯は main が決める） */
  timeLabel: (utc: number) => string = (utc) => new Date(utc).toISOString().slice(0, 16).replace('T', ' ');

  /** 時間の目盛りの札: 垂直線はいつも、ほかの図形は選んでいるときだけ点の時刻を出す（価格の目盛りの札と同じ考え） */
  timeAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    const views: ISeriesPrimitiveAxisView[] = [];
    if (!this.chart) return views;
    const ts = this.chart.timeScale();
    for (const d of this.drawings) {
      if (d.kind !== 'vline' && d.id !== this.selectedId) continue;
      if (d.kind === 'hline' || d.kind === 'text') continue;
      for (const pt of d.kind === 'vline' ? d.points.slice(0, 1) : d.points) {
        const x = this.mapper.toX(ts, pt.t);
        if (x == null) continue;
        views.push({
          coordinate: () => x,
          text: () => this.timeLabel(pt.t),
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

  /** テキストの大きさ（描いたときに測る。つかむ判定に使う） */
  private textBoxes = new Map<string, { w: number; h: number }>();
  /** フィボの水準の数値の四角（描いたときに測る。水準の線ではなく、この数値でつかむ） */
  private fiboLabels = new Map<string, { x1: number; y1: number; x2: number; y2: number }[]>();
  /** 打ち直しているテキスト */
  private editingId: string | null = null;

  /** 吹き出しで、本体の位置をしっぽの先からの距離で持つか */
  private relative(d: Drawing): boolean {
    return d.kind === 'text' && !!d.callout && !!d.points[1];
  }

  /**
   * テキストの左上の位置（px）。吹き出しはしっぽの先 + 距離。距離をまだ持っていなければ（以前の吹き出し）、
   * 今の見た目から決めて覚える
   */
  textAnchor(d: Drawing): Px | null {
    if (!this.relative(d)) return this.toPx(d.points[0]);
    const tip = this.toPx(d.points[1]);
    if (!tip) return null;
    if (!d.offset) {
      const a = this.toPx(d.points[0]);
      if (!a) return null;
      d.offset = { x: a.x - tip.x, y: a.y - tip.y };
    }
    return { x: tip.x + d.offset.x, y: tip.y + d.offset.y };
  }

  /** テキストの左上を (x, y) px に置く。吹き出しはしっぽの先からの距離を変える（1 つ目の点も今の時間足に合わせておく） */
  private setTextAnchor(d: Drawing, x: number, y: number) {
    if (!this.chart || !this.series) return;
    const l = this.chart.timeScale().coordinateToLogical(x);
    const p = this.series.coordinateToPrice(y);
    if (l !== null && p !== null) d.points[0] = { t: this.mapper.toTime(l), p };
    const tip = this.relative(d) ? this.toPx(d.points[1]) : null;
    if (tip) d.offset = { x: x - tip.x, y: y - tip.y };
  }

  /** 吹き出しをふつうの文字に戻すとき、今の見た目の位置を 1 つ目の点にする */
  syncTextPoint(d: Drawing) {
    const a = this.textAnchor(d);
    if (a) this.setTextAnchor(d, a.x, a.y);
  }

  /** テキストの文字の大きさ（px） */
  textSizeOf(d: Drawing): number {
    return d.fontSize ?? textSize(this.lineWidthOf(d));
  }

  /**
   * テキストのつまみの位置（0〜3: 左上・右上・右下・左下、4〜7: 上・右・下・左の辺の真ん中。
   * 吹き出しなら 8: しっぽの先）
   */
  private textHandles(d: Drawing, a: Px, tip?: Px | null): Px[] {
    const box = this.textBoxes.get(d.id);
    if (!box) return [];
    const pad = textPad(d);
    const x0 = a.x - pad;
    const y0 = a.y - pad;
    const x1 = a.x + box.w + pad;
    const y1 = a.y + box.h + pad;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    return [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
      { x: mx, y: y0 },
      { x: x1, y: my },
      { x: mx, y: y1 },
      { x: x0, y: my },
      ...(d.callout && tip ? [tip] : []),
    ];
  }

  /** 吹き出しにしたとき、しっぽの先が無ければ、吹き出しの左下の少し下に置く */
  ensureTail(d: Drawing) {
    if (d.points[1] || !this.chart || !this.series) return;
    const at = this.textAnchor(d);
    // まだ描いていなければ（打ち終えた直後）、1 行分の大きさとみなす
    const box = this.textBoxes.get(d.id) ?? { w: 60, h: Math.round(this.textSizeOf(d) * 1.3) };
    if (!at) return;
    const l = this.chart.timeScale().coordinateToLogical(at.x + Math.min(30, box.w / 3));
    const p = this.series.coordinateToPrice(at.y + box.h + CALLOUT_PAD + 45);
    if (l !== null && p !== null) d.points[1] = { t: this.mapper.toTime(l), p };
    // 本体はしっぽの先からの距離で持つ
    const tip = this.toPx(d.points[1]);
    if (tip) d.offset = { x: at.x - tip.x, y: at.y - tip.y };
  }

  /** テキストのつまみを動かす。4 隅は反対の角を止めて拡大・縮小、辺は幅・高さだけ（左・上の辺は左上の点も動く） */
  private dragTextHandle(d: Drawing, handle: number, s: NonNullable<NonNullable<typeof this.drag>['text']>, mouse: Px) {
    const toPoint = (x: number, y: number) => this.setTextAnchor(d, x, y);
    if (handle === 8) {
      // しっぽの先（マグネットを入れていれば足に吸い付く）
      const l = this.chart!.timeScale().coordinateToLogical(mouse.x);
      const p = this.series!.coordinateToPrice(mouse.y);
      if (l === null || p === null) return;
      const m = this.snap({ px: mouse, l, p });
      d.points[1] = { t: this.mapper.toTime(m.l), p: m.p };
      // 本体は画面の同じ所に残す（しっぽの先からの距離を覚え直す）
      const tip = this.toPx(d.points[1]);
      if (tip) d.offset = { x: s.x - tip.x, y: s.y - tip.y };
      return;
    }
    const minW = 20;
    const lh = Math.round(s.size * 1.3);
    if (handle <= 3) {
      // 反対の角（つかんだ角の向かい）は止めたまま
      const right = handle === 1 || handle === 2;
      const bottom = handle === 2 || handle === 3;
      const fx = right ? s.x : s.x + s.w;
      const fy = bottom ? s.y : s.y + s.h;
      const k = Math.max(Math.abs(mouse.x - fx) / Math.max(1, s.w), Math.abs(mouse.y - fy) / Math.max(1, s.h));
      const scale = Math.max(8 / s.size, Math.min(96 / s.size, k));
      d.fontSize = Math.round(s.size * scale * 10) / 10;
      if (s.boxW !== undefined) d.boxW = s.boxW * scale;
      if (s.boxH !== undefined) d.boxH = s.boxH * scale;
      const w = s.w * scale;
      const h = s.h * scale;
      toPoint(right ? fx : fx - w, bottom ? fy : fy - h);
      return;
    }
    if (handle === 5) d.boxW = Math.max(minW, mouse.x - s.x);
    if (handle === 6) d.boxH = Math.max(lh, mouse.y - s.y);
    if (handle === 7) {
      const x = Math.min(mouse.x, s.x + s.w - minW);
      d.boxW = s.x + s.w - x;
      toPoint(x, s.y);
    }
    if (handle === 4) {
      const y = Math.min(mouse.y, s.y + s.h - lh);
      d.boxH = s.y + s.h - y;
      toPoint(s.x, y);
    }
  }

  /**
   * テキストを打つ欄を、その図形の所に出す。Enter で決まり、Shift+Enter で改行、Esc でやめる
   * （日本語の変換中の Enter では決めない）。空のまま決めたら図形を消す
   */
  editText(d: Drawing) {
    const at = this.textAnchor(d);
    if (!at) return;
    this.editingId = d.id;
    const size = this.textSizeOf(d);
    const ta = document.createElement('textarea');
    ta.className = 'draw-text-edit';
    ta.value = d.text ?? '';
    ta.style.left = `${at.x - 3}px`;
    ta.style.top = `${at.y - 3}px`;
    ta.style.fontSize = `${size}px`;
    // 幅は描いた枠に合わせる（幅を決めていればその幅で折り返す）。高さは中身に合わせて伸ばす
    const box = this.textBoxes.get(d.id);
    ta.style.width = `${(d.boxW ?? Math.max(180, (box?.w ?? 0) + size)) + textPad(d) * 2}px`;
    ta.style.whiteSpace = d.boxW ? 'pre-wrap' : 'pre';
    const fit = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.max(ta.scrollHeight, d.boxH ?? 0) + 2}px`;
    };
    ta.style.color = this.colorOf(d);
    if (d.callout) {
      // 吹き出しは、描いたときと同じ塗り・文字の色・縁の間で打つ
      const fill = d.custom ?? CALLOUT_FILL;
      ta.style.background = fill;
      ta.style.color = isLight(fill) ? '#111' : '#fff';
      ta.style.padding = `${CALLOUT_PAD - 1}px`;
      ta.style.borderRadius = `${CALLOUT_RADIUS}px`;
      ta.style.left = `${at.x - CALLOUT_PAD}px`;
      ta.style.top = `${at.y - CALLOUT_PAD}px`;
    }
    ta.placeholder = '文字を入力（Enter で決定）';
    this.el.append(ta);
    fit();
    this.refresh();
    ta.focus();
    ta.select();
    let finished = false;
    const done = (ok: boolean) => {
      if (finished) return;
      finished = true;
      const v = ta.value.replace(/\s+$/, '');
      ta.remove();
      this.editingId = null;
      if (ok) d.text = v;
      if (!d.text) this.drawings = this.drawings.filter((x) => x !== d);
      else if (d.callout) this.ensureTail(d);
      this.selectedId = null;
      this.onChange();
      this.refresh();
    };
    ta.addEventListener('keydown', (e) => {
      // ショートカット（Space で再生など）に渡さない
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      }
    });
    ta.addEventListener('input', fit);
    ta.addEventListener('blur', () => done(true));
    ta.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  /** マグネット（ツールバーの 🧲）。点を置く・動かすとき、近くの足の始値・高値・安値・終値に吸い付ける */
  magnet = false;

  /**
   * マウスの近く（左右・上下とも MAGNET px 以内）にある足の始値・高値・安値・終値のうち、一番近いものに吸い付けた位置。
   * 吸い付いたら時刻もその足にそろえる。マグネットが切れているか、近くに無ければそのまま。
   * マウスの真下の 1 本だけを見ると、水平線のように横の位置を気にせず置くときに吸い付かないため、左右の足も見る
   */
  private snap(m: { px: Px; l: number; p: number }): { px: Px; l: number; p: number } {
    if (!this.magnet || !this.series || !this.chart) return m;
    const spacing = this.chart.timeScale().options().barSpacing;
    const reach = Math.max(0, Math.ceil(MAGNET / Math.max(1, spacing)));
    const center = Math.round(m.l);
    let best: { l: number; p: number; d: number } | null = null;
    for (let i = center - reach; i <= center + reach; i++) {
      const bar = this.series.dataByIndex(i) as { open?: number; high?: number; low?: number; close?: number } | null;
      if (!bar || bar.open === undefined) continue;
      const dx = Math.abs(i - m.l) * spacing;
      if (dx > MAGNET + spacing / 2) continue;
      for (const v of [bar.open, bar.high, bar.low, bar.close]) {
        if (v === undefined) continue;
        const y = this.series.priceToCoordinate(v);
        if (y === null) continue;
        const dy = Math.abs(y - m.px.y);
        if (dy > MAGNET) continue;
        // 縦の近さを優先する（横に少しずれていても、価格が近い方に吸い付く）
        const d = dy * 2 + dx;
        if (!best || d < best.d) best = { l: i, p: v, d };
      }
    }
    return best ? { px: m.px, l: best.l, p: best.p } : m;
  }

  private onFiboLabel(id: string, px: Px): boolean {
    return (this.fiboLabels.get(id) ?? []).some((r) => px.x >= r.x1 - 2 && px.x <= r.x2 + 2 && px.y >= r.y1 - 2 && px.y <= r.y2 + 2);
  }

  private hitDrawing(px: Px): { id: string; handle: number } | null {
    const w = this.chart?.timeScale().width() ?? 0;
    for (let k = this.drawings.length - 1; k >= 0; k--) {
      const d = this.drawings[k];
      const pts = d.points.map((pt) => this.toPx(pt));
      if (pts.some((p) => !p)) continue;
      const b = pts[1] as Px;
      // 吹き出しの本体は、しっぽの先からの距離で置く
      const a = (d.kind === 'text' ? this.textAnchor(d) : null) ?? (pts[0] as Px);
      // テキストの 8 つのつまみ: 0〜3 は 4 隅（左上・右上・右下・左下。拡大・縮小）、4〜7 は辺（上・右・下・左。幅・高さ）
      if (d.id === this.selectedId && d.kind === 'text' && !d.locked) {
        const hs = this.textHandles(d, a, b);
        for (let h = 0; h < hs.length; h++) if (Math.hypot(px.x - hs[h].x, px.y - hs[h].y) <= HIT) return { id: d.id, handle: h };
      }
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
        case 'text': {
          // 文字の四角（描いたときに測った大きさ）の中
          const box = this.textBoxes.get(d.id);
          const pad = textPad(d) + 2;
          hit = !!box && px.x >= a.x - pad && px.x <= a.x + box.w + pad && px.y >= a.y - pad && px.y <= a.y + box.h + pad;
          // 吹き出しはしっぽの上でもつかめる
          if (!hit && box && d.callout && b) {
            const q = textPad(d);
            const base = calloutTail(a.x - q, a.y - q, a.x + box.w + q, a.y + box.h + q, b);
            if (base) hit = distToSegment(px, { x: (base[0].x + base[1].x) / 2, y: (base[0].y + base[1].y) / 2 }, b) <= HIT + 2;
          }
          break;
        }
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
          // A→B の線か、水準の数値でつかむ（水準の線の上ではつかまない。線の近くの足や図形を触れるように）
          hit = distToSegment(px, a, b) <= HIT || this.onFiboLabel(d.id, px);
          break;
        }
        case 'fiboexp': {
          // 描いている途中（C を置く前に Esc など）は C = B とみなす
          const c = pts[2] ?? b;
          hit = distToSegment(px, a, b) <= HIT || distToSegment(px, b, c) <= HIT || this.onFiboLabel(d.id, px);
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

    // 新しい点はマグネットで吸い付ける（もうある図形をつかむときは吸い付けない）
    const sm = this.snap(m);
    if (this.tool === 'poly') {
      const pt = { t: this.mapper.toTime(sm.l), p: sm.p };
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
        points: onePoint(this.tool) ? [{ t: this.mapper.toTime(sm.l), p: sm.p }] : [0, 1].map(() => ({ t: this.mapper.toTime(sm.l), p: sm.p })),
        color: COLORS[this.tool],
        tf: this.tf,
        created: Date.now(),
        // テキストは初めから吹き出し（右上の欄の 💬 でふつうの文字にできる）
        ...(this.tool === 'text' ? { callout: true } : {}),
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
      const at = d.kind === 'text' ? this.textAnchor(d) : null;
      const box = at && this.textBoxes.get(d.id);
      this.drag = {
        id: d.id,
        handle: hit.handle,
        start: { l: m.l, p: m.p },
        orig: d.points.map((pt) => ({ l: this.mapper.toLogical(pt.t), p: pt.p })),
        moved: false,
        creating: false,
        ...(at && box ? { text: { x: at.x, y: at.y, w: box.w, h: box.h, size: this.textSizeOf(d), boxW: d.boxW, boxH: d.boxH, mx: m.px.x, my: m.px.y } } : {}),
      };
      e.stopPropagation();
      e.preventDefault();
    }
    if (before !== this.selectedId) this.refresh();
  }

  private onMove(e: MouseEvent) {
    const id = this.drag?.id ?? this.placing ?? this.polyId;
    if (!id) return;
    // テキストのつまみは、ローソク足の欄の外（RCI の欄など）まで引っぱっても動かし続ける
    const td = this.drag?.text ? this.drawings.find((x) => x.id === id) : null;
    if (td && this.drag?.text && (this.drag.handle >= 0 || this.relative(td))) {
      const r = this.el.getBoundingClientRect();
      const mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      const s = this.drag.text;
      if (Math.hypot(mouse.x - s.mx, mouse.y - s.my) > 0) this.drag.moved = true;
      // 吹き出しの本体をつかんで動かすときは、本体だけ動かす（しっぽの先は指した足のまま）
      if (this.drag.handle < 0) this.setTextAnchor(td, s.x + mouse.x - s.mx, s.y + mouse.y - s.my);
      else this.dragTextHandle(td, this.drag.handle, s, mouse);
      this.refresh();
      return;
    }
    const m = this.mouse(e);
    if (!m) return;
    const d = this.drawings.find((x) => x.id === id);
    if (!d) return;
    // 点を置く・つまみを動かすときはマグネットで吸い付ける（図形をまるごと動かすときは吸い付けない）
    const sm = this.snap(m);
    if (!this.drag && this.polyId) {
      d.points[d.points.length - 1] = { t: this.mapper.toTime(sm.l), p: sm.p };
      this.refresh();
      return;
    }
    if (this.placing) {
      d.points[d.points.length - 1] = { t: this.mapper.toTime(sm.l), p: sm.p };
      this.refresh();
      return;
    }
    const drag = this.drag!;
    const dl = m.l - drag.start.l;
    const dp = m.p - drag.start.p;
    if (Math.abs(dl) > 0 || Math.abs(dp) > 0) drag.moved = true;
    d.points = drag.orig.map((o, k) => {
      // 水平線・垂直線は点が 1 つなので、つかんで動かすときもマグネットで吸い付ける
      if (drag.handle === -1 && onePoint(d.kind) && d.kind !== 'text' && this.magnet && sm !== m) return { t: this.mapper.toTime(sm.l), p: sm.p };
      if (drag.handle === -1) return { t: this.mapper.toTime(o.l + dl), p: o.p + dp };
      // 長方形の残りの 2 隅: 2 = (A の時刻, B の価格)、3 = (B の時刻, A の価格)
      if (d.kind === 'rect' && drag.handle >= 2) {
        const timeOf = drag.handle === 2 ? 0 : 1;
        return { t: this.mapper.toTime(k === timeOf ? sm.l : o.l), p: k === timeOf ? o.p : sm.p };
      }
      if (k === drag.handle) return { t: this.mapper.toTime(sm.l), p: sm.p };
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
    if (d?.kind === 'text') {
      // 置いたら、その場で文字を打つ
      this.setTool(null);
      this.refresh();
      this.editText(d);
      return;
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
    const b = pts[1];
    // 吹き出しの本体は、しっぽの先からの距離で置く（時間足を変えても形が変わらない）
    const a = (d.kind === 'text' ? this.textAnchor(d) : null) ?? pts[0];
    // フィボの水準の数値は、線の右端（価格の目盛りの手前）に、線のすぐ上に書く
    const labels: { x1: number; y1: number; x2: number; y2: number }[] = [];
    if (d.kind === 'fibo' || d.kind === 'fiboexp') this.fiboLabels.set(d.id, labels);
    const rightLabel = (text: string, y: number) => {
      const tw = ctx.measureText(text).width;
      ctx.fillText(text, w - tw - 6, y - 3);
      labels.push({ x1: w - tw - 6, y1: y - 14, x2: w - 6, y2: y - 1 });
    };
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
      case 'text': {
        // 打っている間は、打つ欄の方に出す
        if (this.editingId === d.id) break;
        const size = this.textSizeOf(d);
        ctx.font = `${size}px system-ui, -apple-system, 'Hiragino Sans', sans-serif`;
        ctx.textBaseline = 'top';
        const lines = wrapText(ctx, d.text ?? '', d.boxW);
        const lh = Math.round(size * 1.3);
        const tw = Math.max(0, ...lines.map((t) => ctx.measureText(t).width));
        // 枠の大きさ: 幅・高さを決めていればそれ（文字が多ければ高さは文字に合わせて伸びる）
        const bw = d.boxW ?? tw;
        const bh = Math.max(d.boxH ?? 0, lines.length * lh);
        this.textBoxes.set(d.id, { w: bw, h: bh });
        const pad = textPad(d);
        if (d.callout) {
          // 吹き出し: 角の丸い四角としっぽを塗り、文字は塗りが明るければ黒・暗ければ白
          const fill = d.custom ?? CALLOUT_FILL;
          const [x0, y0, x1, y1] = [a.x - pad, a.y - pad, a.x + bw + pad, a.y + bh + pad];
          ctx.setLineDash([]);
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.roundRect(x0, y0, x1 - x0, y1 - y0, CALLOUT_RADIUS);
          ctx.fill();
          const base = b ? calloutTail(x0, y0, x1, y1, b) : null;
          if (base && b) {
            ctx.beginPath();
            ctx.moveTo(base[0].x, base[0].y);
            ctx.lineTo(b.x, b.y);
            ctx.lineTo(base[1].x, base[1].y);
            ctx.closePath();
            ctx.fill();
          }
          ctx.fillStyle = isLight(fill) ? '#111' : '#fff';
        }
        lines.forEach((t, i) => ctx.fillText(t, a.x, a.y + i * lh));
        // マウスを乗せている間は、描いた日付を枠の右下のすぐ外にうっすら出す
        if (this.hoverId === d.id && d.created) {
          const c = new Date(d.created);
          const day = `${c.getFullYear()}.${String(c.getMonth() + 1).padStart(2, '0')}.${String(c.getDate()).padStart(2, '0')}`;
          ctx.save();
          ctx.font = '10px system-ui, -apple-system, sans-serif';
          ctx.fillStyle = '#8b949e';
          ctx.globalAlpha = 0.8;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'top';
          ctx.fillText(day, a.x + bw + pad, a.y + bh + pad + 3);
          ctx.restore();
        }
        if (sel) {
          ctx.strokeStyle = d.callout ? '#4493f8' : color;
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.strokeRect(a.x - pad, a.y - pad, bw + pad * 2, bh + pad * 2);
          ctx.setLineDash([]);
          if (!d.locked) {
            ctx.fillStyle = '#fff';
            for (const q of this.textHandles(d, a, b)) {
              ctx.fillRect(q.x - 3, q.y - 3, 6, 6);
              ctx.strokeRect(q.x - 3, q.y - 3, 6, 6);
            }
          }
        }
        break;
      }
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
