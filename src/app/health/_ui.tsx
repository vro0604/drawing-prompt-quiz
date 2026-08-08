import { Geist_Mono } from "next/font/google";

/**
 * 診断ページ（/health 以下）で共通して使う見た目の部品。
 *
 * app/ の中でも page.tsx / route.ts 以外のファイルは URL にならないので、
 * ここに置いても新しいページが増えることはない。
 *
 * 【等幅の書体をここで読む理由】
 *   使っているのはこの画面だけ。layout.tsx に置くと**全ページで
 *   読み込まれる**ので、内部の点検画面のために全員が払うことになる。
 *   next/font は呼んだ部品の中に閉じるので、ここで呼ぶ。
 */
const geistMono = Geist_Mono({ subsets: ["latin"] });

export function Layout({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <main className={`${geistMono.className} mx-auto max-w-2xl space-y-6 p-8 text-sm`}>
      <h1 className="text-xl font-bold">{title}</h1>
      {children}
      <p className="pt-4 text-xs text-faint">{note}</p>
    </main>
  );
}

/** ok に null を渡すと「まだ試していない」灰色の表示になる */
export function Status({ ok, title }: { ok: boolean | null; title: string }) {
  const tone =
    ok === null
      ? "bg-hover text-muted"
      : ok
        ? "bg-success-tint/15 text-success"
        : "bg-danger-tint/15 text-danger";

  const label = ok === null ? "待機" : ok ? "OK" : "NG";

  return <p className={`rounded-lg px-4 py-3 text-base font-bold ${tone}`}>{label} — {title}</p>;
}

/** フォーム送信用のボタン。押すと Server Action が走る */
export function ActionButton({
  children,
  variant = "primary",
}: {
  children: React.ReactNode;
  variant?: "primary" | "quiet";
}) {
  const tone =
    variant === "primary"
      ? "bg-foreground text-background hover:opacity-80"
      : "border border-ink/20 hover:bg-hover";

  return (
    <button type="submit" className={`rounded-md px-4 py-2 text-sm font-bold transition ${tone}`}>
      {children}
    </button>
  );
}

export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs uppercase tracking-wider text-faint">
        {label}
      </h2>
      <div className="leading-relaxed">{children}</div>
    </section>
  );
}

/** dl の1行。ラベルと値を横に並べる */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="inline text-faint">{label}: </dt>
      <dd className="inline break-all">{children}</dd>
    </div>
  );
}
