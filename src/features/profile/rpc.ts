import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type { PublicWorkListItem } from "@/features/work/types";
import type {
  PublicAnswer,
  PublicProfile,
  SavedWork,
} from "@/features/profile/types";

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
    p_show_answer_history: update.show_answer_history ?? null,
    p_show_saved_works: update.show_saved_works ?? null,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as Required<VisibilityUpdate>;
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
 * キーは固定にする。自由に増やせるようにすると、
 * 4096バイトの上限に当たるまで何個でも足せてしまう。
 */
export const LINK_FIELDS: { key: string; label: string; placeholder: string }[] = [
  { key: "x", label: "X（旧Twitter）", placeholder: "https://x.com/..." },
  { key: "pixiv", label: "pixiv", placeholder: "https://www.pixiv.net/users/..." },
  { key: "site", label: "サイト", placeholder: "https://..." },
];
