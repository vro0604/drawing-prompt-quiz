# applied ／ 適用済みSQL（再実行しない・参照用）

001〜007 は Supabase の SQL Editor から手動で適用した本体SQL。
CLI 運用へ移行したあとも「何をどう作ったか」の記録として残す。

**このフォルダのファイルは db push の対象外**（`supabase/migrations/` にないため）。

| ファイル | Step | 内容 |
|---|---|---|
| 001_profiles.sql | 2 | profiles ＋ auth.users トリガー |
| 002_masters.sql | 3B-1 | マスタ5表＋28行 |
| 003_draft.sql | 3B-2a | draft_sessions / draft_candidates |
| 004_prompts_quiz.sql | 3B-2b | prompts / prompt_cards / quiz_questions / quiz_choices |
| 005_works_answers.sql | 3B-3a | works / answers / answer_items / 集計3表 |
| 006_likes_saves_reports.sql | 3B-3b | likes / saves / reports |
| 007_read_rpcs.sql | 3C | 取得系RPC 13本 |

`*_verify.sql` は当時の手動検証用。検証は `npm run db:verify` に統合済みで、
いまは参照用として残しているだけ。

## この7本と基準マイグレーションの関係

`supabase/migrations/<日時>_baseline_applied_schema.sql` は、
**この7本の本体SQLを適用順に結合したもの**（rollback と verify は含めない）。
各ファイルの先頭 `begin;` と末尾 `commit;` だけを取り除き、
それ以外は1文字も変えていない。

基準マイグレーションはリモートでは実行されない。
`supabase migration repair --status applied` で履歴に登録するだけ。
実際に実行されるのは、新しい環境を1から作り直すときだけ。
