// 前回の続きから再開するための保存（R1）。プロジェクトごとに保存する。
// - 本体: アプリのサーバー経由でフォルダにファイルで保存する（既定は Dropbox。server/projectStore.ts）
// - 控え: ブラウザの localStorage にも同じものを入れる。サーバーに届かなかった分（閉じる直前など）は、
//   次に開いたとき新しい方を使って取り戻す。サーバーが無いときは控えだけで動く
// Dropbox が同期し続けないように、ファイルへの書き込みは 3 秒に 1 回まで（一時停止や切り替えのときはすぐ書く）。

import type { Timeframe } from './core/candles';
import type { DisplayZone } from './core/time';
import type { Drawing } from './chart/drawings';
import type { IndicatorConfig } from './chart/indicators';
import type { Mt4Trade } from './mt4/history';
import type { Action, Baseline } from './trade/account';
import type { Ledger } from './trade/ledger';

export interface TestState {
  /** 検証を始めた時刻 */
  startTime: number;
  initialBalance: number;
  leverage: number;
  /** 口座の出発点（銘柄を切り替えるとその時点に更新する） */
  baseline: Baseline;
  actions: Action[];
  /**
   * 銘柄ごとの固定スプレッド（pips）。Ask = Bid + スプレッド で、データの Ask は使わない。
   * 無い検証（固定スプレッドを入れる前に始めたもの）は、データの Ask を使う
   */
  spreadPips?: Record<string, number>;
  /**
   * 口座の中身。'mt4' なら読み込んだ MT4 履歴の取引をそのまま口座にする（実際のトレードの振り返り用。自分では注文できない）。
   * 無ければ仮想の取引（自分で注文する）
   */
  source?: 'virtual' | 'mt4';
  /** 計算結果（月ごとの区切りと口座履歴）。開き直しや巻き戻しを速くするために残す（操作の記録から作り直せる） */
  ledger?: Ledger;
}

/** EasyOrder の入力（リスクと S/L・T/P の位置） */
export interface EasyOrderState {
  open: boolean;
  mode: 'market' | 'pending';
  risk: number;
  riskUnit: 'pct' | 'jpy';
  entry: number | null;
  sl: number | null;
  tp: number | null;
}

/** 読み込んだ MT4 の取引履歴 */
export interface Mt4State {
  fileName: string;
  trades: Mt4Trade[];
  /** 時刻のずれ（時間）。サーバー時刻 → UTC の変換の後に足す。銘柄ごとの判定が無いときに使う */
  offsetHours: number;
  matched: number;
  checked: number;
  /** 銘柄ごとに自動判定したずれ。価格が足に収まった件数 / 調べた件数 */
  bySymbol?: Record<string, { hours: number; matched: number; checked: number }>;
}

/** チャートの並べ方: 1 枚 / 左右に 2 枚 / 上下に 2 枚 / 2×2 */
export type Layout = '1' | '2h' | '2v' | '4';

/** チャートごとの設定 */
export interface PaneState {
  tf: Timeframe;
  /** 以前の保存（チャートごとのインジケーター）。今は時間足ごとの indicatorSets を使う */
  indicators?: IndicatorConfig;
}

export interface AppState {
  version: 1;
  symbol: string;
  /** 以前の保存（チャート 1 枚）の時間足。今は panes を使う */
  tf: Timeframe;
  zone: DisplayZone;
  /** 最後に見えている 1 分足の時刻（UTC） */
  cursor: number;
  /** 再生速度（SPEEDS の何番目か） */
  speed: number;
  pauseOnFill: boolean;
  lots: number;
  terminalTab: string;
  /** 成績タブで見る取引（仮想の取引か、読み込んだ MT4 の履歴か） */
  statsSource?: 'virtual' | 'mt4';
  terminalHeight: number;
  test: TestState | null;
  drawings: Record<string, Drawing[]>;
  /** 以前の保存のインジケーター。今は panes を使う */
  indicators?: IndicatorConfig;
  layout?: Layout;
  /** 時間足ごとのインジケーターの設定（チャートの時間足を変えると、その時間足の設定に切り替わる） */
  indicatorSets?: Record<string, IndicatorConfig>;
  /** 時間足ごとの図形の色（決めていない時間足は初期値） */
  tfColors?: Record<string, string>;
  /** フィボナッチ・エクスパンションの水準（割合。0.618 など）。無ければ初期値（MT4 と同じ）。全部の図形で共通 */
  fiboLevels?: { fibo?: number[]; fiboexp?: number[] };
  /** ツールバーに出さない時間足（ツールバーの時間足を右クリックして選ぶ） */
  hiddenTfs?: string[];
  /** 左上のワンクリック注文を隠す */
  hideOneClick?: boolean;
  /** キーボードのショートカット（働き → キー。無ければ初期値。src/ui/keys.ts） */
  keymap?: Record<string, string[]>;
  /** チャートの右側の余白（足の本数）。全部のチャートで共通 */
  rightOffset?: number;
  /** 4 枚分（表示していないチャートの設定も残す） */
  panes?: PaneState[];
  activePane?: number;
  easyOrder?: EasyOrderState;
  mt4?: Mt4State | null;
}

