import Link from "next/link";
import { surface } from "@/app/_surface";
import { getCurrentUser } from "@/features/auth/session";
import { fetchUnseenResultWorks } from "@/features/notice/rpc";
import { workImageUrl } from "@/features/work/rpc";

/**
 * /notices ／ 回答の知らせ（D192）。
 *
 * 【何が並ぶか】
 *   回答が来ていて、その結果をまだ開いていない**作品**が並ぶ。
 *   回答1件ごとの行にはしない。1つの作品に何件来ていても1行。
 *   出所: ユーザー指示（2026-09-10）「未確認回答の存在する『作品』を
 *   一覧にする。回答1件を通知1件として並べない。」
 *
 * 【数字を出していない】
 *   何件来たかは書かない。運んでもいない
 *   （list_unseen_result_works は件数を返さない）。
 *   出所: ユーザー指示（2026-09-10）「この一覧では原則として
 *   回答人数を表示しない。」
 *
 *   数は、押した先の結果画面で初めて出る。そこが D112 の
 *   「取りに行った人にだけ出す」場所で、封を切る一瞬でもある。
 *
 * 【新しい結果画面を作っていない】
 *   押すと既存の作品ページの結果へ直接行く。
 *   出所: ユーザー指示（2026-09-10）「既存D112の結果UIを再利用し、
 *   新しい結果画面を作らない。」
 *
 * 【ここを開いても確認済みにはならない】
 *   一覧を見ただけでは、まだ結果を見ていない。確認済みになるのは
 *   作品ページで結果が開いたときだけ（open_my_work_result）。
 */

export const metadata = {
  title: "知らせ",
};

export default async function NoticesPage() {
  const user = await getCurrentUser();

  // 未サインインには、そもそも自分の作品が無い。
  // ゲスト（登録前）は作品を持てるので、ここでは弾かない。
  if (user === null) {
    return (
      <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
        <h1 className="text-2xl font-bold">知らせ</h1>
        <div className={surface}>
          <p className="text-sm">
            自分の作品に回答が届くと、ここに出ます。
          </p>
          <p className="pt-3 text-sm">
            <Link href="/account" className="underline">
              アカウントの画面へ
            </Link>
          </p>
        </div>
      </main>
    );
  }

  const works = await fetchUnseenResultWorks();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <h1 className="text-2xl font-bold">知らせ</h1>

      {works.length === 0 ? (
        <div className={surface} data-testid="notice-empty">
          <p className="text-sm">まだ確認していない回答はありません。</p>
          <p className="pt-3 text-sm text-faint">
            自分の作品に誰かが答えると、ここに出ます。
          </p>
        </div>
      ) : (
        <ul className="space-y-3" data-testid="notice-list">
          {works.map((w) => (
            <li key={w.work_id} data-notice-work={w.work_id}>
              {/*
                行き先は既存の作品ページの結果。**新しい画面は作らない。**
                Link ではなく a を使うのは、先読みで開いてもいないのに
                「結果を見た」ことにならないようにするため。
                記録は開いた先の描画で行われる（D192）。
              */}
              <a
                href={`/works/${w.work_id}?result=open`}
                className={`${surface} flex items-center gap-4 hover:bg-hover`}
              >
                {/*
                  絵は目印として小さく置く。next/image を通さないのは、
                  ここが「どの作品か」を見分けるためだけの場所で、
                  一覧の見栄えを作る場所ではないため。
                */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={workImageUrl(w.image_path)}
                  alt=""
                  width={64}
                  height={64}
                  className="size-16 shrink-0 rounded-lg object-cover"
                />
                <span className="min-w-0 space-y-1">
                  <span className="block text-sm font-bold">
                    あなたの作品に回答が届いています
                  </span>
                  <span className="block truncate text-sm text-muted">{w.title}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
