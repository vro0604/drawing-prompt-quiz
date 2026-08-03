#!/usr/bin/env bash
#
# db-deploy.sh ／ 新しいマイグレーションだけをリモートへ反映する
#
# 【安全のための決まり】
#   1. 必ず先に --dry-run を実行し、何が適用されるかを表示する
#   2. 何も適用されない場合はそこで終了する
#   3. --include-all は使わない
#      （リモート履歴に無い古いファイルまで巻き込んで適用してしまうため）
#   4. db reset / データ削除は一切行わない

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=./_db-target.sh
source "$(dirname "$0")/_db-target.sh"

echo "接続先: $TARGET_LABEL"
echo ""
echo "───────────────────────────────────────────"
echo " 1/3  適用予定の確認（dry-run。DBは変更されません）"
echo "───────────────────────────────────────────"

DRY_OUT="$(npx supabase db push "${TARGET[@]}" --dry-run 2>&1)" || {
  echo "$DRY_OUT"
  echo ""
  echo "✗ dry-run に失敗しました。"
  echo "  SUPABASE_DB_URL を設定するか、supabase link を済ませてください。"
  exit 1
}
echo "$DRY_OUT"

if echo "$DRY_OUT" | grep -qi "up to date"; then
  echo ""
  echo "✓ 適用するものはありません。DBは変更していません。"
  exit 0
fi

echo ""
echo "───────────────────────────────────────────"
echo " 2/3  上記を適用します"
echo "───────────────────────────────────────────"
npx supabase db push "${TARGET[@]}" --yes

echo ""
echo "───────────────────────────────────────────"
echo " 3/3  適用後の履歴"
echo "───────────────────────────────────────────"
npx supabase migration list "${TARGET[@]}"

echo ""
echo "✓ 反映が完了しました。次は npm run db:verify で検証してください。"
