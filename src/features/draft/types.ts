/**
 * ドラフト関連の型。
 *
 * DB の関数（draft_state_json / get_my_prompt）が返す JSON の形をそのまま写す。
 * 手で書いているのは、Supabase CLI の型生成がまだ入っていないため。
 * 型生成に置き換えるときは、このファイルを消して import 先を差し替える。
 */

/**
 * モード選択画面に出す1行（public.draft_modes の公開列）。
 *
 * uses_two_stage が true のモードは「カテゴリを先に引いてから語彙を引く」（D159）。
 * その場合だけ語数の範囲とモーフ上限が入る。
 * false は旧方式（枠が固定）で、いまは一般利用者に見えない。
 */
export type DraftMode = {
  mode_key: string;
  label: string;
  candidate_count: number;
  max_rerolls: number;
  sort_order: number;
  uses_two_stage: boolean;
  word_count_min: number | null;
  word_count_max: number | null;
  morph_max: number | null;
};

/**
 * 伏せカード1枚。
 *
 * **まだめくっていないカードは tag_id も label も null になる。**
 * tags 表は公開されているので、id を渡した時点で label を引けてしまう。
 * だから両方まとめて隠す（draft_state_json 側で実装）。
 */
export type DraftCandidate = {
  candidate_index: number;
  revealed: boolean;
  is_chosen: boolean;
  tag_id: number | null;
  label: string | null;
  /** 枠の中で「残す」と印を付けてあるか（D170）。持ち出しとは別物 */
  is_held: boolean;
};

/**
 * 1つの枠と、その枠の伏せカード一式。
 *
 * 二段階抽選では、枠はモードに固定されておらず**ドラフトのたびに抽選される。**
 * card_slot_label は「モーフ 1」「感情 2」のような通し名で、
 * category_label は「モーフ」「感情」だけを指す。
 *
 * is_carried が true の枠は、前のお題から持ち出した要素で埋まっている（D161）。
 * 中身が最初から見えていて、めくる操作は要らない。
 */
export type DraftSlot = {
  card_slot_key: string;
  card_slot_label: string;
  category_label: string;
  is_carried: boolean;
  /** その枠に配られた候補の枚数（D170）。抽選の枠は2〜5、持ち出しの枠は1 */
  candidate_count: number;
  /** その枠の残り候補を開示済みか（D170）。開示すると、その枠の抽選は終わり */
  pool_revealed: boolean;
  /** その枠で残せる上限。min(2, 候補数 - 1)。全部は残せない（D170） */
  held_limit: number;
  slot_order: number;
  /** いまめくれる枠かどうか。枠は slot_order の順に1つずつ進む */
  is_current: boolean;
  candidates: DraftCandidate[];
};

/** ドラフトの現在状態（draft_state_json の戻り値） */
export type DraftState = {
  session_id: string;
  mode_key: string;
  mode_label: string;
  status: "in_progress" | "completed" | "abandoned";
  candidate_count: number;
  max_rerolls: number;
  reroll_count: number;
  rerolls_left: number;
  time_limit_seconds: number | null;
  /** そのセッションで配り切る候補の総数（D170）。旧方式のセッションは null */
  draft_base: number | null;
  generation: number;
  current_slot_order: number;
  slot_count: number;
  /** 持ち出しで埋まっている枠の数（D161）。0 なら普通の抽選 */
  carried_count: number;
  chosen_count: number;
  is_ready_to_complete: boolean;
  slots: DraftSlot[];
};

/**
 * complete_draft の戻り値。
 *
 * **question_count は card_count と必ず同じになる。**
 * お題として確定した語はすべて出題されるため（D165）。
 * 別々に返しているのは、どちらかがずれたときに気づけるようにするため。
 */
export type CompletedDraft = {
  prompt_id: string;
  mode_key: string;
  card_count: number;
  question_count: number;
};

/** 確定したお題のカード1枚（＝答え） */
export type PromptCard = {
  card_slot_key: string;
  card_slot_label: string;
  slot_order: number;
  tag_id: number;
  tag_label: string;
  pool_key: string;
};

/** 引かなかったカード。開示済みのときだけ入る */
export type UnchosenCard = {
  card_slot_key: string;
  card_slot_label: string;
  slot_order: number;
  candidate_index: number;
  tag_id: number;
  tag_label: string;
};

