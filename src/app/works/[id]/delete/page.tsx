import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/features/auth/session";
import { fetchMyWork, fetchWorkDetail, workImageUrl } from "@/features/work/rpc";
import type { MyWork } from "@/features/work/types";
import { deleteWorkAction } from "../actions";
import { SubmitButton } from "@/app/_pending";
import Image from "next/image";
import { field, surface } from "@/app/_surface";

/**
 * /works/[id]/delete ／ 削除の確認画面。
 *
 * 【なぜ確認画面を挟むのか】
 *   削除は取り返しがつきにくい。ボタン1つだと、押し間違いや
 *   「非公開にするつもりだった」という取り違えで消えてしまう。
 *   **作品タイトルの再入力**を求めることで、消す対象を目で確かめる
 *   一手を必ず通す。
 *
 * 【何が消えて、何が残るか】
 *   画面にそのまま書く。「消える」とだけ言われても、回答やいいねが
 *   どうなるのかが分からないと判断できない。
 *
 * 【自分の作品しか開けない】
 *   get_my_work は他人の作品IDに null を返す。公開・非公開のどちらでも
 *   本人なら取れるので、この画面は本人専用になる。
 */

export const metadata = {
  title: "作品を削除する",
};

export default async function DeleteWorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const user = await getCurrentUser();
  if (!user || user.is_anonymous) notFound();

  const work: MyWork | null = await fetchMyWork(id);
  if (!work) notFound();

  if (work.deleted_at) {
    return (
      <main className="mx-auto w-full max-w-lg space-y-6 p-6 sm:p-10">
        <h1 className="text-2xl font-bold">この作品は削除済みです</h1>
        <div className={surface}>
          <p className="text-sm">
            「{work.title}」はすでに削除されています。ほかの人からは見えません。
          </p>
        </div>
        <Link href="/works" className="text-sm underline">
          作品一覧へ
        </Link>
      </main>
    );
  }

  // 公開中かどうかで、消える範囲の説明を変える
  const isPublic = (await fetchWorkDetail(id)) !== null;

  return (
    <main className="mx-auto w-full max-w-lg space-y-6 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">作品を削除する</h1>
        <p className="text-sm text-faint">
          この操作は元に戻せません。
        </p>
      </header>

      {error ? (
        <p className="rounded-xl bg-danger-tint/10 px-4 py-3 text-sm whitespace-pre-wrap text-danger">
          {error}
        </p>
      ) : null}

      {/* --- 何を消そうとしているか ------------------------------------------- */}
      <section className={`${surface} space-y-4`}>
        <div className="flex items-start gap-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-sunken">
            <Image
              src={workImageUrl(work.image_path)}
              alt={work.title}
              width={work.image_width}
              height={work.image_height}
              className="h-20 w-20 object-cover"
              sizes="80px"
            />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-bold">{work.title}</p>
            <p className="text-xs text-faint">
              {isPublic ? "公開中" : "下書き"}・回答 {work.answers_count}・いいね{" "}
              {work.likes_count}
            </p>
          </div>
        </div>
      </section>

      {/* --- 何が起きるか ----------------------------------------------------- */}
      <section className={`${surface} space-y-3 text-sm`}>
        <div className="space-y-1">
          <p className="font-bold">削除するとどうなるか</p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>作品一覧・ランキング・他の人のお気に入りから消えます</li>
            <li>この作品のページは、ほかの人には「見つかりません」になります</li>
            <li>
              画像ファイルも削除されます。
              <strong>
                ただし、すでに表示されたことのある画像は、配信の仕組みの都合で
                最大1時間ほど見えたままになることがあります
              </strong>
            </li>
            <li>
              <strong>もう一度公開することはできません。</strong>
              同じお題で描き直すこともできません（1つのお題から作れる作品は1件）
            </li>
          </ul>
        </div>

        <div className="space-y-1 border-t border-ink/10 pt-3">
          <p className="font-bold">消えないもの</p>
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>これまでにこの作品へ寄せられた回答の記録（集計に残ります）</li>
            <li>あなたの成績や、ほかの作品</li>
          </ul>
        </div>

        <p className="text-xs text-faint">
          しばらく見せたくないだけなら、削除ではなく
          <Link href={`/works/${work.id}`} className="mx-1 underline">
            下書きに戻す
          </Link>
          を選んでください。こちらはいつでも公開に戻せます。
        </p>
      </section>

      {/* --- 確認して削除 ----------------------------------------------------- */}
      <form action={deleteWorkAction} className={`${surface} space-y-4`}>
        <input type="hidden" name="workId" value={work.id} />
        <input type="hidden" name="expectedTitle" value={work.title} />

        <label className="block space-y-1">
          <span className="block text-sm">
            確認のため、作品タイトル「<strong>{work.title}</strong>」を入力してください
          </span>
          <input
            type="text"
            name="confirmTitle"
            required
            autoComplete="off"
            className={field}
          />
        </label>

        <SubmitButton
          pendingLabel="削除しています…"
          className="w-full rounded-xl bg-danger-solid px-5 py-3 text-sm font-bold text-on-danger hover:opacity-85"
        >
          この作品を削除する
        </SubmitButton>

        <p className="text-center text-sm">
          <Link href={`/works/${work.id}`} className="underline">
            やめる
          </Link>
        </p>
      </form>
    </main>
  );
}
