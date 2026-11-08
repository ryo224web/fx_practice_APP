// 成績のグラフ（SVG の文字列）。画面の成績タブと、書き出す HTML レポートの両方で使う。
// 色は CSS の変数（--pos・--neg・--muted・--grid・--accent）に従うので、明るい表示・暗い表示のどちらでも見える。

const W = 640;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function niceRange(lo: number, hi: number): [number, number] {
  if (lo === hi) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

const yen = (v: number) => `${(Math.round(v) || 0).toLocaleString('ja-JP')}`;

/**
 * 残高の推移（線）と、山からの下げ（ドローダウン、薄い赤の帯）。
 * r（R の累積）があれば、右の目盛りで R の線も重ねる。R の 0 は初期資金の線にそろえるので、
 * 複利（ロットの大きさ）でふくらんだ残高の線と、同じリスクで建てたときの手法そのものの線を見比べられる
 */
export function equityChart(points: { balance: number; drawdown: number; r?: number }[], initial: number): string {
  const H = 220;
  const L = 70;
  const T = 12;
  const B = 24;
  if (points.length < 2) return `<p class="hint">決済した取引が 1 回以上になると表示します</p>`;
  const rs = points.map((p) => p.r ?? 0);
  const showR = rs.some((v) => v !== 0);
  const R = showR ? 44 : 10;
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
  let rPart = '';
  if (showR) {
    // R の 0 を初期資金の高さに置き、上下とも R の線が収まる幅にする
    const f = Math.min(0.95, Math.max(0.05, (initial - lo) / (hi - lo)));
    const rMax = Math.max(0, ...rs);
    const rMin = Math.min(0, ...rs);
    const span = Math.max(rMax / (1 - f), -rMin / f, 1) * 1.08;
    const rLo = -f * span;
    const ry = (v: number) => T + ((H - T - B) * (rLo + span - v)) / span;
    const rLine = rs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${ry(v).toFixed(1)}`).join('');
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((s) => span / s <= 6) ?? 1000;
    const rTicks: number[] = [];
    for (let v = Math.ceil(rLo / step) * step; v <= rLo + span; v += step) rTicks.push(v);
    rPart = `${rTicks.map((v) => `<text x="${W - R + 6}" y="${ry(v) + 4}" class="axis">${v > 0 ? '+' : ''}${v}R</text>`).join('')}
    <path d="${rLine}" class="req"/>
    <text x="${(L + W - R) / 2}" y="${H - 6}" class="axis" text-anchor="middle"><tspan class="leg-eq">━</tspan> 残高（左・円）　<tspan class="leg-r">━</tspan> R の累積（右）　最後 ${rs[rs.length - 1] >= 0 ? '+' : ''}${rs[rs.length - 1].toFixed(1)}R</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="残高の推移">
    ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${yen(v)}</text>`).join('')}
    <line x1="${L}" x2="${W - R}" y1="${y(initial)}" y2="${y(initial)}" class="base"/>
    <path d="${dd}" class="dd"/>
    <path d="${line}" class="eq"/>
    ${rPart}
    <text x="${L}" y="${H - 6}" class="axis">1</text>
    <text x="${W - R}" y="${H - 6}" class="axis" text-anchor="end">${points.length - 1} 回目</text>
  </svg>`;
}

/** 棒グラフ（プラスは緑・マイナスは赤）。labelEvery で下の文字を間引く */
export function barChart(items: { label: string; value: number; note?: string; tone?: 'pos' | 'neg' }[], opts: { height?: number; labelEvery?: number; unit?: string; digits?: number } = {}): string {
  const H = opts.height ?? 160;
  const L = 60;
  const R = 10;
  const T = 10;
  const B = 34;
  if (!items.length) return `<p class="hint">データがありません</p>`;
  const fmt = (v: number) => (opts.digits ? (Math.round(v * 10 ** opts.digits) / 10 ** opts.digits || 0).toLocaleString('ja-JP') : yen(v));
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
      const tip = `${it.label}: ${fmt(it.value)}${opts.unit ?? ''}${it.note ? `（${it.note}）` : ''}`;
      const label = i % every === 0 ? `<text x="${x0 + bw * 0.35}" y="${H - B + 14}" class="axis" text-anchor="middle">${esc(it.label)}</text>` : '';
      return `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" class="${it.tone ?? (it.value >= 0 ? 'pos' : 'neg')}"><title>${esc(tip)}</title></rect>${label}`;
    })
    .join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
    <line x1="${L}" x2="${W - R}" y1="${y(hi - (hi - lo) * 0.1)}" y2="${y(hi - (hi - lo) * 0.1)}" class="grid"/>
    <text x="${L - 6}" y="${y(hi - (hi - lo) * 0.1) + 4}" class="axis" text-anchor="end">${fmt(hi - (hi - lo) * 0.1)}</text>
    <line x1="${L}" x2="${W - R}" y1="${y(lo + (hi - lo) * 0.1)}" y2="${y(lo + (hi - lo) * 0.1)}" class="grid"/>
    <text x="${L - 6}" y="${y(lo + (hi - lo) * 0.1) + 4}" class="axis" text-anchor="end">${fmt(lo + (hi - lo) * 0.1)}</text>
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
.chart .req { fill: none; stroke: #e3a33b; stroke-width: 1.6; }
.chart .leg-eq { fill: var(--accent); }
.chart .leg-r { fill: #e3a33b; }
.chart rect.pos { fill: var(--pos); }
.chart rect.neg { fill: var(--neg); }
`;
