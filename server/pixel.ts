// ドット（方眼の点）で描く数字と天気のマーク（2026-11-27）。腕時計の液晶のように、1 マスずつ小さな四角の点で描き、点の間にすき間を空ける。
// 画像は SVG を img の data: にする（古い Kindle のブラウザでも出るよう、HTML の中に SVG を直接書かない）。

import { kindOf, KIND_JA } from './weather.ts';

/** 点の大きさ（マスに対する割合。残りがすき間） */
const DOT = 0.82;

/** 0/1 の行の並びを、点の SVG の img にする。h は高さ（px） */
function gridImg(rows: string[], h: number, alt: string, extraStyle = '', color = '#000', sub = 1, subDot = DOT, exact = sub > 1): string {
  // sub: 1 マスを sub×sub の小さな点に分ける（数字を SUUNTO のような細かい点の集まりに見せる）
  if (sub > 1) {
    rows = rows.flatMap((r) => Array(sub).fill(r.split('').map((c) => c.repeat(sub)).join('')));
  }
  const ny = rows.length;
  const nx = Math.max(...rows.map((r) => r.length));
  // exact: 間隔も点の大きさも整数 px にする（半端だと描くときに 1px 太り、すき間が埋まって塗りつぶしに見えた）
  const cell = exact ? Math.max(2, Math.round(h / ny)) : h / ny;
  if (exact) h = cell * ny;
  const w = Math.round(cell * nx);
  // 点が小さすぎる（4px 未満）ときは、すき間を空けると薄くかすれるので詰めて描く
  const dot = exact ? subDot : cell >= 4 ? DOT : 1;
  const dpx = exact ? Math.max(1, Math.round(cell * dot)) : cell * dot;
  const off = exact ? 0 : (cell - dpx) / 2;
  const d = dpx.toFixed(2);
  let rects = '';
  rows.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      if (r[x] === '1') rects += `<rect x="${(x * cell + off).toFixed(2)}" y="${(y * cell + off).toFixed(2)}" width="${d}" height="${d}"/>`;
    }
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges" fill="${color}">${rects}</svg>`;
  return `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="${w}" height="${h}" alt="${alt}" style="display:inline-block;vertical-align:baseline;${extraStyle}">`;
}

// ---- 数字（SUUNTO の腕時計のように、線の太さ 2 点の 7×12 マス。電卓の数字と同じ 7 本の線（a〜g）で作る）----
//   a: 上 / b: 右上 / c: 右下 / d: 下 / e: 左下 / f: 左上 / g: 真ん中
const SEG: Record<string, [number, number, number, number]> = {
  a: [0, 0, 6, 1],
  b: [5, 0, 6, 6],
  c: [5, 5, 6, 11],
  d: [0, 10, 6, 11],
  e: [0, 5, 1, 11],
  f: [0, 0, 1, 6],
  g: [0, 5, 6, 6],
};
const DIGIT_SEGS: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg' };
function segGlyph(segs: string, w = 7): string[] {
  return Array.from({ length: 12 }, (_, y) =>
    Array.from({ length: w }, (_, x) => (segs.split('').some((k) => { const [x0, y0, x1, y1] = SEG[k]; return x >= x0 && x <= x1 && y >= y0 && y <= y1; }) ? '1' : '0')).join(''),
  );
}
const GLYPHS: Record<string, string[]> = {
  ...Object.fromEntries(Object.entries(DIGIT_SEGS).map(([d, segs]) => [d, segGlyph(segs)])),
  ':': ['00', '00', '00', '11', '11', '00', '00', '11', '11', '00', '00', '00'],
  '-': ['00000', '00000', '00000', '00000', '00000', '11111', '11111', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00', '00', '00', '00', '00', '00', '00', '00', '00', '00', '11', '11'],
};
// 「1」は SUUNTO と同じく右の線だけの細い幅にする。左に 2 マスの余白を残す（詰めすぎると「11」がくっついて見えた。2026-11-27）
GLYPHS['1'] = GLYPHS['1'].map((r) => r.slice(3));
const GLYPH_ROWS = 12;

/**
 * 数字・コロン・マイナス・点をドットで、それ以外の文字（日・分・℃ など）はそのまま字で出す HTML。
 * h はドットの数字の高さ（px）。数字と数字の間は 1 マス
 */
export function pixelText(text: string, h: number, color = '#000', dotRatio = 5 / 6): string {
  const cell = h / GLYPH_ROWS;
  let out = '';
  let run: string[] | null = null;
  const flush = () => {
    // 1 マス 1 点（6px 間隔・5px の点）。細かい 2×2 の点（2, 0.68）だとやりすぎに見えたので中間にした（2026-11-27）
    if (run) out += gridImg(run, h, '', `margin-right:${cell.toFixed(1)}px;vertical-align:-2px`, color, 1, dotRatio, true);
    run = null;
  };
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (g) {
      // 続く数字は 1 つの絵にまとめる（間に 1 マスのすき間）
      run = run ? run.map((r, i) => `${r}0${g[i]}`) : [...g];
    } else {
      flush();
      out += ch === ' ' ? `<span style="display:inline-block;width:${(cell * 2).toFixed(1)}px"></span>` : ch.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    }
  }
  flush();
  return out;
}

