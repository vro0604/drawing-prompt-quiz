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
| 整合 | **表と表のつなぎ目**を見る。退会で消す6表が CASCADE、残す5表が SET NULL。<br>NOT NULL なのに SET NULL される外部キーが無い。<br>作品のあるお題は消せない（`works.prompt_id` が RESTRICT）。<br>下書きを消してもお題は残る（`prompts.draft_session_id` が SET NULL）。<br>二重送信を止める一意索引が4本ある。<br>いいね・お気に入りが同時押しで例外にならない（`on conflict`）。<br>回答・通報の2件目が日本語で断られる（`unique_violation` を変換） |
| 構造 | 表22個・RLS 有効・マスタ行数 |
| 権限 | 遮断12表に権限0件／ポリシー0本、権限を持つのは10表だけ。<br>`profiles` の保護列（`handle` / `handle_updated_at` / `id` / `is_anonymous` / `created_at`）に UPDATE が無く、<br>直接更新してよい6列は残っている |
| 関数 | `search_path` 固定、PUBLIC に EXECUTE が残っていない、公開／本人用／書き込みの切り分け |
| 登録必須 | `create_work` / `update_work` / `update_my_profile` / `toggle_like` / `toggle_save` と<br>Storage の追加ポリシーが JWT の `is_anonymous` を見ている |
| Storage | `works` バケットが公開読み取り・5MiB・画像3種、ポリシー4本、`anon` に書き込みが無い |
| フィード | 通常フィード（`p_division = null`）が AI 部門を除いている |
| ランキング | `get_rankings` が作者本人のいいねを順位から除き、公開3条件で絞り、<br>伝達率を回答5人以上に限り、同点でも id まで並べ切っている |
| 削除通報 | 手放した ID を他人へ渡さず、変更が30日に1回に制限されている。<br>削除が「公開から外す」だけで行を消していない。通報が公開中の作品にしか届かない |
| 公開 | お気に入りが `show_saved_works` に従い、他人へは公開作品だけを返し、<br>お題を添えるのが「閲覧者が回答済み」のときに限られている。<br>いいねとお気に入りが互いに触れていない。ID の予約語を配らない |
| 選択肢 | `complete_draft` がプール単位でハズレを配り、重複を検算して失敗させる |
| タグ | 有効156件・プール別 102 / 15 / 24 / 15・重複0・抽選とクイズの下限を満たす。<br>重みが均一でなく、最大が最小の4倍未満（＝重みから正解を推測できない）。<br>お題とクイズが存在しないタグを指していない |
| 退会 | **作品・回答・通報・集計の行を消していない**（消す命令が無いことで確かめる）。<br>持ち主と回答者の線だけを切り、本人だけのものを消している。<br>`works.user_id` を外せる（nullable ＋ set null）。持ち主のいない作品は公開対象になれない。<br>書き込みの門番が8つ付いている。退会した ID を平文で持たず、鍵は DB の中にある。<br>Storage の書き込み3本が退会処理中を見ている。引数に利用者を取らない |
| 規約 | 有効な版が規約とポリシーに1つずつ。同意の記録に保存期限が必ず入る。<br>退会で個人と切り離される。未同意では作品を作れない |
| 掃除 | 掃除の関数12本が service_role からだけ呼べる（anon / authenticated からは呼べない）。<br>`search_path` を全部固定している。`submitted` のお題と `completed` のドラフトを消さない。<br>ゲストの掃除が作品を持つ人を除いている |
| 漏洩 | `prompt_id` を返さない、`get_work_quiz` が `is_correct` に触れない、`weight` を読まない、<br>`prompt_cards`（＝答え）に触れる関数が**4本のまま** |
| 診断 | Step 3E の A1〜A27（すべて0行なら正常） |
| 参考 | 合否に数えない件数。修正前クイズの重複数（legacy）など |
| 一覧 | 合否に数えない**中身**。権限を grantee 別・種類別にそのまま並べる |
| 実地 | `anon` / `authenticated` に成りすまして、実際に読めない／呼べないことを確認 |

**`[参考]` は合否に数えない。** 「0 であってほしいが、いまは 0 でないことが
正しい」ものを置く場所。診断に混ぜると常に失敗し、本当の失敗が埋もれる。

いまここに出るのは、選択肢の重複禁止（`20260803045329_quiz_choice_dedupe.sql`）
より前に作られたクイズの重複件数。既存クイズは作り直さない方針なので
0 にはならない。診断 A23 は適用後に作られたぶんだけを厳格に見る。

