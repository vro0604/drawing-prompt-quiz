/**
 * 形状アシスト（D191）。
 *
 * 【これは何か】
 *   お題を引く前に、作者が「どういう形として描くか」の取っかかりを
 *   1つだけ持てるようにするもの。たとえば「人型」を持った状態で
 *   「自動販売機 / 深緑 / 怯え」というお題を受け取ると、
 *   「自動販売機を人型としてどう表現するか」から考え始められる。
 *
 * 【正式なお題ではない】
 *   出所: ユーザー指示（2026-09-09）「正式promptではない ／ クイズ対象外 ／
 *   全語出題の語数に含めない ／ 正解判定に使わない ／ 伝達率に使わない ／
 *   ビタ当て・2択当てに使わない ／ D169の回答供給条件へ使わない ／
 *   未踏組み合わせ判定へ使わない ／ 正式タグとして扱わない ／
 *   守らなくても投稿可能 ／ 作者向け発想補助 ／ ON/OFF可能」。
 *
 *   守り方は「画面で隠す」ではない。**値の置き場所そのものを分けてある。**
 *   保存先は `draft_sessions.shape_assist_key` の1列だけで、
 *   クイズを作る関数が読むのは `prompt_cards` と `card_slots` だけ。
 *   だから届く道が無い。
 *
 * 【なぜ語彙の表に入れないか】
 *   出所: ユーザー指示（2026-09-09）「Morph等の正式語彙と同じテーブルへ
 *   無理に入れないこと。今回の候補は『正式タグ』ではなく、作者向けの
 *   補助カテゴリである。現行構造上、別定義の方が自然なら別定義にする」。
 *
 *   `tags` に入れると、クイズの誤答としてこの語が出てしまう。
 *   出題の抽選は「同じ pool_key の有効なタグ」から誤答を選ぶので、
 *   正式語彙と同じ場所に置いた時点で混ざる道ができる。
 *
 * 【一覧をここに書いてある理由】
 *   正式語彙は DB が持つ（画面に書き写さない）。**こちらは正式語彙ではない。**
 *   DB が知る必要があるのは「どれが選ばれたか」だけで、選べるものの一覧は
 *   知らなくてよい。表を1つ増やさずに済む形として、ここに置いてある。
 *   重みは最初から持たせてあるので、将来かたよりを付けるときも
 *   この配列を書き換えるだけで済む（構造は変えなくてよい）。
 */

export type ShapeAssist = {
  /** 保存される値。DB 側の check は `^[a-z][a-z_]{0,30}$` */
  key: string;
  label: string;
  /**
   * ランダムで選ばれる重み。大きいほど出やすい。
   *
   * 出所: ユーザー指示（2026-09-09）「初期実装では単純な等確率でもよい。
   * ただし候補ごとの重み付けは将来変更できる構造を優先する」。
   * いまは全部 1 なので等確率。
   */
  weight: number;
};

export const SHAPE_ASSISTS: ShapeAssist[] = [
  { key: "humanoid", label: "人型", weight: 1 },
  { key: "animal", label: "動物型", weight: 1 },
  { key: "plant", label: "植物型", weight: 1 },
  { key: "monster", label: "怪物型", weight: 1 },
  { key: "tool", label: "道具型", weight: 1 },
  { key: "building", label: "建造物型", weight: 1 },
  { key: "vehicle", label: "乗物型", weight: 1 },
  { key: "landscape", label: "景観型", weight: 1 },
  { key: "weather", label: "気象型", weight: 1 },
];

/** 操作の3状態。出所: ユーザー指示（2026-09-09）「なし／ランダム／自分で選ぶ」 */
export const SHAPE_ASSIST_MODES = ["none", "random", "pick"] as const;
export type ShapeAssistMode = (typeof SHAPE_ASSIST_MODES)[number];

/** 表示名を引く。知らない値なら null（画面には何も出さない） */
export function shapeAssistLabel(key: string | null): string | null {
  if (!key) return null;
  return SHAPE_ASSISTS.find((s) => s.key === key)?.label ?? null;
}

/** その値が候補に載っているか */
export function isShapeAssistKey(key: string): boolean {
  return SHAPE_ASSISTS.some((s) => s.key === key);
}

/**
 * 重みに従って1つ選ぶ。
 *
 * 出所: ユーザー指示（2026-09-09）「『ランダム』を選んだ場合、お題生成時に
 * 候補から1つ選ぶ」。選んだ結果はドラフトの行に入るので、
 * **そのセッションのあいだ変わらない**（引き直しても同じものが残る）。
 */
export function pickRandomShapeAssist(
  random: () => number = Math.random,
): string {
  const total = SHAPE_ASSISTS.reduce((sum, s) => sum + s.weight, 0);
  let point = random() * total;
  for (const s of SHAPE_ASSISTS) {
    point -= s.weight;
    if (point < 0) return s.key;
  }
  return SHAPE_ASSISTS[SHAPE_ASSISTS.length - 1].key;
}