export interface ProjectMeta {
  id: string;
  name: string;
  updated: number;
}

interface ProjectIndex {
  current: string;
  list: ProjectMeta[];
}

/** localStorage の控え（updated で新しい方を判断する） */
interface LocalCopy {
  updated: number;
  state: AppState | null;
}

const OLD_KEY = 'fx-practice-state-v1';
const INDEX_KEY = 'fx-practice-projects-v1';
const projectKey = (id: string) => `fx-practice-project-${id}`;
const FILE_FORMAT = 'fx-practice-project';
const LOCAL_EVERY = 300;
const REMOTE_EVERY = 3000;
/** 別の Mac が開いていると判断する目安（その Mac は保存のたびに目印を更新する） */
const LOCK_FRESH = 2 * 60_000;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // 容量超過など。ファイルの方には保存される
    return false;
  }
}

function readLocal(id: string): LocalCopy | null {
  const v = read<LocalCopy | AppState>(projectKey(id));
  if (!v) return null;
  // 以前の形式（state をそのまま入れていた）
  if ('version' in v) return { updated: 0, state: v };
  return v;
}

// ---- 状態（起動時に initStore で読む） ----
let index: ProjectIndex = { current: '', list: [] };
let currentState: AppState | null = null;
let remote = false;
let storeDir = '';
let lockedBy: string | null = null;

