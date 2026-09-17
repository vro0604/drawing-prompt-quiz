# 20260909180000 の再現と比較に使った道具（2026-09-17）

`docs/history-20260909180000.md` の数字は、ここにある道具で出した。アプリからもどの検査からも呼ばれない。
残してあるのは、本番の履歴に新しい migration が入って `scripts/db-history-0909.mjs` の値（67行・ほかの66行の指紋）を
作り直す必要が出たとき、同じ手順をもう一度通すため。

## 前提

- origin/main をそのまま取り出した作業木（`HIST_TREE`）。node_modules は実体をコピーする
- 作業用の置き場（`HIST_WORK`）に `npm i embedded-postgres@17.6.0-beta.15 pg` した別フォルダを用意し、
  `hist-server.mjs` をそこで動かす（リポジトリの embedded-postgres は 18 なので、本番と同じ 17.6 はこちらで立てる）
- 本番の読み取りだけ、キーチェーンのパスワードで接続文字列を組み立てて `SUPABASE_DB_URL` として渡す

## 順番

| 順 | 道具 | すること | 本番へ |
|---|---|---|---|
| 1 | `prod-read.mjs` | 本番を読み取り専用のトランザクションで読む（履歴の全行・部品の指紋・権限の指紋・表ごとの件数とハッシュ） | 読むだけ |
| 2 | `hist-server.mjs` | PostgreSQL 17.6（UTF8 / ICU en-US）を 55433 番で立て、届いた文をすべてログに残す | 無関係 |
| 3 | `step-base.mjs` | Supabase の3役と既定の権限を入れた `base` を作り、複製した `clean` へ CLI の `db push` で67本を当てる | 無関係 |
| 4 | `cmp-hist.mjs` / `cmp-cat.mjs` | `clean` の履歴と部品を本番と比べる | 無関係 |
| 5 | `step-prodlike.mjs` | `clean` に種のデータを入れ、複製した `prodlike` の履歴を本番の67行で置き換え、環境由来の2点を本番に合わせる | 無関係 |
| 6 | `probe-ro.mjs` | `prodlike` で `migration list` / `db push --dry-run` が送る文を記録する（本番で流してよいかをここで確かめた） | 無関係 |
| 7 | `exp-repair.mjs` | `migration repair` の正体を、DB の前後とログで測る | 無関係 |
| 8 | `gen-sql.mjs` | CASE C の SQL と戻す SQL を、DB の中身から組み立てる | 無関係 |
| 9 | `run-cases.mjs` | 同じ複製元 `snap` から CASE A/B/C を作り、前後・後続 migration・戻す・再適用を測る | 無関係 |
| 10 | `exp-fetch.mjs` | `migration fetch` と、履歴だけから作り直す場合を A と B で比べる | 無関係 |
| 11 | `exp-evt.mjs` | 本番にある ddl_command_end のイベントトリガーが、B と C で発火するかを測る | 無関係 |
| 12 | `rehearse.mjs` | `scripts/db-history-0909.mjs` を使い捨ての DB で通し、止まるべき場面で止まるかを見る | 無関係 |
