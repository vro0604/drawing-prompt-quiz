/**
 * 作品まわりの型。
 *
 * DB の関数（get_work_detail / get_my_work / create_work）が返す JSON の形を
 * そのまま写す。手で書いているのは features/draft/types.ts と同じ事情で、
 * Supabase CLI の型生成をまだ入れていないため。
 *
 * **prompt_id はどの型にも現れない。** DB 側がそもそも返さないので
 * （D23）、ここに書きようがない。
 */

/** Storage のバケット名（spec 8-6） */
export const WORKS_BUCKET = "works";

/** 画像の上限。バケット側の file_size_limit と同じ値にしておく */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 部門。works.division の CHECK 制約と同じ3つ */
export type Division = "original" | "fanart" | "ai";

export const DIVISIONS: { value: Division; label: string; note: string }[] = [
  {
    value: "original",
    label: "オリジナル",
    note: "自分で考えたキャラクター・世界の絵",
  },
  {
    value: "fanart",
    label: "ファンアート",
    note: "既存の作品やキャラクターを描いたもの。元作品名が必須",
  },
  {
    value: "ai",
    label: "AI生成",
    note: "生成AIを使ったもの。通常のフィードとは分けて扱う",
  },
];

/**
 * 完成度。works.completeness の CHECK 制約と同じ3つ（D135）。
 *
 * **division（何を描いたか）とは別の軸。**こちらは「どこまで描いたか」。
 *
 * この軸があること自体が目的で、絞り込みは付け足し。
 * 10分の落書きと数十時間の作品が同じ棚に並ぶと、
 * 「これを出したら見劣りする」が働いて気軽に出せなくなる。
 * **落書きの棚があれば、落書きは落書きとして出せる。**
 */
export type Completeness = "sketch" | "lineart" | "finished";

export const COMPLETENESS_CHOICES: {
  value: Completeness;
  label: string;
  note: string;
}[] = [
  {
    value: "sketch",
    label: "落書き",
    note: "思いついたまま描いたもの。線が荒くても、途中でも構いません",
  },
  {
    value: "lineart",
    label: "線画",
    note: "線は引いたが、色は塗っていないもの",
  },
  {
    value: "finished",
    label: "仕上げ",
    note: "色を塗って、自分なりに仕上げたもの",
  },
];

export const DEFAULT_COMPLETENESS: Completeness = "finished";

export function completenessLabel(value: string): string {
  return COMPLETENESS_CHOICES.find((c) => c.value === value)?.label ?? value;
}

/**
 * 制作時間の計測値（get_production_time の戻り値。2026-09-09）。
 *
 * 【自己申告をやめた】
 *   2026-09-09 より前は、投稿するときに「実制作時間」を選ぶ欄があった。
 *   選んだ値がそのまま記録になるので、記録を好きに書き換えられた。
 *   いまは3つともサーバーが持っている値から作る。
 *
 *     chosen_limit_seconds  最初に選んだ制作時間（prompts.time_limit_seconds）
 *     granted_seconds       延長で足された合計（challenge_renewals の履歴から）
 *     elapsed_seconds       実際にかかった時間（開始から投稿まで）
 *
 *   投稿画面はこれを表示するだけで、送信もしない。
 */
export type ProductionTime = {
  chosen_limit_seconds: number | null;
  renew_count: number;
  granted_seconds: number;
  elapsed_seconds: number;
  is_measured: true;
};

/**
 * 一覧の絞り込みタブ。
 *
 * value が null のときは get_public_works に何も渡さない＝通常フィードで、
 * **AI 部門は出ない**（20260803041246_feed_ai_separation.sql）。
 * AI を見るには 'ai' を明示して選ぶ。締め出すのではなく場所を分ける（spec 7-3）。
 */
export const FEED_TABS: { key: string; value: string | null; label: string }[] = [
  { key: "normal", value: null, label: "すべて（AI以外）" },
  { key: "original", value: "original", label: "オリジナル" },
  { key: "fanart", value: "fanart", label: "ファンアート" },
  { key: "ai", value: "ai", label: "AI生成" },
];

