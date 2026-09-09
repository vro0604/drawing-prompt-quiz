"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/env";
import {
  EMAIL_RATE_LIMIT_MESSAGE,
  SAME_PASSWORD,
  authErrorMessage,
  isEmailRateLimit,
} from "@/features/auth/errors";
import {
  LINK_FIELDS,
  callEnqueueMyAvatarCleanup,
  callSetMyAvatar,
  callSetMySpecialties,
  callUpdateMyProfile,
  callUpdateMyVisibility,
} from "@/features/profile/rpc";
import { VISIBILITY_FIELDS } from "@/features/profile/types";
import {
  AVATAR_MAX_BYTES,
  avatarStoragePath,
} from "@/features/profile/avatar";
import { readImageInfo } from "@/features/work/image";
import { removeWorkImage, uploadWorkImage } from "@/features/work/rpc";
import { getCurrentUser } from "@/features/auth/session";
import { callAgree } from "@/features/consent/rpc";

/**
 * /account のボタンから呼ばれる Server Action。
 *
 * 【この画面の位置づけ】
 *   spec 13 の Step 6（登録／匿名→昇格＋handle 設定）の**最小版**。
 *   handle・表示名・プロフィールの設定は Step 6 本体で作る。
 *   ここにあるのは「作品投稿は登録ユーザーだけ」（spec C3 / D27-1）を
 *   ブラウザで満たすために要る最低限だけ。
 *
 * 【昇格を signUp でやらない理由】
 *   ゲストの状態で signUp を呼ぶと **別の uid のユーザーが新しくできる**。
 *   引いたお題は元のゲストのものなので、新しいアカウントからは投稿できない
 *   （create_work の検査2で弾かれる）。
 *
 *   updateUser でメールを結びつけると **uid はそのまま**で永続アカウントに
 *   変わる（spec 11-2）。auth.users のトリガーが profiles.is_anonymous も
 *   false に直す（001_profiles.sql の 4-b）。
 *
 * 【refreshSession を必ず呼ぶ理由】
 *   投稿できるかどうかの判定は JWT の is_anonymous で行う（spec 9-1）。
 *   updateUser はユーザー情報を書き換えるだけで、手元のアクセストークンは
 *   古いまま（is_anonymous: true）残る。取り直さないと、
 *   登録できたのに投稿だけ断られる、という分かりにくい状態になる。
 */

const PAGE = "/account";

/*
 * SAME_PASSWORD（同じパスワードを送った印。**二重送信の合図**として使う）と
 * 送信枠切れの判定・文面は features/auth/errors.ts にまとめてある。
 * 画面に出す文はすべてそこを通す。**生のエラー文を出さない。**
 */

/**
 * 確認メールのリンクから戻ってくる場所。
 *
 * **必ず正規URLを使う**（siteUrl）。個別 Deployment URL を混ぜると、
 * 引き換えに要る控えが読めず、確認が完了しない。
 */
const CONFIRM_URL = siteUrl("/auth/confirm");

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function back(message?: string, notice?: string): never {
  const params = new URLSearchParams();
  if (message) params.set("error", message);
  if (notice) params.set("notice", notice);
  const query = params.toString();
  redirect(query ? `${PAGE}?${query}` : PAGE);
}

/**
 * 同意を記録する。**記録できないときは黙って諦める（P5）。**
 *
 * 【なぜ諦めてよいか】
 *   記録できる条件は「IDが確定していて、匿名でないこと」。
 *   まったくの新規登録では、メールの確認が終わるまでこれが揃わない。
 *   その場合はここで何もせず、**次に画面を開いたときに /consent が出る。**
 *   関門は DB 側にあるので、記録し損ねた人が素通りすることはない。
 *
 *   逆に、ここで失敗を画面に出すと「登録できたのにエラーが出る」ことになる。
 *   登録そのものは終わっているので、それは嘘になる。
 */
async function recordConsent(terms: string, privacy: string): Promise<void> {
  if (!terms || !privacy) return;
  try {
    await callAgree(terms, privacy);
  } catch {
    /* まだ記録できる状態ではない。/consent が引き受ける */
  }
}

