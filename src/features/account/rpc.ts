import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canUseSupabaseAdmin, createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readableRpcError } from "@/features/draft/rpc";

/**
 * 退会と規約同意。サーバー専用。
 *
 * 【退会が2段階に分かれている理由】
 *   DB の中だけで完結しないため。
 *
 *     第1段階（RPC / 1つの取引）
 *       個人データを消し、作品を公開から外し、書き込みを止める
 *     第2段階（ここ / 取引の外）
 *       Storage の画像を消し、auth.users を消す
 *
 *   第2段階は取引に入れられない。外部のAPIだからで、
 *   途中で失敗しても巻き戻らない。
 *
 *   **だから順番を「危ないほうを先に閉じる」にしてある。**
 *   第1段階が終わった時点で、その人はもう何も書き込めず、
 *   作品も公開されていない。第2段階が失敗しても、
 *   残るのは auth.users のメールと Storage のファイルだけで、
 *   どちらも掃除の対象として記録に残る。
 *
 *   逆順にすると「ログインできないのに作品が公開されたまま」になる。
 */

export type AccountState = {
  account_status: "active" | "deletion_pending";
  is_anonymous: boolean;
  handle: string | null;
  display_name: string;
  /** 退会の確認で入力してもらう言葉（handle。無ければ表示名） */
  confirm_word: string;
  terms_agreed: boolean;
  privacy_agreed: boolean;
  works_count: number;
};

export type LegalDocument = {
  version: string;
  body_md: string;
  published_at: string;
};

export type CurrentDocuments = {
  terms: LegalDocument | null;
  privacy: LegalDocument | null;
};

export type PendingObject = { id: number; bucket: string; path: string };

/** 退会の第2段階の結果。**どこまで進んだかを隠さない。** */
export type DeletionOutcome = {
  storageDeleted: number;
  storageFailed: number;
  authDeleted: boolean;
  /** 鍵が無くて Admin API を呼べなかった */
  authSkippedNoKey: boolean;
};

// ── 読み取り ──────────────────────────────────────────────

/** いま有効な規約とポリシー。未サインインでも読める。 */
export async function fetchCurrentDocuments(): Promise<CurrentDocuments> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_current_documents");

  if (error) throw new Error(readableRpcError(error.message));
  return (data as CurrentDocuments | null) ?? { terms: null, privacy: null };
}

/** 自分のアカウントの状態。サインインしていなければ null。 */
export async function fetchAccountState(): Promise<AccountState | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_account_state");

  // 未サインインは権限で弾かれる。エラーにせず null を返す（D40）
  if (error) return null;
  return (data as AccountState | null) ?? null;
}

// ── 書き込み ──────────────────────────────────────────────

/** 規約への同意を記録する。 */
export async function callAgreeToDocuments(
  termsVersion: string,
  privacyVersion: string,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("agree_to_documents", {
    p_terms_version: termsVersion,
    p_privacy_version: privacyVersion,
  });

  if (error) throw new Error(readableRpcError(error.message));
}

/**
 * 退会の第1段階。
 *
 * **引数に利用者を渡さない。**RPC が auth.uid() の行しか触らないので、
 * 他人のアカウントを消す経路が構造として存在しない。
 */
export async function callStartAccountDeletion(
  confirm: string,
): Promise<{ userId: string; objects: PendingObject[] }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("start_account_deletion", {
    p_confirm: confirm,
  });

  if (error) throw new Error(readableRpcError(error.message));

  const result = data as { user_id: string; objects: PendingObject[] } | null;
  if (!result) throw new Error("退会の処理を開始できませんでした");

  return { userId: result.user_id, objects: result.objects ?? [] };
}

/**
 * 退会の第2段階。Storage を消してから auth.users を消す（指定11）。
 *
 * **どちらが失敗しても例外にしない。**第1段階は終わっているので、
 * ここで例外を投げると「消えたのに失敗した」という表示になる。
 * 失敗は掃除の対象として記録に残し、結果をそのまま返す。
 */
export async function finishAccountDeletion(
  userId: string,
  objects: PendingObject[],
): Promise<DeletionOutcome> {
  const outcome: DeletionOutcome = {
    storageDeleted: 0,
    storageFailed: 0,
    authDeleted: false,
    authSkippedNoKey: false,
  };

  const admin = createSupabaseAdminClient();

  if (!admin) {
    // 鍵が無い。第1段階は終わっているので、残りは掃除に任せる。
    outcome.authSkippedNoKey = true;
    outcome.storageFailed = objects.length;
    await recordDeletionAttempt(null, userId, "SUPABASE_SECRET_KEY 未設定");
    return outcome;
  }

  // --- Storage ---------------------------------------------------------
  //
  // 1件ずつ消す。まとめて消すと、どれが失敗したのか分からなくなる。
  for (const obj of objects) {
    const { error } = await admin.storage.from(obj.bucket).remove([obj.path]);

    if (error) {
      outcome.storageFailed += 1;
      await admin
        .from("storage_cleanup_queue")
        .update({ attempts: 1, last_error: error.message })
        .eq("id", obj.id);
      continue;
    }

    outcome.storageDeleted += 1;
    await admin
      .from("storage_cleanup_queue")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", obj.id);
  }

  if (outcome.storageFailed === 0) {
    await admin
      .from("account_deletions")
      .update({ storage_done_at: new Date().toISOString() })
      .eq("user_id", userId);
  }

  // --- auth.users ------------------------------------------------------
  //
  // 画像が消せなくても実行する。**メールを残さないことのほうが重い。**
  // 消し残した画像は queue に残るので、あとから消せる。
  const { error: authError } = await admin.auth.admin.deleteUser(userId);

  if (authError) {
    await recordDeletionAttempt(admin, userId, authError.message);
    return outcome;
  }

  outcome.authDeleted = true;

  // 消し終わったので記録も消す。**残す必要が無いものは残さない。**
  await admin.from("account_deletions").delete().eq("user_id", userId);

  return outcome;
}

/** 失敗を記録する。次の掃除がここを見て再試行する。 */
async function recordDeletionAttempt(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  message: string,
): Promise<void> {
  if (!admin) return;

  const { data } = await admin
    .from("account_deletions")
    .select("attempts")
    .eq("user_id", userId)
    .maybeSingle();

  await admin
    .from("account_deletions")
    .update({
      attempts: ((data?.attempts as number | undefined) ?? 0) + 1,
      last_error: message.slice(0, 500),
    })
    .eq("user_id", userId);
}

export { canUseSupabaseAdmin };
