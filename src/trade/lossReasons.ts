// 取引に付ける「敗因」「勝因」の札と、それぞれの集計（成績タブの「敗因別」「勝因別」）。
// 負けた取引には敗因の一覧、勝った取引には勝因の一覧から付ける（ID は敗因 r1…、勝因 w1…）。
// 敗因の一覧と、どの取引にどの札を付けたかは全部のプロジェクトで共通の設定に入れる（MT4 の取引は月ごとのプロジェクトをまたぐため）。

import type { TradeRecord } from './analysis';

export interface LossReason {
  id: string;
  name: string;
}

/** 初めて使うときの一覧（それまで簡易メモに書いていた敗因） */
export const DEFAULT_LOSS_REASONS: LossReason[] = [
  { id: 'r1', name: 'エントリーが下降ダウ入りで入ってない' },
  { id: 'r2', name: 'H1 の波が戻ってない（波の戻りを待つ）' },
  { id: 'r3', name: 'SL 狩り後に狙い通りに進む' },
  { id: 'r4', name: '3 波ではなく 5 波になっていた（H1）' },
];

/** 初めて使うときの勝因の一覧（空。付けながら足していく） */
export const DEFAULT_WIN_REASONS: LossReason[] = [];

/** 勝ちの取引か（損益が 0 より大きい）。勝ちなら勝因、それ以外は敗因を付ける */
export const isWin = (profit: number) => profit > 0;

export interface ReasonRow {
  reason: LossReason;
  count: number;
  /** 札を付けた取引の損益の合計（円） */
  profit: number;
  pips: number;
  trades: TradeRecord[];
}

export interface ReasonTally {
  rows: ReasonRow[];
  /** 札の無い取引（負けを数えるなら負け、勝ちなら勝ち。付け忘れを見つけるため。新しい順） */
  untagged: TradeRecord[];
}

/**
 * 敗因ごとに回数・損益を数える。1 つの取引に札が 2 つあれば、両方に数える。
 * 一覧から消した敗因の札は数えない。並びは一覧の並び（札を付ける欄・成績タブの表のドラッグで変える）
 */
export function tallyReasons(records: TradeRecord[], reasons: LossReason[], tagsOf: (r: TradeRecord) => string[], wins = false): ReasonTally {
  const rows = new Map(reasons.map((reason) => [reason.id, { reason, count: 0, profit: 0, pips: 0, trades: [] as TradeRecord[] }]));
  const untagged: TradeRecord[] = [];
  for (const r of records) {
    const tags = tagsOf(r).filter((id) => rows.has(id));
    for (const id of new Set(tags)) {
      const row = rows.get(id)!;
      row.count++;
      row.profit += r.profit;
      row.pips += r.pips;
      row.trades.push(r);
    }
    if (!tags.length && isWin(r.profit) === wins) untagged.push(r);
  }
  untagged.sort((a, b) => b.closeTime - a.closeTime);
  return {
    rows: [...rows.values()].filter((x) => x.count),
    untagged,
  };
}

/** 新しい敗因の ID（今ある ID と重ならないもの） */
export function newReasonId(reasons: LossReason[], prefix = 'r'): string {
  let n = reasons.length + 1;
  while (reasons.some((r) => r.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** フィボの数値の札か（「38.2」「61.8-78.6」のように数と区切りだけの名前） */
export const isFiboReason = (name: string) => /^\s*\d+(\.\d+)?(\s*[-–〜~]\s*\d+(\.\d+)?)?\s*$/.test(name);

/**
 * もう一方の一覧にあって、この一覧に無いフィボの数値の札（勝因の一覧にも敗因と同じ数値を用意するため）。
 * 名前の空白の違いは同じとみなす。並びはもう一方の一覧のまま
 */
export function missingFiboReasons(list: LossReason[], other: LossReason[]): string[] {
  const norm = (n: string) => n.replace(/\s/g, '');
  const have = new Set(list.map((r) => norm(r.name)));
  return other.filter((r) => isFiboReason(r.name) && !have.has(norm(r.name))).map((r) => r.name);
}
