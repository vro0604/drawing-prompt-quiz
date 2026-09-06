#!/usr/bin/env node
/**
 * vocab-audit.mjs ／ ヒント語彙が正解語を漏らしていないかを、組み合わせで数える
 *
 * 実行: npm run check:vocab
 *
 * 【何を確かめるものか】
 *   「候補の絞り込みが動くこと」と「登録された語彙が正解を漏らさないこと」は別。
 *   前者は動きの試験、後者は**中身**の試験で、ここは後者だけを見る。
 *
 * 【どう見るか】
 *   お題語（tags）とヒント語（flavor_vocab）の全組み合わせを1つずつ突き合わせ、
 *   次の観点に振り分ける。判定は DB の flavor_block_reason を呼ぶ。
 *   **ここに判定を書き写さない。**書き写すと、規則を直したときに検査だけ古くなる。
 *
 *     exact      表記をそろえると同じ語
 *     substring  正解語を含む複合語・部分文字列
 *     reading    漢字とかなの対応（読みが同じ・含む）
 *     synonym    同義グループ
 *     kanji      漢字を共有する（語幹の重なり）
 *     manual     人が1件ずつ登録した禁止の組
 *
 *   さらに、判定に入っていない観点も**別枠で数える。**
 *
 *     kanji_share 漢字を共有しているのに、どの規則にも当たらない組
 *                 （「古い」と「古書」のような、語幹だけ重なる組）
 *
 *   最後に「禁止しすぎていないか」を見る。お題語ごとに、使えるヒント語が
 *   何語残るかを数え、少ないものから並べる。0語のお題語があれば、
 *   その語ではフレーバーが1文字も書けない。
 *
 * 【この検査で言えないこと】
 *   意味の近さは見ていない。「葬送」と「終わり」のような、文字も読みも
 *   重ならない言い換えは、人が禁止の組に足すまで拾えない。
 *   **自動検査で意味的な漏洩を保証できたとは言えない。**
 */

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { installLocalOnlyGuard } from "../test/guard/no-production.mjs";
import { createTestDb } from "../test/db/harness.mjs";
import { recordCount } from "../test/counts.mjs";

// **最初のネットワーク要求より前に柵を立てる。**
// 本番のURL・project ref・ホスト名・鍵が環境にあれば、ここで異常終了する。
installLocalOnlyGuard("語彙検査（check:vocab）");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** 漢字を1文字ずつ取り出す */
function kanji(s) {
  return new Set([...s].filter((c) => /[一-鿿]/.test(c)));
}

function shareKanji(a, b) {
  const ka = kanji(a);
  for (const c of kanji(b)) if (ka.has(c)) return c;
  return null;
}

