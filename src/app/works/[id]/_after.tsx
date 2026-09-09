import Link from "next/link";
import { SubmitButton } from "@/app/_pending";
import {
  btnPrimary,
  btnQuiet,
  btnSecondary,
  field,
  noticeMuted,
  surface,
} from "@/app/_surface";
import { MAX_CARRY_PER_SAVE, type RevealedPrompt } from "@/features/carry/types";
import {
  flavorLines,
  hintAccuracy,
  type FlavorReply,
  type FlavorVocabItem,
  type WorkFlavor,
  type WorkHintResult,
} from "@/features/flavor/types";
import {
  carryElementsAction,
  nextWorkAction,
  openFlavorHintAction,
  openShareAction,
  postFlavorReplyAction,
} from "./actions";

/**
 * 作品ページのうち、「回答したあと」に出る部分。
 *
 * 【並ぶ順番と、その理由】
 *   1. 正誤（既存の AnswerResult）
 *   2. 正解のお題まるごと      … お題の全語（D162 の 4 ／ D165 の 1）
 *   3. 作者の文章              … 2 と同時に必ず開く（D162 の 4）
 *   4. 要素を持ち出す          … 開示された語から1〜3個（D161）
 *   5. 返歌                    … 開示のあと、自分の意思で（D162 の 7）
 *   6. 次の作品／自分も描く    … 鑑賞から制作へ戻る道
 *
 *   **2 と 3 を分けて出さない。**D162 は「正解のお題と作者の文章を一緒に開示する」
 *   と決めている。片方だけ先に出すと、文章が「答え合わせ」ではなく
 *   「もう一つのヒント」になってしまう。
 *
 * すべて Server Component。ボタンは form の送信で、JavaScript が無くても動く。
 */

/* ===========================================================================
 * 共有
 * =========================================================================== */

/**
 * 共有のボタンと、開いたときに出る面。
 *
 * 【URLに答えは載らない】
 *   共有するのは作品ページのURLだけ。そのページを開いた人には
 *   回答前の画面が出る。共有カード（OGP）にも答えは載らない（D64）。
 */
