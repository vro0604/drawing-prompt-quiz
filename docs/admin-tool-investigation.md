# 管理ツール導入前の現状調査（つたわるかな）

調査日 2026-09-08 ／ 基準は作業ツリーの `main`（未コミットの差分を含む）。

**この文書は調査であって仕様書ではない。コードを1行も変えていない。**
migration も作っていない。画面名・列名・権限方式はどれも決めていない（第16節）。

出所: 2026-09-08 のユーザー指示「つたわるかな 管理ツール導入前の現状調査」
（原文の項目1〜12）。

> **2026-09-08 追記。この調査は承認され、第14節の MVP のうち P0 を実装した
> （管理 v0）。**確定した仕様は `docs/decisions.md` の D177 にある。
> この文書は「実装前に何が分かっていたか」の記録として、直さずに残す。
>
> 実装したのは、第14節の1〜5のうち **2・3・4・5**。すなわち
> 通報の一覧（`/admin/reports`）、通報の詳細と3つの操作
> （`/admin/reports/[id]`）、監査記録（`admin_audit_log`）、
> 管理者の判定（環境変数 `ADMIN_USER_ID` との照合）。
> **1（数字の窓としての `/admin` ダッシュボード）は作っていない。**
>
> したがって、第14節の「日常作業8つのうち6つ」のうち、
> 実装で満たしたのは **1〜4 の4つ**。5（掃除の残り）と 6（登録・投稿・
> 回答の数）はダッシュボードに載せる予定だったもので、
> **いまも端末から見る。**割合の見立ては第14節に書いたまま据え置く。
>
> 第10節で「推奨は C（環境変数の UUID 照合）」と書いた案を、そのまま採った。
> 第15節の順序（入口 → 記録の器 → 読む → 危険側 → 検査）もそのまま通した。

## 読んだもの・叩いたもの

- `supabase/migrations/` の全47ファイル（該当箇所）。表50・RPC 134本
- `src/` の全ソース（`app/` は画面19枚と API 3本、`features/` 25、`lib/` 6）
- `scripts/` 44本のうち、本番の接続情報・秘密鍵・本番URLのいずれかに触れる21本
- 既存文書: `docs/spec.md` / `docs/decisions.md` / `docs/legal-draft.md` /
  `docs/launch-checklist.md` / `docs/prod-runbook.md` / `docs/db-workflow.md` /
  `docs/postlaunch-feature-architecture.md` / `docs/prod-audit-2026-09-06.md` /
  `docs/verify-2026-09-07.md` / `docs/prod-apply-2026-09-08.md` /
  `docs/roadmap.md` / `docs/PENDING.md` / `docs/QUEUE.md` / `BACKLOG.md` / `README.md`
- Next.js 16.2.12 の同梱文書
  （`node_modules/next/dist/docs/01-app/02-guides/server-actions.md` ほか）
- **本番DB（読み取りのみ）。**`npm run db:audit:prod` を1回、
  および `begin transaction read only` を張った件数取得を1回。
  どちらも Postgres 側が書き込みを拒む取引の中で実行し、`rollback` で閉じた。
  本文・題名・メールアドレスは1文字も取っていない。
- 外部サービスの料金は Web で当日の公開ページを読んだ（第13節に URL を付ける）

---

## 1. 結論

**管理ツールは要る。ただし「必要になる」のではなく、いま既に足りていない。**

根拠は3つとも実測である。

1. **本番に未処理の通報が70件あり、処理する経路がコードに存在しない。**
   `public.reports` の70行はすべて `status = 'open'`（本番実測 2026-09-08）。
   `reports` を読む・更新するコードは `src/` に1行も無い（`grep` で確認）。
   状態を動かせるのは SQL を直に打つ経路だけである。
   なお、この70件は検査（`npm run smoke:report`）が積んだものと見てよい
   （公開作品が2件しか無いため）。**件数の出どころが検査であっても、
   「積んだものを閉じる道が無い」という事実は変わらない。**

2. **作品を運営の判断で非表示にする経路が無い。**
   `works.review_status`（`ok` / `flagged` / `hidden`）は
   一覧・詳細・ランキングの全経路で絞り込みに使われているのに、
   **この列に値を書くコードが DB にもアプリにも1つも無い**
   （`supabase/migrations/*.sql` と `src/` の全文検索で0件）。
   本番の919件は全行が `ok` である（実測）。
   `delete_work` は本人しか呼べない（`step15_...sql:590`）ので、
   他人の作品を運営が下げる手段は SQL 直打ちしかない。

3. **利用規約でそれを行うと書いてある。**
   `docs/legal-draft.md` の「6. 報告と、運営者が行うこと」は、報告を受けたら
   運営者が「作品を非公開にすること／作品を削除すること／アカウントの利用を
   停止すること」を行うことがある、と公開文面で宣言している。
   同文書 0-6 は自ら「**通報を受けたあとの運用は、まだ画面が無い**」
   「それを操作するコードは無い（確認済み）」と書いている。
   **約束と実装が食い違ったまま一般公開すると、約束のほうが守れない。**

そのうえで、規模の見立ては小さい。公開作品は2件、実利用者は事実上0人で、
まだ限定公開（`next.config.ts` が全経路に `X-Robots-Tag: noindex` を付けている）。
**大きな管理システムは要らない。**要るのは「通報を見て、作品を下げて、
閉じたことを残す」までの一本道である（第14節）。

---

## 2. 現在の管理方法

### 2-1. 運営者が使える入口は、実質3つしかない

| 入口 | 何ができるか | 誰が使えるか |
|---|---|---|
| Supabase ダッシュボード | 表の直接編集、SQL 実行、auth ユーザーの操作、Storage、ログ | ブラウザで組織にログインした人 |
| Claude Code（この端末のコマンド） | `npm run db:*` / `smoke:*` / `cleanup:testdata` など46本 | この Mac のキーチェーンとローカルの鍵を持つ人 |
| Vercel ダッシュボード | デプロイ、環境変数、実行ログ | ブラウザでログインした人 |

**サービス自身の中には、運営専用の画面が1枚も無い。**
`src/app/` の画面19枚と API 3本を数えた。運営向けと呼べるのは `/health` と
`/health/auth` の2枚だけで、どちらも本番では `notFound()` で閉じてある
（`src/app/health/page.tsx`。「本番では出さない」と明記）。
`/api/cron/cleanup` は画面ではなく、`CRON_SECRET` を知る者だけが叩ける機械用の口。

### 2-2. Claude Code 経由で実際に何をしているか

コマンドの実体は次のとおり。すべて「人が端末で叩く」形で、画面は無い。

| コマンド | 何をするか | 本番への影響 |
|---|---|---|
| `npm run db:audit:prod` | 本番の件数・migration 履歴・関数権限を読む | 読むだけ（`read only` 取引） |
| `npm run db:status` | 未適用の migration を一覧 | 読むだけ |
| `npm run db:deploy` | migration を本番へ当てる | **構造を変える** |
| `npm run db:verify:keychain` | 構造・権限・漏洩経路の検査176件 | 読むだけ |
| `npm run db:privs` | 関数の実行権限を一覧 | 読むだけ |
| `npm run cleanup:testdata -- --apply` | 検査用の作品を、秘密鍵で**まとめて論理削除** | **データを変える** |
| `npm run smoke:fixtures:purge` | 検査用の利用者を Admin API で削除 | **データを消す** |
| `npm run smoke:*`（11本） | 本番に検査用の作品・回答・通報を作る | **データを増やす** |
| `curl` で `/api/cron/cleanup` | 掃除を手で1回走らせる | **データを消す** |

