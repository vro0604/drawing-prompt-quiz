"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ensureUserId } from "@/features/auth/session";
import { callSubmitAnswer } from "@/features/quiz/rpc";
import type { AnswerSelection } from "@/features/quiz/types";
import { callCreateReport } from "@/features/report/rpc";
import {
  captchaConfigError,
  captchaRequired,
  verifyCaptcha,
} from "@/features/report/captcha";
import { callSavePromptElements } from "@/features/carry/rpc";
import {
  EMPTY_SAVED,
  type SavedCarrySlot,
  type SavedElements,
} from "@/features/carry/types";
import { fetchNextWorkId, recordUsageEvent } from "@/features/discover/rpc";
import {
  callOpenFlavorHint,
  callPostFlavorReply,
  callSetFlavorText,
} from "@/features/flavor/rpc";
import type { FlavorReplyToken } from "@/features/flavor/types";
import {
  callDeleteWork,
  callMarkWorkImageDeleted,
  callPublishWork,
  callToggleLike,
  callToggleSave,
  callUnpublishWork,
  removeWorkImage,
} from "@/features/work/rpc";

/**
 * 作品ページのボタンから呼ばれる Server Action。
 *
 * 公開／下書きの切り替えだけを行う。どちらも update_work を呼ぶ。
 *
 * **本人確認はここでしない。** update_work が
 * 「その作品の user_id は auth.uid() と一致するか」を見るので、
 * 他人の作品IDを送っても「見つかりません」で終わる（D40）。
 */

/** FormData から必ず文字列を取り出す（無ければ空文字） */
function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

/** 失敗したら理由を URL に載せて作品ページへ戻る */
function backWithError(workId: string, e: unknown): never {
  const message = e instanceof Error ? e.message : String(e);
  redirect(`/works/${workId}?error=${encodeURIComponent(message)}`);
}

export async function publishWorkAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  try {
    await callPublishWork(workId);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}`);
}

export async function unpublishWorkAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  try {
    await callUnpublishWork(workId);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}`);
}

/**
 * いいね・保存を付ける／外す。
 *
 * 【回答と違って、ここでは匿名サインインをしない】
 *   いいねと保存は登録ユーザー限定（D7 / spec 10）。
 *   ここで ensureUserId を呼ぶと、押せもしないゲストを1人作ってしまう。
 *   閲覧しただけの人でユーザーを増やさない方針（spec 11-1）にも反する。
 *
 * 【判定は DB 側】
 *   ゲストかどうかは toggle_like / toggle_save が JWT で見る。
 *   ここを通り抜けても必ず止まる。
 */
