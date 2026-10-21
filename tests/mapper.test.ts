import { describe, expect, it } from 'vitest';
import { TimeMapper } from '../src/chart/mapper';

describe('時刻と足の位置の変換', () => {
  const H = 3_600_000;
  // 金曜 20 時の次が日曜 21 時（週末の空白）
  const m = new TimeMapper([0, H, 2 * H, 51 * H], H);

  it('足の時刻はその足の番号になる', () => {
    expect(m.toLogical(H)).toBe(1);
    expect(m.toTime(1)).toBe(H);
  });

  it('足の途中は比例、週末の空白は 1 本分に縮める', () => {
    expect(m.toLogical(1.5 * H)).toBe(1.5);
    expect(m.toLogical(30 * H)).toBe(3);
  });

  it('最後の足より先（未来）は時間足の長さで延ばす', () => {
    expect(m.toLogical(53 * H)).toBe(5);
    expect(m.toTime(5)).toBe(53 * H);
  });
});

describe('古い足を省いてチャートに渡したとき', () => {
  it('offset の分だけ位置をずらす（時刻との対応は変わらない）', () => {
    const H = 3_600_000;
    const m = new TimeMapper([0, H, 2 * H, 3 * H], H, 2);
    expect(m.toLogical(2 * H)).toBe(0);
    expect(m.toTime(1)).toBe(3 * H);
  });
});
