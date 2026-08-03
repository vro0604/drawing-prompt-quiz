# pending ／ まだマイグレーション化していないSQL

ここのファイルは `db push` の対象外。
`supabase/migrations/` に基準（remote_schema）ができてから、
`npx supabase migration new <名前>` で作った日時つきファイルへ中身を移す。

日時を手で付けないのは、基準より前の番号になると
CLI が履歴の食い違いとみなして反映が止まるため。