/**
 * 完成度での絞り込み。value が null なら絞らない。
 *
 * **既定は「すべて」。**落書きを別の場所へ押し込めるための機能ではなく、
 * 落書きにも居場所を作るための機能なので、既定で全部見える形にする。
 */
export const COMPLETENESS_FILTERS: { value: string | null; label: string }[] = [
  { value: null, label: "すべて" },
  { value: "sketch", label: "落書き" },
  { value: "lineart", label: "線画" },
  { value: "finished", label: "仕上げ" },
];

/** 一覧の並び順。get_public_works の p_sort と同じ値 */
export const FEED_SORTS: { value: string; label: string }[] = [
  { value: "new", label: "新着" },
  { value: "likes", label: "いいね順" },
  { value: "answers", label: "回答数順" },
];

/** 1ページの件数。get_public_works の上限は50 */
export const FEED_PAGE_SIZE = 24;

/** 一覧の1件（get_public_works が返す行） */
export type PublicWorkListItem = {
  id: string;
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: Division;
  completeness: Completeness;
  source_title: string | null;
  source_character: string | null;
  fanart_note: string | null;
  actual_time_seconds: number | null;
  time_limit_seconds: number | null;
  mode_key: string;
  was_rerolled: boolean;
  likes_count: number;
  saves_count: number;
  answers_count: number;
  created_at: string;
  author_id: string;
  author_handle: string | null;
  author_display_name: string;
};

/**
 * お題の出どころ（prompts.origin）。
 *
 *   draft     … ランダムに引いたお題
 *   saved     … 持ち出した要素を含むお題
 *   daily     … 毎日のお題（値は許してあるが、作る経路はまだ無い）
 *   art_first … 既にある絵を持ち込み、作者が正式なクイズ項目を選んだもの
 *
 * **画面にこの値を出さない。**持ち込みであることを一覧や作品ページに
 * 明示するかどうかは未確定なので、いまは時間の表示を分けるためだけに使う。
 */
export type WorkOrigin = "draft" | "saved" | "daily" | "art_first";

/**
 * 枠ごとの伝達率（get_work_detail / get_my_work の slot_stats）。
 *
 * **ビタ当てと2択当てを1つの割合にまとめない**（D165 の 4 / 11-2）。
 * attempts / corrects は素の合計として持つが、画面はこの2つから
 * 百分率を作らない。作ると、断定して当てた人と2つまで絞った人が
 * 同じ重みで混ざる。
 */
export type SlotStat = {
  card_slot_key: string;
  card_slot_label: string;
  attempts: number;
  corrects: number;
  /** ビタ当て（4択から1語を選んで断定した） */
  exact_attempts: number;
  exact_corrects: number;
  /** 2択当て（4択から2語を選んで、どちらかに正解を含めた） */
  pair_attempts: number;
  pair_corrects: number;
};

/** 作品の投稿者（get_work_detail の author） */
export type WorkAuthor = {
  id: string;
  handle: string | null;
  display_name: string;
  bio: string | null;
  links: Record<string, string>;
};

/** 公開作品1件（get_work_detail の戻り値） */
export type WorkDetail = {
  id: string;
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: Division;
  source_title: string | null;
  source_character: string | null;
  fanart_note: string | null;
  actual_time_seconds: number | null;
  time_limit_seconds: number | null;
  mode_key: string;
  /**
   * お題の出どころ。'art_first' は既に描いてあった絵を持ち込んだ作品で、
   * **制作時間という測定値を持たない**（2026-09-08 のユーザー確定7）。
   * 画面はこの値で時間の表示を出し分ける。値そのものは表示しない。
   */
  origin: WorkOrigin;
  was_rerolled: boolean;
  likes_count: number;
  saves_count: number;
  answers_count: number;
  created_at: string;
  author: WorkAuthor;
  is_author: boolean;
  liked_by_me: boolean;
  saved_by_me: boolean;
  answered_by_me: boolean;
  slot_stats: SlotStat[];
};

/**
 * 自分の作品1件（get_my_work の戻り値）。
 *
 * 公開作品と違い、非公開・審査中・削除済みも返る。
 * その代わり author を持たない（自分だとわかっているため）。
 */
