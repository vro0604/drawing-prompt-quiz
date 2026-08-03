# DB反映の手順（Supabase CLI 版）

2026-08-03 に運用を変更した。**SQL Editor への手動コピー＆実行は廃止**し、
VS Code のターミナルからコマンドで反映・検証する。

---

## フォルダの役割

```
supabase/
  config.toml        CLI の設定（project_id を持つ。秘密は入っていない）
  migrations/        ← CLI が管理する。ここに置いたものだけが db:deploy で適用される
  applied/           ← 001〜007。SQL Editor で適用済み。**二度と実行しない**
  pending/           ← まだマイグレーション化していない下書き
  seed/              シードデータ（未使用）
scripts/
  db-status.sh       履歴の確認（読むだけ）
  db-deploy.sh       dry-run → push
  db-verify.mjs      構造・権限・漏洩経路・診断の自動検証
  db-checks.mjs      検証項目の定義（項目を足すときはここだけ編集）
```

**`supabase/applied/` の17ファイルを `migrations/` へ戻してはいけない。**
戻すと `db push` が再実行しようとし、`create table` が「already exists」で
止まる（データは消えないが、以降の反映が全部止まる）。

---

## 初回だけ必要な準備

ターミナルで**本人が**実行する。トークンやパスワードは
ファイル・ログ・Git のどこにも残さない。チャットにも貼らない。

```bash
# 1. Supabase にログイン（ブラウザが開く）
npx supabase login

# 2. プロジェクトに紐づける（DBパスワードを聞かれる）
npm run db:link

# 3. いまのリモートDBを基準として取り込む
#    supabase/migrations/<日時>_remote_schema.sql が作られ、
#    「適用済み」としてリモートの履歴表にも記録される
npx supabase db pull
```

`db pull` の後は必ず `npm run db:status` で
Local と Remote の版が一致していることを確かめる。

---

## ふだんの流れ

```bash
npm run db:status    # 何が適用されるかを見る（DBは変更しない）
npm run db:deploy    # dry-run を表示 → 問題なければ push
npm run db:verify    # 構造・権限・漏洩経路・診断を自動判定
```

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
| 関数 | `search_path` 固定、PUBLIC に EXECUTE が残っていない、公開／本人用の切り分け |
| 漏洩 | `prompt_id` を返さない、`get_work_quiz` が `is_correct` に触れない、`weight` を読まない |
| 診断 | Step 3E の A1〜A14（すべて0行なら正常） |
| 実地 | `anon` / `authenticated` に成りすまして、実際に読めない／呼べないことを確認 |

実地確認は1件ずつ `begin ... rollback` の中で行うため、**データは1行も変わらない**。

### 接続文字列の扱い

`db:verify` は環境変数 `SUPABASE_DB_URL` を読む。無ければその場で伏せ字入力を求める。
毎回聞かれたくない場合は、そのターミナルの間だけ有効な形で設定する。

```bash
export SUPABASE_DB_URL='postgresql://...'   # Supabase → Connect からコピー
```

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
| `applied/` のファイルを `migrations/` へ移す | 再実行されて反映が止まる |
| 接続文字列やアクセストークンをファイルに書く | 漏れたらDBを自由にされる |