**このうち `cleanup:testdata` は、実質すでに管理操作である。**
持ち主のメールアドレスで対象を選び、`is_published = false` と `deleted_at` を
まとめて立てる。`delete_work` と同じことを、本人の許可なく、鍵で行っている
（`scripts/cleanup-testdata.mjs` の冒頭に、その設計理由が書いてある）。
**画面が無いだけで、一括の危険操作は既に存在している。**

### 2-3. 秘密鍵（`SUPABASE_SECRET_KEY`）が実際に使われている場所

`docs/db-workflow.md:260` は「使ってよいのは `src/lib/supabase/admin.ts` だけ」と
書き、`src/lib/supabase/admin.ts` 自身は「使ってよい場所は退会の第2段階の1つだけ」と
書いている。**どちらも現状と食い違う。**（第17節の差分表に再掲）

実際に鍵を読むファイルは14本ある。

- アプリ内4本 … `src/lib/env.ts` と `src/lib/supabase/admin.ts`（鍵の入口そのもの）、
  `src/features/account/rpc.ts`（退会の第2段階）、
  `src/features/cleanup/run.ts`（掃除 Cron。RPC 10本と Storage 削除と
  `auth.admin.deleteUser` を呼ぶ）
- 運用スクリプト7本 … `cleanup-testdata.mjs` `_smoke-users.mjs` `_smoke-http.mjs`
  `check-env.mjs` `run-all-checks.mjs` `smoke-account.mjs` `smoke-work.mjs`
- 検査3本 … `test/e2e/server.mjs` `test/e2e/smoke.mjs` `test/guard/selftest.mjs`

食い違いは「危険」ではなく「文書が追いついていない」ことの記録として扱う。
ただし管理画面を足すとき、**鍵の使用箇所が1つと思って設計すると必ずずれる。**

---

## 3. 現在管理可能な対象（実装から見た棚卸し）

以下は本番DBの実測値（2026-09-08、読み取りのみ）を添えてある。

### 3-1. ユーザー

| 項目 | 実装の事実 | 本番実測 |
|---|---|---|
| 登録ユーザー | `auth.users` と `public.profiles` が 1:1。トリガーで同期 | 657 / 657（ずれ0） |
| 匿名ユーザー | `signInAnonymously`。`profiles.is_anonymous` | 21 |
| ID を確定した人 | `profiles.handle` が非 null | 261 |
| アカウント状態 | `profiles.account_status` は `active` / `deletion_pending` の2値のみ | 全657が `active` |
| 作成日時 | `profiles.created_at` | 直近7日で39 |
| BAN | **アプリには無い。** `auth.users.banned_until` は Supabase 側に列があるが、コードから触っていない | `banned_until` が入った行は0 |
| 停止（suspension） | **無い。** 状態の値そのものが2つしかない | — |
| 削除 | 本人の退会のみ（`start_account_deletion` → Cron が Admin API で `auth.users` を消す） | 退会待ち0件 |
| 削除後の関連データ | 作品は残り持ち主だけ外れる（D70）。回答は `user_id` が null になる | 持ち主 null の作品46件／`user_id` null の回答179件 |
| 運営による直接操作 | **1つも無い。** 運営が呼べる利用者向け RPC は存在しない | — |

`auth` 側と `public` 側の整合は取れている（どちらにしか無い行が0件）。

### 3-2. 作品

| 項目 | 実装の事実 | 本番実測 |
|---|---|---|
| 一覧 | `get_public_works` は `is_published and review_status='ok' and deleted_at is null` の3条件で絞る | 全919 / 公開2 |
| 公開・非公開 | `works.is_published`。本人が `update_work` で切り替える | — |
| 削除 | 論理削除のみ。`delete_work` が `is_published=false` と `deleted_at` を立て、行は残す | 削除済み917 |
| 審査状態 | `works.review_status`（`ok`/`flagged`/`hidden`）。**書く経路が無い** | 全919が `ok` |
| 部門 | `division`（`original`/`fanart`/`ai`）。投稿後は変更不可 | 公開2件はどちらも `original` |
| ファンアート情報 | `source_title` 必須ほか3列。制約で整合を強制 | — |
| 画像 | Storage の `works` バケット。**`public = true`**（URL を知れば誰でも取れる） | 2オブジェクト・2.99 MiB |
| 作者 | `works.user_id`。退会で null になりうる | null 46件 |
| お題との関係 | `works.prompt_id` は `not null unique`。**この列はどの経路でもクライアントへ返さない**（D23） | — |
| 投稿日時 | `created_at` | 最新 2026-09-07 14:08 |
| 回答数 | `works.answers_count`（トリガーで同期するキャッシュ） | — |
| 管理者削除 | **無い。** `delete_work` は自分の作品しか対象にしない | — |
| 復元 | `update_work` が `deleted_at is not null` を明示的に拒む。**復元の経路は存在しない** | — |
| 一時的な非表示 | **無い**（`review_status` に書けないため） | — |

画像の消去は待ち行列方式（`storage_cleanup_queue` ＋ 毎日の Cron）。
**バケットが公開なので、作品を下げてから画像が消えるまでの間、
直リンクでは画像が見え続ける。**規約8にもその旨が書いてある。

### 3-3. 回答・クイズ

| 項目 | 実装の事実 | 本番実測 |
|---|---|---|
| 回答 | `answers`。1作品1ユーザー1回（`unique (work_id, user_id)`） | 661 |
| 内訳 | `answer_items`。**正解が判明するので機密扱い**。権限もポリシーも与えない | 1997 |
| 匿名の回答 | ゲストも回答できる。ゲスト掃除で `user_id` が null になる | null 179件 |
| 回答削除 | **経路が無い。**本人にも運営にも無い | — |
| 作品削除時 | `answers.work_id` は `on delete cascade`。ただし**作品の行を消さない**設計なので、実際には回答は消えない | — |
| 集計 | `work_slot_stats` / `user_stats` / `user_slot_stats` をトリガーで同期 | `work_slot_stats` 965行 |
| 荒らし対応 | **無い。**不正回答という概念が実装に無い | — |

### 3-4. お題（prompts）

| 項目 | 実装の事実 | 本番実測 |
|---|---|---|
| お題 | `prompts`。状態は `active` / `submitted` / `abandoned` | 1044（うち `active` 104） |
| 生成元 | `draft_sessions` から確定。持ち込み（art_first）経路も追加済み | `draft_sessions` 1024 |
| 答え | `prompt_cards`。**権限もポリシーも与えない**（クイズの答えそのもの） | 4000行 |
| 作成者 | `prompts.created_by`。null 可（運営が作ったお題を置ける形にはなっている） | — |
| 掃除 | `cleanup_orphan_prompts` が「持ち主がおらず作品も無い」ものを消す | 掃除待ち0 |
| 停止・削除 | **運営の経路は無い。**`works.prompt_id` の FK が `restrict` なので、作品のあるお題は消せない | — |
| 重複 | 概念が無い（毎回抽選なので同じ組み合わせは起こりうる） | — |

