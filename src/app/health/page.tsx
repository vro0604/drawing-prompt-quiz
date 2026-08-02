import Link from "next/link";
import { connection } from "next/server";
import { missingSupabaseEnv, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Field, Layout, Section, Status } from "./_ui";

const NOTE = "このページは開発用です。Step 3 でテーブルを作成したら本物のクエリに置き換えます。";

/**
 * Supabase との接続を確認するための診断ページ（開発用）。
 *
 * まだテーブルを1つも作っていない段階なので、
 * 「存在しないテーブルを問い合わせて、返ってきたエラーの種類で判定する」
 * という方法をとる。
 *
 *   テーブルが無い、というエラー  → URL も鍵も正しい（＝接続成功）
 *   鍵が不正、というエラー        → Publishable key が違う
 *   通信自体が失敗                → URL が違う、またはネットワークの問題
 *
 * Step 3 で実際のテーブルを作ったら、このページは本物のクエリに置き換える。
 */

type Diagnosis = {
  ok: boolean;
  title: string;
  detail: string;
  hint: string[];
};

function diagnose(errorMessage: string, errorCode: string | undefined): Diagnosis {
  const message = errorMessage.toLowerCase();

  // PGRST205 = スキーマキャッシュにテーブルが見つからない
  if (errorCode === "PGRST205" || errorCode === "42P01" || message.includes("could not find the table")) {
    return {
      ok: true,
      title: "接続成功",
      detail:
        "Supabase に到達し、認証も通りました。" +
        "「テーブルが存在しない」というエラーが返ってきたのは想定どおりです（まだ何も作っていないため）。",
      hint: [],
    };
  }

  if (message.includes("invalid api key") || message.includes("no api key") || message.includes("jwt")) {
    return {
      ok: false,
      title: "鍵が正しくありません",
      detail: errorMessage,
      hint: [
        "Supabase の Project Settings → API Keys を開く",
        "Publishable key（sb_publishable_ で始まる値）をコピーする",
        ".env.local の NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY に貼り付ける",
        "Legacy API keys タブの anon キー（eyJ... で始まる値）ではないか確認する",
        "開発サーバーを再起動する",
      ],
    };
  }

  if (message.includes("fetch failed") || message.includes("enotfound") || message.includes("econnrefused")) {
    return {
      ok: false,
      title: "Supabase に到達できません",
      detail: errorMessage,
      hint: [
        ".env.local の NEXT_PUBLIC_SUPABASE_URL を確認する",
        "https://xxxxx.supabase.co の形式か、末尾に / や余分な文字が付いていないか",
        "Supabase のプロジェクトが一時停止していないか（無料プランは7日間アクセスが無いと停止する）",
        "ネットワーク接続を確認する",
      ],
    };
  }

  return {
    ok: false,
    title: "想定外のエラー",
    detail: `${errorCode ? `[${errorCode}] ` : ""}${errorMessage}`,
    hint: ["このメッセージをそのまま共有してください"],
  };
}

export default async function HealthPage() {
  // ビルド時に結果を固定させず、アクセスのたびに実際の接続を確認する
  await connection();

  const missing = missingSupabaseEnv();

  if (missing.length > 0) {
    return (
      <Layout title="Supabase 接続診断" note={NOTE}>
        <Status ok={false} title="環境変数が未設定です" />
        <Section label="未設定の変数">
          <ul className="list-disc pl-5">
            {missing.map((name) => (
              <li key={name}>
                <code className="rounded bg-black/10 px-1 dark:bg-white/10">{name}</code>
              </li>
            ))}
          </ul>
        </Section>
        <Section label="対処">
          <ol className="list-decimal space-y-1 pl-5">
            <li>プロジェクト直下の .env.local に値を書く</li>
            <li>Ctrl+C で開発サーバーを止める</li>
            <li>npm run dev で再起動する（.env.local は起動時にしか読まれない）</li>
          </ol>
        </Section>
      </Layout>
    );
  }

  let result: Diagnosis;
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.from("__connection_check__").select("*").limit(1);

    if (error) {
      result = diagnose(error.message, error.code);
    } else {
      result = {
        ok: true,
        title: "接続成功",
        detail: "問い合わせが成功しました。",
        hint: [],
      };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result = diagnose(message, undefined);
  }

  return (
    <Layout title="Supabase 接続診断" note={NOTE}>
      <Status ok={result.ok} title={result.title} />
      <Section label="詳細">
        <p className="whitespace-pre-wrap">{result.detail}</p>
      </Section>
      <Section label="接続先">
        <dl className="space-y-1">
          <Field label="URL">{SUPABASE_URL}</Field>
          <Field label="Publishable key">
            {SUPABASE_PUBLISHABLE_KEY.slice(0, 22)}…（以降は伏せています）
          </Field>
        </dl>
      </Section>
      {result.hint.length > 0 && (
        <Section label="確認する箇所">
          <ol className="list-decimal space-y-1 pl-5">
            {result.hint.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ol>
        </Section>
      )}
      <Section label="次の診断">
        <Link className="underline" href="/health/auth">
          /health/auth — 匿名サインインと profiles 自動生成
        </Link>
      </Section>
    </Layout>
  );
}