export type MyWork = {
  id: string;
  title: string;
  image_path: string;
  image_width: number;
  image_height: number;
  division: Division;
  source_title: string | null;
  source_character: string | null;
  fanart_note: string | null;
  actual_time_seconds: number | null;
  time_limit_seconds: number | null;
  mode_key: string;
  /** お題の出どころ。WorkDetail の同名と同じ意味 */
  origin: WorkOrigin;
  is_published: boolean;
  review_status: "ok" | "flagged" | "hidden";
  deleted_at: string | null;
  likes_count: number;
  saves_count: number;
  answers_count: number;
  created_at: string;
  can_edit_actual_time: boolean;
  slot_stats: SlotStat[];
};

/**
 * 自分の作品の結果（get_my_work_result）。他人・未サインインには null。
 *
 * **予告と中身が同じ型に入っている。**分けないのは、
 * 開いたかどうかは画面側の状態であって、データの性質ではないため。
 */
export type MyWorkResult = {
  /** 予告の1行目 */
  answers_count: number;
  /**
   * 予告の2行目。**全部の枠を外した人の数**（D134）。
   *
   * 「間違えた人の数」にすると、回答人数と並べたときに
   * 正答率が計算できてしまう。全部外すのは珍しいので、
   * これなら復元されない。
   */
  blind_count: number;
  /** ここから下は「開く」を押したときだけ画面に出す */
  /** **実際に出題された問の総数。**3で割らない（D165） */
  total_items: number;
  correct_items: number;
  /** ビタ当て（1語で断定）の数。2択当てと混ぜない（D165 の 11-2） */
  exact_items: number;
  exact_correct: number;
  /** 2択当て（2語まで絞った）の数 */
  pair_items: number;
  pair_correct: number;
  /** 固定問数だった時代の回答が何件混ざっているか。0 なら全部が新方式 */
  legacy_answers: number;
  /** 枠ごとの方式別。どの要素が断定で伝わったかを見る */
  slots: ResultSlotStat[];
  misreads: { slot_label: string; tag_label: string; count: number }[];
};

/**
 * 枠ごとの方式別の内訳（get_my_work_result の slots）。作者だけに見せる。
 *
 * attempts は方式を問わない合計で、exact_/pair_ はその内訳。
 * **重みを付けて1つの数にまとめない**（D165 の 11-2）。
 */
export type ResultSlotStat = {
  card_slot_key: string;
  card_slot_label: string;
  attempts: number;
  corrects: number;
  exact_attempts: number;
  exact_corrects: number;
  pair_attempts: number;
  pair_corrects: number;
};

/** create_work / update_work の戻り値 */
export type WorkWriteResult = {
  work_id: string;
  is_published: boolean;
};

/** 部門キーから表示名を引く。未知の値はそのまま返す */
export function divisionLabel(division: string): string {
  return DIVISIONS.find((d) => d.value === division)?.label ?? division;
}

/**
 * 割合を百分率にする。挑戦が0回なら null（「まだ分からない」）。
 *
 * 0回のときに 0% と出すと「誰も当てられなかった」と読めてしまう。
 * 「まだ誰も答えていない」と意味が違うので、区別できる形で返す。
 */
export function ratioPercent(corrects: number, attempts: number): number | null {
  if (!attempts) return null;
  return Math.round((corrects / attempts) * 100);
}

/**
 * 枠ごとの、ビタ当てだけの伝達率。
 *
 * **2択当てと足さない。**足すと「断定して当てた」と
 * 「2つまで絞れた」が同じ1つの数になってしまう（D165 の 11-2）。
 */
export function slotExactAccuracy(stat: SlotStat): number | null {
  return ratioPercent(stat.exact_corrects, stat.exact_attempts);
}

/** 枠ごとの、2択当てだけの伝達率 */
export function slotPairAccuracy(stat: SlotStat): number | null {
  return ratioPercent(stat.pair_corrects, stat.pair_attempts);
}

/** 実制作時間の秒数を「2時間30分」のような表示に変える。null は未申告 */
export function formatActualTime(seconds: number | null): string {
  if (seconds === null) return "未申告";

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (hours === 0) return `${minutes}分`;
  if (minutes === 0) return `${hours}時間`;
  return `${hours}時間${minutes}分`;
}
