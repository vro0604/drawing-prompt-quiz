import Link from "next/link";
import { getCurrentUser } from "@/features/auth/session";
import { fetchMyPrompt, fetchPromptTimer } from "@/features/draft/rpc";
import { fetchProductionTime } from "@/features/work/rpc";
import { formatDuration } from "@/features/draft/types";
import { TimerBox } from "@/app/prompt/[id]/_timer";
import { WorkForm } from "./_form";
import { noticeError, surface } from "@/app/_surface";
import { requireConsent } from "@/features/consent/rpc";

/**
 * /works/new ／ 作品を投稿する画面。
 *
 * 【入口はお題】
 *   ?promptId=... が必ず要る。作品は「どのお題から生まれたか」と
 *   1対1で結びつくため（works.prompt_id の UNIQUE。A11 / D17）。
 *   お題のないところから作品だけを作ることはできない。
 *
 * 【他人のお題IDを入れたら】
 *   get_my_prompt が null を返すので「見つかりません」になる。
 *   「権限がありません」とは言わない。存在するかどうかを教えないため（D40）。
 *
 * 【ここでの確認は親切であって守りではない】
 *   登録済みか・お題の持ち主か・そのお題がまだ使えるかは、
 *   すべて create_work（D27 の6検査）が最終的に判定する。
 *   この画面が見せているのは、投稿ボタンを押す前に分かることだけ。
 *
 * Next.js 16 では searchParams が Promise なので await が必要。
 */

export const metadata = {
  title: "作品を投稿する",
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">作品を投稿する</h1>
        <p className="text-sm text-faint">
          描いた絵と、引いたお題を結びつけます。見た人は絵だけを見てお題を当てます。
        </p>
      </header>
      {children}
    </main>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={`${surface} space-y-3`}>
      <h2 className="text-sm font-bold">{title}</h2>
      <div className="space-y-2 text-sm text-muted">{children}</div>
    </div>
  );
}

