import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectStore, safeFileName, uniqueFileName } from '../server/projectStore';

describe('プロジェクトのファイル名', () => {
  it('使えない文字は _ にする', () => {
    expect(safeFileName('USDJPY/2026:10月')).toBe('USDJPY_2026_10月');
    expect(safeFileName('  ')).toBe('プロジェクト');
  });

  it('同じ名前があれば (2) (3) を付ける（大文字・小文字は区別しない）', () => {
    const taken = new Set(['a.fxp.json', 'a (2).fxp.json']);
    expect(uniqueFileName('A', taken)).toBe('A (3).fxp.json');
    expect(uniqueFileName('B', taken)).toBe('B.fxp.json');
  });
});

describe('プロジェクトの保存（フォルダ）', () => {
  let dir: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'fxp-'));
    let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};
    const plugin = projectStore(dir);
    // vite の開発サーバーの代わり（/api/projects を外した URL で呼ぶ）
    (plugin.configureServer as (s: unknown) => void)({
      middlewares: { use: (_: string, fn: typeof handler) => (handler = fn) },
    });
    server = createServer((req, res) => {
      req.url = req.url!.replace(/^\/api\/projects/, '') || '/';
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects`;
  });

  afterEach(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const put = (id: string, name: string) =>
    fetch(`${base}/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, state: { n: 1 }, updated: 1 }) });
  const files = async () => (await readdir(path.join(dir, 'projects'))).filter((f) => f.endsWith('.fxp.json')).sort();

  it('名前のファイル名で保存し、名前を変えるとファイル名も変わる', async () => {
    await put('id-1', 'プロジェクト 1');
    expect(await files()).toEqual(['プロジェクト 1.fxp.json']);
    await fetch(`${base}/id-1/rename`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'USDJPY 練習' }) });
    expect(await files()).toEqual(['USDJPY 練習.fxp.json']);
    const p = JSON.parse(await readFile(path.join(dir, 'projects', 'USDJPY 練習.fxp.json'), 'utf8'));
    expect(p).toMatchObject({ id: 'id-1', name: 'USDJPY 練習', state: { n: 1 } });
  });

  it('同じ名前の 2 つ目は (2) になり、保存し直してもファイル名は変わらない', async () => {
    await put('id-1', 'A');
    await put('id-2', 'A');
    await put('id-2', 'A');
    expect(await files()).toEqual(['A (2).fxp.json', 'A.fxp.json']);
    const list = await (await fetch(base)).json();
    expect(list.projects.map((p: { id: string }) => p.id).sort()).toEqual(['id-1', 'id-2']);
  });

  it('以前の形式（ファイル名が ID）は、一覧を読んだときに名前のファイル名へ移す', async () => {
    await mkdir(path.join(dir, 'projects'), { recursive: true });
    await writeFile(path.join(dir, 'projects', 'abc-123.fxp.json'), JSON.stringify({ format: 'fx-practice-project', version: 1, name: '古い', updated: 1, state: null }));
    const list = await (await fetch(base)).json();
    expect(list.projects).toEqual([{ id: 'abc-123', name: '古い', updated: 1 }]);
    expect(await files()).toEqual(['古い.fxp.json']);
    expect((await (await fetch(`${base}/abc-123`)).json()).name).toBe('古い');
  });
});