async function main() {
  const db = await createTestDb();

  const tags = (
    await db.query(
      `select t.id, t.label, t.pool_key, t.reading, t.synonym_group,
              coalesce(dc.kind, 'legacy') as kind
         from public.tags t
         left join public.draw_categories dc on dc.pool_key = t.pool_key
        where t.is_active
        order by t.pool_key, t.id`,
    )
  ).rows;

  // 上位種別ごとの語数。**カラーを状態に混ぜない**（2026-09-05 の訂正）
  const byKind = new Map();
  for (const t of tags) byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);

  const vocab = (
    await db.query(
      `select id, label, kind, reading, synonym_group
         from public.flavor_vocab where is_active order by id`,
    )
  ).rows;

  console.log(`${BOLD}ヒント語彙の内容検査${RESET}`);
  console.log(`  お題語 ${tags.length} 語 × ヒント語 ${vocab.length} 語`
    + ` = ${tags.length * vocab.length} 組を1組ずつ見る`);
  console.log(`  ${DIM}上位種別ごとの語数: `
    + [...byKind.entries()].map(([k, n]) => `${k} ${n}`).join(" / ")
    + `${RESET}\n`);

  // --- 判定を DB から一度に取る -------------------------------------------
  //
  // 1組ずつ問い合わせると 3万回になる。1本のクエリで受け取る。
  const pairs = (
    await db.query(
      `select v.id as vocab_id, v.label as vocab_label,
              t.id as tag_id, t.label as tag_label, t.pool_key,
              public.flavor_block_reason(v.id, t.id) as reason
         from public.flavor_vocab v
         cross join public.tags t
        where v.is_active and t.is_active`,
    )
  ).rows;

  const byReason = new Map();
  for (const p of pairs) {
    const k = p.reason ?? "(使える)";
    if (!byReason.has(k)) byReason.set(k, []);
    byReason.get(k).push(p);
  }

  const ORDER = ["exact", "substring", "reading", "kanji", "synonym", "manual"];
  const LABEL = {
    exact: "完全一致（表記をそろえると同じ語）",
    substring: "正解語を含む複合語・部分文字列",
    reading: "漢字とかなの対応（読みが同じ）",
    kanji: "漢字を共有する（語幹の重なり）",
    synonym: "同義グループが同じ（単純な同義語）",
    manual: "人が明示的に登録した禁止の組",
  };

  console.log(`${BOLD}1. 使えないと判定された組${RESET}`);
  let blocked = 0;
  for (const key of ORDER) {
    const rows = byReason.get(key) ?? [];
    blocked += rows.length;
    console.log(`  ${LABEL[key].padEnd(34, "　")} ${String(rows.length).padStart(5)} 組`);
    for (const r of rows.slice(0, 6)) {
      console.log(`      ${DIM}${r.vocab_label} × ${r.tag_label}（${r.pool_key}）${RESET}`);
    }
    if (rows.length > 6) console.log(`      ${DIM}… 他 ${rows.length - 6} 組${RESET}`);
  }
  console.log(`  ${DIM}使える組 ${(byReason.get("(使える)") ?? []).length}${RESET}\n`);

  // --- 判定に入っていない観点 ---------------------------------------------
  console.log(`${BOLD}2. 判定に入っていないが、漢字を共有している組${RESET}`);
  console.log(`  ${DIM}どの規則にも当たらないのに、同じ漢字を含む組。`
    + `「古い」と「古書」のような語幹の重なり。${RESET}`);

  const shared = [];
  for (const p of byReason.get("(使える)") ?? []) {
    const c = shareKanji(p.vocab_label, p.tag_label);
    if (c) shared.push({ ...p, c });
  }
  console.log(`  ${shared.length === 0 ? GREEN : YELLOW}${shared.length} 組${RESET}`);
  for (const s of shared) {
    console.log(`      ${s.vocab_label} × ${s.tag_label}（${s.pool_key}）`
      + ` ${DIM}共有する字: ${s.c}${RESET}`);
  }
  console.log();

  // --- 禁止しすぎ ----------------------------------------------------------
  console.log(`${BOLD}3. 禁止しすぎていないか（お題語ごとに使えるヒント語の数）${RESET}`);
  const perTag = new Map();
  for (const t of tags) perTag.set(t.id, { label: t.label, pool: t.pool_key, usable: 0 });
  for (const p of pairs) {
    if (p.reason === null) perTag.get(p.tag_id).usable += 1;
  }

  const sorted = [...perTag.values()].sort((a, b) => a.usable - b.usable);
  const empty = sorted.filter((x) => x.usable === 0);

  console.log(`  使えるヒント語が0語のお題語: ${empty.length === 0 ? GREEN : RED}${empty.length}${RESET}`);
  for (const e of empty) console.log(`      ${RED}${e.label}（${e.pool}）${RESET}`);

  console.log(`  ${DIM}少ないほうから10語（ヒント語は全部で ${vocab.length} 語）${RESET}`);
  for (const s of sorted.slice(0, 10)) {
    console.log(`      ${String(s.usable).padStart(3)} 語  ${s.label}（${s.pool}）`);
  }
  const avg = [...perTag.values()].reduce((a, b) => a + b.usable, 0) / perTag.size;
  console.log(`  ${DIM}平均 ${avg.toFixed(1)} 語${RESET}\n`);

  // --- お題そのものへの影響 -------------------------------------------------
  //
  // お題は3〜6語ある。全部の語で禁止された語は使えないので、
  // 語数が増えるほど候補は減る。最悪の組み合わせを見る。
  console.log(`${BOLD}4. お題（複数語）にしたときに残るヒント語${RESET}`);
  // モーフ以外（状態8カテゴリ ＋ カラー）から3語を引く。
  // **カラーもお題に入るので、ここに含める。**含めないと、
  // 実際には起こるお題の組み合わせを見ないまま数えることになる。
  const morphs = tags.filter((t) => t.kind === "morph");
  const states = tags.filter((t) => t.kind === "state" || t.kind === "color");
  let worst = { n: Infinity, labels: [] };
  const sample = 400;
  for (let i = 0; i < sample; i += 1) {
    const pick = [
      morphs[Math.floor(Math.random() * morphs.length)],
      states[Math.floor(Math.random() * states.length)],
      states[Math.floor(Math.random() * states.length)],
      states[Math.floor(Math.random() * states.length)],
    ];
    const ids = new Set(pick.map((x) => x.id));
    let n = 0;
    for (const v of vocab) {
      let ok = true;
      for (const p of pairs) {
        if (p.vocab_id === v.id && ids.has(p.tag_id) && p.reason !== null) {
          ok = false;
          break;
        }
      }
      if (ok) n += 1;
    }
    if (n < worst.n) worst = { n, labels: pick.map((x) => x.label) };
  }
  console.log(`  ${DIM}4語のお題を ${sample} 通り無作為に作って、いちばん少ない場合を見る${RESET}`);
  console.log(`  最少 ${worst.n === Infinity ? "—" : worst.n} 語`
    + `  ${DIM}（${worst.labels.join("・")}）${RESET}\n`);

  // --- まとめ ---------------------------------------------------------------
  console.log(`${BOLD}まとめ${RESET}`);
  console.log(`  使えないと判定された組: ${blocked}`);
  console.log(`  規則に当たらないが漢字を共有する組: ${shared.length}`);
  console.log(`  ヒント語が0語になるお題語: ${empty.length}`);
  console.log(
    `  ${DIM}この検査は文字・読み・同義グループ・登録済みの禁止だけを見ている。`
    + `\n  意味だけが近い言い換え（文字も読みも重ならないもの）は拾えない。`
    + `\n  Claude による初期点検であって、ユーザーの承認ではない。${RESET}`,
  );

  // --- 一覧をファイルに出す -------------------------------------------------
  //
  // 【なぜ画面ではなくファイルか】
  //   語は 474 + 90 = 564 語ある。端末に流すと読み返せない。
  //   ユーザーが目で確認して承認するための資料なので、残る形にする。
  const inventory = await writeInventory(db, pairs);

  // --- 棚卸しが1語も落としていないか ---------------------------------------
  //
  // 【なぜ数え合わせるか】
  //   「564語ある」と書いても、書き出す途中で落ちていれば気づけない。
  //   DB の件数・関数が返した件数・ファイルに書いた表の行数の**3つ**が
  //   一致することを見る。1つでも違えば失敗にする。
  console.log(`${BOLD}5. 棚卸しの取りこぼし${RESET}`);
  const counted = (
    await db.query(
      `select (select count(*)::int from public.tags)         as tags,
              (select count(*)::int from public.flavor_vocab) as flavor`,
    )
  ).rows[0];

  const expected = counted.tags + counted.flavor;
  const missing = [];

  if (inventory.fromDb !== expected) {
    missing.push(`棚卸し関数が ${inventory.fromDb} 語（DB は ${expected} 語）`);
  }
  if (inventory.written !== expected) {
    missing.push(`書き出した表が ${inventory.written} 行（DB は ${expected} 語）`);
  }

  console.log(
    `  DB ${expected} 語（お題語 ${counted.tags} ＋ ヒント語 ${counted.flavor}）`
      + ` / 関数 ${inventory.fromDb} 語 / ファイル ${inventory.written} 行`,
  );
  console.log(
    missing.length === 0
      ? `  ${GREEN}3つとも一致（取りこぼしなし）${RESET}\n`
      : `  ${RED}${missing.join(" / ")}${RESET}\n`,
  );

  // 文書に書いた語数と突き合わせられるように、実測を残す
  recordCount("語彙", expected);

  // 0語のお題語と、棚卸しの取りこぼしがあれば失敗にする。
  // それ以外は数を出すだけで合否を作らない
  process.exit(empty.length === 0 && missing.length === 0 ? 0 : 1);
}

