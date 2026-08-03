# DB反映の手順（Supabase CLI 版）

2026-08-03 に運用を変更した。**SQL Editor への手動コピー＆実行は廃止**し、
VS Code のターミナルからコマンドで反映・検証する。

---

## フォルダの役割

```
supabase/
  config.toml        CLI の設定（project_id を持つ。秘密は入っていない）
  migrations/        ← CLI が管理する。ここに置いたものだけが db:deploy で適用される
  applied/           ← 001〜007 の本体SQL。SQL Editor で適用済み。参照用
  rollback/          ← 取り消し用SQL。db push の対象外。手で流す
  seed/              シードデータ（未使用）
scripts/
  _db-target.sh      接続先の決めかた（共通部分）
  db-status.sh       履歴の確認（読むだけ）
  db-verify-keychain.sh  キーチェーンのパスワードで db:verify を実行（macOS）
  db-baseline.sh     001〜007 を「適用済み」として履歴へ登録（1回だけ）
  db-deploy.sh       dry-run → push
  db-verify.mjs      構造・権限・漏洩経路・診断の自動検証
  db-privs.mjs       関数のEXECUTE権限を引数型つきで一覧（読むだけ）
  db-checks.mjs      検証項目の定義（項目を足すときはここだけ編集）
```

**`supabase/applied/` と `supabase/rollback/` のファイルを `migrations/` へ戻してはいけない。**
戻すと `db push` が再実行しようとし、`create table` が「already exists」で
止まる（データは消えないが、以降の反映が全部止まる）。

---

## 初回だけ必要な準備

### なぜ db pull を使わないか

`supabase db pull` は差分計算に Docker を使う。Mac の負荷を増やしたくないため、
**Docker を必要としない baseline + repair 方式**で同期する。

やっていることは同じ「いまのリモートを基準として記録する」だが、
基準の中身をリモートから取り出す代わりに、**手元の適用済みSQLから組み立てる**。
001〜007 の本体SQLがすべて `supabase/applied/` に残っているから成立する。

### 手順

```bash
# 1. 接続文字列をこのターミナルの間だけ設定する
#    Supabase ダッシュボード → 上部の Connect → Session pooler の URI
export SUPABASE_DB_URL='postgresql://...'

# 2. 001〜007 を「適用済み」として履歴へ登録する（1回だけ）
npm run db:baseline

# 3. 新しいマイグレーションだけを適用する
npm run db:deploy

# 4. 自動検証
npm run db:verify
```

`db:baseline` が行うのは `supabase migration repair --status applied` だけ。
**履歴表に1行入れるだけで、既存の表・データ・権限には一切触れない。**

### login / link を使う場合

`SUPABASE_DB_URL` を設定しない場合は `--linked` が使われる。

```bash
npx supabase login   # トークンは macOS のキーチェーンへ入る
npm run db:link      # DBパスワードを聞かれる
```

ただしキーチェーンは別プロセスから読めないことがあるため、
うまくいかないときは `SUPABASE_DB_URL` の経路を使う。

---

## ふだんの流れ

```bash
npm run db:status    # 何が適用されるかを見る（DBは変更しない）
npm run db:deploy    # dry-run を表示 → 問題なければ push
npm run db:verify    # 構造・権限・漏洩経路・診断を自動判定
npm run db:privs     # 誰がどの関数を呼べるかを一覧（読むだけ）
```

`db:baseline` は初回の1回だけ。2回目以降は実行不要（実行しても害はない）。

### db:deploy が守っていること

1. 必ず `--dry-run` を先に実行し、適用予定を表示する
2. 適用するものが無ければそこで終了する
3. **`--include-all` を使わない**
   （リモート履歴に無い古いファイルまで巻き込むため）
4. `db reset` やデータ削除は一切行わない

### db:verify が見ていること

| 区分 | 内容 |
|---|---|
| 構造 | 表21個・RLS 有効・マスタ行数 |
| 権限 | 遮断11表に権限0件／ポリシー0本、権限を持つのは10表だけ |
| 関数 | `search_path` 固定、PUBLIC に EXECUTE が残っていない、公開／本人用／書き込みの切り分け |
| 登録必須 | `create_work` / `update_work` / `update_my_profile` / `toggle_like` / `toggle_save` と<br>Storage の追加ポリシーが JWT の `is_anonymous` を見ている |
| Storage | `works` バケットが公開読み取り・5MiB・画像3種、ポリシー4本、`anon` に書き込みが無い |
| フィード | 通常フィード（`p_division = null`）が AI 部門を除いている |
| ランキング | `get_rankings` が作者本人のいいねを順位から除き、公開3条件で絞り、<br>伝達率を回答5人以上に限り、同点でも id まで並べ切っている |
| 公開 | お気に入りが `show_saved_works` に従い、他人へは公開作品だけを返し、<br>お題を添えるのが「閲覧者が回答済み」のときに限られている。<br>いいねとお気に入りが互いに触れていない。ID の予約語を配らない |
| 選択肢 | `complete_draft` がプール単位でハズレを配り、重複を検算して失敗させる |
| 漏洩 | `prompt_id` を返さない、`get_work_quiz` が `is_correct` に触れない、`weight` を読まない、<br>`prompt_cards`（＝答え）に触れる関数が**4本のまま** |
| 診断 | Step 3E の A1〜A24（すべて0行なら正常） |
| 参考 | 合否に数えない件数。修正前クイズの重複数（legacy）など |
| 実地 | `anon` / `authenticated` に成りすまして、実際に読めない／呼べないことを確認 |

