/**
 * 管理画面が受け取る形。**DB の列をそのまま写したものではない。**
 *
 * 返ってこない（返させない）ものを、ここで名前ごと落としてある。
 *   ・reporter_id  … 誰が通報したかは当事者にも運営の画面にも出さない
 *                    （reports の表コメント）。下げるか却下するかの判断に要らない
 *   ・prompt_id    … D23。管理画面も例外にしない
 *   ・answer_items / prompt_cards … 機密。モデレーションの判断に要らない
 */

/** 通報の状態。reports_status_valid（CHECK）と同じ4つ */
export type ReportStatus = "open" | "reviewing" | "resolved" | "rejected";

/** 通報の理由。reports_reason_valid（CHECK）と同じ5つ */
export type ReportReason =
  | "copyright"
  | "inappropriate"
  | "spam"
  | "ai_undeclared"
  | "other";

/** 作品の審査状態。works_review_status_valid（CHECK）と同じ3つ */
export type ReviewStatus = "ok" | "flagged" | "hidden";

/** 一覧に出す作品の最小情報 */
export type AdminReportWork = {
  work_id: string;
  title: string | null;
  image_path: string | null;
  division: "original" | "fanart" | "ai";
  review_status: ReviewStatus;
  is_published: boolean;
  is_deleted: boolean;
};

/** 作者の識別に要る最小情報。メールアドレスは含まない */
export type AdminAuthor = {
  user_id: string;
  handle: string | null;
  display_name: string;
  is_anonymous?: boolean;
} | null;

/** 一覧の1行 */
export type AdminReportRow = {
  report_id: number;
  status: ReportStatus;
  reason: ReportReason;
  created_at: string;
  resolved_at: string | null;
  work: AdminReportWork;
  author: AdminAuthor;
  /** 同じ作品への未処理の通報が何件あるか */
  open_reports_for_work: number;
};

export type AdminReportList = {
  status: ReportStatus | "all";
  limit: number;
  offset: number;
  total: number;
  rows: AdminReportRow[];
};

/** 詳細画面が受け取るもの */
export type AdminReportDetail = {
  report: {
    report_id: number;
    status: ReportStatus;
    reason: ReportReason;
    detail: string | null;
    created_at: string;
    resolved_at: string | null;
  };
  work: {
    work_id: string;
    title: string | null;
    image_path: string | null;
    image_width: number | null;
    image_height: number | null;
    division: "original" | "fanart" | "ai";
    source_title: string | null;
    review_status: ReviewStatus;
    is_published: boolean;
    is_deleted: boolean;
    created_at: string;
    answers_count: number;
  };
  author: AdminAuthor;
  same_work_reports: {
    report_id: number;
    status: ReportStatus;
    reason: ReportReason;
    detail: string | null;
    created_at: string;
    resolved_at: string | null;
  }[];
  same_work_open_count: number;
};

export type AdminHideResult = {
  work_id: string;
  review_status: "hidden";
  previous: ReviewStatus;
  audit_id: number;
};

export type AdminResolveResult = {
  report_id: number;
  status: "resolved" | "rejected";
  previous: ReportStatus;
  resolved_at: string;
  audit_id: number;
};

/** 画面に出す通報理由の日本語。REPORT_REASONS と同じ並び */
export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  copyright: "著作権の侵害",
  inappropriate: "不適切な内容",
  spam: "スパム・宣伝",
  ai_undeclared: "AI生成の未申告",
  other: "その他",
};

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  open: "未処理",
  reviewing: "確認中",
  resolved: "対応済み",
  rejected: "却下",
};

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  ok: "公開中",
  flagged: "要確認",
  hidden: "運営が非表示",
};

export const DIVISION_LABEL: Record<"original" | "fanart" | "ai", string> = {
  original: "オリジナル",
  fanart: "ファンアート",
  ai: "AI生成",
};
