#!/usr/bin/env bash
#
# db-baseline.sh ／ 001〜007 を「適用済み」としてリモート履歴へ登録する
#
# 【何をするか】
#   supabase migration repair --status applied を1回だけ実行する。
#   これは supabase_migrations.schema_migrations という履歴表に
#   1行入れるだけの操作で、**既存の表・データ・権限には一切触れない**。
#
# 【なぜ必要か】
#   001〜007 は SQL Editor から手で適用したため、CLI の履歴表に記録が無い。
#   このままだと db push が「まだ適用されていない」と判断して再実行しようとする。
#
# 【1回だけ実行するもの】
#   2回目以降は「すでに登録済み」となるだけで害はない。

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=./_db-target.sh
source "$(dirname "$0")/_db-target.sh"

BASELINE="$(ls -1 supabase/migrations/*_baseline_applied_schema.sql 2>/dev/null | head -1)"
if [ -z "$BASELINE" ]; then
  echo "✗ baseline_applied_schema のマイグレーションが見つかりません。"
  exit 1
fi
VERSION="$(basename "$BASELINE" | cut -d_ -f1)"

echo "接続先: $TARGET_LABEL"
echo "基準マイグレーション: $(basename "$BASELINE")"
echo "バージョン: $VERSION"
echo ""
echo "───────────────────────────────────────────"
echo " 1/3  履歴へ「適用済み」として登録（表とデータには触れません）"
echo "───────────────────────────────────────────"
npx supabase migration repair "$VERSION" --status applied "${TARGET[@]}"

echo ""
echo "───────────────────────────────────────────"
echo " 2/3  履歴の確認"
echo "───────────────────────────────────────────"
npx supabase migration list "${TARGET[@]}"

echo ""
echo "───────────────────────────────────────────"
echo " 3/3  既存SQLが再適用されないことの確認（dry-run）"
echo "───────────────────────────────────────────"
npx supabase db push "${TARGET[@]}" --dry-run

echo ""
echo "✓ baseline の登録が終わりました。"
echo "  上の dry-run に baseline_applied_schema が出ていなければ成功です。"
