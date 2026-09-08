import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  AdminHideResult,
  AdminReportDetail,
  AdminReportList,
  AdminResolveResult,
} from "./types";

/**
 * 管理用 RPC の呼び出し。**サーバー専用。**
 *
 * 【なぜ秘密鍵のクライアントを使うか】
 *   4本の RPC は service_role にしか実行権限が無い（migration で
 *   anon / authenticated から revoke してある）。
 *   ふだんの取得系で使う `createSupabaseServerClient()` は
 *   利用者の鍵で動くので、呼んでも permission denied になる。
 *   **これは事故ではなく、そうなるように作ってある。**
 *
 * 【呼ぶ前に必ず認可する】
 *   この層は認可しない。呼ぶ側（ページと Server Action）が
 *   `requireAdminPage()` / `requireAdmin()` を先に通す。
 *   ここで両方やると、認可のない経路をうっかり足したときに気づけない。
 *
 * 【Client Component から import しないこと】
 *   `@/lib/supabase/admin` を通じて秘密鍵に触る。
 *   import してよいのは Server Component と Server Action だけ。
 */

/** 鍵が無いときの合図。画面はこれを「設定不足」として出す */
const NO_KEY = "ADMIN_KEY_MISSING: SUPABASE_SECRET_KEY が設定されていません。";

function admin() {
  const client = createSupabaseAdminClient();
  if (!client) throw new Error(NO_KEY);
  return client;
}

/**
 * RPC が投げた合図を、管理者に読める形へ直す。
 *
 * 【利用者向けのものと分ける理由】
 *   利用者向け（readableRpcError）は、合図を落として日本語の1文だけを返す。
 *   運営はそれでは困る。「すでに閉じている」のか「そんな通報が無い」のかで
 *   次にすることが変わるので、**合図を残したまま日本語を添える。**
 */
export type AdminErrorKind =
  | "unauthorized"
  | "not_found"
  | "already_done"
  | "invalid_input"
  | "config"
  | "unknown";

export type AdminError = {
  kind: AdminErrorKind;
  /** DB が投げた合図（WORK_ALREADY_HIDDEN など）。分からなければ空 */
  code: string;
  /** 画面に出す日本語 */
  message: string;
};

const KINDS: { code: string; kind: AdminErrorKind; message: string }[] = [
  {
    code: "ADMIN_REQUIRED",
    kind: "unauthorized",
    message: "この操作を行う権限がありません。",
  },
  {
    code: "ADMIN_KEY_MISSING",
    kind: "config",
    message:
      "SUPABASE_SECRET_KEY が設定されていないため、管理操作を行えません。" +
      "環境変数を設定してから、もう一度お試しください。",
  },
  {
    code: "WORK_NOT_FOUND",
    kind: "not_found",
    message: "その作品が見つかりません。すでに消えている可能性があります。",
  },
  {
    code: "REPORT_NOT_FOUND",
    kind: "not_found",
    message: "その通報が見つかりません。",
  },
  {
    code: "WORK_ALREADY_HIDDEN",
    kind: "already_done",
    message: "その作品はすでに非表示です。何も変えていません。",
  },
  {
    code: "REPORT_ALREADY_RESOLVED",
    kind: "already_done",
    message: "その通報はすでに閉じています。何も変えていません。",
  },
  {
    code: "CONFIRM_REQUIRED",
    kind: "invalid_input",
    message: "確認の欄にチェックを入れてから実行してください。",
  },
  {
    code: "REASON_REQUIRED",
    kind: "invalid_input",
    message: "理由を書いてください。空欄では実行できません。",
  },
  {
    code: "REASON_TOO_LONG",
    kind: "invalid_input",
    message: "理由が長すぎます（1000字まで）。",
  },
  {
    code: "INVALID_RESOLUTION",
    kind: "invalid_input",
    message: "処理の種類が正しくありません。",
  },
  {
    code: "INVALID_STATUS",
    kind: "invalid_input",
    message: "状態の指定が正しくありません。",
  },
  {
    code: "permission denied",
    kind: "unauthorized",
    message:
      "データベースがこの操作を断りました。管理用の関数は service_role だけが" +
      "呼べます。秘密鍵の設定を確かめてください。",
  },
];

export function adminError(e: unknown): AdminError {
  const raw = e instanceof Error ? e.message : String(e);

  for (const k of KINDS) {
    if (raw.includes(k.code)) {
      return { kind: k.kind, code: k.code, message: k.message };
    }
  }

  // 分からないものは握りつぶさない。**そのまま出す。**
  // 「成功したように見える」状態を作らないことのほうが大事。
  return { kind: "unknown", code: "", message: `想定外の失敗です: ${raw}` };
}

/** 例外の中身を1文字も落とさずに投げ直す小さな包み */
function fail(message: string): never {
  throw new Error(message);
}

/* ---------------------------------------------------------------------------
 * 読む
 * ------------------------------------------------------------------------- */

export async function fetchAdminReports(input: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<AdminReportList> {
  const { data, error } = await admin().rpc("admin_list_reports", {
    p_status: input.status ?? "open",
    p_limit: input.limit ?? 20,
    p_offset: input.offset ?? 0,
  });

  if (error) fail(error.message);
  return data as AdminReportList;
}

export async function fetchAdminReport(
  reportId: number,
): Promise<AdminReportDetail> {
  const { data, error } = await admin().rpc("admin_get_report", {
    p_report_id: reportId,
  });

  if (error) fail(error.message);
  return data as AdminReportDetail;
}

/* ---------------------------------------------------------------------------
 * 変える（危険側）
 * ------------------------------------------------------------------------- */

/**
 * 作品を運営の判断で非表示にする。
 *
 * **画像は消さない。行も消さない。**これは公開停止であって削除ではない。
 * 取り消せる操作として作ってある（v0 では戻す画面を作っていない。
 * 戻すには review_status を 'ok' に戻す migration か SQL が要る）。
 */
export async function callAdminHideWork(input: {
  adminUserId: string;
  workId: string;
  reason: string;
}): Promise<AdminHideResult> {
  const { data, error } = await admin().rpc("admin_hide_work", {
    p_admin_user_id: input.adminUserId,
    p_work_id: input.workId,
    p_reason: input.reason,
  });

  if (error) fail(error.message);
  return data as AdminHideResult;
}

/** 通報を閉じる。resolved（対応した）か rejected（理由が無かった）の2つ */
export async function callAdminResolveReport(input: {
  adminUserId: string;
  reportId: number;
  resolution: "resolved" | "rejected";
  reason: string;
}): Promise<AdminResolveResult> {
  const { data, error } = await admin().rpc("admin_resolve_report", {
    p_admin_user_id: input.adminUserId,
    p_report_id: input.reportId,
    p_resolution: input.resolution,
    p_reason: input.reason,
  });

  if (error) fail(error.message);
  return data as AdminResolveResult;
}
