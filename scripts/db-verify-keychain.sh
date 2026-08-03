#!/usr/bin/env bash
#
# db-verify-keychain.sh ／ 接続文字列を手入力せずに db:verify を実行する
#
# 【やること】
#   1. 接続先（パスワード以外）を link の結果から読む
#   2. パスワードを macOS のキーチェーンから取り出す
#   3. その2つから接続文字列を組み立て、**db:verify のプロセスにだけ**渡す
#   4. 終わったら変数を消す
#
# 【やらないこと】
#   ・パスワードや接続文字列を画面に出さない
#   ・ファイルに書かない（.env.local にも書かない）
#   ・シェルに export しない（このスクリプトを抜けた時点で残らない）
#
# 【なぜ必要か】
#   db-verify.mjs は pg で直接つなぐため、パスワード込みの接続文字列が要る。
#   supabase link が保存する supabase/.temp/pooler-url にはパスワードが入らず、
#   CLI が持っている資格情報も別プロセスからは取り出せない。
#   毎回ダッシュボードからコピーして貼るのを避けるための入口。
#
# 【初回だけ必要な準備】
#   キーチェーンにパスワードを登録する（-w のあとに続けて入力するとプロンプトになる）。
#
#     security add-generic-password \
#       -s drawing-prompt-quiz-supabase-db-password \
#       -a "$USER" -w
#
#   入れる値は Supabase ダッシュボード → Project Settings → Database の
#   **データベースのパスワード**（接続文字列全体ではない）。
#
#   初回の実行時に「security がキーチェーンにアクセスしようとしています」と
#   聞かれることがある。許可すると次回から聞かれない。
#
# 【使い方】
#   npm run db:verify:keychain

set -euo pipefail
cd "$(dirname "$0")/.."

KEYCHAIN_SERVICE="drawing-prompt-quiz-supabase-db-password"
POOLER_FILE="supabase/.temp/pooler-url"

# --- 1. 接続先（パスワード以外）------------------------------------------------

if [ ! -f "$POOLER_FILE" ]; then
  echo "接続先が分かりません（$POOLER_FILE がありません）。"
  echo ""
  echo "対処:"
  echo "  1. npx supabase login"
  echo "  2. npm run db:link"
  echo "  を済ませてから、もう一度実行してください。"
  exit 1
fi

# --- 2. パスワード -------------------------------------------------------------
#
# 見つからない場合だけ案内を出す。値そのものは絶対に表示しない。

if ! password="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"; then
  echo "キーチェーンに $KEYCHAIN_SERVICE が見つかりません。"
  echo ""
  echo "登録するには次を実行してください（パスワードの入力を求められます）:"
  echo ""
  echo "  security add-generic-password \\"
  echo "    -s $KEYCHAIN_SERVICE \\"
  echo "    -a \"\$USER\" -w"
  echo ""
  echo "入れる値は Supabase ダッシュボード → Project Settings → Database の"
  echo "データベースのパスワードです（接続文字列全体ではありません）。"
  exit 1
fi

if [ -z "$password" ]; then
  echo "キーチェーンの $KEYCHAIN_SERVICE が空です。登録し直してください。"
  exit 1
fi

# --- 3. 接続文字列を組み立てる -------------------------------------------------
#
# 値の受け渡しは環境変数で行う。コマンドの引数に載せると ps で見えてしまう。
# 組み立てには URL を使う。記号を含むパスワードでも正しくエスケープされる。
# 結果は変数へ入れるだけで、画面には出さない。

url="$(SUPABASE_DB_PASSWORD="$password" node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync("supabase/.temp/pooler-url", "utf8").trim();
  const u = new URL(raw);
  u.password = process.env.SUPABASE_DB_PASSWORD;
  process.stdout.write(u.toString());
')"

# --- 4. 検証を実行する ---------------------------------------------------------
#
# この書き方だと SUPABASE_DB_URL は node のプロセスにだけ渡り、
# このスクリプトを抜けたあとのシェルには残らない。
#
# set -e を一時的に外すのは、失敗した場合でも下の unset まで進めるため。

echo "接続先: キーチェーン ＋ link 済みプロジェクト"
echo ""

set +e
SUPABASE_DB_URL="$url" node scripts/db-verify.mjs
status=$?
set -e

unset url password SUPABASE_DB_PASSWORD

exit "$status"
