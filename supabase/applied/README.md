# applied ／ 適用済みSQL（再実行しない）

001〜007 は Supabase の SQL Editor から手動で適用済み。
CLI 運用へ移行したあとも履歴として残すが、**二度と実行しない**。

`supabase/migrations/` へ戻すと `db push` が再実行しようとし、
`create table` が「already exists」で止まって以降の反映が全部止まる。
（データが消えることはないが、復旧に手間がかかる）

| ファイル | Step | 内容 |
|---|---|---|
| 001_profiles.sql | 2 | profiles ＋ auth.users トリガー |
| 002_masters.sql | 3B-1 | マスタ5表＋28行 |
| 003_draft.sql | 3B-2a | draft_sessions / draft_candidates |
| 004_prompts_quiz.sql | 3B-2b | prompts / prompt_cards / quiz_questions / quiz_choices |
| 005_works_answers.sql | 3B-3a | works / answers / answer_items / 集計3表 |
| 006_likes_saves_reports.sql | 3B-3b | likes / saves / reports |
| 007_read_rpcs.sql | 3C | 取得系RPC 13本 |

`*_rollback.sql` は取り消し用、`*_verify.sql` は当時の手動検証用。
検証は `npm run db:verify` に統合済みなので、verify ファイルは参照用。
