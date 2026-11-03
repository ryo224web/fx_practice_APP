// 短い時間足のチャートに、長い時間足の足を後ろに重ねて描く（キーを押している間だけ。M1 に M5、M5 に M15、M15・M30 に H1、H1 に H4、H4 に D1）。
// M15 を見たまま、H1 の実体が前の高値・安値を抜けたかを確かめるため（時間足を切り替えて拡大し直す手間をなくす）。
// 実体は薄く塗った枠、ヒゲは真ん中の細い線。今の足は今の時刻までの 1 分足だけで作る（先の値は見せない）。

import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';
import type { Bar } from '../core/candles';
import type { TimeMapper } from './mapper';

const UP = '165, 214, 167';
const DOWN = '222, 122, 122';

export class HtfOverlay implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: () => void = () => {};
  /** 長い時間足の足（bars[0..k-1] は終わった足、k 番目は last） */
  private bars: readonly Bar[] = [];
  private k = -1;
  private last: Bar | null = null;
  /** 長い時間足の 1 本の長さ（ミリ秒） */
  private size = 3_600_000;

  constructor(private readonly mapper: TimeMapper) {}

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
    return [{ zOrder: () => 'bottom', renderer: () => this.renderer() }];
  }

  /** 描く足を決める（消すときは clear） */
  set(bars: readonly Bar[], k: number, last: Bar, size: number) {
    this.bars = bars;
    this.k = k;
    this.last = last;
    this.size = size;
    this.requestUpdate();
  }

  clear() {
    if (!this.last) return;
    this.bars = [];
    this.k = -1;
    this.last = null;
    this.requestUpdate();
  }

  private renderer(): IPrimitivePaneRenderer {
    return {
      draw: (target) => {
        if (!this.last || !this.chart || !this.series) return;
        const ts = this.chart.timeScale();
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        // 見えている範囲の足だけ描く
        const from = this.mapper.toTime(range.from) - this.size;
        const to = this.mapper.toTime(range.to + 1);
        let lo = 0;
        let hi = this.k;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (this.bars[mid].t < from) lo = mid + 1;
          else hi = mid;
        }
        const half = ts.options().barSpacing / 2;
        target.useMediaCoordinateSpace(({ context: ctx }) => {
          ctx.save();
          ctx.lineWidth = 1.5;
          for (let j = lo; j <= this.k; j++) {
            const b = j < this.k ? this.bars[j] : this.last!;
            if (b.t > to) break;
            const x0 = this.mapper.toX(ts, b.t);
            const x1 = this.mapper.toX(ts, b.t + this.size);
            const yo = this.series!.priceToCoordinate(b.o);
            const yc = this.series!.priceToCoordinate(b.c);
            const yh = this.series!.priceToCoordinate(b.h);
            const yl = this.series!.priceToCoordinate(b.l);
            if (x0 === null || x1 === null || yo === null || yc === null || yh === null || yl === null) continue;
            // 足の幅は、その時間に入る短い足の左端から右端まで（真ん中どうしでなく）
            const left = Math.round(x0 - half) + 0.5;
            const right = Math.round(x1 - half) - 0.5;
            const mid = Math.round((left + right) / 2) + 0.5;
            const top = Math.round(Math.min(yo, yc)) + 0.5;
            const bottom = Math.max(top + 1, Math.round(Math.max(yo, yc)) + 0.5);
            const rgb = b.c >= b.o ? UP : DOWN;
            ctx.fillStyle = `rgba(${rgb}, 0.2)`;
            ctx.strokeStyle = `rgba(${rgb}, 0.95)`;
            ctx.fillRect(left, top, right - left, bottom - top);
            ctx.strokeRect(left, top, right - left, bottom - top);
            ctx.beginPath();
            ctx.moveTo(mid, Math.round(yh));
            ctx.lineTo(mid, top);
            ctx.moveTo(mid, bottom);
            ctx.lineTo(mid, Math.round(yl));
            ctx.stroke();
          }
          ctx.restore();
        });
      },
    };
  }
}