**運営が自分でお題を作る構想（毎日のお題＝F6）との接続。**
`prompts.created_by` が null を許す形になっているので、
「持ち主のいない運営のお題」を置く器は既にある
（`docs/postlaunch-feature-architecture.md` 1-6 が「運営が作ったお題を置ける」と
書いている）。**ただし `works.prompt_id` の UNIQUE が正面からぶつかる。**
1つのお題から作れる作品は1件だけなので、全員が同じお題で描く形は
いまの構造では成立しない（同文書が F6 の直撃点として挙げている）。
管理画面から「運営のお題を1件作る」ことは器の上は可能だが、
**その先の仕様が未決定**なので、今回の候補には入れない（第16節ではなく、
F6 側の未決定事項として既に記録されている）。

**注意。お題の中身を管理画面に出すことは、そのままクイズの答えを出すことになる。**
運営者本人が見るぶんには構わないが、「お題一覧」画面は
`prompt_cards` を伴うので、閲覧機能としても慎重に扱う（第9節）。

### 3-5. タグ（語彙）

| 項目 | 実装の事実 | 本番実測 |
|---|---|---|
| タグ本体 | `public.tags`（`pool_key` + `label` で一意） | 474行・13プール |
| 分類 | `tag_pools`（`motif` 102 / `morph` 126 / `color` 15 / `species` 24 / `genre` 15 ほか） | 上記 |
| 使用停止 | `is_active = false` にすると一般利用者からは存在しないものとして扱われる | 停止中は0件 |
| 重み | `weight`（既定100）。**非公開列**。列権限を与えていない | — |
| 運用メモ | `note` 列がある（「固有名詞に近いので要検討」等を書く想定） | — |
| 追加・修正・削除 | **すべて migration か SQL 直打ち。**RPC も画面も無い | — |
| 使用中タグの削除 | `prompt_cards.tag_id` などが `on delete restrict`。**参照があれば DB が拒む** | — |
| 重複・表記ゆれ | `unique (pool_key, label)` が完全一致の重複だけを防ぐ。ゆれは防げない | — |
| 統合・別名 | **概念が無い。**列も表も無い | — |

タグの棚卸しは既に別系統がある（`npm run check:vocab` → `docs/vocab-inventory.md`）。
**「読む」側は自動化済みで、「直す」側だけが手作業。**

### 3-6. 通報・モデレーション

| 機能 | 実装状況 |
|---|---|
| 通報の受け付け | **ある。**`create_report`。ゲストも送れる。24時間10件・同一作品1回・Turnstile |
| 通報の保管 | **ある。**`reports`（`open`/`reviewing`/`resolved`/`rejected` ＋ `resolved_at`） |
| 通報の閲覧 | **無い。**`reports` を読む RPC も画面も0本 |
| 通報の処理 | **無い。**`status` を更新する経路が0本 |
| 著作権侵害の報告 | 通報の理由の1つ（`copyright`）としてある。専用の窓口・様式は無い |
| 盗作の報告 | 独立した機能は無い（`copyright` か `other` に含まれる） |
| NSFW の扱い | 理由 `inappropriate` があるだけ。自動判定は無い（A8 のとおり自己申告） |
| 管理者審査 | **無い** |
| 管理者メモ | **無い**（`reports.detail` は通報者が書く欄） |
| 審査履歴 | **無い** |
| 件数に応じた自動処理 | **無い。**`docs/launch-checklist.md` 付録A が「いまは何件集まっても自動では何も起きない」と明記 |

### 3-7. サービス状態の確認

いま数えられるものと、数えられないものを分ける。

数えられる（ただし**運営に配る経路が無い**）。

| 見たい数 | どこから出るか | いまの取り出し方 |
|---|---|---|
| 総ユーザー数・匿名数 | `profiles` / `auth.users` | SQL |
| 新規登録者 | `profiles.created_at` | SQL |
| 投稿作品数・公開作品数 | `works` の3条件 | SQL |
| 回答数 | `answers` | SQL |
| お題の利用数 | `prompts` / `draft_sessions` | SQL |
| 削除数 | `works.deleted_at is not null` | SQL |
| 通報数 | `reports` | SQL |
| 掃除の残り | `cleanup_status()` | **`service_role` 限定の RPC**。Cron 経由か SQL |
| 5つの動きの件数 | `get_usage_summary(days)` | **`service_role` 限定の RPC**。呼び出し元が存在しない |
| Storage 使用量 | `storage.objects.metadata->>'size'` | SQL か Supabase ダッシュボード |

数えられない。

- **DAU 相当。**滞在・訪問を記録していない。`usage_events` は
  `share_opened` と `next_work_opened` の2種類しか受け付けない（CHECK で固定）。
  本番の `usage_events` は2行しかない。
  「汎用のイベントログにしない」は意図した設計である
  （`20260904096000_usage_events.sql` の冒頭に理由が書いてある）。
  **したがって、いわゆる analytics は未実装。**能動的にそう決めている。
- **エラー件数。**アプリ側に記録先が無い。Vercel の実行ログを見るしかない。
- **異常検知。**閾値も通知先も無い。

### 3-8. 決済

**存在しない。**`package.json` に決済系の依存は無く、`src/` に該当コードも無い。
外部への通信は Supabase・Vercel・Cloudflare Turnstile の3つだけ
（`docs/legal-draft.md` 0-7 の表と一致することを確認した）。

---

## 4. 現在不足している管理機能

第3節の裏返しを、足りない側だけ列挙する。

1. 通報を**見る**手段（画面・RPC とも0）
2. 通報を**閉じる**手段（`status` と `resolved_at` を動かす経路が0）
3. 作品を運営の判断で**下げる**手段（`review_status` に書く経路が0）
4. 下げた作品を**戻す**手段（同上。かつ `update_work` は削除済みを拒む）
5. 利用者を**止める**手段（`account_status` は2値。`banned_until` は未使用）
6. 運営が**利用者を探す**手段（handle や作品から辿る画面が無い）
7. **誰が何を変えたかの記録**（監査表・トリガー・拡張のいずれも無い。
   本番に `pgaudit` も `supa_audit` も入っていないことを実測で確認）
8. **サービスの数値を見る場所**（`get_usage_summary` は作ったが呼び出し元が無い）
9. **タグを直す手段**（migration 以外に無い）
10. **異常に気づく仕組み**（記録先も通知も無い）

---

## 5. 管理者が日常的に行う作業一覧

「現在の方法」は実装から逆算した実際の手順。頻度は**暫定（私が設定）**で、
一般公開後・利用者が数十人規模という前提での見込みである。承認前の数字なので、
これを根拠に合否は出さない。

