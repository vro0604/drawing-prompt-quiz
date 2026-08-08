import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser, getMyProfile } from "@/features/auth/session";
import type { Profile } from "@/types/database";
import { ActionButton, Field, Layout, Section, Status } from "../_ui";
import { ensureGuestAction, signOutAction } from "./actions";

/**
 * 匿名サインインと profiles 自動生成の動作確認ページ（開発用）。
 *
 * 確認したいのは次の2つ。
 *   1. ボタン（＝書き込み操作の代わり）を押すとゲストIDが発行されること
 *   2. そのとき profiles の行が自動で1つできていること
 *
 * ページを開いただけでは何も発行しない。これは仕様（spec 11-1）で、
 * 見ているだけの訪問者でユーザーを増やさないため。
 */

const NOTE =
  "このページは開発用です。本番の画面では、ゲストにサインアウトのボタンを見せません（戻れなくなるため）。";

/** テーブルがまだ無いことを示すエラーかどうか */
function looksLikeMissingTable(message: string): boolean {
  return (
    message.includes("PGRST205") ||
    message.includes("42P01") ||
    message.toLowerCase().includes("could not find the table")
  );
}

export default async function AuthHealthPage({
  searchParams,
}: {
  // Next.js 16 では searchParams が Promise なので await が必要
  searchParams: Promise<{ error?: string }>;
}) {
  // **本番では出さない。**開発用の診断画面で、
  // 誰でも1クリックでゲストを作れるボタンが付いている。
  // 匿名サインインは1時間30回・IP単位の上限があるので（D83）、
  // 公開したままにする理由が無い。
  if (process.env.NODE_ENV === "production") notFound();

  const { error: actionError } = await searchParams;

  const user = await getCurrentUser();

  let profile: Profile | null = null;
  let profileError: string | null = null;
  if (user) {
    try {
      profile = await getMyProfile();
    } catch (e) {
      profileError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <Layout title="匿名サインイン診断" note={NOTE}>
      <Status {...judge({ actionError, user, profile, profileError })} />

      {actionError && (
        <Section label="エラー内容">
          <p className="whitespace-pre-wrap">{actionError}</p>
        </Section>
      )}

      <Section label="いまのあなた">
        {user ? (
          <dl className="space-y-1">
            <Field label="ユーザーID">{user.id}</Field>
            <Field label="種別">{user.is_anonymous ? "ゲスト（匿名）" : "登録済み"}</Field>
            <Field label="発行日時">{new Date(user.created_at).toLocaleString("ja-JP")}</Field>
          </dl>
        ) : (
          <p>まだサインインしていません。下のボタンが「初めての書き込み」の代わりです。</p>
        )}
      </Section>

      <Section label="profiles の行">
        {!user ? (
          <p className="text-ink/50">
            ユーザーが発行されると、ここに自動で作られた行が表示されます。
          </p>
        ) : profileError ? (
          <p className="whitespace-pre-wrap">{profileError}</p>
        ) : profile ? (
          <dl className="space-y-1">
            <Field label="表示名">{profile.display_name}</Field>
            <Field label="handle">{profile.handle ?? "（未設定。登録時に決める）"}</Field>
            <Field label="匿名">{profile.is_anonymous ? "true" : "false"}</Field>
            <Field label="成績を公開">{profile.show_answer_stats ? "する" : "しない"}</Field>
            <Field label="回答履歴を公開">{profile.show_answer_history ? "する" : "しない"}</Field>
            <Field label="保存作品を公開">{profile.show_saved_works ? "する" : "しない"}</Field>
            <Field label="作成日時">{new Date(profile.created_at).toLocaleString("ja-JP")}</Field>
          </dl>
        ) : (
          <p>行がありません。自動生成のしくみがまだ入っていない可能性があります。</p>
        )}
      </Section>

      <Section label="操作">
        <div className="flex flex-wrap gap-3">
          <form action={ensureGuestAction}>
            <ActionButton>
              {user ? "もう一度試す（発行済みなら何も起きない）" : "書き込みを試す（ゲストIDを発行）"}
            </ActionButton>
          </form>
          {user && (
            <form action={signOutAction}>
              <ActionButton variant="quiet">サインアウト</ActionButton>
            </form>
          )}
        </div>
        <p className="pt-3 text-xs text-ink/50">
          発行済みの状態でもう一度押しても、新しいユーザーは増えません。
          既にサインインしていれば、そのIDをそのまま返すためです。
        </p>
      </Section>

      {hints({ actionError, user, profile, profileError }).length > 0 && (
        <Section label="確認する箇所">
          <ol className="list-decimal space-y-1 pl-5">
            {hints({ actionError, user, profile, profileError }).map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ol>
        </Section>
      )}

      <Section label="ほかの診断">
        <Link className="underline" href="/health">
          /health — Supabase への接続確認
        </Link>
      </Section>
    </Layout>
  );
}

type State = {
  actionError?: string;
  user: { id: string } | null;
  profile: Profile | null;
  profileError: string | null;
};

function judge({ actionError, user, profile, profileError }: State): {
  ok: boolean | null;
  title: string;
} {
  if (actionError) return { ok: false, title: "ゲストIDを発行できませんでした" };
  if (!user) return { ok: null, title: "まだサインインしていません" };
  if (profileError) return { ok: false, title: "profiles を読めませんでした" };
  if (!profile) return { ok: false, title: "ゲストIDは出ましたが profiles の行がありません" };
  return { ok: true, title: "ゲストIDが発行され、profiles も自動で作られました" };
}

function hints({ actionError, user, profile, profileError }: State): string[] {
  if (actionError?.includes("匿名サインインが Supabase 側で無効")) {
    return [
      "Supabase ダッシュボード → Authentication → Sign In / Providers を開く",
      "Anonymous sign-ins を有効にして保存する",
      "このページに戻ってもう一度ボタンを押す",
    ];
  }

  if (profileError && looksLikeMissingTable(profileError)) {
    return [
      "supabase/migrations/001_profiles.sql をまだ実行していない可能性が高い",
      "Supabase ダッシュボード → SQL Editor にファイルの中身を貼り付けて Run",
      "このページを再読み込みする",
    ];
  }

  if (user && !profileError && !profile) {
    return [
      "001_profiles.sql の最後にあるトリガー部分が実行されているか確認する",
      "SQL Editor で: select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;",
      "トリガーを付け直したら、いちどサインアウトして再度ボタンを押す（既存ユーザーには後から行が作られないため）",
    ];
  }

  return [];
}