// ---- 天気のマーク（16×16。1 点ずつ手で描いた形）----

const SUN = [
  '................',
  '.......##.......',
  '.......##.......',
  '..##........##..',
  '..##..####..##..',
  '.....######.....',
  '....########....',
  '.##.########.##.',
  '.##.########.##.',
  '....########....',
  '.....######.....',
  '..##..####..##..',
  '..##........##..',
  '.......##.......',
  '.......##.......',
  '................',
];
const MOON = [
  '................',
  '......####......',
  '....###.........',
  '...##...........',
  '..###...........',
  '..##............',
  '.###............',
  '.###............',
  '.###............',
  '.####...........',
  '..####........#.',
  '..######....###.',
  '...##########...',
  '.....######.....',
  '................',
  '................',
];
// 雲（8 行。下は平ら）
const CLOUD = [
  '......####......',
  '.....#....#.....',
  '...###.....##...',
  '..#..........#..',
  '.#............#.',
  '.#............#.',
  '.#............#.',
  '..############..',
];
const SMALL_SUN = ['....#....', '.#.....#.', '...###...', '..#####..', '#.#####.#', '..#####..', '...###...', '.#.....#.', '....#....'];
const SMALL_MOON = ['..###....', '.##......', '##.......', '##.......', '##.......', '.##......', '..###....'];
// 雨は粒の数で 3 段階（弱い・ふつう・強い。2026-11-27）
const RAIN1 = ['......#.....#...', '.....#.....#....', '................', '................', '................'];
const RAIN2 = ['....#....#....#.', '...#....#....#..', '................', '..#....#....#...', '.#....#....#....'];
const RAIN3 = ['..#..#..#..#..#.', '.#..#..#..#..#..', '#..#..#..#..#...', '..#..#..#..#..#.', '.#..#..#..#..#..'];
// 雪は雪だるまで 3 段階（少し・ふつう・たくさん＝積もる）。小さな画面で雨と見分けやすいように（2026-11-27）。
// 帽子・2 つの目・3 つのボタン・木の枝の腕（ユーザーが見せた絵に合わせた。シルクハットとマフラーも試したが、こちらの方がよいと言われた）
const SNOWMAN = [
  '......####......',
  '......####......',
  '.....######.....',
  '.....#....#.....',
  '....#.#..#.#....',
  '....#......#....',
  '.....#....#....#',
  '....#......#.##.',
  '...#...##...##..',
  '..#..........#..',
  '..#....##....#..',
  '..#..........#..',
  '..#....##....#..',
  '...#........#...',
  '....########....',
  '................',
];
const FLAKES1: [number, number][] = [[1, 3], [14, 2]];
const FLAKES2: [number, number][] = [[1, 1], [14, 1], [0, 5], [14, 3], [0, 9], [15, 11]];
const FLAKES3: [number, number][] = [[1, 0], [3, 2], [14, 0], [13, 3], [15, 4], [0, 4], [1, 7], [0, 10], [15, 9]];
const SLEET = ['...#.....#....#.', '..#.....#....#..', '................', '.....#.....#....', '................'];
const BOLT = ['........#.......', '.......#........', '......####......', '........#.......', '.......#........', '......#.........'];
const FOG = ['................', '................', '................', '..############..', '................', '................', '................', '....########....', '................', '................', '................', '..############..'];

