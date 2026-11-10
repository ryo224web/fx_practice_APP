// 「RCI の 0 付近」を背景で知らせる。決めた時間足（初めは M15）の RCI（初めは 25）が -20〜+20 にある時間だけ、
// どの時間足のチャートでも背景をうっすら塗る。2 波の戻しで M15 の RCI25 が 0 付近まで戻ったかを、
// M1 を見たまま気づけるようにするため（M15 のチャートを見に行かなくてよい。2026-11-09）。
// 今の足（できかけ）の RCI は、今の時刻の終値で計算する（先の値は使わない）。

import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';
import { rciAt } from '../indicators/calc';
import type { TimeMapper } from './mapper';

export interface RciZoneConfig {
  enabled: boolean;
  /** RCI を計算する時間足（"M15" など） */
  tf: string;
  /** RCI の期間 */
  period: number;
  /** ±この値の内側に入ったら塗る */
  level: number;
}

export const DEFAULT_RCI_ZONE: RciZoneConfig = { enabled: true, tf: 'M15', period: 25, level: 20 };

/** 塗る時間（UTC ミリ秒。t0 以上 t1 未満） */
export interface Span {
  t0: number;
  t1: number;
}

/**
 * 塗る時間を求める。starts・barTimes は決めた時間足の足の始まり（1 分足の添字と時刻）、closes はその足の終値、
 * k は今の足、partialClose は今の足の今の終値、now は今の時刻の終わり（塗るのはここまで）。from 本前の足から見る
 */
export function rciZoneSpans(
  barTimes: ArrayLike<number>,
  closes: ArrayLike<number>,
  k: number,
  partialClose: number,
  now: number,
  size: number,
  cfg: RciZoneConfig,
  cache: Float64Array | null,
  back = 800,
): Span[] {
  const out: Span[] = [];
  const from = Math.max(cfg.period - 1, k - back);
  for (let j = from; j <= k; j++) {
    let r: number;
    if (j < k) {
      if (cache && !Number.isNaN(cache[j])) r = cache[j];
      else {
        r = rciAt(closes, j, cfg.period);
        if (cache) cache[j] = r;
      }
    } else r = rciAt(closes, k, cfg.period, partialClose);
    if (!(Math.abs(r) <= cfg.level)) continue;
    const t0 = barTimes[j];
    const t1 = j < k ? Math.min(t0 + size, j + 1 < barTimes.length ? barTimes[j + 1] : t0 + size) : Math.min(t0 + size, now);
    const last = out[out.length - 1];
    if (last && last.t1 >= t0) last.t1 = Math.max(last.t1, t1);
    else out.push({ t0, t1 });
  }
  return out;
}

/** チャートの後ろに、塗る時間を縦の帯で描く */
export class RciZoneOverlay implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private requestUpdate: () => void = () => {};
  private spans: Span[] = [];

  constructor(private readonly mapper: TimeMapper) {}

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart as IChartApi;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
  }

  set(spans: Span[]) {
    const same = spans.length === this.spans.length && spans.every((s, i) => s.t0 === this.spans[i].t0 && s.t1 === this.spans[i].t1);
    if (same) return;
    this.spans = spans;
    this.requestUpdate();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [{ zOrder: () => 'bottom', renderer: () => this.renderer() }];
  }

  private renderer(): IPrimitivePaneRenderer {
    return {
      draw: (target) => {
        if (!this.chart || !this.spans.length) return;
        const ts = this.chart.timeScale();
        const half = ts.options().barSpacing / 2;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          ctx.save();
          ctx.fillStyle = 'rgba(76, 139, 245, 0.11)';
          for (const s of this.spans) {
            const x0 = this.mapper.toX(ts, s.t0);
            const x1 = this.mapper.toX(ts, s.t1);
            if (x0 === null || x1 === null) continue;
            const left = x0 - half;
            const right = x1 - half;
            if (right < 0 || left > mediaSize.width) continue;
            ctx.fillRect(left, 0, Math.max(1, right - left), mediaSize.height);
          }
          ctx.restore();
        });
      },
    };
  }
}
