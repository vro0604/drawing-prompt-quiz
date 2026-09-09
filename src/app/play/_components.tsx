import Link from "next/link";
import {
  TIME_LIMIT_CHOICES,
  formatDuration,
  modeSummary,
  type DraftMode,
  type DraftSlot,
  type DraftState,
} from "@/features/draft/types";
import {
  MAX_CARRY_PER_DRAFT,
  MAX_ELEMENTS_PER_SLOT,
  SCOPE_LABEL,
  slotSummary,
  type SavedElements,
} from "@/features/carry/types";
import { subDirectiveLabel } from "@/features/modifier/types";
import {
  SHAPE_ASSISTS,
  shapeAssistLabel,
} from "@/features/shape-assist/types";
import { SubmitButton } from "@/app/_pending";
import {
  abandonDraftAction,
  completeDraftAction,
  deleteSavedCarrySlotAction,
  pickCardAction,
  promoteSessionCarryAction,
  redoSlotAction,
  rerollDraftAction,
  startDraftAction,
} from "./actions";
import {
  btnDanger,
  btnPrimary,
  btnQuiet,
  btnSecondary,
  field,
  noticeError,
  noticeMuted,
  surface,
} from "@/app/_surface";

/**
 * /play の見た目の部品。
 *
 * すべて Server Component で、状態は DB にしか持たない。
 * ボタンは form の submit で、押すと Server Action が動いて画面が再描画される。
 * JavaScript が無効でも動く（表示・操作の両方がサーバー側で完結する）。
 */

export function ErrorBox({ message }: { message: string }) {
  return (
    <p className={noticeError}>
      {message}
    </p>
  );
}

/**
 * モードと制作時間を選んでドラフトを始める。
 *
 * 【持ち出しの欄が出るとき】
 *   手持ちが1つ以上あるとき。**ゲストにも出す**（2026-09-05 の3区分）。
 *   ゲストが持てるのは「いまの流れの中だけ」の分で、
 *   お題を確定した時点で保持が終わる。そのことを欄の中に書く。
 *
 *   本当の判定は start_draft が持っている。画面は案内をするだけ。
 *
 * 【時計はここから動く】
 *   「ドラフトを始める」を押してサーバーが受け取った瞬間が、
 *   制作挑戦の開始時刻になる。カードをめくっている間も時間は進む。
 */
