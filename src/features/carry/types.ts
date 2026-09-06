/**
 * 一部持ち出しの型（D161 ／ D166 の3区分 ／ 2026-09-05 の保存枠）。
 *
 * 【この機能が何をするものか】
 *   他人の作品のクイズに答えると、その作品のお題が開示される。
 *   そこに出てきた語のうち1〜3個をまとめて持ち出しておき、
 *   **次に自分がお題を引くとき、その語を最初から入れた状態で始められる。**
 *
 *   自分で引いたお題からも同じように持ち出せる。
 *
 * 【保存の単位は「保存枠」であって、語の個数ではない】
 *   1回の持ち出し操作が、1つの保存枠になる。
 *   1つの保存枠には、**同じ元お題から選んだ1〜3要素**が入る。
 *
 *     自分のお題由来 … 最大 5 保存枠
 *     他者のお題由来 … 最大 3 保存枠
 *
 *   出所: ユーザー発言「保存上限の単位は、個別の語数ではありません。
 *   『1〜3要素をまとめた保存枠』の数です」（2026-09-05）。
 *
 *   上限に達したら保存しない。古い枠を勝手に押し出さない。
 *   空きを作るのは利用者の操作（枠を捨てる）。
 *
 * 【3つの区分（どこまで残るか）】
 *
 *   session … いまの流れの中だけ。ゲストも登録者も使える。上限なし。
 *             お題を確定した時点、ドラフトを捨てた時点で保持が終わる。
 *   self   … 自分が制作・投稿したお題から。登録者のみ。5枠。
 *   others … 他の人のお題から。登録者のみ。3枠。
 *
 * 【混ぜてはいけない3つの数】
 *   ・1つの保存枠に入る要素の数         … 1〜3（MAX_ELEMENTS_PER_SLOT）
 *   ・1回のお題へ持ち込める要素の数     … 1〜3（MAX_CARRY_PER_DRAFT）
 *   ・手元に残せる保存枠の数            … self 5 ／ others 3（DB の carry_policy）
 *   前の2つは「生成に持ち込む数」、最後は「持ち続けられる枠の数」。
 */

/**
 * 語の上位種別（DB の draw_categories.kind）。
 *
 * **カラーは状態ではない。**状態カテゴリは感情・動作・身体状態・変化・
 * 環境・関係・性質・社会状態の8つで、カラーはその外側に立つ独立の種別。
 * 出所: ユーザー発言「カラーは状態ではありません。状態カテゴリは8つのまま
 * 維持してください」（2026-09-05）。
 *
 * 'legacy' は新分類（2026-09-04）より前からある語で、生成用カテゴリを持たない。
 */
export type ElementKind = "morph" | "state" | "color" | "legacy";

/** 開示されたお題のカード1枚（get_answered_prompt の cards） */
export type RevealedCard = {
  card_slot_key: string;
  card_slot_label: string;
  slot_order: number;
  tag_id: number;
  tag_label: string;
  /** モーフ / 感情 / カラー … のキー */
  category_key: string;
  category_label: string;
  /**
   * 上位種別。'morph' / 'state' / 'color'。
   *
   * **画面が「morph 以外はぜんぶ状態」と数えないために持つ。**
   * その数え方だとカラーが状態に混ざる。
   */
  element_kind: ElementKind;
};

/**
 * 回答後に開示される、そのお題まるごと（get_answered_prompt の戻り値）。
 *
 * D165 以降はお題の全語が出題されるので、開示される語と出題された語は一致する。
 */
export type RevealedPrompt = {
  work_id: string;
  is_author: boolean;
  cards: RevealedCard[];
};

/** 持ち出しの区分（どこまで残るか） */
export type CarryScope = "session" | "self" | "others";

/** 保存枠の中の要素1つ */
export type SavedSlotElement = {
  id: number;
  tag_id: number;
  tag_label: string;
  category_key: string;
  category_label: string;
  /**
   * 上位種別。'morph' は描く対象、'state' は解釈の要求（8カテゴリ）、
   * 'color' は色彩語。**カラーは状態に含めない。**
   * 'legacy' は新分類より前の語（旧 motif / genre など）。
   */
  category_kind: ElementKind;
  /** 枠の中での並び（1〜3） */
  position: number;
};

/** 保存枠1つ（list_saved_elements の slots の1行） */
export type SavedCarrySlot = {
  id: number;
  scope: CarryScope;
  source_is_own: boolean;
  source_work_id: string | null;
  has_source_work: boolean;
  /** session のときだけ入る。過ぎると使えない */
  expires_at: string | null;
  created_at: string;
  element_count: number;
  elements: SavedSlotElement[];
};

/**
 * 保存枠内要素を平らに並べたもの（list_saved_elements の items）。
 *
 * 「どの要素を持ち込むか」を選ぶ画面はこちらを使う。
 * 選ぶ単位は要素で、**上限を数える単位は枠**である点に注意。
 */
export type SavedElement = {
  id: number;
  carry_slot_id: number;
  position: number;
  tag_id: number;
  tag_label: string;
  category_key: string;
  category_label: string;
  category_kind: ElementKind;
  scope: CarryScope;
  source_is_own: boolean;
  source_work_id: string | null;
  has_source_work: boolean;
  expires_at: string | null;
  created_at: string;
};

/** 手持ちまるごと（list_saved_elements の戻り値） */
export type SavedElements = {
  slots: SavedCarrySlot[];
  items: SavedElement[];
  /** **保存枠の数。**上限と突き合わせるのはこちら */
  counts: { session: number; self: number; others: number };
  /** 参考。枠の中に入っている要素の数 */
  element_counts: { session: number; self: number; others: number };
  limits: { self: number; others: number };
  /** 上限の数え方。'slot' = 保存枠の数 */
  limit_unit: "slot";
  max_per_slot: number;
  /** 別のセッションへ残せるか（＝登録者か） */
  can_persist: boolean;
};

/** 何も持っていないときの形。画面が null 判定を書かなくて済むように */
export const EMPTY_SAVED: SavedElements = {
  slots: [],
  items: [],
  counts: { session: 0, self: 0, others: 0 },
  element_counts: { session: 0, self: 0, others: 0 },
  limits: { self: 0, others: 0 },
  limit_unit: "slot",
  max_per_slot: 3,
  can_persist: false,
};

/** 1つの保存枠に入る要素の上限 */
export const MAX_ELEMENTS_PER_SLOT = 3;

/** 1回の保存操作で選べる要素の数の上限（＝保存枠の大きさ） */
export const MAX_CARRY_PER_SAVE = MAX_ELEMENTS_PER_SLOT;

/** 1つのお題へ持っていける要素の数の上限（D161） */
export const MAX_CARRY_PER_DRAFT = 3;

/** 区分の呼び名。画面の文言を1か所にまとめる */
export const SCOPE_LABEL: Record<CarryScope, string> = {
  session: "いまの流れの中だけ",
  self: "自分のお題から",
  others: "他の人のお題から",
};

/** 出所の種類。'work' は他人の作品から、'prompt' は自分のお題から */
export type CarrySourceKind = "work" | "prompt";

/** 保存枠の中身を「傘・蝶・梟」のように1行にする */
export function slotSummary(slot: SavedCarrySlot): string {
  return slot.elements.map((e) => e.tag_label).join("・");
}