async function toggleReaction(
  form: FormData,
  run: (workId: string) => Promise<unknown>,
): Promise<void> {
  const workId = str(form, "workId");

  try {
    await run(workId);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  // 一覧にも件数が出ているので、そちらも描き直させる
  revalidatePath("/works");
  redirect(`/works/${workId}`);
}

export async function toggleLikeAction(form: FormData): Promise<void> {
  await toggleReaction(form, callToggleLike);
}

export async function toggleSaveAction(form: FormData): Promise<void> {
  await toggleReaction(form, callToggleSave);
}

/**
 * クイズの回答を送る。
 *
 * 【フォームの読み取り】
 *   出題側は問ごとに name="q_{question_id}"、value=tag_id のチェックボックスを出す。
 *   ここではその接頭辞が付いた項目を問ごとに集め直す。
 *
 *     1つ入っていた → ビタ当て（tag_id だけを送る）
 *     2つ入っていた → 2択当て（tag_id と tag_id_2 を送る）
 *     3つ以上       → 断る（下記）
 *
 *   答えていない問はそもそも送られてこないので、数が足りなければ
 *   DB 側が INCOMPLETE_ANSWER で断る。ここでは数を数えない
 *   （何問あるべきかを知っているのは DB だけなので、二重管理にしない）。
 *
 * 【3つ以上をここで断る理由】
 *   DB の submit_answer は1問につき2語までしか受け取らない形なので、
 *   ここで黙って切り捨てると「選んだのに数えられなかった」ことになる。
 *   **黙って捨てるより、断って選び直してもらう。**
 *   1問あたりの上限そのものは DB 側にもあり、ここはその写しではなく
 *   「送る形に直せない入力を断る」処理である。
 *
 * 【匿名サインインのタイミング】
 *   ページを開いただけでは発行しない（spec 11-1）。
 *   「回答する」を押した瞬間＝最初の書き込みで初めて発行する。
 *   ゲストのまま回答できるのは仕様どおり（spec 10 の権限表）。
 *
 * 【正しさの判定はここでしない】
 *   自作への回答か、2回目か、選択肢にある答えかは、すべて
 *   submit_answer が見る。ここを通り抜けても DB 側で必ず止まる。
 */
export async function submitAnswerAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  // 問ごとに、選ばれたタグを集める（同じ name が2回来ることがある）
  const byQuestion = new Map<number, number[]>();

  for (const [key, value] of form.entries()) {
    if (!key.startsWith("q_")) continue;

    const questionId = Number.parseInt(key.slice(2), 10);
    const tagId = Number.parseInt(typeof value === "string" ? value : "", 10);
    if (!Number.isFinite(questionId) || !Number.isFinite(tagId)) continue;

    const picked = byQuestion.get(questionId) ?? [];
    if (!picked.includes(tagId)) picked.push(tagId);
    byQuestion.set(questionId, picked);
  }

  const selections: AnswerSelection[] = [];

  for (const [questionId, tagIds] of byQuestion) {
    if (tagIds.length > 2) {
      backWithError(
        workId,
        new Error(
          "1つの問に選べるのは1つ（ビタ当て）か2つ（2択当て）までです。" +
            "3つ以上選ばれた問があります。",
        ),
      );
    }

    selections.push(
      tagIds.length === 2
        ? { question_id: questionId, tag_id: tagIds[0], tag_id_2: tagIds[1] }
        : { question_id: questionId, tag_id: tagIds[0] },
    );
  }

  try {
    // ここが「最初の書き込み」。必要ならこの瞬間にゲストが発行される
    await ensureUserId();
    await callSubmitAnswer(workId, selections);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}`);
}

/**
 * 作品を削除する。**取り返しがつきにくい操作**なので、確認画面から呼ぶ。
 *
 * 【誤操作を防ぐ】
 *   確認画面で作品タイトルの再入力を求め、一致しないときは何もしない。
 *   照合をここで行うのは、DB に渡す前に止めるため（DB 側は
 *   「本人か」しか見ない。タイトルは画面の都合であって、
 *   データの正しさの条件ではない）。
 *
 * 【順序】
 *   1. delete_work … 公開から外し、deleted_at を立てる（DB）
 *   2. Storage から画像を消す
 *   3. mark_work_image_deleted … 消せたことを記録する
 *
 *   2 と 3 が失敗しても作品は削除済みのままで、公開へは戻らない
 *   （update_work が deleted_at を見て断る）。残るのは容量の問題だけで、
 *   Step 16 の掃除が「deleted_at はあるが image_deleted_at が無い」
 *   作品を拾って再試行する。
 *
 *   だから 2 と 3 の失敗はここで握りつぶす。ここで例外にすると、
 *   **削除は成功しているのに画面には失敗と出る**という、
 *   いちばん誤解を生む結果になる。
 */
export async function deleteWorkAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");
  const typedTitle = str(form, "confirmTitle").trim();
  const actualTitle = str(form, "expectedTitle").trim();

  if (typedTitle === "" || typedTitle !== actualTitle) {
    redirect(
      `/works/${workId}/delete?error=${encodeURIComponent(
        "作品タイトルが一致しません。削除していません。",
      )}`,
    );
  }

  let imagePath: string | null = null;

  try {
    const result = await callDeleteWork(workId);
    imagePath = result.image_path;
  } catch (e) {
    redirect(
      `/works/${workId}/delete?error=${encodeURIComponent(
        e instanceof Error ? e.message : String(e),
      )}`,
    );
  }

  // ここから先の失敗は握りつぶす（上記の理由）。
  //
  // **消せたときだけ印を付ける。** 消せていないのに記録すると、
  // Step 16 の掃除がその作品を対象から外し、消し残しが永久に残る。
  if (imagePath) {
    try {
      const removed = await removeWorkImage(imagePath);
      if (removed) await callMarkWorkImageDeleted(workId);
    } catch {
      // 消し残しは Step 16 の掃除が拾う
    }
  }

  revalidatePath("/works");
  revalidatePath("/rankings");
  revalidatePath(`/works/${workId}`);
  redirect("/works?notice=" + encodeURIComponent("作品を削除しました。"));
}

/**
 * 作品を通報する。
 *
 * **ゲストも送れる**（spec 8-4）。通報は「見つけた人が知らせる」行為で、
 * 登録を求めると、いちばん多くの作品を見ている層からの報告が届かなくなる。
 *
 * 未サインインの場合はここでゲストが発行される（ensureUserId）。
 * create_report は anon から呼べないため、この一手が要る。
 */
export async function createReportAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");
  const reason = str(form, "reason");
  const detail = str(form, "detail").trim();

  // --- CAPTCHA（P6）-----------------------------------------------------
  //
  // **本番で鍵が足りなければ、通報そのものを断る**（D78）。
  // 以前は「鍵が無ければ素通し」だったが、それだと環境変数を1つ
  // 入れ忘れただけで CAPTCHA の無い状態ができあがり、しかも
  // 画面は何も変わらないので誰も気づけない。守れないなら受け付けない。
  //
  // 素通しになるのは、開発で鍵をどちらも入れていないときだけ
  // （captchaRequired() が false）。
  //
  // 検証に行けなかった場合も通さない。「確かめられなかったから通す」に
  // すると、検証先を落とすだけで CAPTCHA を無効化できてしまう。
  //
  // proxy でも同じ判定をしている（入口で 503 にする）。ここにも置くのは、
  // proxy が matcher の書き換えひとつで外れるため。**片方だけには頼らない。**
  const configError = captchaConfigError();

  if (configError) {
    redirect(`/works/${workId}/report?error=${encodeURIComponent(configError)}`);
  }

  if (captchaRequired()) {
    const token = str(form, "cf-turnstile-response");
    const headerList = await headers();
    const ip =
      headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      headerList.get("x-real-ip") ??
      undefined;

    const verdict = await verifyCaptcha(token, ip);

    if (!verdict.ok) {
      // 理由は短くしか出さない。何が引っかかったかを詳しく返すと、
      // 通し方を探る手がかりになる。
      redirect(
        `/works/${workId}/report?error=${encodeURIComponent(
          `${verdict.reason}。画面を読み込み直して、もう一度お試しください。`,
        )}`,
      );
    }
  }

  try {
    await ensureUserId();
    await callCreateReport({
      workId,
      reason,
      detail: detail === "" ? null : detail,
    });
  } catch (e) {
    redirect(
      `/works/${workId}/report?error=${encodeURIComponent(
        e instanceof Error ? e.message : String(e),
      )}`,
    );
  }

  redirect(
    `/works/${workId}?notice=${encodeURIComponent(
      "報告を受け付けました。ご協力ありがとうございます。",
    )}`,
  );
}

/* ===========================================================================
 * 回答後の導線・共有・持ち出し・フレーバー（2026-09-04 追加）
 * ===========================================================================
 *
 * ここに増えた入口はどれも「押せる人を画面で絞っている」が、
 * **それは親切であって守りではない。**ゲストか登録者か、回答済みか未回答かは
 * すべて DB 側の RPC が JWT と行の有無で判定する。
 * フォームを直接叩かれても、必ずそちらで止まる。
 */

/**
 * 共有する。
 *
 * 【なぜ押すだけで何も起きないように見えるのか】
 *   押すと `?share=open` に移り、共有用の面が開く。そこにURLが出る。
 *   ブラウザの共有機能を呼ぶには JavaScript が要るが、この画面は
 *   JavaScript 無しでも動くように作ってあるので、URLを見せる形にした。
 *
 * 【ここで数える】
 *   共有は行が増えない操作なので、記録しないと数えられない。
 *   数えるのに失敗しても共有は止めない（recordUsageEvent が握りつぶす）。
 */
export async function openShareAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  await recordUsageEvent("share_opened", workId || null);

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}?share=open`);
}