export function StartForm({
  modes,
  saved,
  signedIn,
}: {
  modes: DraftMode[];
  saved: SavedElements;
  signedIn: boolean;
}) {
  if (modes.length === 0) {
    return (
      <div className={surface}>
        <p className="text-sm">
          使えるモードがありません。マスタデータが入っているか確認してください。
        </p>
      </div>
    );
  }

  return (
    <>
    <form action={startDraftAction} className={`${surface} space-y-6`}>
      <div className="space-y-3">
        <h2 className="text-sm font-bold">モード</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {modes.map((mode, i) => (
            <label
              key={mode.mode_key}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 hover:bg-sunken has-checked:border-line-active"
            >
              <input
                type="radio"
                name="modeKey"
                value={mode.mode_key}
                defaultChecked={i === 0}
                className="mt-1"
              />
              <span className="space-y-1">
                <span className="block text-base font-bold">{mode.label}</span>
                {/* 語数・モーフ上限・候補数・引き直し・出題数を1行にまとめる。
                    語数はモードごとに違う（通常3〜4語／高難度5〜6語。D158）ので、
                    **モードの側から文を作る。**画面に数字を直接書かない。 */}
                <span className="block text-xs text-faint">{modeSummary(mode)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-bold">制作時間</h2>
        <select
          name="timeLimitSeconds"
          defaultValue="3600"
          className={field}
        >
          {TIME_LIMIT_CHOICES.map((c) => (
            <option key={c.label} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        {/* D5 は「制作時間は抽選ではなく利用者が選ぶ」という決定。
            **その番号は画面に出さない。**読む人には意味が無く、
            スクリーンショットにも写る。伝えるべきは
            「自分で決める」と「あとから変えられない」の2つだけ。
            言い回しも周りに合わせて ですます にした。 */}
        <p className="text-xs text-faint">
          制作時間は抽選ではなく、自分で決めます。あとから変更はできません。
        </p>
        <p className="text-xs text-faint">
          時間は「ドラフトを始める」を押した瞬間から進みます。
          カードをめくっている間も、お題が決まったあとも、同じ1つの時計です。
          残りが少なくなると、画面のいちばん上から時間を延ばせます。
        </p>
      </div>

      {/* --- 形状アシスト（D191）------------------------------------------
          **お題ではない。**「何を描くか」はこのあとの抽選で決まる。
          ここで決めるのは「それをどういう形として出すか」の取っかかりだけ。

          正式なお題と同じ大きさで見せない。守らせるものでもないので、
          文言も「決まり」ではなく「手がかり」として書く。
          出所: ユーザー指示（2026-09-09）「正式お題と視覚的に同格に見せない」
          「『必須条件』と誤解させない文言にする」。 */}
      <div className="space-y-3 border-t border-ink/10 pt-6" data-testid="shape-assist">
        <h2 className="text-sm font-bold">形状アシスト（任意）</h2>
        <p className="text-xs text-faint">
          お題ではありません。「このあと出るお題を、どういう形として描くか」の
          手がかりを1つだけ持って始められます。守らなくてもかまいませんし、
          クイズにも出ません。使わないままでも大丈夫です。
        </p>

        <div className="flex flex-wrap gap-2">
          {[
            { value: "none", label: "使わない" },
            { value: "random", label: "ランダムに1つ" },
            { value: "pick", label: "自分で選ぶ" },
          ].map((m, i) => (
            <label
              key={m.value}
              className="flex min-h-11 cursor-pointer items-center rounded-lg border border-line-mid px-3 py-2 text-xs has-checked:border-line-active has-checked:bg-hover"
            >
              <input
                type="radio"
                name="shapeAssistMode"
                value={m.value}
                defaultChecked={i === 0}
                className="mr-2"
              />
              {m.label}
            </label>
          ))}
        </div>

        <div className="space-y-2 rounded-xl bg-sunken p-4">
          <p className="text-xs text-faint">
            「自分で選ぶ」を選んだときの候補です。ここだけ押しても始まりません。
          </p>
          <div className="flex flex-wrap gap-2" data-testid="shape-assist-choices">
            {SHAPE_ASSISTS.map((sa) => (
              <label
                key={sa.key}
                className="flex min-h-11 cursor-pointer items-center rounded-lg border border-line-mid px-3 py-2 text-xs has-checked:border-line-active has-checked:bg-hover"
              >
                <input
                  type="radio"
                  name="shapeAssistKey"
                  value={sa.key}
                  className="mr-2"
                />
                {sa.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      {saved.slots.length > 0 ? (
        <div className="space-y-3 border-t border-ink/10 pt-6">
          <h2 className="text-sm font-bold">持ち出した要素を使う</h2>
          <p className="text-xs text-faint">
            保存枠ごとに分かれています。枠をまたいで選んでも構いません。
            合計 {MAX_CARRY_PER_DRAFT} 個まで選べます。選んだ要素は最初から入った状態で始まり、
            残りだけが抽選されます。選ばなければ全部抽選になります。
          </p>

          <ul className="space-y-3">
            {saved.slots.map((slot) => (
              <li
                key={slot.id}
                data-carry-slot={slot.id}
                data-scope={slot.scope}
                className="space-y-2 rounded-xl border border-line px-4 py-3"
              >
                <p className="text-xs text-faint">
                  {SCOPE_LABEL[slot.scope]}・{slot.element_count} 要素
                </p>
                <div className="flex flex-wrap gap-2">
                  {slot.elements.map((e) => (
                    <label
                      key={e.id}
                      data-saved-element={e.id}
                      className="flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-3 py-2 text-xs has-checked:border-line-active has-checked:bg-hover"
                    >
                      <input
                        type="checkbox"
                        name="carriedElementId"
                        value={e.id}
                        className="mr-2"
                      />
                      <span className="text-faint">{e.category_label}</span>
                      <span className="pl-2 font-bold">{e.tag_label}</span>
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          {saved.counts.session > 0 ? (
            <p className="text-xs text-faint">
              「いまの流れの中だけ」の {saved.counts.session} 枠は、
              お題を確定した時点で手元から無くなります。
              {saved.can_persist
                ? "下のボタンを押すと、別の日にも使えるように残せます。"
                : "アカウントを登録すると、次のセッションでも使えるようになります。"}
            </p>
          ) : null}

          <p className="text-xs text-faint">
            手元に残せるのは保存枠の数で数えます。自分のお題からの分（
            {saved.counts.self}／{saved.limits.self} 枠）と
            他の人のお題からの分（{saved.counts.others}／{saved.limits.others} 枠）。
            1つの枠には {MAX_ELEMENTS_PER_SLOT} 要素まで入ります。
          </p>
        </div>
      ) : signedIn ? (
        <p className={noticeMuted}>
          他の人の作品に答えると、そのお題から要素を1〜3個まとめて持ち出して、
          次の自分のお題に入れられます。まとめた1回ぶんが1つの保存枠になります。
        </p>
      ) : null}

      <SubmitButton
        pendingLabel="始めています…"
        className={`${btnPrimary} w-full`}
      >
        ドラフトを始める
      </SubmitButton>
    </form>

    {/* 「手元に残す」は別の form。**入れ子の form は成立しない**ので、
        始めるフォームの外に出す。押しても挑戦は始まらない。 */}
    {saved.can_persist && saved.counts.session > 0 ? (
      <form action={promoteSessionCarryAction}>
        <SubmitButton pendingLabel="残しています…" className={btnSecondary}>
          いまの流れの持ち出しを手元に残す（{saved.counts.session} 枠）
        </SubmitButton>
      </form>
    ) : null}

    <SavedElementsManager saved={saved} />
    </>
  );
}

/**
 * 手元の持ち出しを捨てる欄。
 *
 * 【なぜ「始める」フォームの外にあるか】
 *   捨てるのは form の送信なので、始めるフォームの中に置くと
 *   form が入れ子になって成立しない。並べて置く。
 *
 * 【なぜ要るか】
 *   保存には上限があり、**上限に達したら古いものを勝手に押し出さない。**
 *   捨てるのは利用者の操作だと決まっているので、その入口が要る。
 *   これが無いと、上限に達した時点で永久に新しい要素を保存できない。
 */
function SavedElementsManager({ saved }: { saved: SavedElements }) {
  if (saved.slots.length === 0) return null;

  return (
    <section className={`${surface} space-y-3`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">手元の保存枠</h2>
        <p className="text-xs text-faint">
          自分のお題から {saved.counts.self}／{saved.limits.self} 枠、
          他の人のお題から {saved.counts.others}／{saved.limits.others} 枠。
          数えているのは<span className="font-bold">枠の数</span>で、語の数ではありません。
          いっぱいのときは、枠を捨てると新しく保存できます。
        </p>
      </div>

      <ul className="space-y-2">
        {saved.slots.map((slot) => (
          <li
            key={slot.id}
            data-saved-manage={slot.id}
            data-element-count={slot.element_count}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line px-4 py-2 text-xs"
          >
            <span className="text-faint">{SCOPE_LABEL[slot.scope]}</span>
            <span className="font-bold">{slotSummary(slot)}</span>
            <span className="text-faint">{slot.element_count} 要素</span>
            <form action={deleteSavedCarrySlotAction} className="ml-auto">
              <input type="hidden" name="carrySlotId" value={slot.id} />
              <SubmitButton
                pendingLabel="捨てています…"
                data={{ "data-discard": String(slot.id) }}
                className="inline-flex min-h-11 items-center rounded-full border border-line-mid px-4 text-xs hover:bg-hover"
              >
                この枠を捨てる
              </SubmitButton>
            </form>
          </li>
        ))}
      </ul>
    </section>
  );
}


/* ===========================================================================
 * カード1枚
 * ===========================================================================
 *
 * カードの状態は4つ。**画面はこの4つしか知らない。**
 *
 *   hidden     まだ引いていない。中身を持っていない（サーバーが返さない）
 *   picked     仮に採用したカード。一巡目に引いたもの
 *   discarded  引き直しで捨てたカード。灰色になり × が付く。もう選べない
 *   open       引き直しのあとに開いた、選べる残りのカード
 *
 * 以前あった「めくったが決めていない」状態は無くなった（2026-09-08）。
 * 引いた瞬間に仮採用になるので、確認を待つ段が存在しない。
 */

const cardBase =
  "flex min-h-24 items-center justify-center rounded-2xl border px-3 py-4 text-center text-sm font-bold transition";

function HiddenCard({
  sessionId,
  cardSlotKey,
  candidateIndex,
}: {
  sessionId: string;
  cardSlotKey: string;
  candidateIndex: number;
}) {
  return (
    <form action={pickCardAction}>
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="cardSlotKey" value={cardSlotKey} />
      <input type="hidden" name="candidateIndex" value={candidateIndex} />
      {/* data-card が検査の手がかり。見た目を変えても枚数の検査は通る */}
      <SubmitButton
        pendingLabel="…"
        title="このカードを引く"
        data={{ "data-card": "hidden" }}
        className={`${cardBase} w-full cursor-pointer border-line-firm hover:border-ink/60 hover:bg-hover`}
      >
        ?
      </SubmitButton>
    </form>
  );
}

/** 引き直しのあとに開いた、選べる残りのカード */
function OpenCard({
  sessionId,
  cardSlotKey,
  candidateIndex,
  label,
}: {
  sessionId: string;
  cardSlotKey: string;
  candidateIndex: number;
  label: string | null;
}) {
  return (
    <form action={pickCardAction}>
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="cardSlotKey" value={cardSlotKey} />
      <input type="hidden" name="candidateIndex" value={candidateIndex} />
      <SubmitButton
        pendingLabel="…"
        data={{ "data-card": "open" }}
        className={`${cardBase} w-full cursor-pointer border-line-firm bg-surface hover:border-ink/60 hover:bg-hover`}
      >
        {label}
      </SubmitButton>
    </form>
  );
}

/** 仮に採用したカード */
function PickedCard({ label }: { label: string | null }) {
  return (
    <div
      data-card="picked"
      className={`${cardBase} border-line-active bg-hover`}
    >
      {label}
    </div>
  );
}

/**
 * 捨てたカード。
 *
 * **消さない。**何を捨てたかが見えていないと、引き直した意味が分からない。
 * 灰色にして大きな × を重ね、押せなくする。
 * `justDiscarded` が真のときだけ、短い退場の動きが1回出る。
 */
function DiscardedCard({
  label,
  justDiscarded,
}: {
  label: string | null;
  justDiscarded: boolean;
}) {
  return (
    <div
      data-card="discarded"
      aria-label={`捨てたカード ${label ?? ""}`}
      className={[
        cardBase,
        "relative select-none border-dashed border-ink/20 bg-sunken text-faint line-through",
        justDiscarded ? "dpq-discarded" : "grayscale opacity-60",
      ].join(" ")}
    >
      {label}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center text-4xl font-bold text-danger/70"
      >
        ×
      </span>
    </div>
  );
}

/* ===========================================================================
 * カテゴリ1つぶん
 * =========================================================================== */

function SlotRow({
  state,
  slot,
  discardedKey,
}: {
  state: DraftState;
  slot: DraftSlot;
  /** 直前に引き直したカテゴリ。ここだけ退場の動きを出す */
  discardedKey: string | null;
}) {
  const decided = slot.candidates.some((c) => c.is_chosen);
  const justDiscarded = discardedKey === slot.card_slot_key;

  // 一巡目に「いま引く」カテゴリか
  const pickingNow = slot.is_current && !decided && !slot.redo_used;

  return (
    <section className="space-y-3" data-slot-row={slot.card_slot_key}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-bold">
          {slot.slot_order}. {slot.card_slot_label}
        </h3>
        {slot.is_carried ? (
          <span className="text-xs text-success">持ち出し</span>
        ) : slot.needs_pick ? (
          <span className="text-xs font-bold text-danger">
            ← 引き直しました。残りから1枚選んでください
          </span>
        ) : decided && slot.redo_used ? (
          <span className="text-xs text-success">引き直して確定</span>
        ) : decided ? (
          <span className="text-xs text-success">
            {state.initial_pass_done ? "仮に採用" : "決定"}
          </span>
        ) : pickingNow ? (
          <span className="text-xs font-bold">← いまここ。1枚引きます</span>
        ) : (
          <span className="text-xs text-faint">順番待ち</span>
        )}
      </div>

      {/* サブ指令（D193）。決まった語に添える手がかりで、**お題ではない。**
          枠の見出しと同じ大きさで出さない。決まっていない枠には出ない
          （決まる前は必ず null）。断り書きは確定したお題の画面に1度だけ置く。 */}
      {subDirectiveLabel(slot.sub_directive_key) ? (
        <p
          data-testid="board-sub-directive"
          data-sub-directive-for={slot.card_slot_key}
          className="text-xs text-faint"
        >
          └ {subDirectiveLabel(slot.sub_directive_key)}
        </p>
      ) : null}

      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(${slot.candidates.length}, minmax(0, 1fr))`,
        }}
      >
        {slot.candidates.map((c) => {
          if (c.is_discarded) {
            return (
              <DiscardedCard
                key={c.candidate_index}
                label={c.label}
                justDiscarded={justDiscarded}
              />
            );
          }
          if (c.is_chosen) {
            return <PickedCard key={c.candidate_index} label={c.label} />;
          }
          if (slot.needs_pick) {
            return (
              <OpenCard
                key={c.candidate_index}
                sessionId={state.session_id}
                cardSlotKey={slot.card_slot_key}
                candidateIndex={c.candidate_index}
                label={c.label}
              />
            );
          }
          if (pickingNow) {
            return (
              <HiddenCard
                key={c.candidate_index}
                sessionId={state.session_id}
                cardSlotKey={slot.card_slot_key}
                candidateIndex={c.candidate_index}
              />
            );
          }
          // 順番待ち、または決まったあとの残り。押せない伏せカード
          return (
            <div
              key={c.candidate_index}
              className={`${cardBase} border-dashed border-ink/15 text-decor`}
            >
              ?
            </div>
          );
        })}
      </div>

      {slot.needs_pick ? (
        <p className="text-xs text-faint">
          捨てたカードは戻りません。残りから1枚選ぶと、このカテゴリは確定します。
        </p>
      ) : null}

      {/* 引き直しの入口。**押してもここでは捨てない。**確認の画面へ移る。
          出すかどうかは DB が返す can_redo だけで決める（条件を組み立て直さない）。 */}
      {slot.can_redo ? (
        <Link
          href={`/play?redo=${encodeURIComponent(slot.card_slot_key)}`}
          data-redo-link={slot.card_slot_key}
          className={`${btnQuiet} inline-block`}
        >
          このカテゴリを引き直す（1回だけ）
        </Link>
      ) : null}

      {state.initial_pass_done && slot.redo_used && decided ? (
        <p className="text-xs text-faint">
          このカテゴリは引き直しを使いました。もう引き直せません。
        </p>
      ) : null}
    </section>
  );
}

/* ===========================================================================
 * 引き直しの確認
 * ===========================================================================
 *
 * **弱い確認にしない。**取り消せない操作なので、盤面の上に小さく出す形では
 * なく、画面を1枚使って何が起きるかを書く。押し間違いでは辿り着けない。
 *
 * JavaScript の confirm() を使わないのは、
 *   ・切っている人には出ない
 *   ・戻るボタンで押し直せてしまう
 *   ・文面を組み立てられない
 * の3つ。ここはサーバーが描く普通の画面で、戻ってもう一度送っても
 * DB が2枚目を捨てないことは別に保証してある。
 */
export function RedoConfirm({
  state,
  cardSlotKey,
}: {
  state: DraftState;
  cardSlotKey: string;
}) {
  const slot = state.slots.find((s) => s.card_slot_key === cardSlotKey);
  const picked = slot?.candidates.find((c) => c.is_chosen);

  if (!slot || !picked || !slot.can_redo) {
    return (
      <div className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">このカテゴリは引き直せません</h2>
        <p className="text-sm text-muted">
          すでに引き直したか、ほかに候補が残っていません。引き直せるのは
          1つのカテゴリにつき1回だけです。
        </p>
        <Link href="/play" className={`${btnSecondary} inline-block`}>
          盤面へ戻る
        </Link>
      </div>
    );
  }

  return (
    <div
      data-redo-confirm={cardSlotKey}
      className="space-y-6 rounded-2xl border-2 border-danger-solid bg-danger-tint/10 p-6 sm:p-8"
    >
      <div className="space-y-2">
        <p className="text-xs font-bold tracking-wider text-danger">
          取り消せません
        </p>
        <h2 className="text-xl font-bold">
          「{picked.label}」を捨てて、{slot.card_slot_label}を引き直します
        </h2>
      </div>

      <div className="space-y-3 text-sm">
        <p className="font-bold">このカードは捨てられます。元には戻せません。</p>
        <ul className="space-y-1 text-muted">
          <li>- 捨てたカードは、このあとの選択肢に出てきません</li>
          <li>- 引き直せるのは、このカテゴリにつき1回だけです</li>
          <li>- 引き直すと、このカテゴリの残りの候補がすべて開きます</li>
          <li>- 開いた中から1枚選ぶと、そこで確定します</li>
          <li>- ドラフト全体の引き直しも、以降はできなくなります</li>
        </ul>
        <p className="font-bold">後悔しませんね？</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <form action={redoSlotAction}>
          <input type="hidden" name="sessionId" value={state.session_id} />
          <input type="hidden" name="cardSlotKey" value={cardSlotKey} />
          <SubmitButton
            pendingLabel="捨てています…"
            className={btnDanger}
            data={{ "data-redo-confirm-submit": cardSlotKey }}
          >
            「{picked.label}」を捨てて引き直す
          </SubmitButton>
        </form>
        <Link href="/play" className={`${btnSecondary} inline-block`}>
          やめる（このまま残す）
        </Link>
      </div>
    </div>
  );
}

/* ===========================================================================
 * 盤面
 * =========================================================================== */

export function DraftBoard({
  state,
  discardedKey = null,
}: {
  state: DraftState;
  discardedKey?: string | null;
}) {
  // 引き直したカテゴリが1つでもあると、全体の引き直しはできない。
  // **断られるボタンを置いたままにしない。**
  const locked = state.slots.some((s) => s.redo_used || s.pool_revealed);
  const waiting = state.slots.find((s) => s.needs_pick) ?? null;

  return (
    <div className="space-y-8">
      <div
        data-board=""
        data-chosen={state.chosen_count}
        data-slots={state.slot_count}
        data-pass-done={state.initial_pass_done ? "1" : "0"}
        className={`${surface} space-y-2`}
      >
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-base font-bold">{state.mode_label}</span>
          <span className="text-xs text-faint">
            制作時間 {formatDuration(state.time_limit_seconds)}
          </span>
          <span className="text-xs text-faint">
            {state.chosen_count} / {state.slot_count} 枠 決定
          </span>
          {state.rerolls_left > 0 && !locked ? (
            <span className="text-xs text-faint">
              引き直し 残り {state.rerolls_left} 回
            </span>
          ) : null}
          {/* 形状アシスト（D191）。**お題ではない**ので、枠と同じ大きさで出さない。
              進み具合と同じ行に、ただの控えとして並べる */}
          {shapeAssistLabel(state.shape_assist_key) ? (
            <span className="text-xs text-faint" data-testid="board-shape-assist">
              形状アシスト {shapeAssistLabel(state.shape_assist_key)}
            </span>
          ) : null}
        </div>

        {/* いまの段階で、利用者が次にすることを1行で書く */}
        {waiting ? (
          <p className="text-xs text-faint">
            {waiting.card_slot_label}の残りが開いています。1枚選ぶと確定します。
          </p>
        ) : state.initial_pass_done ? (
          <p className="text-xs text-faint">
            仮のお題がそろいました。気に入らないカテゴリは1回だけ引き直せます。
            引き直すと、いまのカードは捨てられて戻りません。
          </p>
        ) : (
          <p className="text-xs text-faint">
            カテゴリごとに1枚引きます。引いた時点で仮に採用され、次のカテゴリへ進みます。
            全部引き終わってから、気に入らないカテゴリだけ引き直せます。
            {state.carried_count > 0
              ? "持ち出した枠は最初から決まっているので、その次から始まります。"
              : ""}
          </p>
        )}
      </div>

      <div className="space-y-8">
        {state.slots.map((slot) => (
          <SlotRow
            key={slot.card_slot_key}
            state={state}
            slot={slot}
            discardedKey={discardedKey}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        {state.is_ready_to_complete ? (
          <form action={completeDraftAction}>
            <input type="hidden" name="sessionId" value={state.session_id} />
            <SubmitButton pendingLabel="確定しています…" className={btnPrimary}>
              このお題で確定する
            </SubmitButton>
          </form>
        ) : null}

        {state.rerolls_left > 0 && !locked ? (
          <form action={rerollDraftAction}>
            <input type="hidden" name="sessionId" value={state.session_id} />
            <SubmitButton pendingLabel="引き直しています…" className={btnSecondary}>
              全部引き直す（残り {state.rerolls_left} 回）
            </SubmitButton>
          </form>
        ) : null}

        <form action={abandonDraftAction}>
          <input type="hidden" name="sessionId" value={state.session_id} />
          <SubmitButton pendingLabel="捨てています…" className={btnQuiet}>
            このドラフトを捨てる
          </SubmitButton>
        </form>
      </div>

      {locked && state.rerolls_left > 0 ? (
        <p className="text-xs text-faint">
          引き直したカテゴリがあるので、全部の引き直しはもうできません。
        </p>
      ) : (
        <p className="text-xs text-faint">
          全部引き直すと、引いたカードは白紙に戻り、カテゴリの組み合わせから
          抽選し直しになります。
          {state.carried_count > 0 ? "持ち出した要素は引き直しても残ります。" : ""}
        </p>
      )}
    </div>
  );
}
