import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SubmitButton } from "@/app/_pending";
import { getCurrentUser } from "@/features/auth/session";
import { formatDuration } from "@/features/draft/types";
import { fetchMyAnswer, fetchWorkQuiz } from "@/features/quiz/rpc";
import type { MyAnswer, WorkQuiz } from "@/features/quiz/types";
import {
  fetchMyWork,
  fetchMyWorkResult,
  fetchWorkDetail,
  workImageUrl,
} from "@/features/work/rpc";
import {
  divisionLabel,
  formatActualTime,
  type MyWork,
  type MyWorkResult,
  type WorkDetail,
} from "@/features/work/types";
import { AnswerResult, AuthorNotice, MyResult, QuizForm, SlotStats } from "./_quiz";
import {
  publishWorkAction,
  toggleLikeAction,
  toggleSaveAction,
  unpublishWorkAction,
} from "./actions";
import { surface } from "@/app/_surface";

/**
 * /works/[id] ／ 作品1件。
 *
 * 【誰に何が見えるか】
 *
 *   作品の状態                    他人        本人
 *   ----------------------------  ----------  ------------------------
 *   公開・審査OK・未削除          見える      見える（＋公開設定の操作）
 *   下書き（is_published=false）  **404**     見える（下書きの印つき）
 *   審査で伏せた（hidden 等）     **404**     見える（理由つき）
 *   論理削除済み                  **404**     見える（削除済みの印つき）
 *
 * 【どうやってそれを保証しているか】
 *   この画面は判定をしていない。2本の RPC の結果をそのまま使う。
 *
 *     get_work_detail … 公開条件を満たす作品だけを返す。
 *                       満たさなければ null（「非公開です」とは言わない）
 *     get_my_work     … user_id = auth.uid() の行だけを返す。
 *                       他人のIDには null
 *
 *   両方 null なら 404。**存在しないIDと、他人の下書きの区別がつかない。**
 *   「非公開です」と返すと、そのIDが実在することを教えてしまうため（D40）。
 *
 * 【お題は出さない】
 *   この画面に prompt_id は届かない（D23）。答えは Step 10 のクイズで
 *   出題され、正解は submit_answer だけが返す。
 *
 * Next.js 16 では params / searchParams が Promise なので await が必要。
 */

/**
 * 共有カードの文言。
 *
 * **公開されている作品だけ**にタイトルを出す。get_work_detail は
 * 下書き・審査中・削除済みには null を返すので、本人以外はもちろん、
 * 本人が共有したときも下書きのタイトルは外へ出ない。
 *
 * **お題も答えもここには来ない**（D23）。
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const work = await fetchWorkDetail(id);

  if (!work) return { title: "作品" };

  const description = `${work.author.display_name} さんの作品。絵だけを見て、引かれたお題を当ててみてください。`;

  return {
    title: work.title,
    description,
    alternates: { canonical: `/works/${work.id}` },
    openGraph: {
      type: "article",
      title: work.title,
      description,
      url: `/works/${work.id}`,
    },
  };
}

/** 作品画像。幅と高さは投稿時に実物から数えた値（features/work/image.ts） */
function WorkImage({
  imagePath,
  width,
  height,
  title,
}: {
  imagePath: string;
  width: number;
  height: number;
  title: string;
}) {
  return (
    <Image
      src={workImageUrl(imagePath)}
      alt={title}
      width={width}
      height={height}
      // 実寸ではなく画面幅に合わせて縮める。縦横比は width / height から保たれる。
      className="h-auto w-full rounded-2xl border border-line"
      // 詳細ページの主役なので後回しにしない
      priority
      sizes="(max-width: 768px) 100vw, 768px"
    />
  );
}

