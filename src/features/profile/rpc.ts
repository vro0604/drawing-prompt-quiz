import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type { PublicWorkListItem } from "@/features/work/types";
import type {
  PublicAnswer,
  PublicProfile,
  SavedWork,
  Specialties,
} from "@/features/profile/types";
import type { Vocabulary } from "@/features/vocab/types";
import { EMPTY_VOCABULARY } from "@/features/vocab/types";

/**
 * プロフィールの更新。サーバー専用。
 *
 * 【なぜ表を直接更新しないのか】
 *   001 は列単位で更新権限を配ってある。display_name / bio / links は
 *   直接更新できるが、**handle は意図的に外してある**。
 *   ゲストのうちに好きな ID を先取りされるのを防ぐためで、
 *   handle を設定できるのは update_my_profile だけ。
 *
 *   4項目を1回の呼び出しでまとめて更新するのは、画面のフォームが1つで、
 *   途中で失敗して片方だけ変わる状態を作らないため。
 */

/** 更新後のプロフィール（update_my_profile の戻り値） */
export type MyProfile = {
  id: string;
  handle: string | null;
  display_name: string;
  bio: string | null;
  links: Record<string, string>;
};

/** 渡さなかった項目は変更しない（null = 変更しない。D49 と同じ） */
export type ProfileUpdate = {
  handle?: string | null;
  displayName?: string | null;
  bio?: string | null;
  links?: Record<string, string> | null;
};

export async function callUpdateMyProfile(update: ProfileUpdate): Promise<MyProfile> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_my_profile", {
    p_handle: update.handle ?? null,
    p_display_name: update.displayName ?? null,
    p_bio: update.bio ?? null,
    p_links: update.links ?? null,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as MyProfile;
}

/** 公開設定3つ。渡さなかった項目は変更しない */
export type VisibilityUpdate = {
  show_answer_stats?: boolean;
  show_creator_stats?: boolean;
  show_answer_history?: boolean;
  show_saved_works?: boolean;
};

/**
 * 公開設定を更新する。
 *
 * 001 は show_* 3列に直接の更新権限を与えているが、あえて関数を通す。
 * **ゲストに公開設定を持たせないため**。ゲストのプロフィールはそもそも
 * 他人から見えないので、設定できても「設定したのに公開されない」という
 * 分かりにくい状態だけが残る。
 */
export async function callUpdateMyVisibility(
  update: VisibilityUpdate,
): Promise<Required<VisibilityUpdate>> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("update_my_visibility", {
    p_show_answer_stats: update.show_answer_stats ?? null,
    p_show_creator_stats: update.show_creator_stats ?? null,
    p_show_answer_history: update.show_answer_history ?? null,
    p_show_saved_works: update.show_saved_works ?? null,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as Required<VisibilityUpdate>;
}

/**
 * 自己申告の得意分野を読む（本人だけ）。
 *
 * アカウント画面の初期値に使う。**他人のものは返らない**ので、
 * 引数に利用者を渡す口そのものが無い。
 */
export async function fetchMySpecialties(): Promise<Specialties> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_specialties");

  if (error) throw new Error(readableRpcError(error.message));
  const v = data as Specialties | null;
  return { drawing: v?.drawing ?? [], viewing: v?.viewing ?? [] };
}

/**
 * 得意分野を、描く側・見る側まとめて置き換える。
 *
 * 1件ずつ足し引きしない。**画面のフォームが1つ**なので、
 * 途中で失敗して片方だけ変わる状態を作らない（update_my_profile と同じ）。
 * 上限5件・同じ種類の中での重複・選べない語は、すべて DB 側も見る。
 */
export async function callSetMySpecialties(
  drawing: number[],
  viewing: number[],
): Promise<Specialties> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_my_specialties", {
    p_drawing: drawing,
    p_viewing: viewing,
  });

  if (error) throw new Error(readableRpcError(error.message));
  const v = data as Specialties | null;
  return { drawing: v?.drawing ?? [], viewing: v?.viewing ?? [] };
}

/**
 * プロフィールアイコンの置き場所を設定する。null で外す。
 *
 * **戻り値に前の置き場所が入る。** 呼び出し側はそれを Storage から消す。
 * ここで消さないのは、DB の更新と Storage の削除を同じ処理にすると、
 * 片方だけ成功したときにどちらが正しいか分からなくなるため。
 */
export async function callSetMyAvatar(
  path: string | null,
): Promise<{ avatar_path: string | null; previous_path: string | null }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_my_avatar", { p_path: path });

  if (error) throw new Error(readableRpcError(error.message));
  return data as { avatar_path: string | null; previous_path: string | null };
}