/**
 * 次の作品へ移る。
 *
 * まだ答えていない公開作品を DB に1件選んでもらい、そこへ移動する。
 * 1件も無いときは作品一覧へ送る（行き止まりにしない）。
 */
export async function nextWorkAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");
  let nextId: string | null = null;

  try {
    nextId = await fetchNextWorkId(workId || null);
  } catch {
    // 取れなくても行き止まりにしない。一覧へ送る
    nextId = null;
  }

  await recordUsageEvent("next_work_opened", nextId);

  redirect(nextId ? `/works/${nextId}` : "/works");
}

/**
 * 開示されたお題から要素を1〜3個、**1つの保存枠にまとめて**持ち出す（D161）。
 *
 * 保存できる数の上限は保存枠の数で数える（自分のお題から5枠・他者から3枠）。
 * 数の検査も、その語が本当にそのお題に入っているかの検査も DB 側。
 * ここでやるのはチェックボックスを数字の配列に直すことだけ。
 *
 * 【自分のお題か、他の人のお題かをここで決めない】
 *   送るのは「どの作品から」と「どの語を」の2つだけ。
 *   その作品の持ち主が誰かは save_prompt_elements が DB を見て決める。
 *   画面から `self` や `others` を申告する経路は無い。
 *   **申告できる形にすると、他人のお題を自分の枠として保存できてしまう。**
 *
 * 【何が起きたかを、起きたとおりに書く】
 *   ゲストの持ち出しは永続保存にならない（DB が session の枠にする）。
 *   ここで「保存しました」と書くと、残ると思わせてしまう。
 *   だから戻り値の区分を見てから文面を決める。**画面が決めた区分ではない。**
 */
