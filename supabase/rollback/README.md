# rollback ／ 取り消し用SQL

各工程を1つ前の状態へ戻すためのSQL。**db push の対象外。**

戻す操作は「前へ進む」ための `db push` とは性質が違うため、
CLI では流さず、SQL Editor で意図を持って手で実行する。

| ファイル | 戻す先 |
|---|---|
| 001_profiles_rollback.sql | Step 1 完了時点 |
| 002_masters_rollback.sql | Step 2 完了時点 |
| 003_draft_rollback.sql | Step 3B-1 完了時点 |
| 004_prompts_quiz_rollback.sql | Step 3B-2a 完了時点 |
| 005_works_answers_rollback.sql | Step 3B-2b 完了時点 |
| 006_likes_saves_reports_rollback.sql | Step 3B-3a 完了時点 |
| 007_read_rpcs_rollback.sql | Step 3B-3b 完了時点 |
| 008_draft_rpcs_rollback.sql | Step 3C 完了時点 |

D194〜D196（システム回答の3本。2026-09-12 に作成、どこにも流していない）:

| ファイル | 戻す先 | 流す順 |
|---|---|---|
| 20260912100000_system_answer_out_of_analysis_and_import_rollback.sql | D196 を当てる前 | 1番目 |
| 20260912090000_system_answer_queue_rollback.sql | D195 を当てる前 | 2番目 |
| 20260911090000_answer_source_rollback.sql | D194 を当てる前 | 3番目 |

この3本は、システム回答が0件・待ち行列が0行のときだけ動く（どちらかが1でもあれば、
何も変えずに止まる）。順番を飛ばすと止まる。流し方・履歴の外し方・確かめ方は
docs/landing-d194-d196.md の「取り消し」。

いずれも `begin` / `commit` で囲んであり、途中で失敗すれば何も消えずに巻き戻る。

**注意**：後の工程を実行済みのまま古い rollback を流すと、
外部キーに阻まれて削除が拒否される（＝安全側で止まる）。
戻すときは新しい番号から順に実行する。
