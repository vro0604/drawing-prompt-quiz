import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";

/**
 * 通報。サーバー専用。
 *
 * 【誰が送れるか】
 *   未サインイン … 送れない（create_report に anon の実行権限が無い）
 *   ゲスト       … **送れる**（spec 8-4 の「匿名も可」）
 *   登録ユーザー … 送れる
 *
 *   いいね・投稿と違ってゲストにも許すのは、通報が「権利の主張」ではなく
 *   「見つけた人が知らせる」行為だから。登録を求めると、いちばん多くの
 *   作品を見ている層からの報告が届かなくなる。
 *
 * 【返ってくるもの】
 *   受け付けたかどうかだけ。**通報の総数や、ほかの人の通報は返らない。**
 *   何件集まると何が起きるかを外から測らせないため。
 */

/** reports.reason の CHECK と同じ5つ */
export const REPORT_REASONS: { value: string; label: string; note: string }[] = [
  {
    value: "copyright",
    label: "著作権の侵害",
    note: "他の人の絵をそのまま使っている、無断で転載している",
  },
  {
    value: "inappropriate",
    label: "不適切な内容",
    note: "暴力的・性的など、公開の場にふさわしくない",
  },
  {
    value: "spam",
    label: "スパム・宣伝",
    note: "作品ではなく宣伝や無関係な内容",
  },
  {
    value: "ai_undeclared",
    label: "AI生成の未申告",
    note: "生成AIを使っているのに AI 部門で投稿していない",
  },
  {
    value: "other",
    label: "その他",
    // DB の CHECK が detail を必須にしている
    note: "上に当てはまらないもの。何が問題かを書いてください（必須）",
  },
];

export type ReportResult = {
  report_id: number;
  accepted: boolean;
};

export async function callCreateReport(input: {
  workId: string;
  reason: string;
  detail: string | null;
}): Promise<ReportResult> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_report", {
    p_work_id: input.workId,
    p_reason: input.reason,
    p_detail: input.detail,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as ReportResult;
}
