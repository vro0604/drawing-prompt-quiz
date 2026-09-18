"use server";

import { ensureUserId, getCurrentUser } from "@/features/auth/session";
import { callSetWorkUninterest, fetchFeedWorks } from "@/features/feed/rpc";
import { toFeedCardWorks } from "@/features/feed/present";
import type { FeedCardWork } from "@/features/feed/types";
import { callToggleLike, callToggleSave } from "@/features/work/rpc";

/**
 * 作品一覧（Masonry）から呼ばれる Server Action。
 *
 * 【ここだけ既存の作法と違う】
 *   ほかの画面の Server Action は、終わったら redirect して画面を作り直す。
 *   一覧はそれができない。**読み足した何百枚と、いまのスクロール位置が
 *   全部消える。**だからここの関数は redirect も revalidatePath もせず、
 *   結果を戻り値で返す。画面はその値だけを書き換える。
 *
 * 【revalidatePath を呼ばない影響】
 *   いいね・保存の件数は一覧に出していない（指示 12・5）ので、
 *   一覧の見た目で古くなるものが無い。作品ページを開けば、
 *   そちらは毎回 DB から取り直す。
 */

/** 画面へ返す形。成功なら error は null */
export type FeedActionResult<T> =
  | ({ ok: true; error: null } & T)
  | { ok: false; error: string };

function failed(e: unknown): { ok: false; error: string } {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/**
 * 一覧の続きを取る（無限スクロール）。
 *
 * **絞り込みの条件は画面から受け取る。**URL に出ている条件と同じものが
 * 渡るので、1ページ目と続きで別の条件になることはない。
 * 条件が信用できなくても困らない（返るのは公開作品だけ）。
 */
export async function loadFeedPageAction(input: {
  division: string | null;
  sort: string;
  completeness: string | null;
  unansweredOnly: boolean;
  limit: number;
  offset: number;
}): Promise<FeedActionResult<{ items: FeedCardWork[] }>> {
  try {
    const rows = await fetchFeedWorks({
      division: input.division,
      sort: input.sort,
      completeness: input.completeness,
      unansweredOnly: input.unansweredOnly,
      limit: input.limit,
      offset: input.offset,
    });
    return { ok: true, error: null, items: toFeedCardWorks(rows) };
  } catch (e) {
    return failed(e);
  }
}

/**
 * いいねを付ける／外す（長押しで呼ばれる）。
 *
 * 【ここで匿名ゲストを作らない】
 *   いいねは登録ユーザー限定（D7 / spec 10）。ここで ensureUserId を
 *   呼ぶと、押せもしないゲストを1人作ってしまう。作品ページの
 *   いいねと同じ扱いにしている。
 *
 * 【判定は DB 側】
 *   ゲストかどうかは toggle_like が JWT で見る。ここを通り抜けても必ず止まり、
 *   「いいねにはアカウント登録が必要です」という文が戻り値に入る。
 */
export async function toggleFeedLikeAction(
  workId: string,
): Promise<FeedActionResult<{ liked: boolean }>> {
  try {
    const r = await callToggleLike(workId);
    return { ok: true, error: null, liked: r.liked };
  } catch (e) {
    return failed(e);
  }
}

/** 保存を付ける／外す。条件はいいねと同じ */
export async function toggleFeedSaveAction(
  workId: string,
): Promise<FeedActionResult<{ saved: boolean }>> {
  try {
    const r = await callToggleSave(workId);
    return { ok: true, error: null, saved: r.saved };
  } catch (e) {
    return failed(e);
  }
}

/**
 * 「興味なし」。その人の一覧からだけ消える。
 *
 * 【ここではゲストを作る】
 *   いいね・保存と逆の扱いにしている。興味なしは
 *   **見る人が自分の一覧を整える操作**で、ランキングにも他人の画面にも
 *   影響しない。通報と同じく、押したその瞬間にゲストを発行する
 *   （spec 11-1 が禁じているのは「開いただけで作ること」）。
 */
export async function setFeedUninterestAction(
  workId: string,
  uninterested: boolean,
): Promise<FeedActionResult<{ uninterested: boolean; applied: boolean }>> {
  try {
    await ensureUserId();
    const r = await callSetWorkUninterest(workId, uninterested);
    return { ok: true, error: null, uninterested: r.uninterested, applied: r.applied };
  } catch (e) {
    return failed(e);
  }
}

/**
 * いま登録ユーザーとして見ているか。
 *
 * 画面は、いいね・保存を押す前に案内を出し分けるためだけにこれを使う。
 * **守りではない。**本当の判定は DB 側にある。
 */
export async function isRegisteredViewerAction(): Promise<boolean> {
  const user = await getCurrentUser();
  return user !== null && user.is_anonymous !== true;
}
