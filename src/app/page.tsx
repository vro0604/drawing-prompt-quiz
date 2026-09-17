import Link from "next/link";
import { NavButton } from "@/app/_pending";
import { btnPrimary, btnSecondary, surface } from "@/app/_surface";
import { HomeSteps } from "@/app/_home-steps";

/**
 * / ／ トップページ。
 *
 * 【なぜこの画面が要るか】
 *   ここは create-next-app の雛形のままだった。英語で
 *   「To get started, edit the page.tsx file.」と出て、リンク先は
 *   Vercel と Next.js の資料だけ。**サービスへの入口が1つも無かった。**
 *
 *   /works や /play は互いにリンクし合っているので、いったん中へ入れば
 *   動き回れる。問題は「最初の一歩が無い」ことで、URL を直接打てる人
 *   以外は何も始められない。退会したあとの案内先もここなので、
 *   最後に見る画面が雛形になってしまう（/account/deleted）。
 *
 * 【何を置くか（2026-09-18 に作り直した。docs/home-first-use.md）】
 *   初めて来た人が数秒で「何をするサービスか」「最初に何を押すか」
 *   「引く → 描く → 答える」の流れを読み取れること。文章で説明せず、
 *   問いかけ1行・動詞3つ・押せる3つの手順（_home-steps.tsx）で見せる。
 *
 *   もとは説明文の下に同じ幅のボタンが3つ並び、手順の説明（番号つきの箱3つ）は
 *   ボタンの下で、押せなかった。手順の文には、今は無い「お手軽（3枚）と標準（5枚）」が
 *   残っていた（/play のモードは「通常」「高難度」）。
 *
 * 【ゲストを最初に置く】
 *   このサービスの入口はゲスト（spec 11-1）。登録を先に見せると、
 *   いちばん人数の多い「とりあえず見に来た人」が引き返す。
 *   だから最初のボタンは「お題を引く」で、登録の案内は下に置く。
 *
 * 【ユーザーを作らない】
 *   この画面では匿名サインインをしない。開いただけで auth.users が
 *   増えると、見に来ただけの人が MAU に乗る（spec 11-1）。
 *   ゲストが発行されるのは、お題を引くなど実際に書き込む瞬間だけ。
 *
 * 【末尾に行き先を並べない】
 *   もとは末尾に「そのほかの入口」として、ランキング・作品一覧・利用規約・
 *   プライバシーポリシーの4つを並べていた。全ページにヘッダーとフッターが
 *   付いた（_shell.tsx）ことで、**4つとも同じ画面に二度出る**ようになったので
 *   外した（B-001 / PENDING 6）。行き先は減っていない。
 *   ランキングと作品はヘッダーに、規約とポリシーはフッターにある。
 *
 *   ここへ行き先を足したくなったら、まず _shell.tsx を見ること。
 *   この画面だけに要る導線でなければ、そちらに足すほうが全ページに効く。
 */

export const metadata = {
  // レイアウトの template は「%s ｜ つたわるかな」。
  // トップで使うと名前が二重になるので、ここだけ絶対指定にする。
  title: { absolute: "つたわるかな" },
};

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-2xl space-y-7 px-6 pt-6 pb-10 [word-break:auto-phrase] sm:space-y-10 sm:px-10 sm:pt-14">
      {/* --- 冒頭。何をするサービスかを、問いかけ1行と動詞3つで言い切る -----------

          【形の出どころ】Wordle（NYT Games）の入口。絵記号・名前・1文の説明・ボタンを
          中央に縦へ積み、説明は1文で止める。ここでは名前はヘッダーにあるので、
          いちばん大きい字を「問いかけ」に使う。長い説明文は置かない。 */}
      <header className="space-y-3 text-center text-balance">
        <h1 className="text-2xl leading-snug font-bold sm:text-4xl sm:leading-tight">
          あなたの絵、
          <br />
          何を描いたか伝わる？
        </h1>
        <p className="text-lg font-bold sm:text-xl">引いて、描いて、答える。</p>
        <p className="text-sm leading-6 text-muted">
          描く人と見る人で、何が伝わったかを確かめるお絵描きサービス。
        </p>
      </header>

      {/* --- 主役: 3つの手順。説明の図ではなく、押すとその手順の場所へ行く ------- */}
      <section className="space-y-3">
        <HomeSteps />
        <p className="text-center text-xs text-faint">
          答えが集まると、描いた人に「どう伝わったか」が分かります。
        </p>
      </section>

      {/* --- 最初の一手 ---------------------------------------------------------

          【主ボタンは1つだけ】最初にすることは「お題を引く」。
          答えるだけの人も隠さないので、枠だけの副ボタンを1つ横に置く（Wordle の Play / Log in と同じ重み付け）。
          「描いた絵で試す」はもう描いてある人向けの入口なので、ボタンにせず下の一行に下げる。
          どれもゲストのまま押せる。登録を求める位置（投稿の直前）は変えていない。 */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          {/* 行き先が動的ページで、開くまでに間がある。押した反応をその場で出す（_pending.tsx） */}
          <NavButton href="/play" pendingLabel="読み込み中…" className={`${btnPrimary} sm:min-w-56`}>
            お題を引く
          </NavButton>
          <NavButton href="/works" pendingLabel="読み込み中…" className={`${btnSecondary} sm:min-w-56`}>
            描かずに、絵に答える
          </NavButton>
        </div>
        <p className="text-center text-xs text-faint">
          登録なしで始められます。登録が要るのは作品を投稿するときだけです。
        </p>
        <p className="text-center text-sm">
          <Link href="/works/import" className="inline-flex min-h-11 items-center underline">
            描いた絵で試す
          </Link>
          <span className="block text-xs text-faint">お題を引かずに、もう描いてある絵を出す入口です。</span>
        </p>
      </div>

      {/* --- 登録すると何ができるか ------------------------------------------- */}
      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">アカウント登録でできること</h2>
        <ul className="space-y-2 text-sm text-muted">
          <li>・描いた作品を投稿する</li>
          <li>・いいね と お気に入り を付ける</li>
          <li>・自分のページ（公開プロフィール）を持つ</li>
        </ul>
        <p className="text-xs text-faint">
          ゲストのまま遊んでいる途中で登録しても、引いたお題はそのまま引き継がれます。
        </p>
        <p className="pt-1 text-sm">
          <Link href="/account" className="underline">
            アカウントの画面へ
          </Link>
        </p>
      </section>
    </main>
  );
}
