import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import { isUuid } from "@/lib/uuid";
import {
  EMPTY_SAVED,
  type CarrySourceKind,
  type RevealedPrompt,
  type SavedElements,
} from "@/features/carry/types";

/**
 * 一部持ち出し（D161）の DB 呼び出し。サーバー専用。
 *
 * 【正解が外へ出る経路が1本増えたこと】
 *   fetchRevealedPrompt は prompt_cards（＝クイズの答え）を返す。
 *   返るのは「その作品に回答済みの人」と「作者」だけで、
 *   判定は DB の get_answered_prompt が持っている。
 *   ここでは判定していない。**判定をここに写すと、二重管理になって必ずずれる。**
 */

/**
 * 回答後に開示される、その作品のお題まるごと。
 *
 * 未回答・他人・未サインインには null。
 * **未サインインのときは DB へ問い合わせない。**
 * get_answered_prompt は authenticated だけが呼べるので、
 * anon のまま呼ぶと permission denied で画面が 500 になる（D90 と同じ形）。
 */
export async function fetchRevealedPrompt(workId: string): Promise<RevealedPrompt | null> {
  if (!isUuid(workId)) return null;

  const supabase = await createSupabaseServerClient();

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;

  const { data, error } = await supabase.rpc("get_answered_prompt", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as RevealedPrompt | null) ?? null;
}

/**
 * 手持ちの持ち出し要素。未サインインには空。
 *
 * **ゲストにも問い合わせる。**2026-09-05 の3区分で、ゲストも
 * 「いまの流れの中だけ」の持ち出しを持てるようになった。
 * 何を持てるかの判定は DB 側にある。
 */
export async function fetchSavedElements(): Promise<SavedElements> {
  const supabase = await createSupabaseServerClient();

  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return EMPTY_SAVED;

  const { data, error } = await supabase.rpc("list_saved_elements");

  if (error) throw new Error(readableRpcError(error.message));
  return (data as SavedElements | null) ?? EMPTY_SAVED;
}

/**
 * 同じ元お題から選んだ1〜3個の要素を、**1つの保存枠**として持ち出す。
 *
 * persist を true にすると、別のセッションでも使える形で保存しようとする。
 * **できるかどうかはここで決めない。**ゲストなら DB 側が
 * 「いまの流れの中だけ」へ落とす。保存枠の数が上限なら断られる。
 *
 * 数の検査も、その語が本当にそのお題に入っているかの検査も DB 側。
 */
export async function callSavePromptElements(
  sourceKind: CarrySourceKind,
  sourceId: string,
  tagIds: number[],
  persist = true,
): Promise<SavedElements> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("save_prompt_elements", {
    p_source_kind: sourceKind,
    p_source_id: sourceId,
    p_tag_ids: tagIds,
    p_persist: persist,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as SavedElements | null) ?? EMPTY_SAVED;
}

/**
 * 保存枠を1つ捨てる。**上限に空きができるのはこの操作だけ。**
 *
 * 上限の単位は保存枠なので、枠の中の要素を1つ消しても
 * （枠が空にならない限り）空きは増えない。他人の枠は消せない（判定は DB 側）。
 */
export async function callDeleteSavedCarrySlot(slotId: number): Promise<SavedElements> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_saved_carry_slot", {
    p_slot_id: slotId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as SavedElements | null) ?? EMPTY_SAVED;
}

/** 保存枠の中の要素を1つ捨てる。枠が空になれば枠も消える */
export async function callDeleteSavedElement(id: number): Promise<SavedElements> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("delete_saved_element", { p_id: id });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as SavedElements | null) ?? EMPTY_SAVED;
}

/**
 * ゲストのときに作った保存枠を、登録後に永続保存へ移す。
 *
 * 移す単位は**保存枠**。ids を渡さなければ、いま持っている
 * 「流れの中だけ」の枠をすべて移す。
 * 上限（枠の数）を超えるときは断られる（何枠まで移せるかも DB が決める）。
 */
export async function callPromoteSessionCarry(
  slotIds: number[] | null = null,
): Promise<SavedElements> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("promote_session_carry", {
    p_slot_ids: slotIds && slotIds.length > 0 ? slotIds : null,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as SavedElements | null) ?? EMPTY_SAVED;
}
