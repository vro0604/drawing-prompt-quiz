import { formatDateTime } from "@/lib/datetime";
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
  openMyWorkResult,
  workImageUrl,
} from "@/features/work/rpc";
import {
  divisionLabel,
  formatActualTime,
  type MyWork,
  type MyWorkResult,
  type WorkDetail,
  type WorkOrigin,
} from "@/features/work/types";
import { AnswerResult, AuthorNotice, MyResult, QuizForm, SlotStats } from "./_quiz";
import {
  FlavorComposer,
  FlavorHintBox,
  FlavorRevealBox,
  HintSplitStats,
  NextSteps,
  ReplyBox,
  RevealedPromptBox,
  ShareBox,
} from "./_after";
import { fetchRevealedPrompt } from "@/features/carry/rpc";
import type { RevealedPrompt } from "@/features/carry/types";
import {
  fetchFlavorReplies,
  fetchFlavorVocab,
  fetchReplyVocab,
  fetchWorkFlavor,
  fetchWorkHasFlavor,
  fetchWorkHintResult,
} from "@/features/flavor/rpc";
import type {
  FlavorReply,
  FlavorVocabItem,
  FlavorVocabSet,
  WorkFlavor,
  WorkHintResult,
} from "@/features/flavor/types";
import { SITE_URL } from "@/lib/env";
import {
  publishWorkAction,
  toggleLikeAction,
  toggleSaveAction,
  unpublishWorkAction,
} from "./actions";
import {
  btnPrimary,
  btnSecondary,
  btnToggle,
  btnToggleOff,
  btnToggleOn,
  noticeError,
  noticeSuccess,
  surface,
} from "@/app/_surface";

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

  // 共有カードの説明文。**答えも、作者の文章も入れない**（D64 / D162）。
  // 遊び方が1文で分かることだけを目的にする。
  const description =
    `${work.author.display_name} さんの作品。` +
    "絵だけを見て、描き手が引いたお題を4択で当てます。当たった割合が伝達率として残ります。";

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

/**
 * 部門・時間・投稿日など、公開・非公開に関わらず同じ並びで出す。
 *
 * 【持ち込みの作品に「お題の制作時間」を出さない】
 *   既に描いてあった絵を持ち込んだ作品（origin が art_first）は、
 *   制限時間を持たない。そのまま formatDuration に渡すと「無制限」と出るが、
 *   **それは測った値ではない。**無制限の枠で描いた作品と区別がつかなくなる。
 *   行そのものを出さない（2026-09-08 のユーザー確定7）。
 *
 *   出どころを画面に書くわけではない。書かないのは時間の行だけ。
 */
