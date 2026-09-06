#!/usr/bin/env bash
#
# db-audit-prod.sh ／ 本番DBを読むだけの監査を、パスワードを手入力せずに走らせる
#
# db-verify-keychain.sh と同じ手順で接続文字列を組み立て、
# **読むだけの監査**（scripts/db-audit-prod.mjs）にだけ渡す。
#
# この入口は本番へつなぐ。ローカル試験（test:db / test:e2e / test:smoke:local）は
# 別の入口で、そちらには本番向きの環境変数を見つけたら止まる柵が入っている。
# 2つを混ぜないために、コマンドを分けてある。
#
# 使い方: npm run db:audit:prod

set -euo pipefail
cd "$(dirname "$0")/.."

KEYCHAIN_SERVICE="drawing-prompt-quiz-supabase-db-password"
POOLER_FILE="supabase/.temp/pooler-url"

if [ ! -f "$POOLER_FILE" ]; then
  echo "接続先が分かりません（$POOLER_FILE がありません）。"
  echo "  npx supabase login → npm run db:link を済ませてください。"
  exit 1
fi

if ! password="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"; then
  echo "キーチェーンに $KEYCHAIN_SERVICE が見つかりません。"
  echo "  security add-generic-password -s $KEYCHAIN_SERVICE -a \"\$USER\" -w"
  exit 1
fi

url="$(SUPABASE_DB_PASSWORD="$password" node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync("supabase/.temp/pooler-url", "utf8").trim();
  const u = new URL(raw);
  u.password = process.env.SUPABASE_DB_PASSWORD;
  process.stdout.write(u.toString());
')"

set +e
SUPABASE_DB_URL="$url" node scripts/db-audit-prod.mjs
status=$?
set -e

unset url password SUPABASE_DB_PASSWORD
exit "$status"