**`[参考]` は合否に数えない。** 「0 であってほしいが、いまは 0 でないことが
正しい」ものを置く場所。診断に混ぜると常に失敗し、本当の失敗が埋もれる。

いまここに出るのは、選択肢の重複禁止（`20260803045329_quiz_choice_dedupe.sql`）
より前に作られたクイズの重複件数。既存クイズは作り直さない方針なので
0 にはならない。診断 A23 は適用後に作られたぶんだけを厳格に見る。

**`prompt_cards` に触れる関数の本数は、単独では意味を持たない。**
「回答済み判定なしに読んでいないか」を見る項目と**対で**確認すること。
本数だけを見ていると、無条件に答えを読む関数が紛れ込んでも気づけない。
いまの4本は complete_draft / get_my_prompt / get_my_answer / get_saved_works。

診断 A24 は、ランキングの伝達率が2通りの数え方で同じ値になることを見る。
`get_rankings` は軽いほう（`work_slot_stats` の合計）を使うので、
仕様どおりの定義（`answers.correct_count` の合計 ÷ 回答項目数）と
ずれていないことを確かめておく必要がある。

「登録必須」の2項目だけ毛色が違う。ほかは権限や構造を見ているが、ここは
**関数とポリシーの定義文そのもの**を見ている。匿名ゲストと登録ユーザーは
Postgres 側では同じ `authenticated` ロールなので、この区別は
「関数の中の1行」と「ポリシーの中の1行」だけで成り立っている。
消えても表面上は動いてしまうため、条件式が残っていること自体を検査する。

実地確認は1件ずつ `begin ... rollback` の中で行うため、**データは1行も変わらない**。

### 接続文字列の扱い

`db:verify` は環境変数 `SUPABASE_DB_URL` を読む。無ければその場で伏せ字入力を求める。
毎回聞かれたくない場合は、そのターミナルの間だけ有効な形で設定する。

```bash
export SUPABASE_DB_URL='postgresql://...'   # Supabase → Connect からコピー
```

### 毎回貼らずに済ませる（macOS）

`npm run db:verify:keychain` を使うと、接続文字列を手入力せずに検証できる。

```bash
# 初回だけ。データベースのパスワードをキーチェーンへ入れる
security add-generic-password \
  -s drawing-prompt-quiz-supabase-db-password \
  -a "$USER" -w

# 以降はこれだけ
npm run db:verify:keychain
```

やっていることは3つ。

1. 接続先（パスワード以外）を `supabase/.temp/pooler-url` から読む
   （`supabase link` が作る。**パスワードは入っていない**）
2. パスワードをキーチェーンから取り出し、接続文字列を組み立てる
3. `db-verify.mjs` の**プロセスにだけ**渡し、終わったら変数を消す

パスワードも接続文字列も画面に出さず、ファイルにも書かず、
シェルへ export もしない。スクリプトを抜けた時点で残らない。

入れる値は Supabase ダッシュボード → Project Settings → Database の
**データベースのパスワード**（接続文字列全体ではない）。

初回の実行時に「security がキーチェーンにアクセスしようとしています」と
聞かれることがある。許可すると次回から聞かれない。

**`.env.local` や `.env.example` に書かないこと。** `.env*` は Git 管理外だが、
DBの完全な権限を持つ文字列を平文でディスクに残さない方針とする。

---

## 新しいSQLを追加するとき

```bash
npx supabase migration new draft_rpcs
# → supabase/migrations/<日時>_draft_rpcs.sql が空で作られる
# → 中身を書く
npm run db:status    # 適用予定に出ることを確認
npm run db:deploy
npm run db:verify
```

ファイル名の日時は**必ず既存より後**になる。手で番号を付けない。

---

## やってはいけないこと

| 禁止 | 理由 |
|---|---|
| `supabase db reset --linked` | リモートDBを作り直す。**データが全部消える** |
| `db push --include-all` | `applied/` を戻した場合などに古いSQLを巻き込む |
| `applied/` `rollback/` のファイルを `migrations/` へ移す | 再実行されて反映が止まる |
| 基準マイグレーションへ verify / rollback SQL を混ぜる | rollback には `drop table` が入っている。**新環境で表が消える** |
| 接続文字列やアクセストークンをファイルに書く | 漏れたらDBを自由にされる |
| ACL を文字列比較で判定する | `anon=X/` にも `=X/` が含まれる。`aclexplode` で grantee の oid を見る |
| `supabase db pull` | Docker が必要。方針に反する（baseline + repair を使う） |