| # | 管理作業 | 現在の方法 | 必要な権限 | 誤操作リスク | 頻度予想（暫定） | 管理画面化すべきか |
|---|---|---|---|---|---|---|
| 1 | 未処理の通報を見る | SQL 直打ち（`select * from reports where status='open'`） | `service_role` か DB 直結 | 低（読むだけ） | 毎日 | **する（P0）** |
| 2 | 通報の対象作品を見る | 通報の `work_id` を控えて公開URLを開く | 無し（公開作品） | 低 | 毎日 | **する（P0）** |
| 3 | 作品を非表示にする | SQL で `update works set review_status='hidden'` | DB 直結 | **高**（`where` を書き損なうと全件） | 週1〜数回 | **する（P0）** |
| 4 | 通報を処理済みにする | SQL で `status` と `resolved_at` を同時更新（CHECK が対で要求） | DB 直結 | 中 | 毎日 | **する（P0）** |
| 5 | 掃除が回っているか見る | Cron のログか `cleanup_status()` を鍵付きで呼ぶ | `service_role` | 低 | 週1 | **する（P0の窓）** |
| 6 | 新規登録・投稿・回答の数を見る | SQL、または `npm run db:audit:prod` | DB 直結 | 低 | 毎日 | **する（P0の窓）** |
| 7 | 特定の利用者を調べる | handle → `profiles.id` → 作品・回答・通報を SQL で辿る | DB 直結 | 低 | 月数回 | する（P1） |
| 8 | 利用者を止める | Supabase ダッシュボードで `banned_until` を入れる（アプリは未対応） | 組織ログイン | **高**（戻し方が画面に出ない） | 稀 | する（P1） |
| 9 | 下げた作品を戻す | SQL で `review_status='ok'` | DB 直結 | 中 | 稀 | する（P1） |
| 10 | タグを1件止める | SQL で `is_active=false`、または migration を1本 | DB 直結 | 中 | 月数回 | する（P1） |
| 11 | タグを追加する | migration を書いて `npm run db:deploy` | 本番デプロイ権限 | 中 | 月数回 | する（P2） |
| 12 | 表記ゆれ・typo を直す | SQL で `label` を更新 | DB 直結 | **高**（`prompt_cards` から参照されている＝過去の答えの表示が変わる） | 稀 | 慎重に（P2） |
| 13 | DB の整合を確かめる | `npm run db:audit:prod` ／ `npm run db:verify:keychain` | キーチェーン＋DB 直結 | 低 | 反映のたび | しない（端末で足りる） |
| 14 | migration を当てる | `npm run db:deploy` | 本番 DB | **高** | 機能追加のたび | **しない**（端末に置く） |
| 15 | 検査データを片づける | `npm run cleanup:testdata -- --apply` | 秘密鍵 | **高**（一括の論理削除） | 反映のたび | しない（端末に置く） |
| 16 | 画像の容量を見る | Supabase ダッシュボード | 組織ログイン | 低 | 月1 | する（P2） |
| 17 | エラーを見る | Vercel のログ | 組織ログイン | 低 | 週1 | しない（Vercel で足りる） |
| 18 | 退会待ちの後始末を確認する | `cleanup_status()` の `pending_account_deletions` | `service_role` | 低 | 週1 | する（P0の窓に同居） |

**13・14・15・17 を管理画面へ入れない、と判断した理由。**
どれも「端末とキーチェーンを持つ人だけができる」ことに意味がある操作で、
ブラウザから届く場所へ移すと、守りが1段落ちる。
一括削除と本番反映は、画面化の利得より事故の代償が大きい。

---

## 6. P0 / P1 / P2 / P3 の分類

### P0 ── これが無いと一般公開できない

| 機能 | 無いと何が起きるか |
|---|---|
| 管理者だけが入れる入口 | 以下すべての前提 |
| 通報一覧（未処理・作品・理由・日時） | 規約6で約束した「内容を確認する」が実行できない |
| 作品を非表示にする専用操作（理由の記入つき） | 権利侵害・不適切投稿に対して手が出せない |
| 通報を閉じる操作（対応内容つき） | 同じ通報を何度も見直すことになり、対応漏れに気づけない |
| 監査記録（誰が・いつ・何を・何から何へ・なぜ） | 上の2つが「危険な書き込み」なので、記録なしでは入れられない |
| サービス状態の1画面（登録・投稿・公開・回答・未処理通報・掃除の残り） | 異常に気づく手段が SQL しか無い |

### P1 ── 利用者が増える前に欲しい

- 利用者の検索と個別ページ（handle・作品・回答数・通報の被数）
- アカウント停止と解除（`banned_until` を使う。アプリ側の表示も要る）
- 非表示にした作品を戻す操作
- タグの使用停止と再開（`is_active` の切り替え）
- 掃除を手で1回走らせるボタン（いまは `curl` に鍵を付けて叩いている）

### P2 ── 運営が楽になる

- 通報の履歴（閉じたものを含む一覧・絞り込み）
- 作品一覧（削除済み・非表示を含む。いまはどの画面にも出ない）
- タグの追加と `weight` の調整
- Storage 使用量と、消し残しの一覧
- 利用状況の推移（`get_usage_summary` を画面へ出す）

### P3 ── 前提の機能ごと未実装

- DAU・継続率・行動分析（`usage_events` が2種類しか受け付けない。
  設計として意図的にそうしてある）
- 通報件数による自動非表示（閾値そのものが未決定。
  `docs/decisions.md` D69 と `launch-checklist.md` 付録A が未決定と書いている）
- 課金・売上（決済が存在しない）
- タグの統合・別名（列も表も無い）
- 複数の運営者・役割分担（個人運営。`docs/legal-draft.md` が「VRO（個人運営）」と宣言）

---

## 7. 管理画面の候補ページ構成

**実装から必要性が言えるものだけを挙げる。**一般的な管理画面の目次は写さない。

| ページ | 入れる根拠 | 段階 |
|---|---|---|
| `/admin`（ダッシュボード） | 未処理の通報件数と掃除の残りを、毎日1画面で見るため | P0 |
| `/admin/reports` | 70件が open のまま積んでいる。読む経路が無い | P0 |
| `/admin/reports/[id]` | 対象作品を見て、下げるか閉じるかをその場で決めるため | P0 |
| `/admin/works/[id]` | 通報から辿る先。非表示・復帰の操作を置く場所 | P0（最小は通報詳細に同居でもよい） |
| `/admin/users/[id]` | 同じ人物が繰り返し通報されているかを見るため | P1 |
| `/admin/tags` | 語彙が閉じている設計なので、悪い1語が全員に出続ける | P1 |
| `/admin/audit` | 危険な書き込みの記録を、運営者自身が読み返すため | P0（記録は必須。画面は P1 でもよい） |
| `/admin/system` | 掃除の残り・Storage・退会待ちの窓 | P1 |

**作らないと判断したもの。**

- `/admin/prompts` … お題の中身は `prompt_cards`（＝クイズの答え）そのもの。
  見る用事が「不適切な語が出ていないか」なら、それは `/admin/tags` で足りる。
