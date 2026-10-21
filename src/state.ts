// 前回の続きから再開するための保存（R1）。プロジェクトごとにブラウザの localStorage に入れる。
// プロジェクトはファイル（.json）に書き出し・読み込みもできる。

import type { Timeframe } from './core/candles';
import type { DisplayZone } from './core/time';
import type { Drawing } from './chart/drawings';
import type { IndicatorConfig } from './chart/indicators';
import type { Mt4Trade } from './mt4/history';
import type { Action, Baseline } from './trade/account';

export interface TestState {
  /** 検証を始めた時刻 */
  startTime: number;
  initialBalance: number;
  leverage: number;
  /** 口座の出発点（銘柄を切り替えるとその時点に更新する） */
  baseline: Baseline;
  actions: Action[];
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

export interface AppState {
  version: 1;
  symbol: string;
  tf: Timeframe;
  zone: DisplayZone;
  /** 最後に見えている 1 分足の時刻（UTC） */
  cursor: number;
  /** 再生速度（SPEEDS の何番目か） */
  speed: number;
  pauseOnFill: boolean;
  lots: number;
  terminalTab: string;
  terminalHeight: number;
  test: TestState | null;
  drawings: Record<string, Drawing[]>;
  indicators?: IndicatorConfig;
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

const OLD_KEY = 'fx-practice-state-v1';
const INDEX_KEY = 'fx-practice-projects-v1';
const projectKey = (id: string) => `fx-practice-project-${id}`;

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
    // 容量超過など。次の保存で再挑戦する
    return false;
  }
}

/** プロジェクトの一覧。初めてなら作る（以前の保存があれば「プロジェクト 1」に移す） */
export function loadIndex(): ProjectIndex {
  let index = read<ProjectIndex>(INDEX_KEY);
  if (index && index.list.length) return index;
  const id = crypto.randomUUID();
  const old = read<AppState>(OLD_KEY);
  if (old) write(projectKey(id), old);
  index = { current: id, list: [{ id, name: 'プロジェクト 1', updated: Date.now() }] };
  write(INDEX_KEY, index);
  return index;
}

export function currentMeta(): ProjectMeta {
  const index = loadIndex();
  return index.list.find((p) => p.id === index.current) ?? index.list[0];
}

export function loadState(): AppState | null {
  const s = read<AppState>(projectKey(currentMeta().id));
  return s && s.version === 1 ? s : null;
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** 頻繁に呼ばれても 300 ms に 1 回だけ書く */
export function saveState(s: AppState, now = false) {
  clearTimeout(timer);
  const run = () => {
    const index = loadIndex();
    if (!write(projectKey(index.current), s)) return;
    const meta = index.list.find((p) => p.id === index.current);
    if (meta) meta.updated = Date.now();
    write(INDEX_KEY, index);
  };
  if (now) run();
  else timer = setTimeout(run, 300);
}

export function listProjects(): ProjectMeta[] {
  return loadIndex().list;
}

/** 新しいプロジェクトを作って切り替える。state を渡すとその内容で始める */
export function createProject(name: string, state: AppState | null = null): string {
  clearTimeout(timer);
  const index = loadIndex();
  const id = crypto.randomUUID();
  if (state) write(projectKey(id), state);
  index.list.push({ id, name, updated: Date.now() });
  index.current = id;
  write(INDEX_KEY, index);
  return id;
}

export function switchProject(id: string) {
  clearTimeout(timer);
  const index = loadIndex();
  if (!index.list.some((p) => p.id === id)) return;
  index.current = id;
  write(INDEX_KEY, index);
}

export function renameProject(id: string, name: string) {
  const index = loadIndex();
  const p = index.list.find((x) => x.id === id);
  if (p) p.name = name;
  write(INDEX_KEY, index);
}

/** 消して、残りの最初のプロジェクトに切り替える。最後の 1 つは消せない */
export function deleteProject(id: string): boolean {
  clearTimeout(timer);
  const index = loadIndex();
  if (index.list.length <= 1) return false;
  index.list = index.list.filter((p) => p.id !== id);
  if (index.current === id) index.current = index.list[0].id;
  write(INDEX_KEY, index);
  localStorage.removeItem(projectKey(id));
  return true;
}

const FILE_FORMAT = 'fx-practice-project';

export function exportProject(name: string, state: AppState): string {
  return JSON.stringify({ format: FILE_FORMAT, version: 1, name, state });
}

/** 書き出したファイルを読み込んで、新しいプロジェクトとして切り替える */
export function importProject(json: string): string {
  const data = JSON.parse(json) as { format?: string; name?: string; state?: AppState };
  if (data.format !== FILE_FORMAT || !data.state || data.state.version !== 1) throw new Error('FX Practice のプロジェクトファイルではありません');
  return createProject(data.name ?? '読み込んだプロジェクト', data.state);
}