export async function carryElementsAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  const tagIds = form
    .getAll("tagId")
    .map((v) => Number.parseInt(typeof v === "string" ? v : "", 10))
    .filter((n) => Number.isFinite(n));

  if (tagIds.length === 0) {
    backWithError(workId, new Error("持ち出す要素を選んでください。"));
  }

  let saved: SavedElements = EMPTY_SAVED;
  try {
    saved = await callSavePromptElements("work", workId, tagIds);
  } catch (e) {
    backWithError(workId, e);
  }

  // いま作られた枠（＝いちばん新しい枠）の区分を見る
  const created = saved.slots.reduce<SavedCarrySlot | null>(
    (newest, slot) => (newest === null || slot.id > newest.id ? slot : newest),
    null,
  );
  const isSessionOnly = created === null ? !saved.can_persist : created.scope === "session";

  const notice = isSessionOnly
    ? `${tagIds.length}個をまとめて1つの枠にしました。` +
      "これは保存ではありません。この流れの間だけ使えます。" +
      "次のお題を確定すると手元から無くなります。" +
      "別の日にも残すにはアカウント登録が必要です。"
    : `${tagIds.length}個をまとめて1つの保存枠にしました（${
        created?.source_is_own ? "自分のお題から" : "他の人のお題から"
      }）。次にお題を引くとき、この枠の中から選んで始められます。`;

  revalidatePath(`/works/${workId}`);
  revalidatePath("/play");
  redirect(`/works/${workId}?notice=${encodeURIComponent(notice)}`);
}

/** 回答前に、作者の文章をヒントとして開く（D162）。開いた事実が記録される */
export async function openFlavorHintAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  try {
    await callOpenFlavorHint(workId);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}?hint=open`);
}

/**
 * 作者が自作の文章を保存する（D162）。
 *
 * 正解に近すぎる語が混じっていれば set_flavor_text が断る。
 * **画面で候補を絞っているだけでは守りにならない**ので、保存でも同じ関門を通す。
 */
export async function setFlavorTextAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  const vocabIds = form
    .getAll("vocabId")
    .map((v) => Number.parseInt(typeof v === "string" ? v : "", 10))
    .filter((n) => Number.isFinite(n));

  if (vocabIds.length === 0) {
    backWithError(workId, new Error("語を1つ以上選んでください。"));
  }

  try {
    await callSetFlavorText(workId, vocabIds);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(
    `/works/${workId}?notice=${encodeURIComponent("作者の文章を保存しました。")}`,
  );
}

/**
 * 返歌を送る（D162）。**正誤判定は無い。**
 *
 * 送れるのは、すでに正解が開示されている語（そのお題のタグ）と、
 * 確認済みの制限語彙だけ。判定は post_flavor_reply が行う。
 */
export async function postFlavorReplyAction(form: FormData): Promise<void> {
  const workId = str(form, "workId");

  const tokens: FlavorReplyToken[] = [];

  for (const raw of form.getAll("token")) {
    if (typeof raw !== "string") continue;
    // 値は "v:123"（制限語彙）か "t:456"（開示済みの正解タグ）
    const [kind, idText] = raw.split(":");
    const id = Number.parseInt(idText ?? "", 10);
    if (!Number.isFinite(id)) continue;

    if (kind === "v") tokens.push({ vocab_id: id });
    else if (kind === "t") tokens.push({ tag_id: id });
  }

  if (tokens.length === 0) {
    backWithError(workId, new Error("語を1つ以上選んでください。"));
  }

  try {
    await callPostFlavorReply(workId, tokens);
  } catch (e) {
    backWithError(workId, e);
  }

  revalidatePath(`/works/${workId}`);
  redirect(`/works/${workId}?notice=${encodeURIComponent("返歌を送りました。")}`);
}