- `/admin/answers` … 個別の回答を運営が見る用事が実装から出てこない。
  `answer_items` は機密扱いで、他人の行を運営が読むこと自体を今は避けたい。
- `/admin/moderation` と `/admin/reports` の分離 … 個人運営で、
  審査の待ち行列が2つに割れる意味が無い。1つにする。

---

## 8. 各画面に必要な操作

### `/admin`（ダッシュボード）
- 読む: 未処理の通報件数／直近7日の新規登録・投稿・回答／公開作品数／
  掃除の残り（`cleanup_status` の7項目）／退会待ち件数
- 書く: 無し

### `/admin/reports`
- 読む: 未処理の通報を、作品・理由・日時・同一作品の通報数つきで一覧
- 書く: 無し（一覧からは変更させない。**押し間違いを構造で防ぐ**）

### `/admin/reports/[id]`
- 読む: 通報1件の全内容、対象作品（画像・題名・部門・作者）、
  同じ作品への他の通報
- 書く（安全側）: `reviewing` にする ／ `rejected` にして閉じる（理由の記入必須）
- 書く（危険側）: 作品を `hidden` にする（理由の記入必須）→ 同じ操作の中で
  通報を `resolved` にする

### `/admin/works/[id]`
- 読む: 作品の全列（`prompt_id` は出さない。D23 を管理画面でも守る）、
  回答数、通報履歴
- 書く（危険側）: `hidden` にする ／ `ok` に戻す ／ 画像の即時消去

### `/admin/users/[id]`
- 読む: handle・表示名・登録日・匿名か・作品数・回答数・通報された回数
- 書く（危険側）: 利用停止（期間と理由）／解除

### `/admin/tags`
- 読む: プール別のタグ一覧、使用回数（`prompt_cards` から数える）
- 書く（安全側）: `note` の記入
- 書く（危険側）: `is_active` の切り替え／`label` の修正／追加

### `/admin/audit`
- 読む: 記録の一覧（新しい順、対象・操作・理由で絞る）
- 書く: 無し。**この画面から記録を消せてはいけない**

### `/admin/system`
- 読む: 掃除の残り、Storage の使用量、退会待ち
- 書く（安全側）: 掃除を1回走らせる

---

## 9. Read / Safe Write / Dangerous Write の分類

判定の基準を先に置く。

- **Read only** … 行を1つも変えない
- **Safe write** … 間違えても元に戻せて、利用者から見える結果が変わらないか、
  変わっても実害が無い
- **Dangerous write** … 利用者から見えるものが変わる、または元に戻せない

| 操作 | 分類 | 理由 |
|---|---|---|
| 通報一覧・詳細を見る | Read only | |
| 作品・利用者・タグを見る | Read only | |
| 数値の窓を見る | Read only | |
| 通報に運営メモを書く | Safe write | 利用者に見えない（列を新設する場合） |
| 通報を `reviewing` にする | Safe write | 表示に影響しない。戻せる |
| 通報を `resolved` / `rejected` にする | Safe write | 同上。ただし `resolved_at` と対で入る必要がある（CHECK） |
| タグに `note` を書く | Safe write | 非公開の運用メモ |
| 掃除を1回走らせる | **Dangerous write** | 期限切れの下書き・画像・ゲストを実際に消す |
| 作品を `hidden` にする | **Dangerous write** | 公開中の作品が全経路から消える |
| 作品を `ok` に戻す | **Dangerous write** | 下げた判断を取り消す。誤って戻すと問題投稿が再公開される |
| 画像を即時に消す | **Dangerous write** | **戻せない** |
| 利用者を停止する | **Dangerous write** | 本人の全セッションが切れる |
| タグを `is_active=false` にする | **Dangerous write** | 以後の抽選から消える |
| タグの `label` を直す | **Dangerous write** | `prompt_cards` から参照されており、**過去の作品のお題表示が変わる** |
| 利用者を削除する | **入れない** | 退会の経路が既にある。運営から消す用事が無い |
| 作品を物理削除する | **入れない** | 回答と集計が cascade で消える（D63・D70 が明確に禁じている） |
| 表の直接編集 | **入れない** | 第8節の専用操作で置き換える |
| 一括操作 | **入れない**（当面） | 個人運営・公開作品2件の規模で、一括が要る場面が実装から出てこない |

### Dangerous write に付ける守り

| 守り | 付けるか | 理由 |
|---|---|---|
| 確認ダイアログ | **付ける** | 最低限 |
| 二段階確認（対象名を打ち込ませる） | **画像の即時消去と利用者停止だけ**に付ける | 戻せない／影響が大きい2つに絞る。全部に付けると読み飛ばされる |
| 理由の入力 | **全部に必須** | 監査記録の中身になる。空欄では後から判断を追えない |
| 監査記録 | **全部に必須** | 第12節 |
| 論理削除 | **既にそうなっている** | `works` は行を消さない設計。管理画面もそれに従う |
| 取り消し（rollback） | `hidden` ↔ `ok` は往復できる形にする。画像の消去は取り消せない | 取り消せないものは、二段階確認の側で守る |

---

## 10. 管理者認証・権限設計の現状

### 10-1. いまの認証

| 項目 | 事実 |
|---|---|
| 方式 | メールアドレス＋パスワード（`signInWithPassword`）と匿名（`signInAnonymously`） |
| 外部 ID 連携 | 無し |
| 多要素 | 無し |
| セッション確認 | `supabase.auth.getUser()`。Cookie を信じず毎回検証する（`src/features/auth/session.ts` にその理由が書いてある） |
| 役割の列 | **無い。**`profiles` の14列に role も admin も無い（本番の列名を実測で確認） |
| JWT の中身の利用 | `auth.jwt() ->> 'is_anonymous'` を RPC の中で見ている。**JWT のクレームで権限を判定する形は既にある** |
| `app_metadata` の利用 | **していない**（`src/` と migration の全文検索で0件） |
| RLS | public の50表すべてで有効。**RLS が無効な表は0**（実測） |
| 表への直接権限 | 与えていない表が多数。取得は `security definer` の RPC 経由 |
| `service_role` 専用の関数 | 16本（掃除・退会の後始末・`cleanup_status`・`get_usage_summary`） |
| 秘密鍵の露出 | `SUPABASE_SECRET_KEY` は `NEXT_PUBLIC_` が付いていないためブラウザには渡らない |

### 10-2. 管理者をどう識別できるか（現構成での候補）

| 案 | 仕組み | 良い点 | 悪い点 |
|---|---|---|---|
| A. `profiles` に `role` 列 | 列を足し、RPC の中で見る | DB 側でも判定できる | migration が要る。**本人が書き換えられないよう列権限を revoke する手当てが要る**（`account_status` と同じ作りになる） |
| B. `app_metadata` のクレーム | Admin API で `{"role":"admin"}` を入れ、`auth.jwt()->'app_metadata'->>'role'` で見る | **本人が書き換えられない**（`user_metadata` と違う）。既存の `is_anonymous` 判定と同じ形 | 付与が Supabase の Admin API 経由になり、コードに現れない |
| C. 環境変数に管理者の UUID | Vercel の環境変数に入れ、Server Action で `auth.getUser()` の id と突き合わせる | **migration もスキーマ変更も0**。付け外しが即座。人数1人なら十分 | DB 側には管理者という概念が残らない。判定がアプリ1か所だけになる |

