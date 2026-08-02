import { connection } from "next/server";
import { missingSupabaseEnv, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
      <Layout>
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
    <Layout>
      <Status ok={result.ok} title={result.title} />
      <Section label="詳細">
        <p className="whitespace-pre-wrap">{result.detail}</p>
      </Section>
      <Section label="接続先">
        <dl className="space-y-1">
          <div>
            <dt className="inline text-black/50 dark:text-white/50">URL: </dt>
            <dd className="inline break-all">{SUPABASE_URL}</dd>
          </div>
          <div>
            <dt className="inline text-black/50 dark:text-white/50">Publishable key: </dt>
            <dd className="inline break-all">
              {SUPABASE_PUBLISHABLE_KEY.slice(0, 22)}…（以降は伏せています）
            </dd>
          </div>
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
    </Layout>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8 font-mono text-sm">
      <h1 className="text-xl font-bold">Supabase 接続診断</h1>
      {children}
      <p className="pt-4 text-xs text-black/40 dark:text-white/40">
        このページは開発用です。Step 3 でテーブルを作成したら本物のクエリに置き換えます。
      </p>
    </main>
  );
}

function Status({ ok, title }: { ok: boolean; title: string }) {
  return (
    <p
      className={`rounded-lg px-4 py-3 text-base font-bold ${
        ok
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
          : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
      }`}
    >
      {ok ? "OK" : "NG"} — {title}
    </p>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs uppercase tracking-wider text-black/40 dark:text-white/40">{label}</h2>
      <div className="leading-relaxed">{children}</div>
    </section>
  );
}
