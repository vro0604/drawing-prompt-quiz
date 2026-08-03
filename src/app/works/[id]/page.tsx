import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/features/auth/session";
import { formatDuration } from "@/features/draft/types";
import { fetchMyAnswer, fetchWorkQuiz } from "@/features/quiz/rpc";
import type { MyAnswer, WorkQuiz } from "@/features/quiz/types";
import { fetchMyWork, fetchWorkDetail, workImageUrl } from "@/features/work/rpc";
import {
  divisionLabel,
  formatActualTime,
  type MyWork,
  type WorkDetail,
} from "@/features/work/types";
import { AnswerResult, AuthorNotice, QuizForm, SlotStats } from "./_quiz";
import { publishWorkAction, unpublishWorkAction } from "./actions";

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

export const metadata = {
  title: "作品",
};

const box =
  "rounded-2xl border border-black/10 bg-white/60 p-6 dark:border-white/15 dark:bg-white/5";

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
      className="h-auto w-full rounded-2xl border border-black/10 dark:border-white/15"
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
    <div className={`${box} space-y-4`}>
      <dl className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-4 text-sm">
            <dt className="w-40 shrink-0 text-black/50 dark:text-white/50">{r.label}</dt>
            <dd className="font-bold">{r.value}</dd>
          </div>
        ))}
      </dl>

      {fanartNote ? (
        <div className="space-y-1 border-t border-black/10 pt-4 dark:border-white/10">
          <p className="text-xs text-black/50 dark:text-white/50">補足</p>
          <p className="text-sm whitespace-pre-wrap">{fanartNote}</p>
        </div>
      ) : null}
    </div>
  );
}

/** 公開されている作品の表示 */
function PublicView({
  work,
  quiz,
  myAnswer,
}: {
  work: WorkDetail;
  quiz: WorkQuiz | null;
  myAnswer: MyAnswer | null;
}) {
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">{work.title}</h1>
        <p className="text-sm text-black/55 dark:text-white/55">
          {work.author.display_name}
          {work.author.handle ? `（@${work.author.handle}）` : ""}
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

      <SlotStats stats={work.slot_stats} />

      {work.is_author ? (
        <form action={unpublishWorkAction}>
          <input type="hidden" name="workId" value={work.id} />
          <button
            type="submit"
            className="rounded-xl border border-black/20 px-6 py-3 text-sm font-bold hover:bg-black/[0.04] dark:border-white/25 dark:hover:bg-white/10"
          >
            下書きに戻す（他の人から見えなくする）
          </button>
        </form>
      ) : null}
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
        <p className="text-xs font-bold tracking-wider text-amber-600 dark:text-amber-400">
          {work.is_published ? "本人にのみ表示" : "下書き"}
        </p>
        <h1 className="text-2xl font-bold">{work.title}</h1>
        <p className="text-sm text-black/55 dark:text-white/55">{reason}</p>
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
          <button
            type="submit"
            className="rounded-xl bg-black px-6 py-3 text-sm font-bold text-white hover:opacity-85 dark:bg-white dark:text-black"
          >
            公開する
          </button>
          <p className="text-xs text-black/45 dark:text-white/45">
            公開すると実制作時間は変更できなくなります（D25）。
          </p>
        </form>
      ) : null}
    </>
  );
}

export default async function WorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  // まず公開の経路で引く。ここで取れたものは誰が見ても同じ。
  const publicWork = await fetchWorkDetail(id);

  // 取れなかったときだけ、本人用の経路を試す。
  // 未サインイン（anon）には get_my_work の実行権限が無いので、
  // 呼ぶ前にサインイン済みか確かめる。
  let myWork: MyWork | null = null;
  if (!publicWork) {
    const user = await getCurrentUser();
    if (user) myWork = await fetchMyWork(id);
  }

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

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      {error ? (
        <p className="rounded-xl bg-rose-500/10 px-4 py-3 text-sm whitespace-pre-wrap text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {publicWork ? (
        <PublicView work={publicWork} quiz={quiz} myAnswer={myAnswer} />
      ) : myWork ? (
        <OwnerOnlyView work={myWork} />
      ) : null}

      <footer className="flex flex-wrap gap-x-4 gap-y-2 border-t border-black/10 pt-6 text-sm dark:border-white/10">
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