**推奨は C（環境変数の UUID 照合）＋ 管理操作は `service_role` 専用 RPC。**
理由は1行で言える。**いま管理者は1人で、スキーマを増やさずに済むのは C だけだから。**

具体的にどうなるか。`/admin/*` の各ページは、まず `getCurrentUser()` で本人を取り、
環境変数の UUID と一致しなければ `notFound()` を返す（`/health` が本番で
使っているのと同じ形）。管理操作は Server Action の中で、まず同じ照合を行い、
通ったときだけ秘密鍵のクライアントで `service_role` 限定の RPC を呼ぶ。
**RPC 側は `anon` と `authenticated` に一切 grant しない。**
これは掃除 Cron（`/api/cron/cleanup` → `runCleanup()` → 鍵で RPC）と同じ経路で、
新しい仕組みを1つも足さない。

C の弱点は「守りがアプリ1か所」であること。これを次の2つで埋める。

- ページ側（表示）と Server Action 側（実行）の**両方**で照合する。
  Next.js の同梱文書が「画面を出さないことは安全の境界ではない。
  UI を通さずに要求は送れる」と明記している
  （`server-actions.md`。「Render-time gating ... is not a security boundary」）
- 管理者が増えたら A か B へ移す。**そのときスキーマを触るのは1回で済む。**

### 10-3. URL を知っているだけで入れないか

入れない形にできる。`/admin` を「未サインイン・一般利用者からは 404」にする。
`notFound()` を返すのは、存在そのものを教えないため（D40 と同じ考え方で、
既に `/health` がそうしている）。

**ただし proxy（旧 middleware）に認可を書かない。**
`src/proxy.ts` の先頭に「認可の判定はここに書かない。matcher の書き換えひとつで
簡単に外れる」と既に書いてある。この方針を管理画面でも守る。

---

## 11. セキュリティ上の注意点

1. **秘密鍵をブラウザへ出さない。**管理画面は Server Component と Server Action
   だけで組み、`createSupabaseAdminClient()` を Client Component から import しない。
   `src/lib/supabase/admin.ts` に既にその注意が書いてあるが、
   **機械的に止める仕組みは無い**（`server-only` パッケージを入れていない）。
   管理画面を作るなら、ここは入れる価値がある。
2. **CSRF。**Next.js 16 の Server Actions は `Origin` と `Host` を突き合わせて
   不一致を拒む（同梱文書 `server-actions.md`）。追加の対策は要らないが、
   **フレームワークの守りは各操作の認可の代わりにならない**とも同文書が書いている。
   照合は毎回、各 Server Action の中で行う。
3. **管理画面から生の表を編集させない。**第8節の専用操作だけを置く。
   理由は、`reports` に「`status` と `resolved_at` は対で入る」という CHECK が
   あり、表編集ではこれを破って例外を出すか、片方だけ埋めた不整合を作るため。
4. **`prompt_id` を管理画面でも返さない。**D23 は「どの取得経路でも返さない」と
   書いている。管理画面は例外にしない（自分の目で見るぶんには構わないが、
   応答に載せた瞬間に経路が1本増える）。
5. **画像は公開バケットにある。**作品を `hidden` にしても、直リンクの画像は
   消去されるまで見える。**「下げた」と「消えた」を画面で言い分ける。**
6. **noindex を外す作業と管理画面は別。**`next.config.ts` の `X-Robots-Tag` は
   全経路に付いている。一般公開でこれを外すと `/admin` も対象になるので、
   管理画面には別途 `noindex` を残す。
7. **ログに個人情報を書かない。**既存の運用スクリプトは接続文字列を
   `echo` しない設計になっている。管理画面の監査記録も、
   本文や画像URLではなく ID を持つ。

---

## 12. Audit Log の要件

### 12-1. 現状

**存在しない。**

- 監査用の表は無い（本番の public 50表を実測。該当なし）
- 監査トリガーも無い
- `pgaudit` も `supa_audit` も入っていない（本番の `pg_extension` を実測。0件）
- Supabase の Platform Audit Logs はダッシュボード操作の記録で、
  かつ Team / Enterprise プラン限定（第13節の出典）
- Postgres の既定では `log_statement = ddl` なので、
  `update` や `delete` は記録されない

つまり**いま SQL で本番の行を書き換えても、記録はどこにも残らない。**

### 12-2. 管理画面を入れるなら必要になるもの（新規要件の候補）

記録するのは危険側の書き込みだけでよい。読み取りは記録しない（量が意味を薄める）。

| 項目 | 中身 |
|---|---|
| 誰が | 管理者の user id |
| いつ | `created_at` |
| 何を | 対象の種類（work / user / tag / report）と id |
| どの操作 | `hide_work` / `unhide_work` / `resolve_report` / `ban_user` など、**列挙で固定する**（`usage_events` が CHECK でキーを固定しているのと同じ形） |
| 何から何へ | 変更前と変更後の値（1組でよい） |
| なぜ | 理由の自由記述（**必須**） |

置き場所は `public.admin_audit_log`（仮）。書くのは管理 RPC の中だけで、
`insert` を RPC の外から行えないようにする。
**運営者本人にも `delete` を与えない。**消せる記録は記録ではない。

これは migration が1本要る。**今回は作っていない。**

---

## 13. 外部 Admin ツール vs 自前の `/admin`

料金は 2026-09-08 に各社の公開ページを読んだ値。

| 比較項目 | Supabase ダッシュボード | Retool | Appsmith | Directus | Forest Admin | 自前 `/admin` |
|---|---|---|---|---|---|---|
| 実装時間 | **0**（もう有る） | 数時間〜数日 | 同左 | 数日（別サービスとして立てる） | 数時間〜数日 | **P0 だけなら小さい**（第15節） |
| 月額 | 契約中のまま | 無料枠5人 → Team は作る人 $10・使う人 $5 | 無料枠5人 → Business $15/人 | 自己ホストは無料、Cloud $99〜、Team $499 | 10人まで無料 → Business $250/10人 | **0** |
| 日本語運用 | 画面は英語 | 英語（画面は自作できる） | 英語 | 英語 | 英語 | **日本語で書ける** |
| Supabase との相性 | 同一 | Postgres 接続で可 | 同左 | **自前のスキーマ思想が強く、既存DBに後乗せしにくい** | Postgres 接続で可 | 同一 |
| 認証 | 組織のログイン | サービス側の認証 | 同左 | 同左 | 同左 | **既存のログインをそのまま使える** |
| RLS | 迂回する（`postgres` ロール） | 迂回する（接続ロール次第） | 同左 | 同左 | 同左 | **RPC を通せば守りが効く** |
| 操作ミス防止 | **弱い。**表を直接編集でき、CHECK 違反で例外が出るか不整合が残る | 画面を作り込めば可 | 同左 | 同左 | 同左 | **専用操作だけ置ける** |
| UI 自由度 | 無し | 高い | 高い | 中 | 中 | **最も高い** |
| モデレーション用途 | 通報を SQL で読むだけ | 一覧＋ボタンは作れる | 同左 | 同左 | 同左 | 作れる |
| 監査記録 | Team / Enterprise 限定、かつダッシュボード操作の記録のみ | ツール側のログ | 同左 | 同左 | 同左 | **自分で持つ（第12節）** |
| 囲い込み | 無し | 有り | 中（自己ホスト可） | 中 | 有り | 無し |
| 将来の規模 | 数人まで | 大規模まで | 大規模まで | 大規模まで | 大規模まで | 個人〜小規模 |
| セキュリティ | 組織ログインの強さに依存 | 外部に本番DBの接続情報を預ける | 自己ホストなら預けない | 同左 | 外部に預ける | **鍵はいまと同じ場所のまま** |
| 個人開発との相性 | 良い（無料・即時） | 無料枠内なら良い | 同左 | 重い | 良い | 良い |