/** メールとパスワードでサインインする（既にあるアカウントへ） */
export async function signInAction(form: FormData): Promise<void> {
  const email = str(form, "email");
  const password = str(form, "password");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  // 生のエラー文は出さない。「なぜ入れないのか」だけを日本語で伝える
  if (error) {
    back(
      authErrorMessage(
        error,
        "サインインできませんでした。メールアドレスとパスワードを確かめてください。",
      ),
    );
  }

  revalidatePath(PAGE);
  back(undefined, "サインインしました。");
}

/** 送信済みのときに出す文。再送していないことが伝わる言葉にする */
const ALREADY_SENT =
  "確認メールは送信済みです。受信箱をご確認ください。" +
  "（迷惑メールに入っていることがあります）";

/** メールは大文字小文字を区別しない。比較の前にそろえる */
function sameEmail(a: string | undefined | null, b: string): boolean {
  return typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * 昇格の途中で失敗したとき、**いまの状態を読み直して**判定する。
 *
 * 【なぜ状態を見るか】
 *   エラーの文面で分岐すると、Supabase 側の文言が変わった日に壊れる。
 *   すでにメールが入った／確認待ちになったのなら、
 *   **利用者にとっては成功している。**そこを見て決める。
 *
 * @returns 成功として扱ってよければ画面に出す文。だめなら null
 */
async function successFromCurrentState(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  const user = data.user;
  if (!user) return null;

  // すでにそのメールで確定している（確認が要らない設定のとき、または確認済み）
  if (sameEmail(user.email, email) && !user.is_anonymous) {
    return "登録は完了しています。ゲストのときに引いたお題はそのまま使えます。";
  }

  // 確認待ちに入っている。**もう一通は送らない**
  if (sameEmail(user.new_email, email) || sameEmail(user.email, email)) {
    return ALREADY_SENT;
  }

  return null;
}

/**
 * アカウントを登録する。
 *
 * ゲストとして来ている場合は昇格（同じ uid のまま）、
 * まったくの未サインインなら新規作成。
 *
 * 【二重送信への備え（本番で実際に起きた）】
 *   ボタンに反応が無かったため、利用者が2回押していた。
 *   1回目の updateUser は**パスワードを即座に確定**させ、
 *   メールは確認待ちに入れて確認メールを送る。
 *   2回目は同じパスワードを送るので Supabase が same_password を返し、
 *   **リクエスト全体が失敗**して「登録できませんでした」と出ていた。
 *
 *   対策は3つ重ねる。
 *
 *   1. 押した瞬間にボタンを塞ぐ（SubmitButton）
 *   2. **送る前に**、同じメールが既に入っている／確認待ちなら送らない
 *   3. それでも失敗したら、**状態を読み直して**成功か判断する
 *
 *   2 と 3 があるので、同時に何本届いても**メールは増えない。**
 *
 * 【同じメールの再送と、別のメールへの変更を混同しない】
 *   確認待ちのメールと入力が**同じ**なら、何もせず「送信済み」と返す。
 *   **違う**なら、宛先を変える操作なので updateUser を実行する。
 *   このとき既にパスワードが確定していると same_password になるので、
 *   その1回だけ**メールだけ**で送り直す。
 *
 * 【いまの構造で判定できないこと】
 *   Auth のユーザー情報には「パスワードが設定済みか」が入っていない。
 *   そのため、パスワードを送ってよいかを**事前には決められない。**
 *   same_password が返ってきたことを、設定済みの合図として使っている。
 */
export async function registerAction(form: FormData): Promise<void> {
  const email = str(form, "email");
  const password = str(form, "password");

  // --- 規約への同意（P5）------------------------------------------------------
  //
  // **登録の条件にする。**チェックが無ければ、メールも1通も送らない。
  // 記録するのは登録が通ったあと（匿名のままでは記録できないため）。
  const terms = str(form, "termsVersion");
  const privacy = str(form, "privacyVersion");
  if (str(form, "agreeDocs") !== "on") {
    back("利用規約とプライバシーポリシーへの同意が必要です。同意の欄にチェックを入れてください。");
  }

  const supabase = await createSupabaseServerClient();
  const { data: current } = await supabase.auth.getUser();

  // --- ゲストからの昇格（uid を保つ）-----------------------------------------
  if (current.user?.is_anonymous) {
    // 同じ人の昇格は1本ずつ通す。**まったく同時に届いた場合の備え**
    return oneAtATime(current.user.id, () =>
      promoteGuest(supabase, email, password, terms, privacy),
    );
  }

  return createNewAccount(supabase, email, password, terms, privacy);
}

/**
 * 同じ鍵の処理を、この処理系の中では**1本ずつ**にする。
 *
 * 【なぜ要るか】
 *   状態を読み直す備え（D87）は、**1本目の書き込みが終わっていれば**効く。
 *   ところが本当に同時だと、5本とも「まだメールは入っていない」を読み、
 *   5本とも送ってしまう。実測で**確認メールが4通よけいに出た。**
 *
 *   Enter とクリックが同じ瞬間に重なると、これが起こりうる。
 *   届く順を1本ずつにすれば、2本目は1本目の結果を読める。
 *
 * 【できないこと】
 *   これは**この処理系の中だけ**の順番付け。
 *   本番で処理系が複数に分かれると、またぎ越して同時に届くことはある。
 *   それでも「送る前に読む」「same_password なら読み直す」が残るので、
 *   増えるとしても稀な1通で、**壊れることはない。**
 *   完全に1通にするには記録を持つ場所が要る（テーブルを増やすことになる）。
 */
const inFlight = new Map<string, Promise<void>>();

async function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const mine = previous.then(run, run);

  // 待ち行列は失敗で止めない。redirect も例外として飛んでくる
  const tail = mine.then(
    () => {},
    () => {},
  );
  inFlight.set(key, tail);
  void tail.then(() => {
    if (inFlight.get(key) === tail) inFlight.delete(key);
  });

  return mine;
}

