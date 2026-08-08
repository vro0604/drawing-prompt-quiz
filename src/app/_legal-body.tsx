/**
 * 規約とポリシーの本文を出す。
 *
 * 【Markdown をライブラリで描かない理由】
 *   本文を書くのは運営だけで、利用者が投稿するものではない。
 *   それでも、DBの文字列をそのまま dangerouslySetInnerHTML に渡すと
 *   「本文に script を入れたら動くのか」という穴が開く。
 *   運営しか書けないとはいえ、**開けなくてよい穴は開けない。**
 *
 *   必要なのは見出し・箇条書き・表・強調だけなので、
 *   行単位で読んで JSX にする。タグは1つも解釈しない。
 */

type Block =
  | { kind: "h1" | "h2" | "h3"; text: string }
  | { kind: "li"; text: string }
  | { kind: "p"; text: string }
  | { kind: "table"; rows: string[][] };

function parse(body: string): Block[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let table: string[][] | null = null;

  const flushTable = () => {
    if (table && table.length > 0) out.push({ kind: "table", rows: table });
    table = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // 表：| a | b | の行が続く塊。区切り行（|---|---|）は捨てる
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split("|").map((c) => c.trim());
      if (!cells.every((c) => /^:?-{1,}:?$/.test(c) || c === "")) {
        table = table ?? [];
        table.push(cells);
      }
      continue;
    }
    flushTable();

    if (line === "") continue;
    if (line.startsWith("### ")) out.push({ kind: "h3", text: line.slice(4) });
    else if (line.startsWith("## ")) out.push({ kind: "h2", text: line.slice(3) });
    else if (line.startsWith("# ")) out.push({ kind: "h1", text: line.slice(2) });
    else if (line.startsWith("- ")) out.push({ kind: "li", text: line.slice(2) });
    else out.push({ kind: "p", text: line });
  }
  flushTable();

  return out;
}

/** **強調** だけを反映する。ほかの記法は文字のまま出す */
function withBold(text: string, keyPrefix: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={`${keyPrefix}-${i}`}>{part}</span>
    ),
  );
}

export function LegalBody({
  body,
  version,
  publishedAt,
}: {
  body: string;
  version: string;
  publishedAt: string;
}) {
  const blocks = parse(body);

  return (
    <article className="space-y-4">
      <p className="text-xs text-faint">
        版 {version}（{new Date(publishedAt).toLocaleDateString("ja-JP")}）
      </p>

      {blocks.map((b, i) => {
        if (b.kind === "h1") {
          return (
            <h1 key={i} className="text-2xl font-bold">
              {b.text}
            </h1>
          );
        }
        if (b.kind === "h2") {
          return (
            <h2 key={i} className="pt-4 text-lg font-bold">
              {b.text}
            </h2>
          );
        }
        if (b.kind === "h3") {
          return (
            <h3 key={i} className="pt-2 text-sm font-bold">
              {b.text}
            </h3>
          );
        }
        if (b.kind === "li") {
          return (
            <li key={i} className="ml-5 list-disc text-sm leading-relaxed">
              {withBold(b.text, `l${i}`)}
            </li>
          );
        }
        if (b.kind === "table") {
          const [head, ...rest] = b.rows;
          return (
            <div key={i} className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line-mid">
                    {head.map((c, j) => (
                      <th key={j} className="py-2 pr-4 font-bold">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rest.map((row, ri) => (
                    <tr key={ri} className="border-b border-line-faint">
                      {row.map((c, ci) => (
                        <td key={ci} className="py-2 pr-4 align-top">
                          {withBold(c, `t${i}-${ri}-${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={i} className="text-sm leading-relaxed">
            {withBold(b.text, `p${i}`)}
          </p>
        );
      })}
    </article>
  );
}