**推奨は「Supabase ダッシュボードを残したまま、自前の `/admin` を最小で作る」。**

理由は1行で言える。**必要な操作が5つしかなく、そのどれもが
「表を編集する」ではなく「決まった手順を1回実行する」形だから。**
外部ツールの強みは、多数の表に多数の人が触る場面での作り込みの速さで、
今回は表4つ・操作5つ・利用者1人。導入と接続情報の受け渡しのほうが高くつく。

Supabase ダッシュボードは捨てない。migration の適用、`banned_until` の操作、
Storage の実容量、バックアップの確認は、当面そちらに残す。

---

## 14. 最小管理画面（MVP）案

### 今日から作るなら、入れるのはこれだけ

画面2枚と、危険操作2つと、記録1本。

1. **`/admin`** … 数字の窓。未処理の通報件数／公開作品数／直近7日の
   新規登録・投稿・回答／掃除の残り／退会待ち。すべて読むだけ。
2. **`/admin/reports`** … 未処理の通報一覧。作品のサムネイル・理由・日時・
   同一作品の通報数。押せるのは「1件開く」だけ。
3. **`/admin/reports/[id]`** … 通報1件と対象作品。ここに操作を3つ置く。
   - 作品を非表示にする（理由の記入必須・確認ダイアログ）
   - 通報を却下して閉じる（理由の記入必須）
   - 通報を対応済みにして閉じる（作品を下げた場合は自動で連動）
4. **監査記録** … 上の操作を `admin_audit_log` に1行ずつ残す。
5. **管理者の判定** … 環境変数の UUID と照合。外れたら 404。

**入れないもの。**利用者停止、タグ編集、作品の復帰、一括操作、
利用状況グラフ、お題の閲覧、回答の閲覧。
どれも「無いと公開できない」に当てはまらない。

### DB 側に要る変更（提案。まだ作っていない）

migration 1本で足りる。

- `admin_audit_log` 表を1つ新設
- 管理用の RPC を4本追加し、**`service_role` にだけ** `grant execute` する
  - `admin_list_open_reports(limit)`
  - `admin_get_report(id)`
  - `admin_hide_work(work_id, reason)` … `review_status='hidden'` ＋ 監査1行
  - `admin_resolve_report(report_id, status, reason)` … `status` と
    `resolved_at` を対で更新 ＋ 監査1行
- **既存の表・列・RPC・RLS は1つも変えない。**
  `review_status` は最初から `hidden` を許す CHECK になっており、
  絞り込みも全経路に入っているので、**値を書くだけで期待どおり消える。**

### Claude Code 無しで日常運営の何割を回せるようになるか

第5節に挙げた18作業のうち、**一般公開後に日常（毎日〜週1）で発生するもの**を
数え直す。頻度が「稀」「機能追加のたび」のものは日常から外す。

日常作業（暫定・私が数えた）は8つ。

| # | 作業 | 頻度 | MVP で足りるか |
|---|---|---|---|
| 1 | 未処理の通報を見る | 毎日 | **足りる** |
| 2 | 通報の対象作品を見る | 毎日 | **足りる** |
| 3 | 作品を非表示にする | 週1〜数回 | **足りる** |
| 4 | 通報を処理済みにする | 毎日 | **足りる** |
| 5 | 掃除が回っているか見る | 週1 | **足りる** |
| 6 | 新規登録・投稿・回答の数を見る | 毎日 | **足りる** |
| 7 | 特定の利用者を調べる | 月数回 | 足りない（P1） |
| 10 | タグを1件止める | 月数回 | 足りない（P1） |

8つのうち6つが MVP で完結する。**約75%。**
P1（利用者ページとタグの停止）まで入れると8/8で100%になる。

この数値の性質を明示する。**分母は私が実装から数えて並べた8作業であって、
ユーザーが承認した作業一覧ではない。**割合そのものは暫定（私が設定）で、
これを根拠に「合格」とは書かない。実際の運営が始まって作業が増減したら、
分母から作り直す。

残る25%（7と10）と、頻度の低い作業（migration の適用、検査データの片づけ、
利用者の停止、Vercel のログ）は、**引き続き端末とダッシュボードで行う。**
これは MVP の欠陥ではなく、第5節で「画面に入れない」と判断した結果である。

---

## 15. 推奨実装順

分量の見積もりは付けない（測っていないため）。順番だけを書く。

1. **管理者の判定と `/admin` の入口。**環境変数1本と、404 を返す関門。
   ここが通らないうちは、下のどれも作らない。
2. **`admin_audit_log` の migration。**先に記録の器を作る。
   **危険な書き込みより先に記録を用意する。**逆にすると、
   最初の数回の操作が記録に残らない。
3. **読む RPC 2本（通報一覧・通報詳細）と画面2枚。**
   ここまでで「見えるが何も変えられない」状態が完成する。
   この時点で本番の70件を実際に開いて確認する。
4. **`admin_hide_work` と `admin_resolve_report`。**危険側の2操作。
   確認ダイアログと理由の必須化を同時に入れる。
5. **検査。**既存の層に合わせる（`test/db/run.mjs` に管理 RPC の権限検査、
   `scripts/db-checks.mjs` に「`anon` と `authenticated` から呼べないこと」を追加）。
   **「呼べる」ではなく「呼べない」を検査する。**
6. ここで一度止めて、公開する。P1 は運営を始めてから足す。

---

## 16. 未確定事項（この調査では決めていない）

1. **管理者の識別方式。**第10節で C を推したが、決まっていない。
2. **`/admin` の URL。**推測されにくい経路にするか、素直に `/admin` にするか。
   404 で閉じるなら素直でよい、と考えているが未確定。
3. **通報を却下したことを通報者へ伝えるか。**規約は「個別に結果を回答することは
   お約束できません」と書いてある。伝えないことは決まっているが、
   **通報者に何も残らない形でよいか**は確認していない。
4. **作品を下げたことを作者へ伝えるか。**現状、作者には何も届かない。
   通知の仕組み自体が無い。
5. **画像を即時に消すかどうか。**下げた時点で消すのか、
   待ち行列に載せるのか。戻す可能性を残すなら消せない。