export default async function NewWorkPage({
  searchParams,
}: {
  searchParams: Promise<{ promptId?: string; error?: string }>;
}) {
  // 未同意の登録者をここで止める（P5）。**判定は DB の consent_status()。**
  // 止めるのは、そのセッションが関門より後に始まっていて、かつ未同意のときだけ。
  await requireConsent();

  const { promptId, error } = await searchParams;

  const errorBox = error ? (
    <p className={noticeError}>
      {error}
    </p>
  ) : null;

  // --- お題が指定されていない -------------------------------------------------
  if (!promptId) {
    return (
      <Shell>
        {errorBox}
        <Notice title="どのお題の作品かが分かりません">
          <p>投稿はお題の画面から始めてください。</p>
          <p>
            <Link href="/play" className="underline">
              お題を引く画面へ
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // --- 誰として来ているか ----------------------------------------------------
  //
  // 未サインインのまま get_my_prompt を呼ぶと permission denied になる
  // （anon には実行権限が無い）。呼ぶ前に分ける。
  const user = await getCurrentUser();

  if (!user) {
    return (
      <Shell>
        {errorBox}
        <Notice title="サインインが必要です">
          <p>作品の投稿にはアカウントが必要です。</p>
          <p>
            <Link href="/account" className="underline">
              アカウントの画面へ
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  if (user.is_anonymous) {
    return (
      <Shell>
        {errorBox}
        <Notice title="投稿にはアカウント登録が必要です">
          <p>
            ゲストのままお題を引くことはできますが、作品の投稿はできません（spec C3）。
          </p>
          <p>
            いまのゲストのまま登録すれば <strong>同じアカウントのまま</strong> 続けられ、
            引いたお題もそのまま使えます。
          </p>
          <p>
            <Link href="/account" className="underline">
              アカウントを登録する
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // 【規約への同意は、ここでは確かめない（P5）】
  //   同意は登録のときに済ませる。未同意の登録者は、このページの入口の
  //   requireConsent() が /consent へ送るので、そもそもここへ来ない。
  //   守りは変わらず works の門番（app_guard_works）が持っている。

  // --- お題を読む ------------------------------------------------------------
  const prompt = await fetchMyPrompt(promptId);

  if (!prompt) {
    return (
      <Shell>
        {errorBox}
        <Notice title="そのお題は見つかりません">
          <p>URL が間違っているか、自分が引いたお題ではありません。</p>
          <p>
            <Link href="/play" className="underline">
              お題を引く画面へ
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  if (prompt.work_id) {
    return (
      <Shell>
        <Notice title="このお題ではもう投稿しています">
          <p>1つのお題から作れる作品は1件までです（A11 / D17）。</p>
          <p>
            <Link href={`/works/${prompt.work_id}`} className="underline">
              投稿した作品を見る
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // 猶予を使い切った挑戦（D163）。**作品や記録が消えたわけではない**ことを書く。
  // ここを「状態: failed」とだけ出すと、何かを失ったように読める。
  if (prompt.status === "failed") {
    return (
      <Shell>
        <Notice title="この挑戦は時間切れで終了しました">
          <p>
            制作時間を延ばさないまま猶予を過ぎたため、このお題では投稿できません。
            描いた絵も、これまでの作品や記録も消えていません。
          </p>
          <p>
            <Link href="/play" className="underline">
              新しいお題を引く
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // 「このお題は描かない」を押したお題（D171）。**状態の英字をそのまま出さない。**
  // 自分で押した操作なので、何をしたからこうなったのかを書けば意味が通る。
  if (prompt.status === "abandoned") {
    return (
      <Shell>
        <Notice title="このお題は「描かない」を選んでいます">
          <p>
            このお題では投稿できません。引かなかったカードは、お題の画面で
            見られます。
          </p>
          <p>
            <Link href={`/prompt/${prompt.id}`} className="underline">
              お題の画面へ
            </Link>
          </p>
          <p>
            <Link href="/play" className="underline">
              新しいお題を引く
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  if (prompt.status !== "active") {
    return (
      <Shell>
        <Notice title="このお題はもう使えません">
          <p>状態: {prompt.status}</p>
          <p>
            <Link href="/play" className="underline">
              新しいお題を引く
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // 投稿の画面でも時計は止まらない（D163）。
  const timer = await fetchPromptTimer(promptId);

  // 制作時間は自己申告ではなく計測値を出す（2026-09-09）。
  // ここで読んだ値を、フォームは**表示するだけ**で送信しない
  const production = await fetchProductionTime(promptId);

  // 【予定終了時刻を過ぎているだけなら、フォームは出す（2026-09-09）】
  //   超過は失敗ではない。投稿もできる。
  //   出さないのは、長い放置で自動破棄されたときだけ。
  //   **status を待たない。**status が 'discarded' になるのは掃除が回ったあとで、
  //   それまでの間もこのお題では投稿できない（投稿の受け口が断る）。
  if (timer?.is_discarded) {
    return (
      <Shell>
        <Notice title="この制作は自動的に破棄されました">
          <p>
            2日間操作がなかったため、制作途中のお題を自動的に破棄しました。
            描いた絵も、これまでの作品や記録も消えていません。
          </p>
          <p>
            <Link href="/play" className="underline">
              新しいお題を引く
            </Link>
          </p>
        </Notice>
      </Shell>
    );
  }

  // --- 投稿フォーム ----------------------------------------------------------
  return (
    <Shell>
      {errorBox}

      {timer ? <TimerBox promptId={promptId} timer={timer} /> : null}

      {/* 何を描いたはずかを手元で確認できるように、答えを並べておく。
          この情報が外へ出ないのは get_my_prompt が本人にしか返さないから。 */}
      <section className={`${surface} space-y-4`}>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-sm font-bold">{prompt.mode_label}のお題</h2>
          <span className="text-xs text-faint">
            制作時間 {formatDuration(prompt.time_limit_seconds)}
          </span>
        </div>
        <ul className="flex flex-wrap gap-2">
          {prompt.cards.map((c) => (
            <li
              key={c.card_slot_key}
              className="rounded-lg bg-hover px-3 py-1.5 text-xs"
            >
              <span className="text-faint">{c.card_slot_label}</span>{" "}
              <span className="font-bold">{c.tag_label}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-faint">
          この一覧は自分にしか見えません。投稿した作品のページには出ません。
        </p>
      </section>

      {/* 規約への同意はここでは求めない。登録のときに済んでいる（P5）。
          未同意の登録者は、このページの入口（requireConsent）で /consent へ送られる。 */}
      <WorkForm promptId={promptId} production={production} />

      <footer className="border-t border-ink/10 pt-6 text-xs text-faint">
        <Link href={`/prompt/${promptId}`} className="underline">
          お題の画面へ戻る
        </Link>
      </footer>
    </Shell>
  );
}