/**
 * 語彙の一覧を docs/vocab-inventory.md に書き出す。
 *
 * 【何を並べるか】
 *   語 ／ 種類・カテゴリ ／ 読み ／ 同義グループ ／ 出所 ／ 承認の有無。
 *   ヒント語については、どの正解語に対してどの理由で除外されるかも並べる。
 *
 * 【出所の見分け】
 *   legacy     2026-08 までにあった語
 *   moved      旧語彙から新しい分類へ移しただけ（表記は同じ）
 *   claude_new 2026-09-04 に Claude が新しく書いた語
 *
 * 【「検査済み」と「承認済み」を同じ欄にしない】
 *   この検査を通ったことは、ユーザーが認めたことではない。
 *   承認の欄は DB の approved_by_user をそのまま写す（いまは全部 false）。
 */
async function writeInventory(db, pairs) {
  // 機械の検査を「いま通した」ことを、この場で記録する。
  // **承認ではない。**approved_by_user には触れない。
  const checkedAt = new Date().toISOString();
  await db.query(`update public.tags set machine_checked_at = $1`, [checkedAt]);
  await db.query(`update public.flavor_vocab set machine_checked_at = $1`, [checkedAt]);

  const inv = (await db.query(`select * from public.vocab_inventory()`)).rows;
  const blocks = (await db.query(`select * from public.vocab_block_matrix()`)).rows;

  const originLabel = {
    legacy: "旧語彙（2026-08 以前）",
    moved: "旧語彙から移した",
    claude_new: "Claude が新規作成",
  };

  const kindLabel = {
    morph: "モーフ",
    state: "状態",
    color: "カラー",
    legacy: "旧語彙",
    flavor: "ヒント語",
  };

  /** 機械検査の時刻。**承認の欄と混ぜない** */
  const stamp = (v) => (v ? new Date(v).toISOString().slice(0, 16).replace("T", " ") : "—");

  const manual = (
    await db.query(
      `select b.vocab_id, b.tag_id, b.reason,
              v.label as vocab_label, t.label as tag_label
         from public.flavor_vocab_blocks b
         join public.flavor_vocab v on v.id = b.vocab_id
         join public.tags t on t.id = b.tag_id
        order by t.label, v.label`,
    )
  ).rows;

  const synonymGroups = new Map();
  for (const row of inv) {
    if (!row.synonym_group) continue;
    const list = synonymGroups.get(row.synonym_group) ?? [];
    list.push(`${row.label}（${row.kind === "flavor" ? "ヒント語" : row.category_key}）`);
    synonymGroups.set(row.synonym_group, list);
  }

  const blocksByVocab = new Map();
  for (const b of blocks) {
    const list = blocksByVocab.get(b.vocab_label) ?? [];
    list.push(`${b.tag_label}（${b.pool_key}／${b.reason}）`);
    blocksByVocab.set(b.vocab_label, list);
  }

  const lines = [];
  lines.push("# 語彙の棚卸し（自動生成）");
  lines.push("");
  lines.push("このファイルは `npm run check:vocab` が書き出します。手で編集しないでください。");
  lines.push("");
  lines.push("承認の欄はすべて「未承認」です。**機械の検査を通ったことと、");
  lines.push("内容が認められたことは別**なので、検査の結果でこの欄を立てていません。");
  lines.push("認めたものがあれば、その語を教えてください。DB の `approved_by_user` を立てます。");
  lines.push("");
  lines.push("「機械検査」の欄は、文字・読み・同義グループ・登録済みの禁止の組を");
  lines.push("突き合わせた時刻です（この検査を回した時刻）。承認とは別の欄です。");
  lines.push("");
  lines.push("この欄は運営と検収のための情報です。**利用者の画面には出しません。**");
  lines.push("");

  const tagRows = inv.filter((r) => r.kind === "tag");
  const flavorRows = inv.filter((r) => r.kind === "flavor");

  lines.push("## 数");
  lines.push("");
  lines.push("| 区分 | 語数 | 内訳 |");
  lines.push("|---|---:|---|");
  for (const kind of ["tag", "flavor"]) {
    const rows = kind === "tag" ? tagRows : flavorRows;
    const byOrigin = new Map();
    for (const r of rows) byOrigin.set(r.vocab_origin, (byOrigin.get(r.vocab_origin) ?? 0) + 1);
    lines.push(
      `| ${kind === "tag" ? "お題の語" : "ヒント語（フレーバー）"} | ${rows.length} | `
        + [...byOrigin.entries()]
            .map(([o, n]) => `${originLabel[o] ?? o} ${n}`)
            .join("／")
        + " |",
    );
  }
  lines.push("");

  lines.push("## お題の語");
  lines.push("");
  lines.push("上位種別は3つです。**カラーは状態ではありません。**");
  lines.push("");
  lines.push("| 上位種別 | 中身 |");
  lines.push("|---|---|");
  lines.push("| モーフ（morph） | 描く対象となる具体語 |");
  lines.push("| 状態（state） | 感情・動作・身体状態・変化・環境・関係・性質・社会状態の8カテゴリ |");
  lines.push("| カラー（color） | 色彩語。状態とは別 |");
  lines.push("| 旧語彙（legacy） | 2026-09-04 の分類より前からある語。生成用カテゴリを持たない |");
  lines.push("");
  lines.push("| 語 | 上位種別 | 分類 | 読み | 同義グループ | 出所 | 機械検査 | 承認 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of tagRows) {
    lines.push(
      `| ${r.label} | ${kindLabel[r.element_kind] ?? r.element_kind} | `
        + `${r.category_label}（${r.category_key}） | ${r.reading ?? "—"} | `
        + `${r.synonym_group ?? "—"} | ${originLabel[r.vocab_origin] ?? "—"} | `
        + `${stamp(r.machine_checked_at)} | `
        + `${r.approved_by_user ? "承認済み" : "未承認"} |`,
    );
  }
  lines.push("");

  lines.push("## ヒント語（フレーバー）");
  lines.push("");
  lines.push("除外の欄は「この語を使えなくする正解語」と、その理由です。");
  lines.push("理由の読み方は次のとおり。");
  lines.push("");
  lines.push("- exact … 表記をそろえると同じ語");
  lines.push("- substring … 正解語を含む、または正解語に含まれる");
  lines.push("- reading … 読みが同じ（漢字とかなの言い換え）");
  lines.push("- kanji … 漢字を共有する（語幹の重なり）");
  lines.push("- synonym … 同義グループが同じ");
  lines.push("- manual … 人が1件ずつ登録した禁止の組");
  lines.push("");
  lines.push("| 語 | 品詞 | 読み | 同義グループ | 出所 | 機械検査 | 承認 | 除外される正解語（理由） |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of flavorRows) {
    const blocked = blocksByVocab.get(r.label) ?? [];
    lines.push(
      `| ${r.label} | ${r.category_key} | ${r.reading ?? "—"} | ${r.synonym_group ?? "—"} | `
        + `${originLabel[r.vocab_origin] ?? "—"} | ${stamp(r.machine_checked_at)} | `
        + `${r.approved_by_user ? "承認済み" : "未承認"} | `
        + `${blocked.length === 0 ? "—" : blocked.join("、")} |`,
    );
  }
  lines.push("");

  lines.push("## 同義グループ");
  lines.push("");
  if (synonymGroups.size === 0) {
    lines.push("登録されている同義グループはありません。");
  } else {
    lines.push("| グループ名 | 語 |");
    lines.push("|---|---|");
    for (const [name, list] of [...synonymGroups.entries()].sort()) {
      lines.push(`| ${name} | ${list.join("、")} |`);
    }
  }
  lines.push("");

  lines.push("## 明示的に登録した禁止の組");
  lines.push("");
  lines.push("文字も読みも重ならないので、機械では拾えない組です。人が1件ずつ登録しています。");
  lines.push("");
  lines.push("| ヒント語 | 正解語 | 理由 |");
  lines.push("|---|---|---|");
  for (const m of manual) {
    lines.push(`| ${m.vocab_label} | ${m.tag_label} | ${m.reason} |`);
  }
  lines.push("");

  lines.push("## 機械検査で拾えないもの");
  lines.push("");
  lines.push("文字も読みも重ならない言い換え（「葬送」と「終わり」のような組）は、");
  lines.push("上の禁止の組へ人が足すまで拾えません。");
  lines.push(`いま拾えている組は ${pairs.filter((p) => p.reason !== null).length} 組です。`);
  lines.push("");

  const out = fileURLToPath(new URL("../docs/vocab-inventory.md", import.meta.url));
  await writeFile(out, lines.join("\n"), "utf8");
  console.log(`\n一覧を書き出しました: docs/vocab-inventory.md（${inv.length} 語）\n`);

  // 呼び出し側が数え合わせるための値を返す。
  // written は「実際に表の行として書いた数」で、inv.length とは別に数える。
  return { fromDb: inv.length, written: tagRows.length + flavorRows.length };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
