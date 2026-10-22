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
    const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void>();
    const plugin = projectStore(dir);
    // vite の開発サーバーの代わり（登録した道筋 /api/projects・/api/templates を外した URL で呼ぶ）
    (plugin.configureServer as (s: unknown) => void)({
      middlewares: { use: (p: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => handlers.set(p, fn) },
    });
    server = createServer((req, res) => {
      for (const [prefix, fn] of handlers) {
        if (!req.url!.startsWith(prefix)) continue;
        req.url = req.url!.slice(prefix.length) || '/';
        return fn(req, res);
      }
      res.statusCode = 404;
      res.end();
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
    expect(list.projects).toEqual([{ id: 'abc-123', name: '古い', updated: 1, folder: '' }]);
    expect(await files()).toEqual(['古い.fxp.json']);
    expect((await (await fetch(`${base}/abc-123`)).json()).name).toBe('古い');
  });

  const json = { method: 'PUT', headers: { 'Content-Type': 'application/json' } };
  const tree = async (): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (rel: string) => {
      for (const e of await readdir(path.join(dir, 'projects', rel), { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(r);
        else out.push(r);
      }
    };
    await walk('');
    return out.sort();
  };

  it('フォルダを決めるとファイルがそのフォルダへ移る（元のフォルダは空になっても残す）', async () => {
    await put('id-1', 'GOLD 2026 09');
    await fetch(`${base}/id-1/folder`, { ...json, body: JSON.stringify({ folder: 'MT4 / GOLD/2026//09 ' }) });
    expect(await tree()).toEqual(['MT4/GOLD/2026/09/GOLD 2026 09.fxp.json']);
    // 保存し直しても同じ場所。名前を変えても同じフォルダ
    await put('id-1', 'GOLD 2026 09');
    await fetch(`${base}/id-1/rename`, { ...json, body: JSON.stringify({ name: 'GOLD 9月' }) });
    expect(await tree()).toEqual(['MT4/GOLD/2026/09/GOLD 9月.fxp.json']);
    let list = (await (await fetch(base)).json()).projects;
    expect(list).toEqual([{ id: 'id-1', name: 'GOLD 9月', updated: 1, folder: 'MT4/GOLD/2026/09' }]);
    // 別のフォルダへ。前のフォルダは空でも残る（一覧に空のフォルダとして出る）
    await fetch(`${base}/id-1/folder`, { ...json, body: JSON.stringify({ folder: '練習' }) });
    expect(await tree()).toEqual(['練習/GOLD 9月.fxp.json']);
    expect((await (await fetch(base)).json()).folders.sort()).toEqual(['MT4', 'MT4/GOLD', 'MT4/GOLD/2026', 'MT4/GOLD/2026/09', '練習']);
    // フォルダの外へ
    await fetch(`${base}/id-1/folder`, { ...json, body: JSON.stringify({ folder: '' }) });
    expect(await tree()).toEqual(['GOLD 9月.fxp.json']);
    list = (await (await fetch(base)).json()).projects;
    expect(list[0].folder).toBe('');
  });

  it('作るときにフォルダを渡せる。同じ名前でもフォルダが違えば (2) にしない。Finder で動かしたファイルも一覧に出る', async () => {
    await fetch(`${base}/id-1`, { ...json, body: JSON.stringify({ name: 'A', state: null, updated: 1, folder: 'X' }) });
    await fetch(`${base}/id-2`, { ...json, body: JSON.stringify({ name: 'A', state: null, updated: 1, folder: 'Y' }) });
    expect(await tree()).toEqual(['X/A.fxp.json', 'Y/A.fxp.json']);
    // Finder で動かした（サーバーの知らない場所）
    await mkdir(path.join(dir, 'projects', 'Z'), { recursive: true });
    const { rename } = await import('node:fs/promises');
    await rename(path.join(dir, 'projects', 'Y', 'A.fxp.json'), path.join(dir, 'projects', 'Z', 'A.fxp.json'));
    const list = (await (await fetch(base)).json()).projects;
    expect(list.map((p: { id: string; folder: string }) => `${p.id}:${p.folder}`).sort()).toEqual(['id-1:X', 'id-2:Z']);
    expect((await (await fetch(`${base}/id-2`)).json()).name).toBe('A');
  });

  const read = async (rel: string) => JSON.parse(await readFile(path.join(dir, 'projects', ...rel.split('/')), 'utf8'));
  const putState = (id: string, name: string, n: number) => fetch(`${base}/${id}`, { ...json, body: JSON.stringify({ name, state: { n }, updated: n }) });

  it('サーバーの知らないうちにファイルが動いていても、元の場所に書き直したり、ほかのプロジェクトを消したりしない', async () => {
    await putState('id-a', 'A', 1);
    await putState('id-b', 'B', 1);
    await fetch(base); // 一覧を読む（場所を覚える）
    const { rename } = await import('node:fs/promises');
    // Finder で: A をフォルダ X へ動かし、B を A の元の名前に付け替えた
    await mkdir(path.join(dir, 'projects', 'X'), { recursive: true });
    await rename(path.join(dir, 'projects', 'A.fxp.json'), path.join(dir, 'projects', 'X', 'A.fxp.json'));
    await rename(path.join(dir, 'projects', 'B.fxp.json'), path.join(dir, 'projects', 'A.fxp.json'));
    // A を保存: 覚えていた場所（A.fxp.json）には B があるので、そこには書かず、実際の場所（X/A）に書く
    await putState('id-a', 'A', 2);
    expect(await tree()).toEqual(['A.fxp.json', 'X/A.fxp.json']);
    expect(await read('X/A.fxp.json')).toMatchObject({ id: 'id-a', state: { n: 2 } });
    expect(await read('A.fxp.json')).toMatchObject({ id: 'id-b', state: { n: 1 } });
    // B を保存（名前は B なので B.fxp.json に付け直す）。A のファイルは消さない
    await putState('id-b', 'B', 3);
    expect(await tree()).toEqual(['B.fxp.json', 'X/A.fxp.json']);
    expect(await read('B.fxp.json')).toMatchObject({ id: 'id-b', state: { n: 3 } });
    expect(await read('X/A.fxp.json')).toMatchObject({ id: 'id-a', state: { n: 2 } });
  });

  it('同じ ID のファイルが 2 つあれば新しく保存した方を使い、もう一方は消さない', async () => {
    await putState('id-a', 'A', 5);
    await mkdir(path.join(dir, 'projects', 'X'), { recursive: true });
    await writeFile(path.join(dir, 'projects', 'X', 'A.fxp.json'), JSON.stringify({ format: 'fx-practice-project', version: 1, id: 'id-a', name: 'A', updated: 1, state: { n: 1 } }));
    const list = (await (await fetch(base)).json()).projects;
    expect(list).toEqual([{ id: 'id-a', name: 'A', updated: 5, folder: '' }]);
    expect((await (await fetch(`${base}/id-a`)).json()).state).toEqual({ n: 5 });
    expect(await tree()).toEqual(['A.fxp.json', 'X/A.fxp.json']);
  });

  it('上書き・削除の前に控えを取る（削除したプロジェクトも控えから戻せる）', async () => {
    await putState('id-a', 'A', 1);
    await putState('id-a', 'A', 2); // 1 回目の上書きの前に控え
    await putState('id-a', 'A', 3); // 10 分以内なので控えは増えない
    let saved = await readdir(path.join(dir, 'backups', 'id-a'));
    expect(saved.length).toBe(1);
    expect(JSON.parse(await readFile(path.join(dir, 'backups', 'id-a', saved[0]), 'utf8')).state).toEqual({ n: 1 });
    await fetch(`${base}/id-a`, { method: 'DELETE' });
    saved = (await readdir(path.join(dir, 'backups', 'id-a'))).sort();
    expect(saved.length).toBe(2);
    expect(JSON.parse(await readFile(path.join(dir, 'backups', 'id-a', saved[1]), 'utf8')).state).toEqual({ n: 3 });
    expect(await tree()).toEqual([]);
  });

  it('フォルダを作る・名前を変える（中のプロジェクトごと）・空なら消す', async () => {
    const post = (p: string) => fetch(`${base}/folders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    await post('MT4/GOLD');
    await post('練習');
    let data = await (await fetch(base)).json();
    expect(data.folders.sort()).toEqual(['MT4', 'MT4/GOLD', '練習']);
    await fetch(`${base}/id-1`, { ...json, body: JSON.stringify({ name: 'A', state: null, updated: 1, folder: 'MT4/GOLD' }) });
    // 名前を変える: MT4/GOLD → MT4/XAU。中のプロジェクトも一緒に動く
    let res = await fetch(`${base}/folders`, { ...json, body: JSON.stringify({ from: 'MT4/GOLD', to: 'MT4/XAU' }) });
    expect(res.status).toBe(200);
    expect(await tree()).toEqual(['MT4/XAU/A.fxp.json']);
    data = await (await fetch(base)).json();
    expect(data.projects[0].folder).toBe('MT4/XAU');
    // 自分の中へは動かせない。あるフォルダの名前にはできない
    expect((await fetch(`${base}/folders`, { ...json, body: JSON.stringify({ from: 'MT4', to: 'MT4/XAU/MT4' }) })).status).toBe(400);
    expect((await fetch(`${base}/folders`, { ...json, body: JSON.stringify({ from: 'MT4/XAU', to: '練習' }) })).status).toBe(409);
    // プロジェクトが入っているフォルダは消せない。空なら消せる
    expect((await fetch(`${base}/folders?path=MT4`, { method: 'DELETE' })).status).toBe(409);
    res = await fetch(`${base}/folders?path=${encodeURIComponent('練習')}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    data = await (await fetch(base)).json();
    expect(data.folders.sort()).toEqual(['MT4', 'MT4/XAU']);
  });

  it('定型を保存・一覧・既定・削除できる（Dropbox の templates/）', async () => {
    const tb = base.replace('/api/projects', '/api/templates');
    const save = (name: string, n: number) => fetch(tb, { ...json, body: JSON.stringify({ name, settings: { layout: '4', n } }) });
    await save('RCI 4 本', 1);
    await save('シンプル', 2);
    await save('RCI 4 本', 3); // 同じ名前は上書き
    await fetch(`${tb}/default`, { ...json, body: JSON.stringify({ name: 'シンプル' }) });
    let v = await (await fetch(tb)).json();
    expect(v.templates.map((t: { name: string; settings: { n: number } }) => `${t.name}:${t.settings.n}`)).toEqual(['RCI 4 本:3', 'シンプル:2']);
    expect(v.default).toBe('シンプル');
    expect((await readdir(path.join(dir, 'templates'))).sort()).toEqual(['RCI 4 本.fxt.json', '_settings.json', 'シンプル.fxt.json'].sort());
    // 既定の定型を消すと、既定も外れる
    await fetch(`${tb}?name=${encodeURIComponent('シンプル')}`, { method: 'DELETE' });
    v = await (await fetch(tb)).json();
    expect(v.templates.map((t: { name: string }) => t.name)).toEqual(['RCI 4 本']);
    expect(v.default).toBe(null);
  });
});