/** ゲストに メールとパスワードを結び付ける（uid はそのまま） */
async function promoteGuest(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
  password: string,
  terms: string,
  privacy: string,
): Promise<never> {
  {
    // 送る前に見る。ここで止まれば、メールは1通も増えない
    const already = await successFromCurrentState(supabase, email);
    if (already) {
      revalidatePath(PAGE);
      back(undefined, already);
    }

    let { error } = await supabase.auth.updateUser(
      { email, password },
      { emailRedirectTo: CONFIRM_URL },
    );

    // same_password は「同じ合言葉が既に設定されている」という意味。
    // **一度も設定していなければ起きない。**
    // つまりこれは、同じ内容の送信が既に通っていた証拠になる。
    const duplicate = error?.code === SAME_PASSWORD;

    if (duplicate) {
      // **ここでもう一度、状態を読み直す。**
      //   same_password が返るのは、同じ内容の書き込みが**既に終わっている**
      //   ということ。パスワードと確認待ちは1回の更新で一緒に入るので、
      //   この時点で読めば必ず確認待ちが見える。
      //
      //   読まずに送り直すと、同時に届いた本数だけ**確認メールが増える。**
      //   実測で、5本同時に送ると4通よけいに出ていた。
      const sent = await successFromCurrentState(supabase, email);
      if (sent) {
        revalidatePath(PAGE);
        back(undefined, sent);
      }

      // 確認待ちが**別のメール**だった。宛先を変える操作なので、
      // パスワードを外して送り直す（同じ合言葉は2度送れない）
      ({ error } = await supabase.auth.updateUser(
        { email },
        { emailRedirectTo: CONFIRM_URL },
      ));
    }

    if (error) {
      // 送信の回数制限に当たった場合も含めて、いまの状態で判断する。
      // 状態から成功と言えるなら、そう返す（生のエラーは出さない）
      const recovered = await successFromCurrentState(supabase, email);
      if (recovered) {
        revalidatePath(PAGE);
        back(undefined, recovered);
      }

      // **状態がまだ見えないことがある。**
      //   同時に届いた1本目が書き込みを終える前に、2本目がここへ来ると
      //   getUser にはまだ確認待ちが映らない。それでも same_password が
      //   出た以上、同じ送信が通っているのは確かなので、成功として返す。
      if (duplicate) {
        revalidatePath(PAGE);
        back(undefined, ALREADY_SENT);
      }

      // 送信枠を使い切っただけのときは、**登録の失敗として書かない。**
      // 内蔵メールは1時間に2通しか送れない（launch-checklist 手順5）。
      // 利用者は入力を直しようがないので、待てばよいことだけを伝える。
      if (isEmailRateLimit(error)) back(EMAIL_RATE_LIMIT_MESSAGE);

      back(
        authErrorMessage(
          error,
          "登録できませんでした。入力を確かめて、もう一度お試しください。" +
            "（同じメールで何度も試した場合は、届いているメールをご確認ください）",
        ),
      );
    }

    // JWT を取り直して is_anonymous を false にする（上のコメント参照）
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();

    if (refreshError) {
      back(
        [
          "メールとパスワードは登録できましたが、ログイン情報の取り直しに失敗しました。",
          "いったんサインアウトして、登録したメールでサインインし直してください。",
        ].join("\n"),
      );
    }

    // 匿名でなくなっていれば、この場で同意を記録する（P5）。
    // 確認待ちの間はまだ匿名なので記録できない。そのときは /consent が引き受ける。
    if (refreshed.user && !refreshed.user.is_anonymous) {
      await recordConsent(terms, privacy);
    }

    revalidatePath(PAGE);

    // メール確認が必要な設定のときは、確認するまで匿名のまま。
    back(
      undefined,
      refreshed.user?.is_anonymous
        ? "確認メールを送りました。リンクを開くと登録が完了し、作品を投稿できるようになります。"
        : "登録が完了しました。ゲストのときに引いたお題はそのまま使えます。",
    );
  }
}

