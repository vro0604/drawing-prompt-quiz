import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/app/_pending";
import { requireAdminPage } from "@/features/admin/auth";
import { adminError, fetchAdminReport } from "@/features/admin/rpc";
import {
  DIVISION_LABEL,
  REPORT_REASON_LABEL,
  REPORT_STATUS_LABEL,
  REVIEW_STATUS_LABEL,
  type AdminReportDetail,
} from "@/features/admin/types";
import { workImageUrl } from "@/features/work/rpc";
import { formatDateTime } from "@/lib/datetime";
import {
  btnDanger,
  btnSecondary,
  field,
  noticeError,
  noticeMuted,
  noticeSuccess,
  surface,
} from "@/app/_surface";
import { hideWorkAction, rejectReportAction, resolveReportAction } from "./actions";

/**
 * /admin/reports/[id] ／ 判断する画面。
 *
 * 【ここが主画面】
 *   通報1件と、対象の作品と、同じ作品への他の通報を1画面に置く。
 *   一覧からは開くことしかできないので、判断は必ずここを通る。
 *
 * 【操作は3つ。混ぜない】
 *   1. 作品を非表示にする … 作品だけが変わる。通報は開いたまま
 *   2. 通報を対応済みにする … 通報だけが変わる。作品はそのまま
 *   3. 通報を却下する … 通報だけが変わる。作品はそのまま
 *
 *   問題投稿だったときは 1 → 2 の順に2回押す。
 *   通報に理由が無かったときは 3 だけを押す。
 *   判断が付かないときは何も押さない（v0 では「確認中」を作らない）。
 *
 * 【非表示は削除ではない】
 *   画像は消えない。行も消えない。この画面の言葉も「非表示」で統一し、
 *   「削除」とは書かない。
 */

/** リクエストごとに描く。理由は src/app/admin/layout.tsx を参照 */
export const dynamic = "force-dynamic";