6. **通報が一定件数を超えたときの自動処理。**未決定であることが
   `docs/decisions.md` D69 と `launch-checklist.md` 付録A に記録されている。
   MVP では自動処理を入れない前提で書いた。
7. **監査記録の保存期間。**`terms_agreements` には `retain_until` があるが、
   監査記録に同じ考え方を持ち込むかは決めていない。
8. **`reports` に運営メモの列を足すか。**いまの `detail` は通報者の記入欄で、
   運営が書き込む場所は無い。監査記録の `reason` で代用できるかもしれない。
9. **本番の未処理70件をどう扱うか。**検査が積んだものなので、
   画面ができた時点でまとめて閉じるのか、消すのか。
   **`reports` を消す経路も無い**ので、これも決めておく必要がある。

---

## 17. 調査したファイル・コード・DB の一覧

### DB（本番・読み取りのみ・2026-09-08）

実行したのは `npm run db:audit:prod` と、`begin transaction read only` を張った
件数取得1回。取ったのは件数と構造だけで、本文・個人情報は取っていない。

| 見たもの | 値 |
|---|---|
| migration の適用数 | 45本（手元47本。未適用2本） |
| public のテーブル数 | 50 |
| RLS が無効なテーブル | 0 |
| `pg_cron` / `pgaudit` / `supa_audit` | どれも入っていない |
| profiles | 657（匿名21／handle あり261／全行 `active`） |
| auth.users | 657（`banned_until` あり0） |
| auth と public のずれ | 双方向とも0 |
| works | 919（公開2／削除済み917／全行 `review_status='ok'`／持ち主 null 46） |
| answers | 661（`user_id` null 179） |
| answer_items | 1997 |
| reports | **70（全件 `open`）** |
| prompts | 1044（`active` 104） |
| prompt_cards | 4000 |
| draft_sessions | 1024 |
| tags | 474（13プール。停止中0） |
| likes / saves | 425 / 96 |
| usage_events | 2 |
| storage（works バケット） | 2オブジェクト・2.99 MiB |
| 掃除の待ち | 画像0／退会0 |
| 最新の投稿・回答 | 2026-09-07 14:08 / 14:10 |

### コード

- `src/app/` の画面19枚と API 3本（運営向けは `/health` `/health/auth` のみ。本番では404）
- `src/app/api/cron/cleanup/route.ts`（`CRON_SECRET` で守られた掃除の口）
- `src/lib/supabase/admin.ts` / `src/lib/env.ts`（秘密鍵の入口）
- `src/features/cleanup/run.ts`（鍵で RPC 10本と Storage と Admin API を呼ぶ）
- `src/features/account/rpc.ts`（退会の第2段階）
- `src/features/report/rpc.ts` / `captcha.ts`（通報の送信側）
- `src/features/work/rpc.ts` / `types.ts`（`review_status` を読むだけ）
- `src/proxy.ts`（認可を書かない方針が明記されている）
- `next.config.ts`（`X-Robots-Tag: noindex` を全経路へ）
- `scripts/` 44本のうち、本番の接続情報・秘密鍵・本番URLのいずれかに触れる21本
  （`db-audit-prod` / `db-verify-keychain` / `db-deploy` / `db-apply-one` /
  `cleanup-testdata` / `_smoke-users` / `setup-*` / `verify-launch` ほか）

### migration（該当箇所）

- `20260803013433_baseline_applied_schema.sql`
  … `profiles` `works`(2717) `answers` `answer_items` `reports`(3446)
  `tags`(702) `prompts`(1970)。`review_status` の定義は 2782 行
- `20260803025753_works_write_rpcs.sql` … `works` バケット（`public = true`）と
  Storage のポリシー4本
- `20260803213330_step15_handle_history_report_delete.sql`
  … `create_report`(484) `delete_work`(590) `mark_work_image_deleted`(662)
- `20260804090000_account_deletion_and_terms.sql`
  … `account_status`(70)、書き込みを止める門番3種
- `20260804120000_cleanup_jobs.sql` … `cleanup_status`(410) ほか掃除の RPC
- `20260904096000_usage_events.sql` … `record_usage_event` と
  `get_usage_summary`（どちらも運営用。後者は呼び出し元が無い）

### 文書

読んで使ったもの: `spec.md`（A6・A7・A8）、`decisions.md`（D23・D40・D63・
D69・D70・D106）、`legal-draft.md`（0-6 と規約6・規約8）、
`launch-checklist.md`（付録A）、`prod-runbook.md`、`db-workflow.md`、
`postlaunch-feature-architecture.md`（3-3 のイベントログ不要の判断）、
`prod-audit-2026-09-06.md`、`verify-2026-09-07.md`、`prod-apply-2026-09-08.md`、
`roadmap.md`、`PENDING.md`、`QUEUE.md`、`BACKLOG.md`、`README.md`。

読んだが今回の判断に使わなかったもの: `tags-master.md`、`vocab-inventory.md`、
`research-hit-patterns.md`、`art-first-investigation.md`、`test-layers.md`、
`audit-2026-09-04.md`、`prelaunch-debug-report.md`、`verify-2026-09-05.md`、
`verify-2026-09-06.md`、`spec-candidates-2026-09-07.md`、`GPT_HANDOFF.md`、
`docs/RESEARCH/` の2本。

### 外部（2026-09-08 に閲覧）

- Supabase Access Control … https://supabase.com/docs/guides/platform/access-control
- Supabase Platform Audit Logs … https://supabase.com/docs/guides/security/platform-audit-logs
- Supabase pgaudit … https://supabase.com/docs/guides/database/extensions/pgaudit
- Supabase updateUserById（`ban_duration`）… https://supabase.com/docs/reference/javascript/auth-admin-updateuserbyid
- Retool 料金 … https://retool.com/pricing
- Appsmith 料金 … https://www.appsmith.com/pricing
- Directus 料金 … https://directus.com/pricing
- Forest Admin 料金 … https://help.forestadmin.com/article/how-does-your-pricing-work/

### 既存文書と現在の実装が食い違っていた箇所

| 文書の記述 | 現在の実装 | 扱い |
|---|---|---|
| `src/lib/supabase/admin.ts`「使ってよい場所は退会の第2段階の1つだけ」 | `src/features/cleanup/run.ts` も使っている（掃除 Cron） | **実装を優先。**用途は2つ |
| `docs/db-workflow.md:260`「秘密鍵を使ってよいのは `admin.ts` だけ」 | `scripts/cleanup-testdata.mjs` ほか運用スクリプト5本と検査3本が直接読む | **実装を優先。**鍵の使用箇所は14ファイル |
| `docs/spec.md` A6「通報の処理は手動運用。管理画面は作らない」 | 手動運用の手段自体が無い（読む経路が0）。`decisions.md` 2496 も「A6 は共有語彙の管理には足りない」と書いている | **A6 は前提が崩れている。**第1節 |
| `docs/legal-draft.md` 0-6「いまは運営がダッシュボードで手作業する前提」 | ダッシュボードで `reports` を読むことはできるが、CHECK が対で要求する更新を表編集で行うのは事故になりやすい | 文書は正しい。**手作業の中身が定義されていない** |