/** まったくの未サインインから、新しくアカウントを作る */
async function createNewAccount(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
  password: string,
  terms: string,
  privacy: string,
): Promise<never> {
  // 戻り先を昇格と同じ /auth/confirm にそろえる。そうしないと
  // 確認リンクがトップに落ちて、サインインし直しを求めることになる。
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: CONFIRM_URL },
  });

  // 未サインインからの新規作成でも、送信枠切れは起こる。
  // ここは昇格と違って**まだ何も残っていない**ので、成功と偽らずに案内する
  if (error) {
    if (isEmailRateLimit(error)) back(EMAIL_RATE_LIMIT_MESSAGE);
    back(
      authErrorMessage(
        error,
        "登録できませんでした。メールアドレスとパスワードを確かめてください。",
      ),
    );
  }

  // セッションが返っていれば、この場で同意を記録する（P5）。
  // 返っていなければ（＝メールの確認待ち）、確認後に /consent が引き受ける。
  if (data.session) await recordConsent(terms, privacy);

  revalidatePath(PAGE);

  // メール確認が必要な設定だと session が返らない。その場合は
  // このブラウザはまだサインインしていない。
  back(
    undefined,
    data.session
      ? "登録が完了しました。"
      : "確認メールを送りました。リンクを開いてから、もう一度サインインしてください。",
  );
}

/**
 * プロフィール（ID・表示名・自己紹介・外部リンク）を更新する。
 *
 * 【空欄の扱い】
 *   未入力は空文字で届く。それをそのまま渡すと DB 側で
 *   「空にはできません」と断られてしまうので、空欄は
 *   **「変更しない」（null）** に寄せてから渡す。
 *
 *   そのため、この画面から値を消すことはできない。
 *   消す操作が要るようになったら、専用のボタンを足して区別する
 *   （空欄と「消したい」を同じ入力に載せると取り違える。D49）。
 *
 * 【リンク】
 *   キーは LINK_FIELDS で固定してある。入力があったものだけを集める。
 *   値が http(s) で始まるかは DB 側が見る（javascript: を弾くため）。
 */