function MetaList({
  division,
  sourceTitle,
  sourceCharacter,
  fanartNote,
  timeLimitSeconds,
  actualTimeSeconds,
  createdAt,
  origin,
}: {
  division: string;
  sourceTitle: string | null;
  sourceCharacter: string | null;
  fanartNote: string | null;
  timeLimitSeconds: number | null;
  actualTimeSeconds: number | null;
  createdAt: string;
  origin: WorkOrigin;
}) {
  const rows: { label: string; value: string }[] = [
    { label: "部門", value: divisionLabel(division) },
    ...(origin === "art_first"
      ? []
      : [{ label: "お題の制作時間", value: formatDuration(timeLimitSeconds) }]),
    { label: "実制作時間（自己申告）", value: formatActualTime(actualTimeSeconds) },
    { label: "投稿日", value: formatDateTime(createdAt) },
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
  const base = btnToggle;
  const on = btnToggleOn;
  const off = btnToggleOff;

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

/**
 * 公開されている作品の表示。
 *
 * 【回答の前と後で、出るものが入れ替わる】
 *   前  クイズ／作者の言葉をヒントとして開くボタン
 *   後  正誤／お題まるごと／作者の言葉／持ち出し／返歌／次の作品
 *
 *   境目は myAnswer が入っているかどうかの1点だけ。
 *   **どちらに出すかを画面で判断しているのは並べ方だけで、
 *   中身が返ってくるかどうかは全部 DB 側が決めている。**
 *   回答していない人には、そもそもお題も返歌も返ってこない。
 */
function PublicView({
  work,
  quiz,
  myAnswer,
  canReact,
  result,
  resultOpen,
  after,
}: {
  work: WorkDetail;
  quiz: WorkQuiz | null;
  myAnswer: MyAnswer | null;
  canReact: boolean;
  result: MyWorkResult | null;
  resultOpen: boolean;
  after: AfterAnswerData;
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
        origin={work.origin}
      />

      <Reactions work={work} canReact={canReact} />

      {/* クイズ。出す形は3通りしかない。
            作者      → 回答できない案内（D28）
            回答済み  → 結果（ここで初めて正解が出る）
            それ以外  → 回答フォーム（正解を含まない） */}
      {quiz === null ? null : quiz.is_author ? (
        <AuthorNotice />
      ) : myAnswer ? (
        <>
          <AnswerResult answer={myAnswer} />
          {after.analysis ? (
            <AnswererAnalysis
              analysis={after.analysis}
              myTagsByQuestion={Object.fromEntries(
                myAnswer.items.map((i) => [
                  i.question_id,
                  [i.selected_tag_id, i.selected_tag_id_2].filter(
                    (t): t is number => t !== null,
                  ),
                ]),
              )}
            />
          ) : null}
        </>
      ) : (
        <>
          {/* 回答前のヒント（D162 の 2）。開くかどうかは本人が決める */}
          <FlavorHintBox
            workId={work.id}
            hasFlavor={after.hasFlavor}
            flavor={after.flavor}
            canUse={after.isRegistered}
          />

          {/*
            回答は1セクションずつ・長押しで確定する（_answer.tsx）。
            絵はこの中にもう一度置いてある。**答えている間ずっと見えている**
            必要があるためで、上の大きな1枚とは役目が違う
            （同じ画像なので、読み込みは1回で済む）。
          */}
          <AnswerFlow
            quiz={quiz}
            imageSrc={workImageUrl(work.image_path)}
            imageWidth={work.image_width}
            imageHeight={work.image_height}
            title={work.title}
          />

          {/*
            JavaScript が動かないときの回答手段。
            **長押しは JavaScript が要る。**動かない環境で答える道を
            消さないために、今までの「全部並べてチェックする」形を残す。
            JavaScript が動くときは、この noscript の中身は無いものとして扱われ、
            中の style も効かない（＝上の AnswerFlow が見える）。
          */}
          <noscript>
            <style>{"[data-answer-flow]{display:none}"}</style>
            <QuizForm quiz={quiz} />
          </noscript>
        </>
      )}

      {/* 回答したあと。お題と作者の言葉を**一緒に**開示する（D162 の 4） */}
      {myAnswer && after.revealed ? (
        <RevealedPromptBox revealed={after.revealed} canPersist={after.isRegistered} />
      ) : null}

      {myAnswer && after.flavor?.exists ? (
        <FlavorRevealBox flavor={after.flavor} />
      ) : null}

      {myAnswer && after.hasFlavor ? (
        <ReplyBox
          workId={work.id}
          revealed={after.revealed}
          vocab={after.replyVocab}
          replies={after.replies}
          canReply={after.isRegistered}
          open={after.replyOpen}
        />
      ) : null}

      {myAnswer ? <NextSteps workId={work.id} /> : null}

      {/* 作者だけに見える2つ */}
      {work.is_author && after.flavorVocab ? (
        <FlavorComposer
          workId={work.id}
          vocab={after.flavorVocab}
          current={after.flavor}
          action={setFlavorTextAction}
        />
      ) : null}

      {/*
        【開くまで数字を出さない（D112）】
          枠ごとの伝達率（SlotStats）と同じ扱いにする。
          もとはこの欄だけ、開く前から正答率の % が出ていた。
          作者が「読み解かれた人数」の予告を見る画面に数字が混ざると、
          **取りに行く前に数字が目に入る**ことになり、
          その画面を作った意味が消える。
      */}
      {work.is_author && resultOpen && after.hintResult ? (
        <HintSplitStats result={after.hintResult} />
      ) : null}

      <ShareBox
        workId={work.id}
        workTitle={work.title}
        shareUrl={`${SITE_URL}/works/${work.id}`}
        open={after.shareOpen}
      />

      {/*
        **他人には項目別の伝達率を出さない**（D112）。
        「他人の作品ページ＝絵とタイトルだけ」と決めてあるのに、
        ここは誰にでも見えていた。仕様の取りこぼし。

        回答した人が自分の正誤を見るのは AnswerResult のほうで、
        そちらは変えていない。
      */}
      {result ? (
        <>
          {/*
            【開いたあとに、いちばん上へ来るもの】
              主役は当たった割合ではなく、**どの語が選ばれたか**と
              **どの項目が誰に伝わったか**。だから語の分布と重なりの図を先に置く。

              当てられた割合（MyResult）と項目別の内訳（SlotStats）は消していない。
              その下に、小さくして残す。

            封を切る前は MyResult だけ。あの画面は「開く」を出すためにある
            （D112。開くまで数字を出さない）。
          */}
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
              className={btnSecondary}
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
        origin={work.origin}
      />

      {/* 下書きでも、過去に公開していれば回答が付いている可能性がある */}
      <SlotStats stats={work.slot_stats} />

      {!work.is_published && !work.deleted_at && work.review_status === "ok" ? (
        <form action={publishWorkAction} className="space-y-3">
          <input type="hidden" name="workId" value={work.id} />
          <SubmitButton
            pendingLabel="公開しています…"
            className={btnPrimary}
          >
            公開する
          </SubmitButton>
          <p className="text-xs text-faint">
            公開すると実制作時間は変更できなくなります。
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

/**
 * 回答の前後で出す部品へ渡す一式。
 *
 * ばらばらに渡すと引数が10本を超えるので1つにまとめている。
 * **中身の取得はすべて DB 側の判定を通っている。**
 * ここに入っている時点で「その人が見てよいもの」だけになっている。
 */
type AfterAnswerData = {
  /** 登録ユーザーか。ゲストと未サインインは false（D164） */
  isRegistered: boolean;
  /** 作者が文章を付けているか。本文は含まない */
  hasFlavor: boolean;
  /** 作者の文章。見てよい人にだけ入る */
  flavor: WorkFlavor | null;
  /** 回答後に開示されるお題まるごと。回答済みの人にだけ入る */
  revealed: RevealedPrompt | null;
  /** 返歌の一覧。回答済みの人と作者にだけ入る */
  replies: FlavorReply[];
  /** 返歌で使えるつなぎの語 */
  replyVocab: FlavorVocabItem[];
  /** 作者が自作の文章を作るときの語の一覧 */
  flavorVocab: FlavorVocabSet | null;
  /** ヒント使用別の集計。作者にだけ入る */
  hintResult: WorkHintResult | null;
  /** 答え終わった本人だけが見る集計。未回答なら null */
  analysis: MyAnswerAnalysis | null;
  /** 作者だけが見る集計。作者以外なら null */
  workAnalysis: WorkAnswerAnalysis | null;
  /** いま選んでいる区画（当て方の並び）。URL の pattern */
  pattern: string | null;
  /** 掘り下げの条件。URL の f=<問のID>:<語のID> */
  filters: AnswerFilter[];
  /** 区画を選んでいるときだけ入る。作者以外なら null */
  drilldown: Drilldown | null;
  /** 分析から外す相手を選ぶ一覧。作者以外なら null */
  answerList: WorkAnswerList | null;
  /** その一覧を開いているか */
  manageOpen: boolean;
  /** 取り込み枠の状態。作者以外なら null */
  importState: WorkImportState | null;
  shareOpen: boolean;
  replyOpen: boolean;
};

export default async function WorkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    error?: string;
    notice?: string;
    result?: string;
    share?: string;
    hint?: string;
    reply?: string;
    /** 掘り下げで選んだ区画（"11010" のような0と1の並び） */
    pattern?: string;
    /** 掘り下げの条件。`f=<問のID>:<語のID>` を重ねられるので配列も来る */
    f?: string | string[];
    /** 分析から外す相手を選ぶ一覧を開いているか */
    manage?: string;
  }>;
}) {
  const { id } = await params;
  const {
    error,
    notice,
    result: rawResult,
    share: rawShare,
    reply: rawReply,
    pattern: rawPattern,
    f: rawFilters,
    manage: rawManage,
  } = await searchParams;

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

  // 答え終わった人にだけ返る集計（語の人気・自分と似た回答者・完全ビタ）。
  // まだ答えていない人には DB 側が null を返す
  let myAnalysis: MyAnswerAnalysis | null = null;

  if (publicWork) {
    quiz = await fetchWorkQuiz(id);
    if (quiz?.answered_by_me) {
      [myAnswer, myAnalysis] = await Promise.all([
        fetchMyAnswer(id),
        fetchMyAnswerAnalysis(id),
      ]);
    }
  }

  // 作者だけが見る集計。作者以外には DB 側が null を返す
  const workAnalysis: WorkAnswerAnalysis | null =
    publicWork?.is_author && user ? await fetchWorkAnswerAnalysis(id) : null;

  // 封を開けたかどうかは URL で持つ。Client Component にしないので、
  // JavaScript が無効でも開ける
  const resultOpen = rawResult === "open";

  // 自分の作品の結果。他人と未サインインには null が返る（DB 側で判定）。
  // **画面で捨てる形にしない。**捨てても通信には数字が乗ってしまう。
  //
  // 【開いたときだけ、開いた時刻を記録する】
  //   閉じたまま作品ページを見ただけでは記録しない。記録すると、
  //   中身を見ていないのに「結果を確認した」ことになり、
  //   知らせが消えてしまう（D192）。
  //   だから封が開いているときだけ、記録するほうの関数を呼ぶ。
  //   返る中身は同じで、記録するかどうかだけが違う。
  const result =
    publicWork?.is_author && user
      ? resultOpen
        ? await openMyWorkResult(id)
        : await fetchMyWorkResult(id)
      : null;
  /* --- 掘り下げ（作者だけ）------------------------------------------------
   *
   * 選んだ区画と条件は URL に載っている。**手で書き換えても構わない。**
   * 返す・返さないを決めるのは DB 側で、作者でなければ null、
   * 集団が少人数なら人数も内訳も返ってこない。ここは呼ぶだけ。
   */
  const isWorkAuthor = Boolean(publicWork?.is_author && user);
  const pattern =
    isWorkAuthor && typeof rawPattern === "string" && /^[01]+$/.test(rawPattern)
      ? rawPattern
      : null;
  const filters = isWorkAuthor ? parseFilters(rawFilters) : [];
  const manageOpen = isWorkAuthor && rawManage === "open";

  const [drilldown, answerList, importState] = await Promise.all([
    pattern
      ? fetchWorkDrilldown(id, pattern, filters)
      : Promise.resolve<Drilldown | null>(null),
    isWorkAuthor && resultOpen
      ? fetchWorkAnswerList(id)
      : Promise.resolve<WorkAnswerList | null>(null),
    // 取り込み枠は、下書きでも削除済みでも作者に返る。
    // 公開の経路で取れなかったときも本人用の経路で作品が取れていれば読む
    (publicWork?.is_author || myWork) && user
      ? fetchWorkImportState(id)
      : Promise.resolve<WorkImportState | null>(null),
  ]);

  // --- 回答の前後で出すもの --------------------------------------------
  //
  // **見てよいかの判定はここでしていない。**どの関数も、返す条件を
  // DB 側に持っている（回答済みか／作者か／登録者か）。
  // ここでやるのは「呼ぶかどうか」だけで、呼んでも返らないものは返らない。
  //
  // 未サインインとゲストには問い合わせない。フレーバー系の RPC は
  // authenticated だけが呼べるので、anon のまま呼ぶと 500 になる（D90）。
  const isRegistered = user !== null && !user.is_anonymous;

  const [
    hasFlavor,
    flavor,
    revealed,
    replies,
    replyVocab,
    flavorVocab,
    hintResult,
  ] = publicWork
    ? await Promise.all([
        isRegistered ? fetchWorkHasFlavor(id) : Promise.resolve(false),
        isRegistered ? fetchWorkFlavor(id) : Promise.resolve(null),
        user ? fetchRevealedPrompt(id) : Promise.resolve(null),
        isRegistered ? fetchFlavorReplies(id) : Promise.resolve([]),
        isRegistered ? fetchReplyVocab() : Promise.resolve([]),
        isRegistered && publicWork.is_author
          ? fetchFlavorVocab(id)
          : Promise.resolve(null),
        publicWork.is_author && user
          ? fetchWorkHintResult(id)
          : Promise.resolve(null),
      ])
    : [false, null, null, [], [], null, null];

  const after: AfterAnswerData = {
    isRegistered,
    hasFlavor,
    flavor,
    revealed,
    replies,
    replyVocab,
    flavorVocab,
    hintResult,
    shareOpen: rawShare === "open",
    replyOpen: rawReply === "open",
  };

  return (
    <main className="mx-auto w-full max-w-3xl space-y-8 p-6 sm:p-10">
      {error ? (
        <p className={noticeError}>
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className={noticeSuccess}>
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
          after={after}
        />
      ) : myWork ? (
        <OwnerOnlyView work={myWork} />
      ) : null}
    </main>
  );
}