/** 部門・時間・投稿日など、公開・非公開に関わらず同じ並びで出す */
function MetaList({
  division,
  sourceTitle,
  sourceCharacter,
  fanartNote,
  timeLimitSeconds,
  actualTimeSeconds,
  createdAt,
}: {
  division: string;
  sourceTitle: string | null;
  sourceCharacter: string | null;
  fanartNote: string | null;
  timeLimitSeconds: number | null;
  actualTimeSeconds: number | null;
  createdAt: string;
}) {
  const rows: { label: string; value: string }[] = [
    { label: "部門", value: divisionLabel(division) },
    { label: "お題の制作時間", value: formatDuration(timeLimitSeconds) },
    { label: "実制作時間（自己申告）", value: formatActualTime(actualTimeSeconds) },
    { label: "投稿日", value: new Date(createdAt).toLocaleString("ja-JP") },
  ];

  if (sourceTitle) rows.splice(1, 0, { label: "元作品", value: sourceTitle });
  if (sourceCharacter) rows.splice(2, 0, { label: "キャラクター", value: sourceCharacter });

  return (
    <div className={`${surface} space-y-4`}>
      <dl className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-4 text-sm">
            <dt className="w-40 shrink-0 text-faint">{r.label}</dt>
            <dd className="font-bold">{r.value}</dd>
          </div>
        ))}
      </dl>

      {fanartNote ? (
        <div className="space-y-1 border-t border-ink/10 pt-4">
          <p className="text-xs text-faint">補足</p>
          <p className="text-sm whitespace-pre-wrap">{fanartNote}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * いいね・保存。
 *
 * 【押せるのは登録ユーザーだけ（D7 / spec 10）】
 *   ゲストや未サインインにはボタンではなく案内を出す。
 *   人気ランキング（Step 13）を登録ユーザーのいいねだけで集計するためで、
 *   ゲストのままいくらでも押せると順位が意味を持たなくなる。
 *
 *   ここでの出し分けは親切であって守りではない。本当の判定は
 *   toggle_like / toggle_save が JWT で行う。
 *
 * 【状態は追加で問い合わせない】
 *   liked_by_me / saved_by_me と件数は get_work_detail が返している。
 *   get_my_reaction を別に呼ぶ必要はない。
 */
function Reactions({ work, canReact }: { work: WorkDetail; canReact: boolean }) {
  const base =
    "rounded-xl border px-5 py-3 text-sm font-bold transition hover:bg-hover";
  const on = "border-line-active bg-hover";
  const off = "border-line-mid";

  if (!canReact) {
    return (
      <div className={`${surface} space-y-2`}>
        <p className="text-sm">
          いいね {work.likes_count}・保存 {work.saves_count}
        </p>
        <p className="text-xs text-faint">
          いいねと保存にはアカウント登録が必要です。クイズの回答はゲストのままできます。
          <Link href="/account" className="pl-2 underline">
            アカウントの画面へ
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-3">
      <form action={toggleLikeAction}>
        <input type="hidden" name="workId" value={work.id} />
        <SubmitButton
          pendingLabel="送信中…"
          className={`${base} ${work.liked_by_me ? on : off}`}
        >
          {work.liked_by_me ? "いいね済み" : "いいね"} {work.likes_count}
        </SubmitButton>
      </form>

      <form action={toggleSaveAction}>
        <input type="hidden" name="workId" value={work.id} />
        <SubmitButton
          pendingLabel="送信中…"
          className={`${base} ${work.saved_by_me ? on : off}`}
        >
          {work.saved_by_me ? "保存済み" : "保存"} {work.saves_count}
        </SubmitButton>
      </form>
    </div>
  );
}

/** 公開されている作品の表示 */
function PublicView({
  work,
  quiz,
  myAnswer,
  canReact,
  result,
  resultOpen,
}: {
  work: WorkDetail;
  quiz: WorkQuiz | null;
  myAnswer: MyAnswer | null;
  canReact: boolean;
  result: MyWorkResult | null;
  resultOpen: boolean;
}) {
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-2xl font-bold break-words">{work.title}</h1>
        <p className="text-sm text-faint">
          {/* handle がある人だけ公開プロフィールを持つ（001 の SELECT ポリシー） */}
          {/* 1つの式にまとめているのは、隣り合う値の境目に React が
              <!-- --> を挟み、「@handle」が繋がった文字列でなくなるため */}
          {work.author.handle ? (
            <Link href={`/u/${work.author.handle}`} className="underline">
              {`${work.author.display_name}（@${work.author.handle}）`}
            </Link>
          ) : (
            work.author.display_name
          )}
          {work.is_author ? "・あなたの作品" : ""}
        </p>
      </header>

      <WorkImage
        imagePath={work.image_path}
        width={work.image_width}
        height={work.image_height}
        title={work.title}
      />

      <MetaList
        division={work.division}
        sourceTitle={work.source_title}
        sourceCharacter={work.source_character}
        fanartNote={work.fanart_note}
        timeLimitSeconds={work.time_limit_seconds}
        actualTimeSeconds={work.actual_time_seconds}
        createdAt={work.created_at}
      />

      <Reactions work={work} canReact={canReact} />

      {/* クイズ。出す形は3通りしかない。
            作者      → 回答できない案内（D28）
            回答済み  → 結果（ここで初めて正解が出る）
            それ以外  → 回答フォーム（正解を含まない） */}
      {quiz === null ? null : quiz.is_author ? (
        <AuthorNotice />
      ) : myAnswer ? (
        <AnswerResult answer={myAnswer} />
      ) : (
        <QuizForm quiz={quiz} />
      )}

      {/*
        **他人には項目別の伝達率を出さない**（D112）。
        「他人の作品ページ＝絵とタイトルだけ」と決めてあるのに、
        ここは誰にでも見えていた。仕様の取りこぼし。

        回答した人が自分の正誤を見るのは AnswerResult のほうで、
        そちらは変えていない。
      */}
      {result ? (
        <>
          <MyResult result={result} open={resultOpen} workId={work.id} />
          {resultOpen ? <SlotStats stats={work.slot_stats} /> : null}
        </>
      ) : null}

      {work.is_author ? (
        <div className="space-y-3 border-t border-ink/10 pt-6">
          <form action={unpublishWorkAction}>
            <input type="hidden" name="workId" value={work.id} />
            <SubmitButton
              pendingLabel="切り替えています…"
              className="rounded-xl border border-line-firm px-6 py-3 text-sm font-bold hover:bg-hover"
            >
              下書きに戻す（他の人から見えなくする）
            </SubmitButton>
          </form>
          <p className="text-xs text-faint">
            下書きに戻しても画像は残ります。いつでも公開に戻せます。
          </p>
          <p className="text-sm">
            {/* 削除は確認画面を挟む。ここから直接は消さない */}
            <Link
              href={`/works/${work.id}/delete`}
              className="text-danger underline"
            >
              この作品を削除する
            </Link>
          </p>
        </div>
      ) : (
        <p className="border-t border-ink/10 pt-6 text-xs">
          <Link
            href={`/works/${work.id}/report`}
            className="text-faint underline"
          >
            この作品を報告する
          </Link>
        </p>
      )}
    </>
  );
}

/** 本人にだけ見える作品（下書き・審査で伏せた・削除済み）の表示 */
function OwnerOnlyView({ work }: { work: MyWork }) {
  const reason = work.deleted_at
    ? "この作品は削除済みです。"
    : work.review_status !== "ok"
      ? `この作品は運営の審査により表示を止めています（${work.review_status}）。`
      : "この作品は下書きです。ほかの人からは、このURLを開いても存在しないのと同じ扱いになります。";

  return (
    <>
      <header className="space-y-2">
        <p className="text-xs font-bold tracking-wider text-notice">
          {work.is_published ? "本人にのみ表示" : "下書き"}
        </p>
        <h1 className="text-2xl font-bold break-words">{work.title}</h1>
        <p className="text-sm text-faint">{reason}</p>
      </header>

      <WorkImage
        imagePath={work.image_path}
        width={work.image_width}
        height={work.image_height}
        title={work.title}
      />

      <MetaList
        division={work.division}
        sourceTitle={work.source_title}
        sourceCharacter={work.source_character}
        fanartNote={work.fanart_note}
        timeLimitSeconds={work.time_limit_seconds}
        actualTimeSeconds={work.actual_time_seconds}
        createdAt={work.created_at}
      />

      {/* 下書きでも、過去に公開していれば回答が付いている可能性がある */}
      <SlotStats stats={work.slot_stats} />

      {!work.is_published && !work.deleted_at && work.review_status === "ok" ? (
        <form action={publishWorkAction} className="space-y-3">
          <input type="hidden" name="workId" value={work.id} />
          <SubmitButton
            pendingLabel="公開しています…"
            className="rounded-xl bg-accent px-6 py-3 text-sm font-bold text-on-accent hover:opacity-85"
          >
            公開する
          </SubmitButton>
          <p className="text-xs text-faint">
            公開すると実制作時間は変更できなくなります（D25）。
          </p>
        </form>
      ) : null}

      {/* 削除済みの作品には出さない（もう消せるものが無い） */}
      {!work.deleted_at ? (
        <p className="border-t border-ink/10 pt-6 text-sm">
          <Link
            href={`/works/${work.id}/delete`}
            className="text-danger underline"
          >
            この作品を削除する
          </Link>
        </p>
      ) : null}
    </>
  );
}

export default async function WorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string; result?: string }>;
}) {
  const { id } = await params;
  const { error, notice, result: rawResult } = await searchParams;

  // まず公開の経路で引く。ここで取れたものは誰が見ても同じ。
  const publicWork = await fetchWorkDetail(id);

  // 取れなかったときだけ、本人用の経路を試す。
  // 未サインイン（anon）には get_my_work の実行権限が無いので、
  // 呼ぶ前にサインイン済みか確かめる。
  const user = await getCurrentUser();

  let myWork: MyWork | null = null;
  if (!publicWork && user) myWork = await fetchMyWork(id);

  // いいね・保存は登録ユーザーだけ（D7 / spec 10）。
  // ボタンを出すか案内を出すかの判断にだけ使う。本当の判定は DB 側。
  const canReact = user !== null && !user.is_anonymous;

  // どちらでも取れないなら、存在しないのと同じ扱い（D40）。
  if (!publicWork && !myWork) notFound();

  // 公開されている作品にだけクイズが付く。
  //
  // 回答済みかどうかは get_work_quiz が answered_by_me で教えてくれるので、
  // 結果を取りに行くのはそのときだけ。未回答の人に余分な問い合わせをしない
  // （そして get_my_answer は未回答なら null しか返さない）。
  let quiz: WorkQuiz | null = null;
  let myAnswer: MyAnswer | null = null;

  if (publicWork) {
    quiz = await fetchWorkQuiz(id);
    if (quiz?.answered_by_me) myAnswer = await fetchMyAnswer(id);
  }

  // 自分の作品の結果。他人と未サインインには null が返る（DB 側で判定）。
  // **画面で捨てる形にしない。**捨てても通信には数字が乗ってしまう。
  const result =
    publicWork?.is_author && user ? await fetchMyWorkResult(id) : null;

  // 封を開けたかどうかは URL で持つ。Client Component にしないので、
  // JavaScript が無効でも開ける
  const resultOpen = rawResult === "open";

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      {error ? (
        <p className="rounded-xl bg-danger-tint/10 px-4 py-3 text-sm whitespace-pre-wrap text-danger">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="rounded-xl bg-success-tint/10 px-4 py-3 text-sm whitespace-pre-wrap text-success">
          {notice}
        </p>
      ) : null}

      {publicWork ? (
        <PublicView
          work={publicWork}
          quiz={quiz}
          myAnswer={myAnswer}
          canReact={canReact}
          result={result}
          resultOpen={resultOpen}
        />
      ) : myWork ? (
        <OwnerOnlyView work={myWork} />
      ) : null}

      <footer className="flex flex-wrap gap-x-4 gap-y-2 border-t border-ink/10 pt-6 text-sm">
        <Link href="/works" className="underline">
          作品一覧へ
        </Link>
        <Link href="/play" className="underline">
          お題を引く画面へ
        </Link>
      </footer>
    </main>
  );
}
