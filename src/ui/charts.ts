// 成績のグラフ（SVG の文字列）。画面の成績タブと、書き出す HTML レポートの両方で使う。
// 色は CSS の変数（--pos・--neg・--muted・--grid・--accent）に従うので、明るい表示・暗い表示のどちらでも見える。

const W = 640;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function niceRange(lo: number, hi: number): [number, number] {
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

const yen = (v: number) => `${Math.round(v).toLocaleString('ja-JP')}`;

/** 残高の推移（線）と、山からの下げ（ドローダウン、薄い赤の帯） */
export function equityChart(points: { balance: number; drawdown: number }[], initial: number): string {
  const H = 220;
  const L = 70;
  const R = 10;
  const T = 12;
  const B = 24;
  if (points.length < 2) return `<p class="hint">決済した取引が 1 回以上になると表示します</p>`;
  const bal = points.map((p) => p.balance);
  const [lo, hi] = niceRange(Math.min(...bal, initial), Math.max(...bal, initial));
  const x = (i: number) => L + ((W - L - R) * i) / (points.length - 1);
  const y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`).join('');
  // ドローダウン: 山の高さから今の残高までを塗る
  const peak = points.map((p) => p.balance + p.drawdown);
  const dd =
    peak.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('') +
    points
      .map((p, i) => [i, p] as const)
      .reverse()
      .map(([i, p]) => `L${x(i).toFixed(1)},${y(p.balance).toFixed(1)}`)
      .join('') +
    'Z';
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="残高の推移">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${yen(v)}</text>`).join('')}
    <line x1="${L}" x2="${W - R}" y1="${y(initial)}" y2="${y(initial)}" class="base"/>
    <path d="${dd}" class="dd"/>
    <path d="${line}" class="eq"/>
    <text x="${L}" y="${H - 6}" class="axis">1</text>
    <text x="${W - R}" y="${H - 6}" class="axis" text-anchor="end">${points.length - 1} 回目</text>
  </svg>`;
}

/** 棒グラフ（プラスは緑・マイナスは赤）。labelEvery で下の文字を間引く */
export function barChart(items: { label: string; value: number; note?: string; tone?: 'pos' | 'neg' }[], opts: { height?: number; labelEvery?: number; unit?: string } = {}): string {
  const H = opts.height ?? 160;
  const L = 60;
  const R = 10;
  const T = 10;
  const B = 34;
  if (!items.length) return `<p class="hint">データがありません</p>`;
  const vals = items.map((i) => i.value);
  const [lo, hi] = niceRange(Math.min(0, ...vals), Math.max(0, ...vals));
  const y = (v: number) => T + ((H - T - B) * (hi - v)) / (hi - lo);
  const bw = (W - L - R) / items.length;
  const every = opts.labelEvery ?? Math.max(1, Math.ceil(items.length / 16));
  const bars = items
    .map((it, i) => {
      const x0 = L + i * bw + bw * 0.15;
      const y0 = y(Math.max(0, it.value));
      const h = Math.abs(y(it.value) - y(0));
      const tip = `${it.label}: ${yen(it.value)}${opts.unit ?? ''}${it.note ? `（${it.note}）` : ''}`;
      const label = i % every === 0 ? `<text x="${x0 + bw * 0.35}" y="${H - B + 14}" class="axis" text-anchor="middle">${esc(it.label)}</text>` : '';
      return `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" class="${it.tone ?? (it.value >= 0 ? 'pos' : 'neg')}"><title>${esc(tip)}</title></rect>${label}`;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
    <line x1="${L}" x2="${W - R}" y1="${y(hi - (hi - lo) * 0.1)}" y2="${y(hi - (hi - lo) * 0.1)}" class="grid"/>
    <text x="${L - 6}" y="${y(hi - (hi - lo) * 0.1) + 4}" class="axis" text-anchor="end">${yen(hi - (hi - lo) * 0.1)}</text>
    <line x1="${L}" x2="${W - R}" y1="${y(lo + (hi - lo) * 0.1)}" y2="${y(lo + (hi - lo) * 0.1)}" class="grid"/>
    <text x="${L - 6}" y="${y(lo + (hi - lo) * 0.1) + 4}" class="axis" text-anchor="end">${yen(lo + (hi - lo) * 0.1)}</text>
    ${bars}
    <line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" class="base"/>
  </svg>`;
}

/** グラフの見た目（画面とレポートの両方に入れる） */
export const CHART_CSS = `
.chart { width: 100%; max-width: 760px; height: auto; display: block; }
.chart .grid { stroke: var(--grid); stroke-width: 1; }
.chart .base { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
.chart .axis { fill: var(--muted); font-size: 11px; }
.chart .eq { fill: none; stroke: var(--accent); stroke-width: 2; }
.chart .dd { fill: var(--neg); opacity: 0.15; }
.chart rect.pos { fill: var(--pos); }
.chart rect.neg { fill: var(--neg); }
`;
