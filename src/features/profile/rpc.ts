import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";

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
