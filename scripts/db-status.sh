#!/usr/bin/env bash
#
# db-status.sh ／ ローカルとリモートのマイグレーション履歴を見比べる
#
# DBは一切変更しない。読むだけ。

set -euo pipefail

cd "$(dirname "$0")/.."

echo "───────────────────────────────────────────"
echo " マイグレーション履歴（Local = 手元のファイル / Remote = 適用済み）"
echo "───────────────────────────────────────────"
npx supabase migration list --linked

echo ""
echo "───────────────────────────────────────────"
echo " 次の db:deploy で適用されるもの（dry-run。DBは変更されません）"
echo "───────────────────────────────────────────"
npx supabase db push --linked --dry-run

echo ""
echo "───────────────────────────────────────────"
echo " 適用済みで再実行しないSQL（supabase/applied/）"
echo "───────────────────────────────────────────"
ls -1 supabase/applied/*.sql 2>/dev/null | sed 's|supabase/applied/|  |' || echo "  （なし）"

if [ -d supabase/pending ] && [ -n "$(ls -A supabase/pending 2>/dev/null)" ]; then
  echo ""
  echo "───────────────────────────────────────────"
  echo " まだマイグレーション化していないSQL（supabase/pending/）"
  echo "───────────────────────────────────────────"
  ls -1 supabase/pending/*.sql | sed 's|supabase/pending/|  |'
fi
