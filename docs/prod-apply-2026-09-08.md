# 本番へ当てる前の確認（2026-09-08 ／ art_first）

この文書は、**本番へ当てる直前の控え**である。まだ当てていない。
書いてあるのは、実際に走らせたものと、実際に出た値だけ。

出所: 2026-09-08 のユーザー指示（1〜13）。前日の本番反映の記録は
`docs/verify-2026-09-07.md`、手順の正本は `docs/prod-runbook.md`。

---

## 1. 訂正。「9月7日分3本」は既に本番へ入っている

前回の報告で「本番へ当てる migration は4本（9月7日ぶんの3本 ＋ art_first）」と
書いたが、**間違いだった。**9月7日ぶんは4本あり、その4本とも
2026-09-07 に本番へ適用済みである（出所: `docs/verify-2026-09-07.md` 1節。
本番の migration は 40 本から 44 本になった、と実測が書いてある）。

したがって、いま本番に入っていないのは2本だけで、そのうち当てるのは1本。

---

## 2. 適用対象（1本だけ）

| ファイル名 | 内容 | 適用可否 |
|---|---|---|
| `supabase/migrations/20260908090000_art_first.sql` | 持ち込み（art_first）。出どころの許可値を1つ増やし、draft_modes に `word_source` と持ち込み用のモードを足し、関数を2本足し、取得系4本へ `origin` と時間区分の分岐を入れる | 当てる |

## 3. 本番から除外するもの（1本）

| ファイル名 | 内容 | 除外の理由 |
|---|---|---|
| `supabase/migrations/20260907120000_single_pass_draw_and_slot_redo.sql` | 一巡で仮のお題を作り、カテゴリごとに1回だけ引き直す（`pick_card` / `redo_slot` を足し、`draft_state_json` と `reroll_draft` を作り替える） | **別の作業線の書きかけ。**完成と採用の確認が済んでいない |

この1本には手を触れていない。中身も並びも変えていない。

## 4. すでに本番へ入っている44本

`supabase/migrations/` にあるファイルは46本。上の2本を除いた44本が本番に入っている
（出所: `docs/verify-2026-09-07.md` の「40本 → 44本」）。内訳は、
baseline から `20260907110000_split_reveal_from_commit.sql` までの連番すべて。
この文書では一覧を再掲しない。**再掲すると、本番の実測ではなく写しになるため。**
当てる直前に `npm run db:status` か `npm run db:audit:prod` で本番側を読むこと。

---

## 5. art_first が、除外する1本に依存していないこと（実測）

まっさらな Postgres（PGlite）に、**本番と同じ44本だけ**を当て、そのうえで
art_first を当てて確かめた。一巡ドローの書きかけは入れていない。

実行: `node scripts/verify-art-first-prod-order.mjs` ／ 13件中13件合格。

確かめた中身。

- 本番と同じ44本が当たる
- 書きかけが入っていない（`pick_card` / `redo_slot` が0本であることを数えた）
- art_first の migration が当たる
- `create_art_first_work` と `get_art_first_vocabulary` が在る
- 既存4モードの `word_source` が実態どおりに埋まる
  （easy / standard = `fixed_slots`、normal / hard = `two_stage_draw`）
- art_first のモードが在り、`is_active = false`（お題を引く画面には出ない）
- 出どころの許可値が4つ（draft / saved / daily / art_first）
- 通常のドロー（normal）が通り、3〜4語のお題ができる
- 持ち込みの作品が作れる。選んだ4語がそのまま4問になる（全語出題）
- 出どころが art_first ／ ドラフト無し ／ 制限時間なし
- 他の人が全問に答えられる
- 診断（A群 41項目）が全部0件

触っている物の重なりも数えた。**2本のあいだに重なりは1つも無い。**

- 一巡ドロー: `draft_candidates` / `draft_session_slots` / `draft_state_json` /
  `pick_card` / `redo_slot` / `reroll_draft`
- art_first: `draft_modes` / `prompts` / `get_my_prompt` / `get_my_work` /
  `get_rankings` / `get_work_detail` ＋ 新しい関数2本

## 6. DBだけ先に当てたとき、いま動いている画面は壊れないか

本番に出ている画面は `main`（`e388f4d`）から作られたもので、
`reveal_card` / `choose_card` を使う旧い流れである。art_first の migration は
その2つを触らない。作り替える取得系4本は、**引数も返す列も変えていない。**

- `get_work_detail` / `get_my_work` / `get_my_prompt` は jsonb を返す関数で、
  鍵を1つ（`origin`）足しただけ。古い画面は知らない鍵を読まない
- `get_rankings` は列の並びも型も同じ。`time_limit_bucket` が null になるのは
  持ち込みの作品だけで、本番にはまだ1件も無い

したがって、**この1本はDBだけ先に当てても中間状態を作らない。**
持ち込みの画面（`/works/import`）は、デプロイするまで本番には出ない。

---

## 7. 本番の鍵が要る検査4本の性質

| コマンド | 何をするか | 読み書き | 要るもの | 当てる前 | 当てた後 | 残るもの |
|---|---|---|---|---|---|---|
| `npm run db:verify` | 構造・権限・関数・漏洩経路・診断・成りすましの確認 | **読むだけ**（役の切り替えは `begin … rollback` の中） | 本番の接続文字列（`SUPABASE_DB_URL`） | 意味がある（当てる前の姿を控えられる） | **必須** | 残らない |
| `npm run verify:launch` | 本番URLの応答・見出し・robots・リダイレクトを外から見る | **読むだけ**（HTTP のみ） | 本番URL（鍵は不要） | 意味がある | あってよい | 残らない |
| `npm run smoke:draft` | 匿名サインイン → ドラフト一連 → お題確定 | **書く**（ゲスト・`draft_sessions`・`prompts` が残る） | `run-production-smoke` 経由＋`--production` | いまは流せない（下の理由） | 一巡ドローを当てるまで流せない | ゲストとお題。`npm run smoke:fixtures:purge` と `npm run cleanup:testdata` で片づける |
| `npm run smoke:play` | 画面（Server Action）経由で同じ流れ | **書く**（同上）。別窓の `npm run dev` が要る | 同上 | いまは流せない | 同上 | 同上 |

### スモーク2本を、いま本番へ向けられない理由

作業ツリーのスモークと画面は、**一巡ドローの書きかけに合わせて書き換わっている。**

- `scripts/smoke-draft.mjs` は `pick_card` を9か所で呼ぶ（実測: grep で9件）
- `src/features/draft/rpc.ts` は `pick_card` と `redo_slot` を呼ぶ

本番のDBにはその2つの関数がまだ無い（除外した1本が作るもの）。
いま本番へ向けると、**art_first とは無関係な理由で必ず落ちる。**
落ちた結果を「本番の不具合」と読み違えないため、この2本は
一巡ドローが本番へ入るまで実行しない。

art_first だけを確かめるなら、当てた後に `npm run db:verify` を回す。
持ち込みの経路そのものは、画面をデプロイしてから確かめる。

---

## 8. 未解決

- 一巡ドローの migration・画面・スモークは、別作業線の書きかけのまま。
  完成と採用の判断は、そちらの担当。
- `20260907120000_single_pass_draw_and_slot_redo.sql` の冒頭の見出しに
  `20260908090000` と書かれている（ファイル名と食い違う）。相手のファイルなので直していない。
- 高負荷で試験がランダムに落ちる性質は、重い検査の札を build と型検査へ広げたことで
  当たりにくくなったが、**同時に2つの作業線が動くこと自体は止められない。**
