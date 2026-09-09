import Link from "next/link";
import { getCurrentUser, getMyProfile } from "@/features/auth/session";
import { SubmitButton } from "@/app/_pending";
import {
  fetchMySpecialties,
  fetchPickableVocabulary,
} from "@/features/profile/rpc";
import { VISIBILITY_FIELDS } from "@/features/profile/types";
import { avatarInitial, avatarUrl } from "@/features/profile/avatar";
import { EMPTY_VOCABULARY, type Vocabulary } from "@/features/vocab/types";
import type { PickedTag } from "@/features/vocab/picker";
import { EMPTY_SPECIALTIES, type Specialties } from "@/features/profile/types";
import { ProfileForm } from "./_profile-form";
import type { Profile } from "@/types/database";
import {
  registerAction,
  signInAction,
  signOutAction,
  updateProfileAction,
  updateVisibilityAction,
} from "./actions";
import {
  btnPrimary,
  btnSecondary,
  field,
  noticeError,
  noticeSuccess,
  surface,
} from "@/app/_surface";
import { AuthConfirmedBeacon } from "@/app/_auth-sync";

/**
 * /account ／ アカウントの最小画面。
 *
 * 【なぜ最小か】
 *   spec 13 の Step 6（登録・昇格・handle 設定）の本体はまだ先。
 *   ここにあるのは「作品の投稿は登録ユーザーだけ」（spec C3 / D27-1）を
 *   ブラウザで満たすために要る分だけ。
 *   handle・表示名・プロフィール・パスワード再設定は Step 6 で作る。
 *
 * 【ゲストに見せる文言】
 *   ここで signUp を選ぶと uid が変わり、引いたお題を持ち主ごと失う。
 *   だからゲストには「登録する」しか出さない（内部では昇格を呼ぶ）。
 *
 * Next.js 16 では searchParams が Promise なので await が必要。
 */

export const metadata = {
  title: "アカウント",
};

/*
 * この画面のボタンは全部が横いっぱいに伸びる（フォームが縦に並ぶため）。
 * 形そのものは共通の定数が持ち、ここでは幅だけを足す。
 */
const primary = `${btnPrimary} w-full`;
const secondary = `${btnSecondary} w-full`;

/** メールとパスワードの2欄。サインインにも登録にも同じ形を使う */
function Credentials({ idPrefix }: { idPrefix: string }) {
  return (
    <>
      <label className="block space-y-1">
        <span className="block text-xs text-faint">メールアドレス</span>
        <input
          id={`${idPrefix}-email`}
          type="email"
          name="email"
          required
          autoComplete="email"
          className={field}
        />
      </label>
      <label className="block space-y-1">
        <span className="block text-xs text-faint">
          パスワード（6文字以上）
        </span>
        <input
          id={`${idPrefix}-password`}
          type="password"
          name="password"
          required
          minLength={6}
          className={field}
        />
      </label>
    </>
  );
}

/**
 * 登録のときに求める同意（P5）。
 *
 * 【なぜ投稿のときではなく、ここか】
 *   投稿の直前に同意欄を出していたときは、規約を読む場面が
 *   **作品を出す一歩手前**にあった。読む余裕が無い場所で、
 *   しかも投稿しない人には一度も出なかった。
 *   登録に移すと、サービスを使い始める前に一度だけ読むことになる。
 *
 * 【押しただけでは記録されないことがある】
 *   ゲストからの昇格は、その場で記録できる（IDが既にあるため）。
 *   まったくの新規は、メールの確認が終わるまでIDが確定しないので、
 *   **その場では記録できない。**確認のあと最初に開いたときに
 *   /consent が出て、そこで記録する。どちらの道でも、
 *   同意していない人が通常の画面へ進むことはない。
 */
