/**
 * 診断ページ（/health 以下）で共通して使う見た目の部品。
 *
 * app/ の中でも page.tsx / route.ts 以外のファイルは URL にならないので、
 * ここに置いても新しいページが増えることはない。
 */

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
    <main className="mx-auto max-w-2xl space-y-6 p-8 font-mono text-sm">
      <h1 className="text-xl font-bold">{title}</h1>
      {children}
      <p className="pt-4 text-xs text-black/40 dark:text-white/40">{note}</p>
    </main>
  );
}

/** ok に null を渡すと「まだ試していない」灰色の表示になる */
export function Status({ ok, title }: { ok: boolean | null; title: string }) {
  const tone =
    ok === null
      ? "bg-black/5 text-black/60 dark:bg-white/10 dark:text-white/60"
      : ok
        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
        : "bg-rose-500/15 text-rose-700 dark:text-rose-300";

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
      : "border border-black/20 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10";

  return (
    <button type="submit" className={`rounded-md px-4 py-2 text-sm font-bold transition ${tone}`}>
      {children}
    </button>
  );
}

export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs uppercase tracking-wider text-black/40 dark:text-white/40">
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
      <dt className="inline text-black/50 dark:text-white/50">{label}: </dt>
      <dd className="inline break-all">{children}</dd>
    </div>
  );
}
