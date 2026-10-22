// 開いたとき、ブラウザの控えとファイルのどちらを使うか（src/state.ts の localIsNewer）
import { describe, expect, it } from 'vitest';
import { localIsNewer } from '../src/state';

const M = 60_000;
describe('ブラウザの控えとファイルのどちらを使うか', () => {
  it('閉じる直前の分がファイルに届いていない（控えが新しく、ファイルは控えの元の版のまま）→ 控え', () => {
    expect(localIsNewer({ updated: 1000 + 5, state: null, base: 1000 }, 1000)).toBe(true);
  });
  it('Dropbox で古い版に戻した（ファイルの updated が控えの元の版と違う）→ ファイル', () => {
    expect(localIsNewer({ updated: 50 * M, state: null, base: 40 * M }, 20 * M)).toBe(false);
  });
  it('ほかの Mac が新しく保存した → ファイル', () => {
    expect(localIsNewer({ updated: 10 * M, state: null, base: 5 * M }, 12 * M)).toBe(false);
  });
  it('前の版の控え（base が無い）は、5 分以内の差だけ控えを使う', () => {
    expect(localIsNewer({ updated: 10 * M + 30_000, state: null }, 10 * M)).toBe(true);
    expect(localIsNewer({ updated: 46 * M, state: null }, 28 * M)).toBe(false);
  });
  it('控えが無い・古い → ファイル', () => {
    expect(localIsNewer(null, 1)).toBe(false);
    expect(localIsNewer({ updated: 1, state: null, base: 1 }, 5)).toBe(false);
  });
});