function ConsentCheck({
  idPrefix,
  termsVersion,
  privacyVersion,
}: {
  idPrefix: string;
  termsVersion: string;
  privacyVersion: string;
}) {
  return (
    <div data-register-consent="" className="space-y-2">
      <input type="hidden" name="termsVersion" value={termsVersion} />
      <input type="hidden" name="privacyVersion" value={privacyVersion} />
      <label className="flex items-start gap-3 text-sm">
        <input
          id={`${idPrefix}-agree`}
          type="checkbox"
          name="agreeDocs"
          value="on"
          required
          className="mt-1 size-4"
        />
        <span>
          <a href="/terms" target="_blank" className="underline">
            利用規約
          </a>
          と
          <a href="/privacy" target="_blank" className="underline">
            プライバシーポリシー
          </a>
          に同意します。
        </span>
      </label>
      <p className="text-xs text-faint">
        同意した記録として、どの版にいつ同意したかを5年間だけ保存します。
        退会するとこの記録からあなたとの結び付きが外れます。
      </p>
    </div>
  );
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; confirmed?: string }>;
}) {
  const { error, notice, confirmed } = await searchParams;
  const user = await getCurrentUser();

  const isGuest = user?.is_anonymous === true;
  const isRegistered = user !== null && !user.is_anonymous;

  // 登録の欄に出す同意のために、いま有効な版を読む（P5）。
  // **未サインインでも読める**（get_current_documents は anon にも許可）。
  const docs = await fetchCurrentDocuments();

  // 登録ユーザーのときだけ、いまの設定値をフォームの初期値として読む。
  // 自分の行は RLS で必ず見えるので、ここは直接読んでよい（001 の SELECT ポリシー）。
  let profile: Profile | null = null;
  let vocabulary: Vocabulary = EMPTY_VOCABULARY;
  let specialties: Specialties = EMPTY_SPECIALTIES;
  if (isRegistered) {
    profile = await getMyProfile();
    // 語の一覧と、いま選んである得意分野。**持ち込みと同じ語彙**を使う。
    [vocabulary, specialties] = await Promise.all([
      fetchPickableVocabulary(),
      fetchMySpecialties(),
    ]);
  }

  /**
   * 保存してある得意分野を、選択部品が扱える形へ直す。
   *
   * DB は語と分類の「名前」を返すが、部品は分類の中身（語の一覧・上限）ごと
   * 必要とする。**語彙側に見つからないものは落とす。**
   * 分類が使われなくなった場合に、選べない語だけが残るのを防ぐ。
   */
  function toPicked(list: Specialties["drawing"]): PickedTag[] {
    const out: PickedTag[] = [];
    for (const s of list) {
      const cat = vocabulary.categories.find(
        (c) => c.category_key === s.category_key,
      );
      const tag = cat?.tags.find((t) => t.id === s.tag_id);
      if (cat && tag) out.push({ tag, category: cat });
    }
    return out;
  }

  const initialDrawing = toPicked(specialties.drawing);
  const initialViewing = toPicked(specialties.viewing);

  return (
    <main className="mx-auto w-full max-w-lg space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">アカウント</h1>
        <p className="text-sm text-faint">
          お題を引く・クイズに答えるはゲストのままできます。
          作品の投稿にはアカウントが必要です。
        </p>
      </header>

      {error ? (
        <p className={noticeError}>
          {error}
        </p>
      ) : null}

      {/*
        メールの確認から戻ってきた面（D171）。
        **同じブラウザの他のタブへ合図を送る。**受け取ったタブは
        サーバーへ聞き直すだけで、合図そのものを認証の証拠にしない。

        別の端末で開いた人には合図が届かない。だからここには
        「元のタブに戻る」だけでなく、このまま続けられることも書く。
      */}
      {confirmed === "1" ? (
        <>
          <AuthConfirmedBeacon />
          <section className={`${surface} space-y-2`}>
            <h2 className="text-sm font-bold">登録が完了しました</h2>
            <p className="text-sm text-muted">
              同じブラウザで登録を始めたタブを開いたままなら、そちらの表示が
              自動で切り替わります。元のタブに戻って続けてください。
            </p>
            <p className="text-xs text-faint">
              別の端末やブラウザでこのリンクを開いた場合、元の画面は自動では
              切り替わりません。元の画面を読み込み直すか、このままこの画面で
              続けてください。どちらでも同じアカウントです。
            </p>
          </section>
        </>
      ) : null}

      {notice ? (
        <p className={noticeSuccess}>
          {notice}
        </p>
      ) : null}

      {/* --- いまの状態 -------------------------------------------------------- */}
      <section className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">いまの状態</h2>
        {isRegistered ? (
          <div className="space-y-1 text-sm">
            <p>
              登録ユーザーとしてサインインしています（{user.email ?? "メール未設定"}）。
            </p>
            <p className="text-xs text-faint">ID: {user.id}</p>
          </div>
        ) : isGuest ? (
          <div className="space-y-1 text-sm">
            <p>ゲストとして遊んでいます。作品の投稿はできません。</p>
            <p className="text-xs text-faint">ID: {user.id}</p>
          </div>
        ) : (
          <p className="text-sm">まだサインインしていません。</p>
        )}
      </section>

      {/* --- 登録ユーザー：プロフィール ---------------------------------------- */}
      {isRegistered ? (
        <section className={`${surface} space-y-4`}>
          <div className="space-y-1">
            <h2 className="text-sm font-bold">プロフィール</h2>
            <p className="text-xs text-faint">
              ここで決めた表示名が、作品一覧や作品ページに出ます。
              空欄のままにした項目は変更されません。
            </p>
          </div>

          <ProfileForm
            action={updateProfileAction}
            handle={profile?.handle ?? ""}
            displayName={profile?.display_name ?? ""}
            bio={profile?.bio ?? ""}
            links={profile?.links ?? {}}
            avatarUrl={profile?.avatar_path ? avatarUrl(profile.avatar_path) : null}
            avatarInitial={avatarInitial(profile?.display_name ?? "")}
            categories={vocabulary.categories}
            initialDrawing={initialDrawing}
            initialViewing={initialViewing}
          />

          {profile?.handle ? (
            <p className="border-t border-ink/10 pt-4 text-sm">
              <Link href={`/u/${profile.handle}`} className="underline">
                公開プロフィールを見る（/u/{profile.handle}）
              </Link>
            </p>
          ) : (
            <p className="border-t border-ink/10 pt-4 text-xs text-faint">
              ID を決めると、公開プロフィールのページ（/u/あなたのID）ができます。
            </p>
          )}
        </section>
      ) : null}

      {/* --- 登録ユーザー：公開設定 -------------------------------------------- */}
      {isRegistered ? (
        <section className={`${surface} space-y-4`}>
          <div className="space-y-1">
            <h2 className="text-sm font-bold">公開設定</h2>
            <p className="text-xs text-faint">
              すべて既定では公開しません。
              <strong>投稿した作品と、描き手としての記録は常に公開されます。</strong>
            </p>
          </div>

          <form action={updateVisibilityAction} className="space-y-4">
            {VISIBILITY_FIELDS.map((f) => (
              <label key={f.key} className="flex gap-3">
                <input
                  type="checkbox"
                  name={f.key}
                  defaultChecked={profile?.[f.key] ?? false}
                  className="mt-1 size-4 shrink-0"
                />
                <span className="space-y-1">
                  <span className="block text-sm">{f.label}</span>
                  <span className="block text-xs text-faint">
                    {f.note}
                  </span>
                </span>
              </label>
            ))}

            <SubmitButton pendingLabel="保存しています…" className={primary}>
              公開設定を保存する
            </SubmitButton>
          </form>

          <p className="border-t border-ink/10 pt-4 text-sm">
            <Link href="/saves" className="underline">
              自分のお気に入りを見る
            </Link>
            <span className="ml-2 text-xs text-faint">
              公開設定に関わらず、自分では常に見られます
            </span>
          </p>
        </section>
      ) : null}

      {/* --- ゲスト：昇格 ------------------------------------------------------ */}
      {isGuest ? (
        <section className={`${surface} space-y-4`}>
          <div className="space-y-1">
            <h2 className="text-sm font-bold">アカウントを登録する</h2>
            <p className="text-xs text-faint">
              いまのゲストにメールとパスワードを結びつけます。
              <strong>IDは変わりません。</strong>
              引いたお題も、これまでの記録もそのまま残ります。
            </p>
          </div>
          <form action={registerAction} className="space-y-4">
            <Credentials idPrefix="promote" />
            <ConsentCheck
              idPrefix="promote"
              termsVersion={docs.terms?.version ?? ""}
              privacyVersion={docs.privacy?.version ?? ""}
            />
            <SubmitButton pendingLabel="登録中…" className={primary}>
              このゲストのまま登録する
            </SubmitButton>
          </form>
        </section>
      ) : null}

      {/* --- 未サインイン：登録／サインイン ------------------------------------ */}
      {user === null ? (
        <>
          <section className={`${surface} space-y-4`}>
            <h2 className="text-sm font-bold">新しく登録する</h2>
            <form action={registerAction} className="space-y-4">
              <Credentials idPrefix="signup" />
              <ConsentCheck
                idPrefix="signup"
                termsVersion={docs.terms?.version ?? ""}
                privacyVersion={docs.privacy?.version ?? ""}
              />
              <SubmitButton pendingLabel="登録中…" className={primary}>
                登録する
              </SubmitButton>
            </form>
          </section>

          <section className={`${surface} space-y-4`}>
            <h2 className="text-sm font-bold">登録済みの方はこちら</h2>
            <form action={signInAction} className="space-y-4">
              <Credentials idPrefix="signin" />
              <SubmitButton pendingLabel="サインイン中…" className={secondary}>
                サインインする
              </SubmitButton>
            </form>
          </section>
        </>
      ) : null}

      {/* --- アカウント（サインアウト・退会）------------------------------------

          出所: ユーザー指示（2026-09-08）「プロフィール設定と危険な
          アカウント操作を同じ情報密度で連続させない」。
          機能は1つも減らしていない。**1つのまとまりにして、
          プロフィールの設定欄とのあいだに区切りを置いた。** */}
      {user !== null ? (
        <section className={`${surface} space-y-4`} data-testid="account-group">
          <div className="space-y-1">
            <h2 className="text-sm font-bold">アカウント</h2>
            <p className="text-xs text-faint">
              ここから下は、プロフィールの設定ではなくアカウントそのものの操作です。
            </p>
          </div>

          <form action={signOutAction}>
            <SubmitButton pendingLabel="サインアウト中…" className={secondary}>
              サインアウトする
            </SubmitButton>
          </form>

          {isGuest ? (
            <p className="text-xs text-danger">
              ゲストのままサインアウトすると、そのIDには二度と戻れません。
              引いたお題も見られなくなります。
            </p>
          ) : null}

          {/*
            退会はゲストに出さない。メールもプロフィールも持たないので
            消すものが無く、使われなくなれば自動で消えるため。
            いちばん下に置き、確認画面を挟む。ここでは実行しない。
          */}
          {!isGuest ? (
            <div className="space-y-2 border-t border-ink/10 pt-4">
              <h3 className="text-sm font-bold">退会</h3>
              <p className="text-xs text-faint">
                アカウントと投稿した作品を削除します。取り消せません。
                次の画面で、何が消えて何が残るかを確認できます。
              </p>
              <p className="pt-1 text-sm">
                <Link href="/account/delete" className="underline">
                  退会の手続きへ進む
                </Link>
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

    </main>
  );
}