/**
 * 「語のIDをカンマでつないだ欄」を数の並びに直す。
 *
 * **画面から来た値を信じない。**数でないもの・重複・多すぎる件数は
 * ここで落とすが、同じ判定は set_my_specialties も持っている。
 */
function parseTagIds(raw: string): number[] {
  const out: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isSafeInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * 消せなかったファイルを、掃除の待ち行列へ渡す。
 *
 * **ここで失敗しても、呼び出し側は止めない。**渡せなかったこと自体は
 * 保存の成否と関係が無く、止めると「保存できたのに失敗と出る」ことになる。
 */
async function handOverToCleanup(path: string): Promise<void> {
  try {
    await callEnqueueMyAvatarCleanup(path);
  } catch {
    /* 掃除へ渡せなかった。保存そのものは終わっている */
  }
}

/**
 * プロフィールのアイコンを、選ばれていれば置き換える。
 *
 * 【Storage と DB は、まとめて巻き戻せない】
 *   画像の置き場（Storage）と DB は別の仕組みなので、片方だけ成功する。
 *   4つの失敗を、それぞれどう扱うかを決めてある。
 *
 *   1. 置くのに失敗した
 *      → DB は触っていない。いまのアイコンはそのまま。保存を失敗にする
 *   2. 置けたが、DB に書けなかった
 *      → **置いたファイルをその場で消す。**消せなければ掃除へ渡す。
 *        誰からも辿れないファイルを残さない。保存は失敗にする
 *   3. DB に書けたが、前のファイルを消せなかった
 *      → 新しいアイコンは正しく使える。**保存は失敗にしない。**
 *        前のファイルは掃除へ渡す
 *   4. アイコンを外したが、ファイルを消せなかった
 *      → プロフィールは既定の表示に戻る（DB は空になっている）。
 *        ただし**古いURLを知っている人には、消えるまで画像が見える。**
 *        これも掃除へ渡す
 *
 * 【順番】
 *   中身を読んで形式と大きさを確かめる → 新しい名前で置く → DB に書く →
 *   前のファイルを消す。**先に消してから置かない。**
 */
async function applyAvatar(form: FormData): Promise<void> {
  const remove = str(form, "avatarRemove") === "1";
  const file = form.get("avatar");
  const picked = file instanceof File && file.size > 0 ? file : null;

  if (!picked && !remove) return;

  // --- 外す（4） -------------------------------------------------------
  if (remove && !picked) {
    const { previous_path } = await callSetMyAvatar(null);
    if (previous_path && !(await removeWorkImage(previous_path))) {
      await handOverToCleanup(previous_path);
    }
    return;
  }

  if (!picked) return;

  // --- 受け取ってよい中身か --------------------------------------------
  //
  // 大きさは**中身のバイト数**で見る。画面でも止めているが、
  // 受け口が見ないと、画面を通さずに送られたときに素通りする。
  if (picked.size > AVATAR_MAX_BYTES) {
    throw new Error(
      `アイコンは ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)}MB までです。`,
    );
  }

  const bytes = new Uint8Array(await picked.arrayBuffer());
  const info = readImageInfo(bytes);
  if (!info) {
    throw new Error("アイコンは JPEG / PNG / WebP のみです。");
  }

  const user = await getCurrentUser();
  if (!user) throw new Error("サインインし直してください。");

  // --- 置く（1） -------------------------------------------------------
  const path = avatarStoragePath(user.id, info.ext);
  await uploadWorkImage(path, bytes, info);

  // --- DB に書く（2・3） -----------------------------------------------
  let previous: string | null = null;
  try {
    previous = (await callSetMyAvatar(path)).previous_path;
  } catch (e) {
    if (!(await removeWorkImage(path))) await handOverToCleanup(path);
    throw e;
  }

  if (previous && previous !== path && !(await removeWorkImage(previous))) {
    await handOverToCleanup(previous);
  }
}

/**
 * プロフィールを保存する。
 *
 * 【3つを順に保存する。途中で失敗したら、そこまでは保存されている】
 *   1. プロフィール（ID・表示名・自己紹介・外部リンク）
 *   2. 得意分野（描く側・見る側）
 *   3. アイコン
 *
 *   3つは別々の受け口なので、まとめて巻き戻せない。**巻き戻せないものを
 *   「全部失敗しました」と書かない。**どこまで保存できたかを画面に出す。
 *   出所: ユーザー指示（2026-09-09）「実際には部分成功しているのに
 *   『全部rollbackされた』ように表示しないこと」。
 */
export async function updateProfileAction(form: FormData): Promise<void> {
  const handle = str(form, "handle");
  const displayName = str(form, "displayName");
  const bio = str(form, "bio");

  const links: Record<string, string> = {};
  for (const field of LINK_FIELDS) {
    const value = str(form, `link_${field.key}`);
    if (value !== "") links[field.key] = value;
  }

  const drawing = parseTagIds(str(form, "drawingTagIds"));
  const viewing = parseTagIds(str(form, "viewingTagIds"));

  const steps: { label: string; run: () => Promise<unknown> }[] = [
    {
      label: "プロフィール",
      run: () =>
        callUpdateMyProfile({
          handle: handle === "" ? null : handle,
          displayName: displayName === "" ? null : displayName,
          bio: bio === "" ? null : bio,
          // リンクは「1つも入力が無い」と「全部消したい」を区別できないため、
          // 何か入力があるときだけ送る。
          links: Object.keys(links).length > 0 ? links : null,
        }),
    },
    {
      // 得意分野は**毎回まとめて置き換える。**0件で送れば0件になる
      // （リンクと違い、「全部外したい」を表せる必要がある）。
      label: "得意分野",
      run: () => callSetMySpecialties(drawing, viewing),
    },
    { label: "アイコン", run: () => applyAvatar(form) },
  ];

  const saved: string[] = [];
  let failure: { label: string; reason: string } | null = null;

  for (const step of steps) {
    try {
      await step.run();
      saved.push(step.label);
    } catch (e) {
      failure = { label: step.label, reason: e instanceof Error ? e.message : String(e) };
      break;
    }
  }

  // 途中まで保存できていれば、その分は画面へ反映させる
  revalidatePath(PAGE);
  // 一覧や作品ページの投稿者名も変わるので、まとめて描き直させる
  revalidatePath("/works");

  if (failure) {
    const done =
      saved.length > 0 ? `${saved.join("と")}は保存しました。` : "";
    back(`${done}${failure.label}を保存できませんでした: ${failure.reason}`);
  }

  back(undefined, "プロフィールを更新しました。");
}

/**
 * 公開設定（3つのチェックボックス）を更新する。
 *
 * 【チェックボックスは「外したこと」が届かない】
 *   HTML のチェックボックスは、入っているときだけ値が送られる。
 *   だから「入っていない ＝ フォームに無い」で false を作る。
 *   ここで null（変更しない）に寄せてしまうと、**一度入れた設定を
 *   二度と外せなくなる**。プロフィールの空欄とは扱いが逆になる。
 *
 *   その代わり、この画面は必ず3つとも送る。1つだけ更新する経路を
 *   作らないので、フォームに無い＝外した、と読んで間違いがない。
 */
export async function updateVisibilityAction(form: FormData): Promise<void> {
  const update: Record<string, boolean> = {};
  for (const field of VISIBILITY_FIELDS) {
    update[field.key] = form.get(field.key) !== null;
  }

  try {
    await callUpdateMyVisibility(update);
  } catch (e) {
    back(e instanceof Error ? e.message : String(e));
  }

  revalidatePath(PAGE);
  revalidatePath("/saves");
  back(undefined, "公開設定を更新しました。");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  revalidatePath(PAGE);
  back(undefined, "サインアウトしました。");
}
