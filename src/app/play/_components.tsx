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
import { SubmitButton } from "@/app/_pending";
import {
  abandonDraftAction,
  chooseCardAction,
  holdCardAction,
  revealSlotPoolAction,
  completeDraftAction,
  deleteSavedCarrySlotAction,
  promoteSessionCarryAction,
  rerollDraftAction,
  revealCardAction,
  startDraftAction,
} from "./actions";
import {
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

/** 伏せカード1枚。めくる前は中身を持っていない */
function CandidateButton({
  sessionId,
  slot,
  candidateIndex,
  revealed,
  isChosen,
  isHeld,
  label,
  selectable,
  canHold,
}: {
  sessionId: string;
  slot: DraftSlot;
  candidateIndex: number;
  revealed: boolean;
  isChosen: boolean;
  isHeld: boolean;
  label: string | null;
  selectable: boolean;
  canHold: boolean;
}) {
  const base =
    "flex h-24 w-full items-center justify-center rounded-xl border text-center text-sm font-bold transition";

  if (isChosen) {
    return (
      <div
        className={`${base} border-success-tint/50 bg-success-tint/10 text-success`}
      >
        {label}
      </div>
    );
  }

  // めくってあるが、まだ決めていない（D170）。
  // **ここで確定しない。**決めるのは下のボタンを押したときだけ。
  if (revealed && selectable) {
    return (
      <div className="space-y-2">
        <div className={`${base} border-line-firm bg-surface`} data-card="revealed">
          {label}
        </div>
        <form action={chooseCardAction}>
          <input type="hidden" name="sessionId" value={sessionId} />
          <input type="hidden" name="cardSlotKey" value={slot.card_slot_key} />
          <input type="hidden" name="candidateIndex" value={candidateIndex} />
          <SubmitButton
            pendingLabel="決めています…"
            className={`${btnPrimary} w-full`}
          >
            これに決める
          </SubmitButton>
        </form>
        {canHold || isHeld ? (
          <form action={holdCardAction}>
            <input type="hidden" name="sessionId" value={sessionId} />
            <input type="hidden" name="cardSlotKey" value={slot.card_slot_key} />
            <input type="hidden" name="candidateIndex" value={candidateIndex} />
            <input type="hidden" name="hold" value={isHeld ? "off" : "on"} />
            <SubmitButton
              pendingLabel="…"
              className={`${btnSecondary} w-full`}
            >
              {isHeld ? "残すのをやめる" : "残しておく"}
            </SubmitButton>
          </form>
        ) : null}
      </div>
    );
  }

  if (revealed) {
    return (
      <div className={`${base} border-ink/10 bg-sunken text-faint`}>
        {label}
      </div>
    );
  }

  if (!selectable) {
    return (
      <div className={`${base} border-dashed border-ink/15 text-decor`}>
        ?
      </div>
    );
  }

  return (
    <form action={revealCardAction}>
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="cardSlotKey" value={slot.card_slot_key} />
      <input type="hidden" name="candidateIndex" value={candidateIndex} />
      {/* data-card が検査の手がかり。「?」という**文字**を数えさせない。
          めくる前のカードをどんな見た目にしても、枚数の検査は通る。 */}
      <SubmitButton
        pendingLabel="…"
        title="このカードをめくる"
        data={{ "data-card": "hidden" }}
        className={`${base} cursor-pointer border-line-firm hover:border-ink/60 hover:bg-hover`}
      >
        ?
      </SubmitButton>
    </form>
  );
}

/** 1つの枠と、その伏せカード一式 */
function SlotRow({ state, slot }: { state: DraftState; slot: DraftSlot }) {
  const decided = slot.candidates.some((c) => c.is_chosen);
  const heldCount = slot.candidates.filter((c) => c.is_held).length;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-bold">
          {slot.slot_order}. {slot.card_slot_label}
        </h3>
        {/* 持ち出した枠は、めくる前から中身が決まっている（D161）。
            「決定」とだけ書くと、自分が引いたものと見分けが付かない */}
        {slot.is_carried ? (
          <span className="text-xs text-success">持ち出し</span>
        ) : decided ? (
          <span className="text-xs text-success">決定</span>
        ) : slot.is_current ? (
          <span className="text-xs font-bold">
            ← いまここ。めくって中身を見てから決めます
          </span>
        ) : (
          <span className="text-xs text-faint">順番待ち</span>
        )}
      </div>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${slot.candidates.length}, minmax(0, 1fr))` }}
      >
        {slot.candidates.map((c) => (
          <CandidateButton
            key={c.candidate_index}
            sessionId={state.session_id}
            slot={slot}
            candidateIndex={c.candidate_index}
            revealed={c.revealed}
            isChosen={c.is_chosen}
            isHeld={c.is_held}
            label={c.label}
            selectable={slot.is_current && !decided}
            canHold={heldCount < slot.held_limit && !slot.pool_revealed}
          />
        ))}
      </div>

      {/*
        残した候補があるときだけ、その枠の残りを開ける（D170）。
        **開いても候補は増えない。**総ドラフト基数は動かない。
        開いた枠は、そこで抽選が終わる。
      */}
      {slot.is_current && !decided && heldCount > 0 && !slot.pool_revealed ? (
        <form action={revealSlotPoolAction}>
          <input type="hidden" name="sessionId" value={state.session_id} />
          <input type="hidden" name="cardSlotKey" value={slot.card_slot_key} />
          <SubmitButton pendingLabel="開いています…" className={btnSecondary}>
            残した{heldCount}枚はそのままに、この枠の残りを見る
          </SubmitButton>
        </form>
      ) : null}

      {slot.is_current && !decided && !slot.pool_revealed ? (
        <p className="text-xs text-faint">
          この枠の候補は {slot.candidate_count} 枚。残しておけるのは {slot.held_limit} 枚までです
          （全部は残せません）。
        </p>
      ) : null}

      {slot.pool_revealed ? (
        <p className="text-xs text-faint">
          この枠は残りを開きました。ここから1枚選んでください。新しい候補は増えません。
        </p>
      ) : null}
    </section>
  );
}

/** 進行中のドラフト盤面 */
export function DraftBoard({ state }: { state: DraftState }) {
  return (
    <div className="space-y-8">
      {/* 進み具合は data-* にも出す。以前の検査は「0 / 5 枠 決定」という
          **文言**で盤面が出たことを確かめていたので、言い回しを変えると落ちた。 */}
      <div
        data-board=""
        data-chosen={state.chosen_count}
        data-slots={state.slot_count}
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
          <span className="text-xs text-faint">
            引き直し 残り {state.rerolls_left} 回
          </span>
          {state.carried_count > 0 ? (
            <span className="text-xs text-success">
              持ち出し {state.carried_count} 個
            </span>
          ) : null}
        </div>
        <p className="text-xs text-faint">
          カードをめくっても、まだ決まりません。中身を見てから「これに決める」を押すと確定します。気に入ったものを残したまま、その枠の残りを開くこともできます。
          {state.carried_count > 0
            ? "持ち出した枠は最初から決まっているので、その次から始まります。"
            : ""}
        </p>
      </div>

      <div className="space-y-8">
        {state.slots.map((slot) => (
          <SlotRow key={slot.card_slot_key} state={state} slot={slot} />
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        {state.is_ready_to_complete ? (
          <form action={completeDraftAction}>
            <input type="hidden" name="sessionId" value={state.session_id} />
            <SubmitButton
              pendingLabel="確定しています…"
              className={btnPrimary}
            >
              このお題で確定する
            </SubmitButton>
          </form>
        ) : null}

        {state.rerolls_left > 0 ? (
          <form action={rerollDraftAction}>
            <input type="hidden" name="sessionId" value={state.session_id} />
            <SubmitButton
              pendingLabel="引き直しています…"
              className={btnSecondary}
            >
              全部引き直す（残り {state.rerolls_left} 回）
            </SubmitButton>
          </form>
        ) : null}

        <form action={abandonDraftAction}>
          <input type="hidden" name="sessionId" value={state.session_id} />
          <SubmitButton
            pendingLabel="捨てています…"
            className={btnQuiet}
          >
            このドラフトを捨てる
          </SubmitButton>
        </form>
      </div>

      <p className="text-xs text-faint">
        引き直すと選んだカードは白紙に戻り、カテゴリの組み合わせから引き直しになります。
        {state.carried_count > 0
          ? "持ち出した要素は引き直しても残ります。"
          : ""}
      </p>
    </div>
  );
}