/**
 * 制作挑戦の残り時間（get_prompt_timer の戻り値。D163）。
 *
 * 【読み方】
 *   is_unlimited が true なら、そのお題に期限は無い。
 *   更新も猶予も時間切れの失敗も起きないので、他の値は見なくてよい。
 *
 *   有限のときは3つの時刻が並ぶ。
 *     renew_opens_at  ここから「時間を延ばす」を押せる
 *     deadline_at     0秒になる時刻。過ぎても即失敗ではない
 *     grace_ends_at   ここまでに延ばさないと挑戦失敗
 *
 * 【経過と残りは別の数】
 *   elapsed_seconds は started_at からの総経過で、更新しても減らない。
 *   seconds_left は「いまの期限まで」で、更新すると入れ替わる。
 *   片方をもう片方から作らないこと。
 */
export type PromptTimer = {
  status: "active" | "submitted" | "abandoned" | "failed";
  is_unlimited: boolean;
  has_deadline: boolean;
  /** 制作挑戦を始めた時刻（お題の確定時刻ではない） */
  started_at: string;
  /** 開始からの総経過秒。更新しても猶予に入っても減らない */
  elapsed_seconds: number;
  deadline_at: string | null;
  seconds_left: number | null;
  overrun_seconds: number;
  /** 猶予が終わるまでの秒 */
  grace_left_seconds: number | null;
  can_renew: boolean;
  renew_opens_at: string | null;
  grace_ends_at: string | null;
  is_expired: boolean;
  renew_count: number;
  time_limit_seconds: number | null;
  /** 終わった時刻（投稿・失敗・放棄）。進行中は null */
  finished_at: string | null;
  /** この値を返したときのサーバー時刻 */
  server_now: string;
};

/** 確定したお題1件（get_my_prompt の戻り値） */
export type PromptDetail = {
  id: string;
  mode_key: string;
  mode_label: string;
  time_limit_seconds: number | null;
  was_rerolled: boolean;
  reroll_count: number;
  /**
   * お題の状態。
   *
   * failed は「更新しないまま猶予を使い切った挑戦」（D163）。
   * 作品や記録は消えない。そのお題での投稿だけができなくなる。
   */
  status: "active" | "submitted" | "abandoned" | "failed";
  candidates_revealed_at: string | null;
  reveal_reason: string | null;
  created_at: string;
  work_id: string | null;
  cards: PromptCard[];
  unchosen: UnchosenCard[];
};

/** 制作時間の選択肢。null = 無制限。DB の CHECK は 60〜600000 秒 */
export const TIME_LIMIT_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "無制限" },
  { value: "600", label: "10分" },
  { value: "1800", label: "30分" },
  { value: "3600", label: "1時間" },
  { value: "10800", label: "3時間" },
  { value: "86400", label: "1日" },
];

/** 秒数を「1時間」「30分」のような表示に変える */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "無制限";
  const known = TIME_LIMIT_CHOICES.find((c) => c.value === String(seconds));
  if (known) return known.label;
  if (seconds % 3600 === 0) return `${seconds / 3600}時間`;
  if (seconds % 60 === 0) return `${seconds / 60}分`;
  return `${seconds}秒`;
}

/**
 * 残り秒を「1時間20分」「あと3分」のような表示に変える。
 *
 * 負の値は「超過」を意味するので、符号を落として別の言い回しにする。
 * 0秒を過ぎても時計は止まらない（D163）ため、超過の表示が必要になる。
 */
export function formatRemaining(seconds: number): string {
  const over = seconds < 0;
  const s = Math.abs(seconds);

  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);

  let body: string;
  if (days > 0) body = `${days}日${hours}時間`;
  else if (hours > 0) body = `${hours}時間${minutes}分`;
  else if (minutes > 0) body = `${minutes}分`;
  else body = `${s}秒`;

  return over ? `${body} 超過` : body;
}

/**
 * モードの説明文。二段階抽選のモードだけ語数を出す。
 *
 * 旧方式のモードには語数の範囲が入っていないので、
 * **数字を作らずに**候補数と引き直し回数だけを出す。
 */
export function modeSummary(mode: DraftMode): string {
  const parts: string[] = [];

  if (mode.uses_two_stage && mode.word_count_min !== null && mode.word_count_max !== null) {
    parts.push(`お題は ${mode.word_count_min}〜${mode.word_count_max} 語`);
    if (mode.morph_max !== null) {
      parts.push(`描く対象は最大 ${mode.morph_max} 個`);
    }
  }

  parts.push(`候補は枠ごとに2〜5枚`);
  parts.push(`引き直し ${mode.max_rerolls} 回`);
  // クイズの問数はお題の語数と同じになるので、別の数として書かない（D165）。
  // 語数を上に出しているモードでは、その行がそのまま問数の説明になる。
  if (mode.uses_two_stage) {
    parts.push("お題の語はすべて出題される");
  }

  return parts.join("・");
}