export const metadata = { title: "通報の詳細" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <dt className="w-28 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

export default async function AdminReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  await requireAdminPage();

  const { id } = await params;
  const { error, done } = await searchParams;

  const reportId = Number.parseInt(id, 10);
  if (!Number.isSafeInteger(reportId) || reportId <= 0) notFound();

  let data: AdminReportDetail | null = null;
  let failure: string | null = null;

  try {
    data = await fetchAdminReport(reportId);
  } catch (e) {
    const err = adminError(e);
    if (err.kind === "not_found") notFound();
    failure = err.code ? `[${err.code}] ${err.message}` : err.message;
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Link href="/admin/reports" className="text-sm underline">
          ← 通報の一覧へ
        </Link>
        <p className={noticeError}>{failure}</p>
      </div>
    );
  }

  const { report, work, author, same_work_reports, same_work_open_count } = data;
  const closed = report.status === "resolved" || report.status === "rejected";
  const hidden = work.review_status === "hidden";

  return (
    <div className="space-y-6">
      <Link href="/admin/reports" className="text-sm underline">
        ← 通報の一覧へ
      </Link>

      {done ? <p className={noticeSuccess} data-done="1">{done}</p> : null}
      {error ? <p className={noticeError} data-error="1">{error}</p> : null}

      {/* --- 通報 --------------------------------------------------------- */}
      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">
          通報 #{report.report_id}
          <span className="ml-2 font-normal text-faint" data-report-status={report.status}>
            {REPORT_STATUS_LABEL[report.status]}
          </span>
        </h2>
        <dl className="space-y-2">
          <Row label="理由">{REPORT_REASON_LABEL[report.reason]}</Row>
          <Row label="補足">
            {report.detail ? (
              <span className="whitespace-pre-wrap">{report.detail}</span>
            ) : (
              <span className="text-faint">なし</span>
            )}
          </Row>
          <Row label="受け付け">{formatDateTime(report.created_at)}</Row>
          {report.resolved_at ? (
            <Row label="閉じた日時">{formatDateTime(report.resolved_at)}</Row>
          ) : null}
        </dl>
        <p className="text-xs text-faint">
          通報した人が誰かは、この画面には出しません（当事者にも運営の画面にも
          出さない決まりです）。下げるか却下するかの判断には要りません。
        </p>
      </section>

      {/* --- 対象の作品 --------------------------------------------------- */}
      <section className={`${surface} space-y-4`}>
        <h2 className="text-sm font-bold">対象の作品</h2>

        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="relative aspect-square w-full max-w-56 shrink-0 overflow-hidden rounded-xl bg-sunken">
            {work.image_path ? (
              <Image
                src={workImageUrl(work.image_path)}
                alt=""
                fill
                sizes="224px"
                className="object-contain"
                unoptimized
              />
            ) : (
              <span className="flex size-full items-center justify-center text-xs text-faint">
                画像なし
              </span>
            )}
          </div>

          <dl className="min-w-0 flex-1 space-y-2">
            <Row label="題名">{work.title ?? "（題名なし）"}</Row>
            <Row label="部門">
              {DIVISION_LABEL[work.division]}
              {work.source_title ? `（原作: ${work.source_title}）` : ""}
            </Row>
            <Row label="作者">
              {author ? (
                author.handle ? (
                  <Link href={`/u/${author.handle}`} className="underline">
                    {author.display_name}（{author.handle}）
                  </Link>
                ) : (
                  author.display_name
                )
              ) : (
                <span className="text-faint">退会済み（作品の持ち主が外れています）</span>
              )}
            </Row>
            <Row label="投稿">{formatDateTime(work.created_at)}</Row>
            <Row label="回答数">{work.answers_count}</Row>
            <Row label="いまの状態">
              <span data-review-status={work.review_status}>
                {REVIEW_STATUS_LABEL[work.review_status]}
              </span>
              {work.is_published ? "" : " ／ 本人が下書きに戻しています"}
              {work.is_deleted ? " ／ 本人が削除済み" : ""}
            </Row>
            <Row label="公開ページ">
              <Link href={`/works/${work.work_id}`} className="underline">
                /works/{work.work_id}
              </Link>
            </Row>
          </dl>
        </div>

        <p className={noticeMuted}>
          非表示にしても、画像そのものは消えません。作品の行も、答えた人の回答も
          残ります。消えるのは一覧・詳細・出題・ランキングからの表示だけで、
          あとから戻せます。画像の消去はこの画面では行いません。
        </p>
      </section>

      {/* --- 同じ作品への他の通報 ------------------------------------------ */}
      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">
          同じ作品への他の通報（未処理 {same_work_open_count} 件）
        </h2>
        {same_work_reports.length === 0 ? (
          <p className="text-sm text-faint">ほかにはありません。</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {same_work_reports.map((r) => (
              <li key={r.report_id}>
                <Link href={`/admin/reports/${r.report_id}`} className="underline">
                  #{r.report_id}
                </Link>{" "}
                {REPORT_REASON_LABEL[r.reason]} ／ {REPORT_STATUS_LABEL[r.status]} ／{" "}
                {formatDateTime(r.created_at)}
                {r.detail ? (
                  <span className="block text-xs text-faint whitespace-pre-wrap">
                    {r.detail}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- 操作1: 作品を非表示にする ------------------------------------- */}
      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">作品を非表示にする</h2>
        <p className="text-xs text-faint">
          公開されている場所から消えます。作品の行も画像も残ります。
          通報の状態はここでは変わりません。
        </p>

        {hidden ? (
          <p className={noticeMuted}>この作品はすでに非表示です。</p>
        ) : (
          <form action={hideWorkAction} className="space-y-3">
            <input type="hidden" name="reportId" value={String(report.report_id)} />
            <input type="hidden" name="workId" value={work.work_id} />

            <label className="block space-y-1">
              <span className="text-xs text-faint">理由（必須。記録に残ります）</span>
              <textarea
                name="reason"
                required
                maxLength={1000}
                rows={2}
                className={field}
                placeholder="例: 他人の絵の無断転載であることを確認した"
              />
            </label>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="confirm"
                value="yes"
                required
                className="mt-1"
                data-confirm-hide="1"
              />
              <span>
                この作品を公開から外すことを確認しました（作者には
                「運営の審査により表示を止めています」と表示されます）
              </span>
            </label>

            <SubmitButton
              className={btnDanger}
              pendingLabel="非表示にしています…"
              data={{ "data-action": "hide-work" }}
            >
              作品を非表示にする
            </SubmitButton>
          </form>
        )}
      </section>

      {/* --- 操作2・3: 通報を閉じる ---------------------------------------- */}
      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">通報を閉じる</h2>

        {closed ? (
          <p className={noticeMuted}>
            この通報はすでに閉じています（{REPORT_STATUS_LABEL[report.status]}）。
            開き直す経路はありません。
          </p>
        ) : (
          <form action={resolveReportAction} className="space-y-3">
            <input type="hidden" name="reportId" value={String(report.report_id)} />

            <label className="block space-y-1">
              <span className="text-xs text-faint">理由（必須。記録に残ります）</span>
              <textarea
                name="reason"
                required
                maxLength={1000}
                rows={2}
                className={field}
                placeholder="例: 作品を非表示にした ／ 通報の内容に当たらなかった"
              />
            </label>

            <div className="flex flex-wrap gap-3">
              <SubmitButton
                className={btnDanger}
                pendingLabel="閉じています…"
                data={{ "data-action": "resolve-report" }}
              >
                対応済みにする
              </SubmitButton>
              <SubmitButton
                formAction={rejectReportAction}
                className={btnSecondary}
                pendingLabel="閉じています…"
                data={{ "data-action": "reject-report" }}
              >
                却下する
              </SubmitButton>
            </div>

            <p className="text-xs text-faint">
              「対応済み」は手を打ったとき、「却下」は通報に理由が無かったとき。
              どちらも作品そのものは変えません。
            </p>
          </form>
        )}
      </section>
    </div>
  );
}
