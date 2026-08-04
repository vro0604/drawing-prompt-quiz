import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * 定期的な掃除の中身（Step 16）。
 *
 * 【なぜサーバー側にこれが要るか】
 *   SQL だけで終わる掃除は RPC が持っている。だが Storage と auth.users は
 *   SQL からは消せない。DB 側は「まだ終わっていないものの一覧」を返し、
 *   実際に消すのはここが行う。
 *
 * 【失敗しても止めない】
 *   1つの job が失敗しても、ほかの job は動かす。
 *   「1件の壊れたデータのせいで、掃除全体が永久に動かない」を避ける。
 *   失敗は結果に載せて返す。**黙って飲み込まない。**
 *
 * 【何度実行してもよい】
 *   すべての job が「まだ終わっていないもの」だけを対象にする。
 *   途中で落ちても、次の実行が続きから拾う。
 */

export type CleanupResult = {
  ok: boolean;
  /** 実行前の残り件数 */
  before: Record<string, number> | null;
  /** 実行後の残り件数。減っていることを確かめる */
  after: Record<string, number> | null;
  jobs: Record<string, number | string>;
  errors: string[];
};

/** 1回の実行で触る上限。溜まっていても少しずつ減らす */
const LIMITS = {
  prompts: 500,
  drafts: 500,
  agreements: 1000,
  images: 100,
  deletions: 50,
  guests: 100,
};

export async function runCleanup(): Promise<CleanupResult> {
  const result: CleanupResult = {
    ok: false,
    before: null,
    after: null,
    jobs: {},
    errors: [],
  };

  const admin = createSupabaseAdminClient();

  if (!admin) {
    result.errors.push("SUPABASE_SECRET_KEY が未設定のため掃除できません");
    return result;
  }

  /** 失敗しても続ける。理由は結果に残す */
  const step = async (name: string, fn: () => Promise<number | string>) => {
    try {
      result.jobs[name] = await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.jobs[name] = `失敗: ${message}`;
      result.errors.push(`${name}: ${message}`);
    }
  };

  // --- 実行前の残り -----------------------------------------------------
  //
  // 取れなくても掃除そのものは進める。ただし**黙って null にしない。**
  // before が null で errors が空だと「何も残っていなかった」と読めてしまい、
  // 実際は「数えられなかった」だったときに区別がつかない。
  result.before = await readStatus(admin, result, "実行前の残り");

  // --- SQL だけで終わるもの ---------------------------------------------
  await step("お題", async () => {
    const { data, error } = await admin.rpc("cleanup_orphan_prompts", {
      p_limit: LIMITS.prompts,
    });
    if (error) throw new Error(error.message);
    return (data as number) ?? 0;
  });

  await step("ドラフト", async () => {
    const { data, error } = await admin.rpc("cleanup_stale_drafts", {
      p_limit: LIMITS.drafts,
    });
    if (error) throw new Error(error.message);
    return (data as number) ?? 0;
  });

  await step("同意記録", async () => {
    const { data, error } = await admin.rpc("cleanup_expired_agreements", {
      p_limit: LIMITS.agreements,
    });
    if (error) throw new Error(error.message);
    return (data as number) ?? 0;
  });

  // --- 消し残した画像を列へ積む -----------------------------------------
  //
  // 積んでから消す。積む前に消そうとしても、対象が見つからない。
  await step("画像を列へ積む", async () => {
    const { data, error } = await admin.rpc("enqueue_orphan_work_images", {
      p_limit: LIMITS.images,
    });
    if (error) throw new Error(error.message);
    return (data as number) ?? 0;
  });

  // --- Storage の削除を再試行 -------------------------------------------
  await step("画像を消す", async () => {
    const { data, error } = await admin.rpc("list_pending_storage_objects", {
      p_limit: LIMITS.images,
    });
    if (error) throw new Error(error.message);

    const objects = (data ?? []) as { id: number; bucket: string; path: string }[];
    let done = 0;

    for (const obj of objects) {
      const { error: removeError } = await admin.storage
        .from(obj.bucket)
        .remove([obj.path]);

      if (removeError) {
        await admin.rpc("mark_storage_object_failed", {
          p_id: obj.id,
          p_error: removeError.message,
        });
        continue;
      }

      await admin.rpc("mark_storage_object_done", { p_id: obj.id });
      done += 1;
    }

    return done;
  });

  // --- auth.users の削除を再試行 ----------------------------------------
  //
  // 退会の第2段階が失敗したぶん。ここが通ると profiles も cascade で消え、
  // その人のデータは1件も残らなくなる。
  await step("退会の続き", async () => {
    const { data, error } = await admin.rpc("list_pending_account_deletions", {
      p_limit: LIMITS.deletions,
    });
    if (error) throw new Error(error.message);

    const pending = (data ?? []) as { user_id: string }[];
    let done = 0;

    for (const row of pending) {
      const { error: authError } = await admin.auth.admin.deleteUser(row.user_id);

      // すでに消えている場合も「終わった」として扱う。
      // 記録だけが残っていると、毎回同じ失敗を繰り返すことになる。
      const alreadyGone =
        authError && /not found|does not exist/i.test(authError.message);

      if (authError && !alreadyGone) {
        await admin.rpc("fail_account_deletion", {
          p_user_id: row.user_id,
          p_error: authError.message,
        });
        continue;
      }

      await admin.rpc("finish_account_deletion", { p_user_id: row.user_id });
      done += 1;
    }

    return done;
  });

  // --- 使われていないゲスト ---------------------------------------------
  //
  // **いちばん最後に置く。**ゲストを消すとお題の持ち主が外れ、
  // 新しく「持ち主のいないお題」が生まれる。次回の実行が拾う。
  await step("ゲスト", async () => {
    const { data, error } = await admin.rpc("list_stale_guests", {
      p_limit: LIMITS.guests,
    });
    if (error) throw new Error(error.message);

    const guests = (data ?? []) as { user_id: string }[];
    let done = 0;

    for (const g of guests) {
      const { error: authError } = await admin.auth.admin.deleteUser(g.user_id);
      if (!authError) done += 1;
      else result.errors.push(`ゲスト ${g.user_id.slice(0, 8)}…: ${authError.message}`);
    }

    return done;
  });

  // --- 実行後の残り -----------------------------------------------------
  result.after = await readStatus(admin, result, "実行後の残り");

  result.ok = result.errors.length === 0;
  return result;
}

/**
 * 残り件数を読む。読めなかったら理由を jobs へ残す。
 *
 * **掃除そのものは止めない。**数えられなかっただけで
 * 片づけをやめるほうが困る。ただし「数えられなかった」ことは記録する。
 * 記録が無いと、次に見た人が「残り0件だった」と誤って読む。
 */
async function readStatus(
  admin: NonNullable<ReturnType<typeof createSupabaseAdminClient>>,
  result: CleanupResult,
  label: string,
): Promise<Record<string, number> | null> {
  try {
    const { data, error } = await admin.rpc("cleanup_status");
    if (error) {
      result.jobs[label] = `数えられませんでした: ${error.message}`;
      return null;
    }
    return (data as Record<string, number>) ?? null;
  } catch (e) {
    result.jobs[label] = `数えられませんでした: ${e instanceof Error ? e.message : String(e)}`;
    return null;
  }
}