export function ShareBox({
  workId,
  workTitle,
  shareUrl,
  open,
}: {
  workId: string;
  workTitle: string;
  shareUrl: string;
  open: boolean;
}) {
  if (!open) {
    return (
      <form action={openShareAction}>
        <input type="hidden" name="workId" value={workId} />
        <SubmitButton pendingLabel="開いています…" className={btnSecondary}>
          この作品を共有する
        </SubmitButton>
      </form>
    );
  }

  const text = `「${workTitle}」\n絵だけを見て、引かれたお題を当ててみてください。`;
  const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    text,
  )}&url=${encodeURIComponent(shareUrl)}`;

  return (
    <section className={`${surface} space-y-4`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">この作品を共有する</h2>
        <p className="text-xs text-faint">
          共有したページには答えが出ません。受け取った人は、まず自分で答えることになります。
        </p>
      </div>

      <input
        type="text"
        readOnly
        value={shareUrl}
        aria-label="共有用のURL"
        className={field}
      />

      <div className="flex flex-wrap gap-3">
        <a
          href={intent}
          target="_blank"
          rel="noopener noreferrer"
          className={`${btnSecondary} inline-block`}
        >
          X に投稿する
        </a>
        <Link href={`/works/${workId}`} className={`${btnQuiet} inline-block`}>
          閉じる
        </Link>
      </div>
    </section>
  );
}

/* ===========================================================================
 * 回答後の行き先
 * =========================================================================== */

/**
 * 次の作品と、自分も描く。
 *
 * 【なぜここに置くか】
 *   答え終わった直後がいちばん「もう1枚見たい」「自分も描きたい」が強い。
 *   ここに行き先が無いと、そのまま閉じられる。
 *
 * 【送るのは作品IDだけ】
 *   部門は送らない。次に出る作品の部門は、いま答えた作品の行から
 *   DB が読む（D169 の12）。**この form に部門を足さないこと。**
 *   足すと、その値を書き換えるだけで別の部門へ移れてしまう。
 */
export function NextSteps({ workId }: { workId: string }) {
  return (
    <section className={`${surface} space-y-4`}>
      <h2 className="text-sm font-bold">つづける</h2>

      <div className="flex flex-wrap gap-3">
        <form action={nextWorkAction}>
          <input type="hidden" name="workId" value={workId} />
          <SubmitButton pendingLabel="探しています…" className={btnPrimary}>
            次の作品に答える
          </SubmitButton>
        </form>

        <Link href="/play" className={`${btnSecondary} inline-block`}>
          自分も描く（お題を引く）
        </Link>
      </div>

      <p className="text-xs text-faint">
        「次の作品」は、いま答えた作品と同じ部門の中から、あなたがまだ答えて
        いない作品を1件選びます。まだ誰にも答えられていない作品があれば、
        その中から選ばれます。無ければ、答えの付いている作品から選ばれます。
        どちらの場合も、その中での順番は決めていません。
      </p>
    </section>
  );
}

/* ===========================================================================
 * 正解のお題まるごと ＋ 一部持ち出し
 * =========================================================================== */

/**
 * 開示されたお題と、そこからの持ち出し（D161 / D162 の 4 ＋ 2026-09-05 の3区分）。
 *
 * 【開示と出題の範囲は一致する】
 *   D165 でお題の全語が出題されるようになったので、
 *   「正解のお題を開示する」と「出題された語をすべて見せる」は同じになった。
 *   それでもこの面を出題とは別に置くのは、開示の理由が
 *   「答え合わせ」であって「採点の内訳」ではないため（D162 の 4）。
 *
 * 【ゲストも持ち出せる。ただし残らない】
 *   ゲストの持ち出しは「いまの流れの中だけ」で、お題を確定した時点で
 *   手元から無くなる。**一時利用は開けるが、永続保存は開けない。**
 *   ボタンを分けるのではなく、押したあとに何が起きるかを先に書く。
 *
 *   本当の判定は save_prompt_elements が JWT で行う。画面は案内をするだけ。
 */
export function RevealedPromptBox({
  revealed,
  canPersist,
}: {
  revealed: RevealedPrompt;
  /** 別のセッションへ残せるか（＝登録者か） */
  canPersist: boolean;
}) {
  // **「モーフ以外はぜんぶ状態」と数えない。**その数え方だとカラーが
  // 状態に混ざる。上位種別は DB が element_kind で渡してくる。
  const morphs = revealed.cards.filter((c) => c.element_kind === "morph");
  const states = revealed.cards.filter((c) => c.element_kind === "state");
  const colors = revealed.cards.filter((c) => c.element_kind === "color");
  const others = revealed.cards.filter(
    (c) => !["morph", "state", "color"].includes(c.element_kind),
  );

  // 自分の作品からなら「自分のお題から」、他人の作品からなら「他の人のお題から」。
  // 上限が別々なので、どちらに入るかを先に書く。
  const bucket = revealed.is_author ? "自分のお題から" : "他の人のお題から";

  return (
    <section className={`${surface} space-y-5`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">この絵のお題</h2>
        <p className="text-xs text-faint">
          描く対象が {morphs.length} 個、そこへの解釈の要求が {states.length} 個
          {colors.length > 0 ? `、色が ${colors.length} 個` : ""}
          {others.length > 0 ? `、その他が ${others.length} 個` : ""}。 この{" "}
          {revealed.cards.length} 語すべてが出題されていました。
        </p>
      </div>

      <form action={carryElementsAction} className="space-y-4">
        <input type="hidden" name="workId" value={revealed.work_id} />

        <ul className="space-y-2">
          {revealed.cards.map((c) => (
            <li key={c.card_slot_key}>
              <label
                data-revealed-card={c.card_slot_key}
                data-tag-label={c.tag_label}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-line px-4 py-3 text-sm has-checked:border-line-active"
              >
                <input type="checkbox" name="tagId" value={c.tag_id} />
                <span className="w-24 shrink-0 text-xs text-faint">
                  {c.category_label}
                </span>
                <span className="font-bold">{c.tag_label}</span>
              </label>
            </li>
          ))}
        </ul>

        <div className="space-y-2">
          <SubmitButton pendingLabel="持ち出しています…" className={btnSecondary}>
            選んだ要素を1つの保存枠にする（{MAX_CARRY_PER_SAVE}個まで）
          </SubmitButton>

          {canPersist ? (
            <p className="text-xs text-faint">
              選んだ要素は、まとめて1つの保存枠になります。枠は「{bucket}」として
              手元に残り、次に自分がお題を引くときに、その中から選んで始められます。
              別の日に開いても残ります。手元に残せるのは
              <span className="font-bold">枠の数</span>で数えます
              （自分のお題から5枠、他の人のお題から3枠）。
              いっぱいのときは、先に要らない枠を捨ててください。
              種類の組み合わせに制限はありません。
            </p>
          ) : (
            <p className="text-xs text-faint">
              ゲストのままでも持ち出せます（枠の数に上限はありません）。ただし残るのは
              <span className="font-bold">いまの流れの中だけ</span>で、
              次のお題を確定した時点で手元から無くなります。
              アカウントを登録すると、別の日にも使えるように残せます。
              <Link href="/account" className="pl-2 underline">
                アカウントの画面へ
              </Link>
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

/* ===========================================================================
 * フレーバーテキスト
 * =========================================================================== */

/**
 * 回答前の「ヒントを開く」。
 *
 * 【開いても減点されない】
 *   開いたことは記録されるが、正答の重みは変わらない（D162）。
 *   記録するのは、作者が「絵だけで伝わった割合」と
 *   「文章を添えて伝わった割合」を分けて見られるようにするため。
 *   その説明をボタンのそばに置く。隠すと不信になる。
 */
export function FlavorHintBox({
  workId,
  hasFlavor,
  flavor,
  canUse,
}: {
  workId: string;
  hasFlavor: boolean;
  flavor: WorkFlavor | null;
  canUse: boolean;
}) {
  if (!hasFlavor) return null;

  if (!canUse) {
    return (
      <div className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">作者からの言葉があります</h2>
        <p className="text-xs text-faint">
          回答前にヒントとして開けるのは登録ユーザーだけです。
          ゲストのままでもクイズには答えられます。
          <Link href="/account" className="pl-2 underline">
            アカウントの画面へ
          </Link>
        </p>
      </div>
    );
  }

  if (flavor?.tokens.length) {
    return (
      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">作者からの言葉（ヒント）</h2>
        {flavorLines(flavor).map((line, i) => (
          <p key={i} className="text-lg leading-relaxed">
            {line}
          </p>
        ))}
        <p className="text-xs text-faint">
          この文章は、回答後にもう一度出ます。開いたことによる減点はありません。
        </p>
      </section>
    );
  }

  return (
    <form action={openFlavorHintAction} className={`${surface} space-y-3`}>
      <input type="hidden" name="workId" value={workId} />
      <h2 className="text-sm font-bold">作者からの言葉があります</h2>
      <p className="text-xs text-faint">
        答える前に開くこともできます。開いても減点はありません。
        開いたかどうかは、作者が「絵だけで伝わったか」を見るためだけに記録されます。
      </p>
      <SubmitButton pendingLabel="開いています…" className={btnSecondary}>
        ヒントとして開く
      </SubmitButton>
    </form>
  );
}

/** 回答後の開示。ヒントを使った人にとっては同じ文章の2度目 */
export function FlavorRevealBox({ flavor }: { flavor: WorkFlavor }) {
  if (!flavor.exists || flavor.tokens.length === 0) return null;

  return (
    <section className={`${surface} space-y-3`}>
      <h2 className="text-sm font-bold">作者の言葉</h2>
      {flavorLines(flavor).map((line, i) => (
        <p key={i} className="text-lg leading-relaxed">
          {line}
        </p>
      ))}
      <p className="text-xs text-faint">
        {flavor.hint_used
          ? "回答前に見た文章と同じものです。答えを知ったいま、同じ言葉が違って読めるはずです。"
          : "作者が、決まった語だけで作った文章です。"}
      </p>
    </section>
  );
}

/**
 * 返歌（D162 の 7・8）。
 *
 * **正誤判定は無い。**採点も、良し悪しの表示もしない。
 * 正解はもう開示されているので、お題の語をそのまま置ける。
 */
export function ReplyBox({
  workId,
  revealed,
  vocab,
  replies,
  canReply,
  open,
}: {
  workId: string;
  revealed: RevealedPrompt | null;
  vocab: FlavorVocabItem[];
  replies: FlavorReply[];
  canReply: boolean;
  open: boolean;
}) {
  const mine = replies.find((r) => r.is_mine);

  return (
    <section className={`${surface} space-y-5`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">返歌</h2>
        <p className="text-xs text-faint">
          作者の言葉に、言葉で返せます。正解も不正解もありません。書かなくても構いません。
        </p>
      </div>

      {replies.length > 0 ? (
        <ul className="space-y-3">
          {replies.map((r) => (
            <li
              key={r.id}
              data-reply={r.id}
              className="rounded-xl border border-line px-4 py-3"
            >
              <p className="text-base leading-relaxed">{r.tokens.join(" ")}。</p>
              <p className="pt-1 text-xs text-faint">
                {r.author_handle
                  ? `${r.author_display_name}（@${r.author_handle}）`
                  : r.author_display_name}
                {r.is_mine ? "・あなた" : ""}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">まだ返歌はありません。</p>
      )}

      {!canReply ? (
        <p className={noticeMuted}>
          返歌を送れるのは登録ユーザーだけです。クイズの回答はゲストのままできます。
          <Link href="/account" className="pl-2 underline">
            アカウントの画面へ
          </Link>
        </p>
      ) : mine ? (
        <p className="text-xs text-faint">
          あなたはすでに返歌を送っています。送り直すと上書きされます。
        </p>
      ) : null}

      {canReply && !open ? (
        <p>
          <Link href={`/works/${workId}?reply=open`} className={`${btnSecondary} inline-block`}>
            返歌を作る
          </Link>
        </p>
      ) : null}

      {canReply && open ? (
        <form action={postFlavorReplyAction} className="space-y-4 border-t border-ink/10 pt-4">
          <input type="hidden" name="workId" value={workId} />

          {revealed && revealed.cards.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-xs font-bold">お題の語（そのまま使えます）</h3>
              <div className="flex flex-wrap gap-2">
                {revealed.cards.map((c) => (
                  <label
                    key={`t-${c.tag_id}`}
                    className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-xs has-checked:border-line-active has-checked:bg-hover"
                  >
                    <input
                      type="checkbox"
                      name="token"
                      value={`t:${c.tag_id}`}
                      className="mr-2"
                    />
                    {c.tag_label}
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <h3 className="text-xs font-bold">つなぐ語</h3>
            <div className="flex flex-wrap gap-2">
              {vocab.map((v) => (
                <label
                  key={`v-${v.id}`}
                  className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-xs has-checked:border-line-active has-checked:bg-hover"
                >
                  <input
                    type="checkbox"
                    name="token"
                    value={`v:${v.id}`}
                    className="mr-2"
                  />
                  {v.label}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <SubmitButton pendingLabel="送っています…" className={btnPrimary}>
              返歌を送る
            </SubmitButton>
            <p className="text-xs text-faint">
              選んだ順ではなく、上から並んだ順に並びます。
            </p>
          </div>
        </form>
      ) : null}
    </section>
  );
}

/**
 * ヒントを使った回答と使わなかった回答を分けて出す（D162）。作者だけに見せる。
 *
 * 【この2つを並べる意味】
 *   上が「絵だけでどこまで伝わったか」、下が「文章を添えるとどこまで伝わったか」。
 *   差が大きいほど、絵だけでは渡っていなかったことになる。
 *   **どちらが良いという話ではない。**
 */
export function HintSplitStats({ result }: { result: WorkHintResult }) {
  const withHint = result.rows.find((r) => r.hint_used);
  const without = result.rows.find((r) => !r.hint_used);

  if (!withHint && !without) return null;

  const line = (label: string, row: typeof withHint) => {
    if (!row || row.answers_count === 0) {
      return (
        <li className="flex items-baseline justify-between gap-4 text-sm">
          <span className="text-faint">{label}</span>
          <span className="text-faint">まだ回答がありません</span>
        </li>
      );
    }
    const percent = hintAccuracy(row);
    return (
      <li
        data-hint-stat={row.hint_used ? "with" : "without"}
        data-answers={row.answers_count}
        data-correct={row.correct_items}
        data-total={row.total_items}
        className="flex items-baseline justify-between gap-4 text-sm"
      >
        <span className="text-faint">{label}</span>
        <span className="font-bold tabular-nums">
          {percent === null ? "—" : `${percent}%`}
          <span className="pl-2 text-xs font-normal text-faint">
            {row.answers_count}人
          </span>
        </span>
      </li>
    );
  };

  return (
    <section className={`${surface} space-y-4`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">文章を読んだ人と、読まなかった人</h2>
        <p className="text-xs text-faint">
          回答前に作者の言葉を開いたかどうかで分けた正答率です。
          どちらが良いという話ではありません。
        </p>
      </div>

      <ul className="space-y-2">
        {line("絵だけで答えた人", without)}
        {line("文章を読んでから答えた人", withHint)}
      </ul>
    </section>
  );
}
