#!/usr/bin/env bash
#
# _db-target.sh ／ 接続先の決めかた（他のスクリプトから読み込む共通部分）
#
# SUPABASE_DB_URL があればそれを使い、無ければ link 済みプロジェクトを使う。
#
# 【なぜ2通りあるか】
#   supabase login はアクセストークンを macOS のキーチェーンへ入れる。
#   別プロセスからは取り出せないことがあり、その場合 --linked は使えない。
#   接続文字列を環境変数で渡す経路を残しておくと、どちらでも動く。
#
# 【秘密の扱い】
#   TARGET の中身は絶対に echo しない。set -x も使わない。

if [ -n "${SUPABASE_DB_URL:-}" ]; then
  TARGET=(--db-url "$SUPABASE_DB_URL")
  TARGET_LABEL="SUPABASE_DB_URL（環境変数）"
else
  TARGET=(--linked)
  TARGET_LABEL="link 済みプロジェクト"
fi

export TARGET_LABEL