### 「0件であること」の検査には一覧を対で置く

**`[一覧]` は合否に数えない。** 権限やポリシーの中身を grantee 別に
そのまま並べる欄。0行のときは「0行が正常」と書いた文言を出す。

数だけを見る検査には、その0件の中身を見せる欄を対で置く。
「期待0／実際N」しか出ないと、**本当に権限があるのか、数え方を
間違えているのか**が読み取れない（実際に Step 15 で両方が同時に起き、
切り分けに時間がかかった。D66）。

権限の検査は `aclexplode` で行う。`information_schema.column_privileges` は
`SELECT` / `INSERT` / `UPDATE` / `REFERENCES` の4種しか見えず、
**`DELETE` や `TRUNCATE` だけを配られていても気づけない**。
さらに表単位の grant を全列に展開して見せるため、
「表に付いているのか列に付いているのか」も読み取れない。

`aclexplode` を使うときの決まりが2つある。

1. **空配列を渡さない。** 受け付けるのは1次元の配列だけで、
   `'{}'::aclitem[]` は「要素数0」ではなく「**次元数0**」。
   `coalesce` の逃げ道に使うと `ACL arrays must be one-dimensional` で落ちる。
   `relacl` / `attacl` が null の行は、そもそも渡さない
2. **CTE に `as materialized` を付ける。** FROM に置いた集合返し関数は
   WHERE より先に評価されることがある。`is not null` を書いても
   順序が入れ替われば同じ場所で落ちる

`relacl`（表単位）と `attacl`（列単位）は**配列としてつながない**。
型は同じでも意味が違うので、別々に展開して `UNION ALL` する。

既定権限（`pg_default_acl`）は**ロールごと**の設定。効くのは
「そのロールがオブジェクトを作ったとき」だけなので、この工程が使わない
内部ロール（`supabase_admin` など）の行が残っていても影響しない。
検査は **migration が表を作るロール**の行だけを見る。

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
| 新しい表を作って `revoke` を書かない | **Supabase は新しい表へ ALL を自動で配る。**<br>遮断表なら `revoke all on <表> from public, anon, authenticated;` まで書いて1組（D65）。<br>20260803221747 で既定を逆にしたので今後は自動では付かないが、<br>別のロールが作った表には効かないため、書く習慣は残す |
| 権限の検査を `information_schema` だけで行う | `DELETE` / `TRUNCATE` が見えない。`aclexplode` で `relacl` / `attacl` を展開する |
| 「見てから書く」だけで二重送信を防いだつもりにする | 見てから書くまでのすき間に同じ操作が並ぶ。<br>**一意索引と、その違反を日本語へ変換する組み合わせまでで1組**（D81 / D82） |
| スモークの失敗を「一時的」で片づける | 回数制限に当たると**無関係な項目が次々に失敗する**。<br>`_smoke-http.mjs` が制限を検知してその場で止めるので、まずその文言を確認する（D83） |
| マスタ行の投入で `delete` してから入れ直す | `tags.id` は `prompt_cards` / `quiz_choices` の宛先。**入れ直すと id がずれ、<br>過去のお題が別のタグを指す。しかもエラーにならない。**<br>`on conflict (自然キー) do update` で当てる（D69） |
| 投入件数の検算を定数で書く | 2回目に必ず失敗し、「壊れたのか、もう入っているのか」が区別できなくなる。<br>`目標件数 −（実行前から在った件数）` で計算する（D69） |
| 鍵やパスワードを migration の本文に書く | migration は Git に入る。**鍵付きハッシュにする意味が無くなる。**<br>`gen_random_uuid()` などで DB の中に作り、遮断表に置く（D73） |
| 「全利用者の書き込みを止める」を RPC 側に足す | 呼べる RPC は35本ある。書き写せば写し間違いが混ざり、**気づけない。**<br>着地する表（8つ）の BEFORE トリガーに置く（D71） |
| `SUPABASE_SECRET_KEY` を RPC やクライアントから使う | RLS を迂回する鍵。使ってよいのは `src/lib/supabase/admin.ts` だけ。<br>`NEXT_PUBLIC_` を付けると**ブラウザに埋め込まれる** |
| 「鍵が無ければ検証を飛ばす」形の守りを書く | 環境変数を1つ忘れただけで穴が開き、**画面は何も変わらないので気づけない。**<br>守れないなら受け付けない（503）。素通しにはしない（D78） |
| 外部への検証が失敗したときに「通す」 | 検証先を落とすだけで守りを無効化できる。**届かない＝通さない**（D79） |