type Grid = string[];
const blank = (): string[][] => Array.from({ length: 16 }, () => Array(16).fill('.'));
/** 形を (dx, dy) に重ねる。mask が true なら、形の行の中（左端の点〜右端の点の間）にある下の点を消してから描く（雲の後ろの太陽を隠す） */
function put(g: string[][], shape: Grid, dx: number, dy: number, mask = false) {
  shape.forEach((row, y) => {
    const yy = y + dy;
    if (yy < 0 || yy >= 16) return;
    const first = row.indexOf('#');
    const last = row.lastIndexOf('#');
    for (let x = 0; x < row.length; x++) {
      const xx = x + dx;
      if (xx < 0 || xx >= 16) continue;
      if (row[x] === '#') g[yy][xx] = '#';
      else if (mask && first >= 0 && x > first && x < last) g[yy][xx] = '.';
    }
  });
}

/** 雨・雪の強さ（1: 弱い・少し / 2: ふつう / 3: 強い・たくさん）。WMO の天気コード */
export function level(code: number): 1 | 2 | 3 {
  if ([55, 57, 65, 67, 75, 82, 86].includes(code)) return 3;
  if ([53, 63, 73, 81].includes(code)) return 2;
  return 1;
}

function iconRows(code: number, isDay: boolean): string[] {
  const g = blank();
  switch (kindOf(code)) {
    case 'clear':
      put(g, isDay ? SUN : MOON, 0, 0);
      break;
    case 'partly':
      if (isDay) put(g, SMALL_SUN, 0, 0);
      else put(g, SMALL_MOON, 1, 1);
      put(g, CLOUD, 1, 7, true);
      break;
    case 'cloud':
      put(g, CLOUD, 0, 4);
      break;
    case 'fog':
      put(g, FOG, 0, 0);
      break;
    case 'thunder':
      put(g, CLOUD, 0, 1);
      put(g, BOLT, 0, 9);
      break;
    case 'snow': {
      const lv = level(code);
      put(g, SNOWMAN, 0, 0);
      for (const [x, y] of lv === 1 ? FLAKES1 : lv === 2 ? FLAKES2 : FLAKES3) g[y][x] = '#';
      // たくさん: 雪だるまの下半分が埋まるくらい積もっている
      if (lv === 3) for (let y = 12; y < 16; y++) for (let x = 0; x < 16; x++) g[y][x] = '#';
      else put(g, ['################'], 0, 15);
      break;
    }
    case 'sleet':
      put(g, CLOUD, 0, 1);
      put(g, SLEET, 0, 10);
      break;
    default: {
      const lv = level(code);
      put(g, CLOUD, 0, 1);
      put(g, lv === 1 ? RAIN1 : lv === 2 ? RAIN2 : RAIN3, 0, 10);
    }
  }
  return g.map((r) => r.join('').replace(/#/g, '1').replace(/\./g, '0'));
}

/** 降水確率の棒を 10 個の点で（10% ごとに 1 点を黒く塗り、残りは枠だけの点）。w は幅（px） */
export function popDots(pop: number | null, w: number, color = '#000'): string {
  const n = 10;
  const filled = Math.round(Math.max(0, Math.min(100, pop ?? 0)) / 10);
  const pitch = Math.floor(w / n);
  const d = Math.max(3, pitch - 2);
  let rects = '';
  for (let i = 0; i < n; i++) {
    const x = i * pitch + 0.5;
    rects += i < filled ? `<rect x="${x}" y="0.5" width="${d}" height="${d}" fill="${color}"/>` : `<rect x="${x + 0.5}" y="1" width="${d - 1}" height="${d - 1}" fill="none" stroke="${color}" stroke-width="1"/>`;
  }
  const W = pitch * n;
  const H = d + 1;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges">${rects}</svg>`;
  return `<img src="data:image/svg+xml,${encodeURIComponent(svg)}" width="${W}" height="${H}" alt="${pop ?? '-'}%" style="display:block;margin:4px auto 0">`;
}

/** ドットの天気のマーク（16×16）。size は一辺（px） */
export function pixelIcon(code: number, isDay: boolean, size: number): string {
  return gridImg(iconRows(code, isDay), size, KIND_JA[kindOf(code)], 'display:block;margin:0 auto;vertical-align:middle');
}
