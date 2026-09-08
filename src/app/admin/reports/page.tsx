import Link from "next/link";
import Image from "next/image";
import { requireAdminPage } from "@/features/admin/auth";
import { adminError, fetchAdminReports } from "@/features/admin/rpc";
import {
  DIVISION_LABEL,
  REPORT_REASON_LABEL,
  REPORT_STATUS_LABEL,
  REVIEW_STATUS_LABEL,
  type AdminReportList,
} from "@/features/admin/types";
import { workImageUrl } from "@/features/work/rpc";
import { formatDateTime } from "@/lib/datetime";
import { noticeError, noticeMuted, surface, tabOff, tabOn } from "@/app/_surface";

/**
 * /admin/reports ／ 通報の一覧。
 *
 * 【この画面からは何も変えられない】
 *   開く以外に押せるものを置かない。一覧に「非表示」ボタンを並べると、
 *   **作品を見ないまま下げられる。**判断は必ず詳細画面で行う。
 *
 * 【全件を出さない】
 *   admin_list_reports が limit / offset で区切る。既定は20件。
 *
 * 【出していないもの】
 *   通報者が誰かは出さない（RPC が返さない）。
 *   下げるか却下するかの判断に、通報者が誰かは要らない。
 */

const PER_PAGE = 20;

const TABS: { key: string; label: string }[] = [
  { key: "open", label: "未処理" },
  { key: "resolved", label: "対応済み" },
  { key: "rejected", label: "却下" },
  { key: "all", label: "すべて" },
];

/** リクエストごとに描く。理由は src/app/admin/layout.tsx を参照 */
export const dynamic = "force-dynamic";

export const metadata = { title: "通報" };

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; offset?: string }>;
}) {
  await requireAdminPage();

  const sp = await searchParams;
  const status = TABS.some((t) => t.key === sp.status) ? sp.status! : "open";
  const offset = Math.max(0, Number.parseInt(sp.offset ?? "0", 10) || 0);

  let list: AdminReportList | null = null;
  let failure: string | null = null;

  try {
    list = await fetchAdminReports({ status, limit: PER_PAGE, offset });
  } catch (e) {
    const err = adminError(e);
    failure = err.code ? `[${err.code}] ${err.message}` : err.message;
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-xl font-bold">通報</h1>
        <p className="text-xs text-faint">
          作品を下げるか、通報を閉じるかは、1件ずつ開いて決めます。
        </p>
      </header>

      <nav className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/admin/reports?status=${t.key}`}
            className={t.key === status ? tabOn : tabOff}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {failure ? <p className={noticeError}>{failure}</p> : null}

      {list ? (
        <>
          <p className="text-xs text-faint">
            {list.total} 件中 {list.rows.length === 0 ? 0 : offset + 1} –{" "}
            {offset + list.rows.length} 件
          </p>

          {list.rows.length === 0 ? (
            <p className={noticeMuted}>この状態の通報はありません。</p>
          ) : (
            <ul className="space-y-3">
              {list.rows.map((r) => (
                <li key={r.report_id}>
                  <Link
                    href={`/admin/reports/${r.report_id}`}
                    className={`${surface} flex gap-4 hover:bg-hover`}
                    data-report-id={String(r.report_id)}
                  >
                    <div className="relative size-20 shrink-0 overflow-hidden rounded-xl bg-sunken">
                      {r.work.image_path ? (
                        <Image
                          src={workImageUrl(r.work.image_path)}
                          alt=""
                          fill
                          sizes="80px"
                          className="object-cover"
                          unoptimized
                        />
                      ) : (
                        <span className="flex size-full items-center justify-center text-[10px] text-faint">
                          画像なし
                        </span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-bold">
                        {REPORT_REASON_LABEL[r.reason]}
                        <span className="ml-2 text-xs font-normal text-faint">
                          {REPORT_STATUS_LABEL[r.status]}
                        </span>
                      </p>
                      <p className="truncate text-sm">
                        {r.work.title ?? "（題名なし）"}
                        <span className="ml-2 text-xs text-faint">
                          {DIVISION_LABEL[r.work.division]}
                        </span>
                      </p>
                      <p className="text-xs text-faint">
                        {formatDateTime(r.created_at)} ／ 作者{" "}
                        {r.author
                          ? (r.author.handle ?? r.author.display_name)
                          : "（退会済み）"}
                      </p>
                      <p className="text-xs text-faint">
                        作品の状態: {REVIEW_STATUS_LABEL[r.work.review_status]}
                        {r.work.is_deleted ? "（本人が削除済み）" : ""} ／ この作品への未処理の通報{" "}
                        <span data-open-count={String(r.open_reports_for_work)}>
                          {r.open_reports_for_work}
                        </span>{" "}
                        件
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <nav className="flex justify-between text-sm">
            {offset > 0 ? (
              <Link
                href={`/admin/reports?status=${status}&offset=${Math.max(0, offset - PER_PAGE)}`}
                className="underline"
              >
                前の {PER_PAGE} 件
              </Link>
            ) : (
              <span />
            )}
            {offset + list.rows.length < list.total ? (
              <Link
                href={`/admin/reports?status=${status}&offset=${offset + PER_PAGE}`}
                className="underline"
              >
                次の {PER_PAGE} 件
              </Link>
            ) : (
              <span />
            )}
          </nav>
        </>
      ) : null}
    </div>
  );
}
