// 保存先（Dropbox）を読めないときに、「無い」と取り違えて書かないこと（2026-11-28 に起きた）
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertStoreReadable, backupTime, orphanBackups, readJson, StoreUnreadable } from '../server/projectStore';
import { AlertBook } from '../server/priceAlerts';

const locked: string[] = [];
afterEach(() => {
  // 片付けられるように戻す
  for (const p of locked.splice(0)) chmodSync(p, 0o755);
});

function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fxp-store-'));
  mkdirSync(path.join(dir, 'projects'));
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ current: 'a', order: ['a'] }));
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ keymap: {} }));
  return dir;
}

describe('readJson', () => {
  it('無いときだけ null', async () => {
    const dir = store();
    expect(await readJson(path.join(dir, 'nothing.json'))).toBeNull();
    expect(await readJson(path.join(dir, 'index.json'))).toEqual({ current: 'a', order: ['a'] });
  });
  it('読めない（許可が無い）ときは null にせず止める', async () => {
    const dir = store();
    const f = path.join(dir, 'settings.json');
    chmodSync(f, 0o000);
    locked.push(f);
    await expect(readJson(f)).rejects.toBeInstanceOf(StoreUnreadable);
  });
  it('壊れている（書きかけ）ときも止める', async () => {
    const dir = store();
    writeFileSync(path.join(dir, 'index.json'), '{"current":"a","ord');
    await expect(readJson(path.join(dir, 'index.json'))).rejects.toBeInstanceOf(StoreUnreadable);
  });
});

describe('assertStoreReadable', () => {
  it('読めれば何もしない', async () => {
    await expect(assertStoreReadable(store())).resolves.toBeUndefined();
  });
  it('保存先のフォルダが無ければ止める（作り直して空から書き始めない）', async () => {
    await expect(assertStoreReadable(path.join(os.tmpdir(), 'fxp-no-such-dir-' + Date.now()))).rejects.toBeInstanceOf(StoreUnreadable);
  });
  it('フォルダを読めなければ止める', async () => {
    const dir = store();
    chmodSync(dir, 0o000);
    locked.push(dir);
    await expect(assertStoreReadable(dir)).rejects.toBeInstanceOf(StoreUnreadable);
  });
  it('中の設定を読めなければ止める', async () => {
    const dir = store();
    const f = path.join(dir, 'settings.json');
    chmodSync(f, 0o000);
    locked.push(f);
    await expect(assertStoreReadable(dir)).rejects.toBeInstanceOf(StoreUnreadable);
  });
});

describe('AlertBook', () => {
  it('alerts.json を読めない間は書かない（ほかの銘柄のアラートを消さない）', async () => {
    const dir = store();
    const f = path.join(dir, 'alerts.json');
    writeFileSync(f, JSON.stringify({ alerts: [{ id: 'x', sym: 'xauusd', p: 2000, t: 0 }] }));
    chmodSync(f, 0o000);
    locked.push(f);
    const book = new AlertBook(f, () => {});
    await expect(book.replace('usdjpy', [{ id: 'y', sym: 'usdjpy', p: 150, t: 0 }])).rejects.toThrow();
    // 読めるようになったら、前のアラートを残したまま足せる
    chmodSync(f, 0o644);
    await book.replace('usdjpy', [{ id: 'y', sym: 'usdjpy', p: 150, t: 0 }]);
    expect((await book.list()).map((a) => a.id).sort()).toEqual(['x', 'y']);
  });
});

describe('削除したプロジェクトの控えの片付け', () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 28);
  const stamp = (t: number) => `${new Date(t).toISOString().replace(/[:T]/g, '-').replace('Z', '')}.fxp.json`;
  it('本体が無く、一番新しい控えから 90 日たったフォルダだけ', () => {
    const folders = [
      { id: 'alive', files: [stamp(now - 200 * day)] }, // まだあるプロジェクトは古くても消さない
      { id: 'old', files: [stamp(now - 200 * day), stamp(now - 91 * day)] },
      { id: 'recent', files: [stamp(now - 200 * day), stamp(now - 30 * day)] }, // 削除して 30 日
      { id: 'noname', files: ['memo.fxp.json'] }, // 日時が読めないものは消さない
    ];
    expect(orphanBackups(folders, new Set(['alive']), now)).toEqual(['old']);
  });
  it('控えの名前の日時を読む', () => {
    expect(backupTime('2026-11-06-01-42-16.415.fxp.json')).toBe(Date.UTC(2026, 10, 6, 1, 42, 16));
    expect(backupTime('settings_20261121_141958.json')).toBeNaN();
  });
});
