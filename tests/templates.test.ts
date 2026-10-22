// 定型（src/templates.ts）
import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/state';
import { applyTemplate, pickTemplate } from '../src/templates';

const base = {
  version: 1,
  symbol: 'xauusd',
  tf: 'H1',
  zone: 'jst',
  cursor: 123,
  speed: 3,
  pauseOnFill: true,
  lots: 0.1,
  terminalTab: 'trade',
  terminalHeight: 200,
  test: { startTime: 1 },
  drawings: { xauusd: [{ id: 'd1' }] },
  layout: '4',
  panes: [{ tf: 'M15' }, { tf: 'H1' }, { tf: 'H4' }, { tf: 'D1' }],
  indicatorSets: { H1: { ma: [{ period: 21 }] } },
  tfColors: { H1: '#ff0000' },
  hiddenTfs: ['M30'],
} as unknown as AppState;

describe('定型', () => {
  it('並べ方・インジケーター・色などだけを取り出す（検証・図形は入れない）', () => {
    const t = pickTemplate(base);
    expect(Object.keys(t).sort()).toEqual(['hiddenTfs', 'indicatorSets', 'layout', 'panes', 'tfColors', 'zone']);
    expect(t).not.toHaveProperty('test');
    expect(t).not.toHaveProperty('drawings');
  });

  it('当てると定型の設定に置き換わり、検証・図形・銘柄はそのまま。定型に無い設定は初期値に戻す', () => {
    const t = pickTemplate(base);
    const other = { ...base, symbol: 'usdjpy', layout: '1', tfColors: { H1: '#00ff00' }, fiboLevels: { fibo: [0.5] }, hiddenTfs: undefined } as unknown as AppState;
    const next = applyTemplate(other, t);
    expect(next.layout).toBe('4');
    expect(next.tfColors).toEqual({ H1: '#ff0000' });
    expect(next.hiddenTfs).toEqual(['M30']);
    expect(next.fiboLevels).toBeUndefined();
    expect(next.symbol).toBe('usdjpy');
    expect(next.drawings).toBe(other.drawings);
    // 中身は写し（当てた後に変えても定型は変わらない）
    next.panes![0].tf = 'M1';
    expect(t.panes![0].tf).toBe('M15');
  });
});
