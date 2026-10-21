// 前回の続きから再開するための保存（R1）。ブラウザの localStorage に入れる。
// 取引記録を別のフォルダに保存する仕組みはステップ 7 で作る。

import type { Timeframe } from './core/candles';
import type { DisplayZone } from './core/time';
import type { Drawing } from './chart/drawings';
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

export interface AppState {
  version: 1;
  symbol: string;
  tf: Timeframe;
  zone: DisplayZone;
  /** 最後に見えている 1 分足の時刻（UTC） */
  cursor: number;
  /** 再生速度（1 秒あたりに進む 1 分足の本数） */
  speed: number;
  pauseOnFill: boolean;
  lots: number;
  terminalTab: string;
  terminalHeight: number;
  test: TestState | null;
  drawings: Record<string, Drawing[]>;
}

const KEY = 'fx-practice-state-v1';

export function loadState(): AppState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AppState;
    return s.version === 1 ? s : null;
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** 頻繁に呼ばれても 300 ms に 1 回だけ書く */
export function saveState(s: AppState, now = false) {
  clearTimeout(timer);
  const write = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // 容量超過など。次の保存で再挑戦する
    }
  };
  if (now) write();
  else timer = setTimeout(write, 300);
}
