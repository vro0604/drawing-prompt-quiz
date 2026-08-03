#!/usr/bin/env bash
#
# db-deploy.sh ／ 新しいマイグレーションだけをリモートへ反映する
#
# 【安全のための決まり】
#   1. 必ず先に --dry-run を実行し、何が適用されるかを表示する
#   2. 何も適用されない場合はそこで終了する（無駄な push をしない）
#   3. --include-all は使わない
#      （リモート履歴に無い古いファイルまで巻き込んで適用してしまうため。
#        001〜007 は SQL Editor から適用済みで、supabase/applied/ に退避してある）
#   4. db reset / データ削除は一切行わない
#
# 【認証】
#   supabase login と supabase link は本人がターミナルで実行しておくこと。
#   このスクリプトはトークンもパスワードも受け取らず、保存もしない。

set -euo pipefail

cd "$(dirname "$0")/.."

echo "───────────────────────────────────────────"
echo " 1/3  適用予定の確認（dry-run。DBは変更されません）"
echo "───────────────────────────────────────────"

DRY_OUT="$(npx supabase db push --linked --dry-run 2>&1)" || {
  echo "$DRY_OUT"
  echo ""
  echo "✗ dry-run に失敗しました。"
  echo "  supabase login / supabase link が済んでいるか確認してください。"
  exit 1
}

echo "$DRY_OUT"

if echo "$DRY_OUT" | grep -qi "Remote database is up to date"; then
  echo ""
  echo "✓ 適用するものはありません。DBは変更していません。"
  exit 0
fi

echo ""
echo "───────────────────────────────────────────"
echo " 2/3  上記を適用します"
echo "───────────────────────────────────────────"

npx supabase db push --linked --yes

echo ""
echo "───────────────────────────────────────────"
echo " 3/3  適用後の履歴"
echo "───────────────────────────────────────────"

npx supabase migration list --linked

echo ""
echo "✓ 反映が完了しました。次は npm run db:verify で検証してください。"
