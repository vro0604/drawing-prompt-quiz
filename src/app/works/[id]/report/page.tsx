import Link from "next/link";
import { notFound } from "next/navigation";
import { REPORT_REASONS } from "@/features/report/rpc";
import { fetchWorkDetail } from "@/features/work/rpc";
import { createReportAction } from "../actions";
import { TURNSTILE_SITE_KEY, captchaEnabled } from "@/features/report/captcha";

/** Turnstile の widget を描くスクリプト */
const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";

/**
 * /works/[id]/report ／ 通報フォーム。
 *
 * 【公開されている作品にしか出さない】
 *   get_work_detail が null なら 404。下書きや削除済みの作品IDを
 *   打ち込んでも、この画面は開かない（存在を確かめる経路にしない。D40）。
 *
 * 【ゲストのまま送れる】
 *   通報は「見つけた人が知らせる」行為なので、登録は求めない（spec 8-4）。
 *   未サインインの場合は送信の瞬間にゲストが発行される。
 *
 * 【自作は通報できないようにはしていない】
 *   DB 側でも止めていない。自分の作品を報告したくなる場面
 *   （盗用された絵を自分が上げてしまったと気づいた等）があるため。
 */

export const metadata = {
  title: "作品を報告する",
};

const box =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

const input =
  "w-full rounded-xl border border-black/15 bg-transparent px-4 py-3 text-sm dark:border-white/20";

export default async function ReportWorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const work = await fetchWorkDetail(id);
  if (!work) notFound();

  return (
    <main className="mx-auto w-full max-w-lg space-y-6 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">この作品を報告する</h1>
        <p className="text-sm text-black/55 dark:text-white/55">
          「{work.title}」（{work.author.display_name} さん）について報告します。
        </p>
      </header>

      {error ? (
        <p className="rounded-xl bg-rose-500/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      <form action={createReportAction} className={`${box} space-y-5`}>
        <input type="hidden" name="workId" value={work.id} />

        <fieldset className="space-y-3">
          <legend className="text-sm font-bold">どの点が問題ですか</legend>
          {REPORT_REASONS.map((r, index) => (
            <label key={r.value} className="flex gap-3">
              <input
                type="radio"
                name="reason"
                value={r.value}
                required
                defaultChecked={index === 0}
                className="mt-1 size-4 shrink-0"
              />
              <span className="space-y-1">
                <span className="block text-sm">{r.label}</span>
                <span className="block text-xs text-black/45 dark:text-white/45">
                  {r.note}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="block space-y-1">
          <span className="block text-sm">
            内容（1000字まで。「その他」を選んだ場合は必須）
          </span>
          <textarea name="detail" maxLength={1000} rows={4} className={input} />
        </label>

        <p className="text-xs text-black/45 dark:text-white/45">
          同じ作品を何度も報告することはできません。
          報告した内容は運営だけが見ます。作者には通知されません。
        </p>

        {/* CAPTCHA（P6）。サイト鍵があるときだけ出す。
            script は widget を描くために要る。data-* だけで動くので、
            こちらから JavaScript を書く必要は無い。 */}
        {captchaEnabled() ? (
          <div className="space-y-2">
            <div className="cf-turnstile" data-sitekey={TURNSTILE_SITE_KEY} />
            <script src={TURNSTILE_SCRIPT} async defer />
            <p className="text-xs text-black/45 dark:text-white/45">
              自動での大量送信を防ぐための確認です。
            </p>
          </div>
        ) : null}

        <button
          type="submit"
          className="w-full rounded-xl bg-black px-5 py-3 text-sm font-bold text-white hover:opacity-85 dark:bg-white dark:text-black"
        >
          報告する
        </button>

        <p className="text-center text-sm">
          <Link href={`/works/${work.id}`} className="underline">
            やめる
          </Link>
        </p>
      </form>
    </main>
  );
}