/**
 * 消せなかった自分のアイコンを、掃除の待ち行列へ入れる。
 *
 * Storage と DB は別の仕組みなので、まとめて巻き戻せない。
 * 「DB は書けたが古いファイルだけ消せなかった」ときに、そのファイルを
 * ここへ渡す。**渡さないと、失敗のたびに誰からも辿れないファイルが増える。**
 *
 * ここで失敗しても、呼び出し側は保存そのものを失敗にしない
 * （新しいアイコンは正しく使えているため）。
 */
export async function callEnqueueMyAvatarCleanup(path: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("enqueue_my_avatar_cleanup", { p_path: path });
  if (error) throw new Error(readableRpcError(error.message));
}

/**
 * 得意分野で選べる語の一覧。
 *
 * **持ち込み（art_first）と同じ関数を使う。**選べる語の範囲を1か所に
 * まとめておくため（出所: ユーザー指示 2026-09-08「art_firstで今回実装した
 * 語彙選択UI・get_art_first_vocabulary() の構造を調査し、再利用可能なら
 * 共通化または流用する」）。返ってくる min_words / max_words は
 * お題を作るときの数なので、得意分野では使わない（上限は5件）。
 */
export async function fetchPickableVocabulary(): Promise<Vocabulary> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_art_first_vocabulary");

  if (error) return EMPTY_VOCABULARY;
  return (data as Vocabulary | null) ?? EMPTY_VOCABULARY;
}

/**
 * 公開プロフィール1件。見つからなければ null。
 *
 * 存在しない ID と、まだ handle を決めていない人を区別しない（D40）。
 * 「その ID の人はいるが見せない」と分かると、ID の総当たりで
 * 誰が登録しているかを調べられてしまう。
 */
export async function fetchPublicProfile(handle: string): Promise<PublicProfile | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_public_profile", { p_handle: handle });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as PublicProfile | null) ?? null;
}

/**
 * 旧ID を、いまの ID に読み替える。旧ID でなければ null。
 *
 * ID を変えると古い ID は他人が取れなくなり（P5）、古い URL は
 * いまのページへ移す。**存在しない ID と、公開されていない人を
 * 区別しない**（どちらも null）。区別すると、ID の総当たりで
 * 誰が登録しているかを調べられる（D40）。
 */
export async function fetchHandleRedirect(handle: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_handle_redirect", {
    p_handle: handle,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as string | null) ?? null;
}

/** その人の公開作品。列は get_public_works と同じなのでカードを使い回せる */
export async function fetchUserWorks(params: {
  userId: string;
  division: string | null;
  sort: string;
  limit: number;
  offset: number;
}): Promise<PublicWorkListItem[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_user_works", {
    p_user_id: params.userId,
    p_division: params.division,
    p_sort: params.sort,
    p_limit: params.limit,
    p_offset: params.offset,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data ?? []) as PublicWorkListItem[];
}

/**
 * お気に入り一覧。本人用と他人用を兼ねる。
 *
 * **誰に何を見せるかは DB 側が決める。** 本人なら常に全部（非公開に
 * なった作品も状態つきで）、他人なら `show_saved_works` が true のときだけ
 * 公開中の作品。ここで条件を組み立てないのは、間違えたときに
 * 他人の非公開作品が出てしまうため。
 *
 * お題の答えは、閲覧者がその作品へ回答済みのときだけ入る（spec 12-1）。
 */
export async function fetchSavedWorks(params: {
  userId: string;
  limit: number;
  offset: number;
}): Promise<SavedWork[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_saved_works", {
    p_user_id: params.userId,
    p_limit: params.limit,
    p_offset: params.offset,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data ?? []) as SavedWork[];
}

/** 回答履歴。作品・日時・正答数だけ。選んだ選択肢は返ってこない */
export async function fetchPublicAnswers(params: {
  userId: string;
  limit: number;
  offset: number;
}): Promise<PublicAnswer[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_public_answers", {
    p_user_id: params.userId,
    p_limit: params.limit,
    p_offset: params.offset,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data ?? []) as PublicAnswer[];
}

/**
 * 外部リンクの入力欄。
 *
 * **定義は features/profile/types.ts にある。**このファイルはサーバー専用の
 * 取り決め（Supabase のクライアント）を取り込むので、画面側の部品から
 * 直接読むとサーバー用のコードが混ざる（2026-09-08 に build が落ちた）。
 * これまでの取り込み文を壊さないよう、名前だけここからも出しておく。
 */
export { LINK_FIELDS } from "@/features/profile/types";