async function api(path: string, method = 'GET', value?: unknown): Promise<Response> {
  const res = await fetch(`/api/projects${path}`, {
    method,
    headers: value === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  if (!res.ok) throw new Error(`保存先との通信に失敗しました（${res.status}）`);
  return res;
}

function localIndex(): ProjectIndex {
  const idx = read<ProjectIndex>(INDEX_KEY);
  if (idx && idx.list.length) return idx;
  // 初めて: 以前の保存があれば「プロジェクト 1」に移す
  const id = crypto.randomUUID();
  const old = read<AppState>(OLD_KEY);
  if (old) write(projectKey(id), { updated: Date.now(), state: old } satisfies LocalCopy);
  const fresh = { current: id, list: [{ id, name: 'プロジェクト 1', updated: Date.now() }] };
  write(INDEX_KEY, fresh);
  return fresh;
}

function putIndex() {
  write(INDEX_KEY, index);
  if (remote) return api('/index', 'PUT', { current: index.current, order: index.list.map((p) => p.id) }).then(() => {});
  return Promise.resolve();
}

/**
 * 起動時に 1 回呼ぶ。保存先のフォルダにまだ何も無ければ、ブラウザの中のプロジェクトを移す。
 * 戻り値の lockedBy は、同じプロジェクトを最近まで開いていた別の Mac の名前
 */
export async function initStore(): Promise<{ remote: boolean; dir: string; lockedBy: string | null }> {
  const local = localIndex();
  try {
    const data = (await (await api('')).json()) as {
      dir: string;
      host: string;
      index: { current: string; order: string[] } | null;
      projects: ProjectMeta[];
    };
    remote = true;
    storeDir = data.dir;
    if (data.projects.length === 0) {
      for (const p of local.list) {
        const copy = readLocal(p.id);
        await api(`/${p.id}`, 'PUT', { name: p.name, state: copy?.state ?? null, updated: copy?.updated || p.updated });
      }
      index = local;
      await putIndex();
    } else {
      const order = data.index?.order ?? [];
      const list = data.projects.slice().sort((a, b) => {
        const ia = order.indexOf(a.id);
        const ib = order.indexOf(b.id);
        return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.name.localeCompare(b.name);
      });
      const current = list.some((p) => p.id === data.index?.current) ? data.index!.current : list[0].id;
      index = { current, list };
    }
    const file = (await (await api(`/${index.current}`)).json()) as { name: string; updated: number; state: AppState | null; lock: { host: string; time: number } | null };
    const copy = readLocal(index.current);
    if (copy && copy.updated > (file.updated ?? 0)) {
      // 閉じる直前の分がファイルに届いていなかった → 控えの方が新しい
      currentState = copy.state;
      await api(`/${index.current}`, 'PUT', { name: file.name, state: copy.state, updated: copy.updated });
    } else {
      currentState = file.state;
    }
    lockedBy = file.lock && file.lock.host !== data.host && Date.now() - file.lock.time < LOCK_FRESH ? file.lock.host : null;
  } catch {
    // サーバーに保存先が無い（ビルドしたものを開いた、など）→ ブラウザの中だけで動く
    remote = false;
    index = local;
    currentState = readLocal(index.current)?.state ?? null;
  }
  write(INDEX_KEY, index);
  return { remote, dir: storeDir, lockedBy };
}

export function storeInfo() {
  return { remote, dir: storeDir, lockedBy };
}

export function currentMeta(): ProjectMeta {
  return index.list.find((p) => p.id === index.current) ?? index.list[0];
}

export function loadState(): AppState | null {
  return currentState && currentState.version === 1 ? currentState : null;
}

export function listProjects(): ProjectMeta[] {
  return index.list;
}

// ---- 保存 ----
let pending: AppState | null = null;
let localTimer: ReturnType<typeof setTimeout> | undefined;
let remoteTimer: ReturnType<typeof setTimeout> | undefined;
let remoteSaving: Promise<void> = Promise.resolve();

function writeLocalNow() {
  clearTimeout(localTimer);
  localTimer = undefined;
  if (!pending) return;
  const meta = currentMeta();
  meta.updated = Date.now();
  write(projectKey(meta.id), { updated: meta.updated, state: pending } satisfies LocalCopy);
  write(INDEX_KEY, index);
}

function writeRemoteNow(): Promise<void> {
  clearTimeout(remoteTimer);
  remoteTimer = undefined;
  if (!remote || !pending) return remoteSaving;
  const meta = currentMeta();
  const value = { name: meta.name, state: pending, updated: meta.updated };
  remoteSaving = remoteSaving.then(() => api(`/${meta.id}`, 'PUT', value).then(() => {}, () => {}));
  return remoteSaving;
}

/**
 * 保存する。再生中など頻繁に呼ばれても、控えは 0.3 秒・ファイルは 3 秒に 1 回だけ書く。
 * now=true ならすぐ書く（一時停止・切り替え・閉じるとき）
 */
export function saveState(s: AppState, now = false) {
  pending = s;
  if (now) {
    writeLocalNow();
    void writeRemoteNow();
    return;
  }
  localTimer ??= setTimeout(writeLocalNow, LOCAL_EVERY);
  if (remote) remoteTimer ??= setTimeout(() => void writeRemoteNow(), REMOTE_EVERY);
}

/** 書きかけの保存を終わらせる（ページを読み直す前に待つ） */
export async function flushSave(): Promise<void> {
  writeLocalNow();
  await writeRemoteNow();
}

// ---- プロジェクトの操作（どれも終わったらページを読み直す前提） ----

/** 新しいプロジェクトを作って切り替える。state を渡すとその内容で始める */
export async function createProject(name: string, state: AppState | null = null): Promise<string> {
  const id = crypto.randomUUID();
  const updated = Date.now();
  write(projectKey(id), { updated, state } satisfies LocalCopy);
  if (remote) await api(`/${id}`, 'PUT', { name, state, updated });
  index.list.push({ id, name, updated });
  index.current = id;
  await putIndex();
  return id;
}

export async function switchProject(id: string) {
  if (!index.list.some((p) => p.id === id)) return;
  index.current = id;
  await putIndex();
}

export async function renameProject(id: string, name: string) {
  const p = index.list.find((x) => x.id === id);
  if (p) p.name = name;
  write(INDEX_KEY, index);
  if (remote) await api(`/${id}/rename`, 'PUT', { name });
}

/** 消して、残りの最初のプロジェクトに切り替える。最後の 1 つは消せない */
export async function deleteProject(id: string): Promise<boolean> {
  if (index.list.length <= 1) return false;
  index.list = index.list.filter((p) => p.id !== id);
  if (index.current === id) index.current = index.list[0].id;
  localStorage.removeItem(projectKey(id));
  if (remote) await api(`/${id}`, 'DELETE');
  await putIndex();
  return true;
}

export function exportProject(name: string, state: AppState): string {
  return JSON.stringify({ format: FILE_FORMAT, version: 1, name, updated: Date.now(), state });
}

/** 書き出したファイルを読み込んで、新しいプロジェクトとして切り替える */
export async function importProject(json: string): Promise<string> {
  const data = JSON.parse(json) as { format?: string; name?: string; state?: AppState };
  if (data.format !== FILE_FORMAT || !data.state || data.state.version !== 1) throw new Error('FX Practice のプロジェクトファイルではありません');
  return createProject(data.name ?? '読み込んだプロジェクト', data.state);
}
