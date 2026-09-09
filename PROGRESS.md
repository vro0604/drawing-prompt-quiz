# PROGRESS

セッションの引き継ぎを置く場所です。新しいものが上。
`/next` はここを起点に「現在地と次の一手」を出し、`/progress` がここへ追記します。
日時は JST。全体が400行を超えたら、一番下（最も古いもの）から削ります。

---
## 2026-09-09 プロフィール拡張を、別作業線を外した木で検査して独立コミットにした

### 終えたこと

- プロフィールに3つ足した。アイコン1枚、描くのが得意0〜5件、見るのが得意0〜5件。
  得意分野は**自己申告で、成績ではない。**次の作品の配り方（D169）にも使わない。
  決定は D176（`docs/decisions.md`）、仕様は `docs/spec.md` の 12-0-2。
- アイコンの上限 2MiB を正式仕様にした（ユーザー承認 2026-09-09）。
  **画面だけで止めない。**受け口（Server Action）が中身の大きさを見て断る。
- 画像の置き場（Storage）と DB は別の仕組みで、まとめて巻き戻せない。
  4つの失敗をそれぞれどう扱うか決めて、消せなかったファイルを
  掃除の待ち行列へ渡す口（`enqueue_my_avatar_cleanup`）を足した。
  **失敗のたびに、誰からも辿れないファイルが増える形を残さない。**
- プロフィールの保存は「プロフィール → 得意分野 → アイコン」の順に進む。
  途中で失敗したら、**どこまで保存できたかを画面に出す。**
  部分的に保存されているのに「全部失敗しました」と書かない。
- 語を選ぶ部品を、持ち込み（art_first）と共通にした
  （`src/features/vocab/picker.tsx`）。分類ごとの上限を見るかどうかだけが違う。
- アカウント画面を3つのまとまりにした。プロフィール／公開設定／アカウント。
  機能は1つも減らしていない。

### 別作業線を外した木での実測

作業ツリーは2つの作業線が混ざっているので、HEAD（本番と同じ内容）から
別の worktree を切り、**プロフィールのぶんだけ**を載せて測った。

- `npm run test:db` 187件すべて合格（プロフィールのY群22件を含む）
- `npm run db:verify:local` 合格179・不合格0（診断 A37〜A39 を追加）
- `npm run typecheck` 終了コード0
- `npm run lint` エラー0・警告2（すべて既存）
- `npm run build` 成功
- `npm run test:e2e` **68件すべて合格**（プロフィールのV群7件を含む）

共有ツリーで落ちていた `[D] カードをめくっていた時間が、確定しても消えない` は、
この木では合格した。**プロフィールのせいではない。**

### 別作業線の記録を1件消してしまった

2026-09-08 に PROGRESS.md が400行を超えたとき、いちばん古いという理由だけで
別作業線の「2026-09-08 P0：一巡で仮のお題を作り、カテゴリごとに1回だけ引き直す」を
削った。**その作業はまだ現役で、消してよいものではなかった。**

原文は復元できない。git にも `統合.md` にも控えが無いことを確かめた。
中身そのものは `docs/decisions.md` の D172（一巡で仮のお題…）に残っている。
今後、400行を超えたときに削るのは、完了済みか別文書へ移し終えた項目だけにする。
**進行中の作業線の記録は、古くても削らない。**

### 本番へ当てた（2026-09-09）。権限を1回落として、直した

- `20260908150000_profile_avatar_and_specialties.sql` を本番へ1本だけ当てた。
  本番の migration は 46本 → 47本、表は 51 → 52。既存の行は減っていない
  （profiles 657・works 919）。
- 当てたあとの `npm run db:verify` で3項目が不合格。原因は**権限の書き落とし**。
  Supabase は「postgres が作った関数は anon にも実行を配る」既定を持つ。
  **PUBLIC 経由ではなく anon へ直接**配られるので、
  `revoke all ... from public` だけでは外れない。
  持ち込み（art_first）は `from public, anon, authenticated` と3つ並べていたが、
  プロフィールのぶんだけ anon を書き落としていた。
- 手元の検査用DB（PGlite）はこの既定を持たないので、**手元では通り本番でだけ落ちる。**
  検査の穴。
- 実害の範囲（本番で begin … rollback して実測）: `get_my_specialties` だけ
  未サインインでも通ったが、返るのは空（auth.uid() が null）。
  残り3本は NOT_SIGNED_IN で断られていた。誰かのデータが読めた・書けた形跡は無い。
- 直す `20260909180000_profile_rpc_revoke_anon.sql` を本番へ当てた
  （ユーザー承認 2026-09-09）。migration 47本 → 48本、表は52のまま。

#### 直したあとの実測（2026-09-09）

- anon の役で4本を呼ぶと、関数の中へ入る前に `permission denied for function`
  で止まる。**NOT_SIGNED_IN ではない。**実行権そのものが無い。
- authenticated の役では4本とも呼べる（`get_my_specialties` は空を返し、
  残り3本は関数の中の認証で NOT_SIGNED_IN。どちらも実行権がある証拠）。
- 関数の中身は動いていない。5本すべて本体の md5・SECURITY DEFINER・
  search_path が適用前と同一。他135本の権限も並びごと md5 が同一。
- `npm run db:verify` 198項目すべて合格（前回は195合格・3不合格）。
- `npm run verify:launch` 18項目すべて合格。
- 手元（wt4）で6コマンド: test:db 205件 / db:verify:local 187件 /
  typecheck / lint（エラー0・警告2は既存）/ build / test:e2e 74件 — すべて緑。

#### 本番へ出して、往復で確かめた（2026-09-09）

`profile-on-main`（管理 v0 の上にプロフィールだけを載せた枝）を main へ
早送りで push した（f4c3893 → 96946eb）。別作業線の未 push コミット
`150edda` は取り込んでいない。Vercel が組み直し、本番の公開プロフィールに
アイコンの欄が出ている。

往復の検査を `scripts/smoke-profile-avatar.mjs` として足した。
**手元のブラウザ試験では確かめられないところ**を本番で通すためのもの。
擬似の Supabase には本物の置き場も、画像を縮めて配る仕組みも無い。

    SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- profile-avatar

本番での実測（2026-09-09。60項目すべて合格）。

- アイコンを置くと `<利用者ID>/avatar/<乱数>.png` に入り、公開プロフィールに出る。
- 配られるのは縮めたもの。原寸 122,128 バイト → 実際に返るのは 5,195 バイト。
- 差し替えると名前が変わり、古いファイルは置き場から消える（Object not found）。
  掃除待ちには積まれない（その場で消せている）。
- **ただし古い公開URLは、消した直後でもしばらく 200 を返す。**配信の途中に
  控え（CDN）があるため。置き場からは消えている。差し替えが毎回新しい名前に
  なるので、いまのアイコンが古いままになることはない。
  この1点だけは、最初に書いた期待（すぐ取れなくなる）が誤りだった。
- 得意分野は 5件 / 5件、同じ語を両方に入れられる。0件の側は見出しごと消える。
- 外すと DB もファイルも空になり、既定の表示に戻る。名前と自己紹介は残る。
- 公開設定・作品一覧・公開プロフィールの下の内容は今までどおり。

出したあとの検査。`npm run db:verify` 198項目すべて合格、
`npm run verify:launch` 18項目すべて合格。
本番のデータは migration 48 / 表52 / works 919 / profile_specialties 0 /
掃除待ち 330（未処理0）。profiles は 657 → 658。
**増えた1人は、この検査が作った検査用の利用者**（smoke+avatar@…）。

### 次の一手

- 検査の穴をふさぐ。`test/db/harness.mjs` に Supabase と同じ既定権限を
  足せば、この種の書き落としを手元で捕まえられる。ただし別作業線も触る
  ファイルなので勝手には変えない。**既存の全RPCを対象に見る。**
  プロフィールの4本だけを特例にしない。
- 検証用の環境では、`next/image` が 127.0.0.1 の画像を最適化しない
  （`resolved to private ip`）。アイコンの部品が出ることは確かめられるが、
  画像そのものが描かれるかは本番でしか確かめられない。

### 400行を超えたので、いちばん古い1件を削った

削ったのは「2026-09-08 描いた絵を持ち込む経路（art_first）を実装した」。
**2026-09-08 に本番へ出し終えている**（同ファイルの「2026-09-08（5回目）
art_first を本番へ出した」に記録がある）。中身は `docs/decisions.md` の
D172（art_first のほう）と `docs/spec.md` 6-1-2 に残っている。
進行中の作業線の記録は1件も消していない。

### 触ったファイル

- `supabase/migrations/20260908150000_profile_avatar_and_specialties.sql`（新規）
- `supabase/migrations/20260909180000_profile_rpc_revoke_anon.sql`（新規・権限の直し）
- `src/features/vocab/{types.ts,picker.tsx}`（新規）、`src/features/profile/avatar.ts`（新規）
- `src/app/account/_profile-form.tsx`（新規）、`src/app/account/{page.tsx,actions.ts}`
- `src/app/u/[handle]/page.tsx`、`src/app/works/import/_form.tsx`
- `src/features/profile/{types.ts,rpc.ts}`、`src/features/artfirst/types.ts`、`src/types/database.ts`
- `scripts/db-checks.mjs`、`scripts/smoke-profile-avatar.mjs`（新規）、`package.json`
- `test/db/run.mjs`、`test/e2e/browser.mjs`
- `docs/decisions.md`（D176）、`docs/spec.md`（12-0-2）、`docs/art-first-investigation.md`（語数の訂正）

---
## 2026-09-09 管理 v0 を独立コミットにした（DBは適用済み。画面はこれから出す）

### 終えたこと

- 通報を見て判断し、作品を非表示にするか通報を閉じるかを、ブラウザから
  1件ずつ行えるようにした。これまでは表に列があるだけで、操作する道が
  1本も無かった（決定は `docs/decisions.md` の D177）。
- 管理者は1人だけ。DB に役割の列は作らず、環境変数 `ADMIN_USER_ID` に
  入っている利用者ID1つとだけ照合する。**未設定なら誰も入れない**（404）。
- 危ない書き込み4本は service_role からしか呼べない関数にして、
  監査記録（`admin_audit_log`）を同じトランザクションに置いた。
  **理由の記入が無いと記録できない**ので、記録の無い操作が起きない。
- 作品を下げることと、通報を閉じることは別の操作にした。
  下げても通報は開いたまま。行は消さない。画像も回答も残る。

### 本番DBへの適用（2026-09-08 に実施済み）

`supabase/migrations/20260908130000_admin_moderation.sql` の1本だけを
`npm run db:apply:one` で当て、`supabase migration repair` で履歴へ記録した。
本番の migration は45本から46本になった。詳しくは `docs/verify-2026-09-09.md`。

### 土台を origin/main にした理由（実測）

作業ツリーには複数の作業線が混ざっている。とくに手元の `main` にある
未 push のコミット `eca460a`（プロフィール拡張）は、その migration
`20260908150000` が**本番に当たっていない**。一緒に押すと本番の
`/account` と `/u/[handle]` が壊れる。

本番の migration 履歴と `origin/main` のファイルを突き合わせた実測。

- 本番に入っている版番号 46 本
- `origin/main` の migration ファイル 45 本（`.gitkeep` を除く）
- 本番にあって `origin/main` に無いのは `20260908130000`（管理 v0）だけ
- `origin/main` にあって本番に無いものは 0 本

したがって `origin/main` ＋ 管理 v0 が、いまの本番DBとちょうど噛み合う。
そこで `origin/main` から worktree を切り、管理 v0 のぶんだけを載せた。
他の作業線のファイルには 1 行も触っていない。

### その木での実測

- `npm run typecheck` 終了コード0
- `npm run lint` エラー0・警告2（すべて既存の `smoke-cutover.mjs`）
- `npm run db:verify:local` 合格184・不合格0（管理の検査8項目と、
  実際に呼んで断られることを見る10件を含む）
- `npm run test:db` 183件すべて合格（管理のW群18件を含む）
- `npm run build` 成功。経路一覧で `/admin/reports` と
  `/admin/reports/[id]` が ƒ（動的）になっている
- `npm run test:e2e` 67件中57件合格・10件不合格。**不合格10件はすべて時間切れ**で、
  サーバー側は 200 / 303 を返していた（`GET /api/challenge 200 in 28.9s` 等）。
  落ちた7群（A・C・D・E・F・Q・S）だけを流し直すと 29 件すべて合格。
  管理のX群6件は、全件通しでも6件とも合格した。

### 次の一手

- push すると Vercel が組み直す。**Vercel の Production に `ADMIN_USER_ID`
  が入っていること**が前提（入っていないと `check-env.mjs` がビルドを止める）。
- 出したあとの検収は、この順を崩さない。
  未ログインで404 → 一般利用者で404 → 運営者で200（read）→ 通報1件だけ write
  → write 後にDBを読んで実測。
- 拒否試験だけでは足りない。出す前も404、出したあと断られても404で
  見分けがつかない。**運営者で200が返ることを確かめて初めて**、
  404 が「画面が無い」ではなく「断られた」だと言える。
- 本番の未処理の通報70件は、**全部が削除済みの検査用作品への通報**
  （実利用者の通報0件・公開中の作品への通報0件。2026-09-09 の実測）。
  扱いは決まっていない。勝手に閉じない。

### 400行を超えたので、いちばん古い2件を削った

削ったのは「2026-09-07（3回目）放棄と『他の候補を見る』に押せるボタンを付けた／
メール確認を2枚のタブで確かめた」と「2026-09-07（2回目）D171 開示後の引き直し禁止・
放棄・表示名・タイマー・認証」。**どちらも 2026-09-07 に本番へ出し終えている**
（同ファイルの「2026-09-07（4回目）本番へ反映した」に記録がある）ので、
進行中の作業線の記録は1件も消していない。中身は `docs/decisions.md` の
D171 と、その回の verify 文書に残っている。

### 触ったファイル

- `supabase/migrations/20260908130000_admin_moderation.sql`（新規）
- `src/features/admin/{auth.ts,rpc.ts,types.ts}`（新規）
- `src/app/admin/layout.tsx`、`src/app/admin/reports/page.tsx`、
  `src/app/admin/reports/[id]/{page.tsx,actions.ts}`（新規）
- `src/app/_pending.tsx`、`src/lib/env.ts`、`src/lib/supabase/admin.ts`
- `next.config.ts`、`scripts/check-env.mjs`、`scripts/db-checks.mjs`、`.env.example`
- `test/db/run.mjs`、`test/e2e/{browser.mjs,seed.mjs,server.mjs}`
- `docs/admin-tool-investigation.md`（新規）、`docs/verify-2026-09-09.md`（新規）
- `docs/{decisions.md,spec.md,legal-draft.md,launch-checklist.md}`、`PROGRESS.md`

---

## 2026-09-08（5回目）art_first を本番へ出した（DB1本＋画面。書きかけは入れていない）

直前に終えたこと。

- 本番へ当てたのは `supabase/migrations/20260908090000_art_first.sql` の**1本だけ**。
  `npm run db:deploy`（`supabase db push`）は使えなかった。dry-run が
  書きかけの `20260907120000_single_pass_draw_and_slot_redo.sql` まで
  一緒に当てると言ったため（実測）。CLI にファイルを選ぶ引数は無い。
- そこで `scripts/db-apply-one.mjs`（`npm run db:apply:one`）を足した。
  名指しした1本を1トランザクションで流す。履歴表への記録は CLI 本来の
  `supabase migration repair <版番号> --status applied` で行った。
  **当てた直後にだけ使う。**当てずに repair だけするのは履歴に嘘を書くこと。
- 本番の migration は 44本 → **45本**。書きかけは未適用のまま。
- 副作用が1つある。書きかけの版番号が本番の最後より古くなったので、次に
  `db push` を叩くと `--include-all` を求められる（実測の文言は
  `docs/prod-apply-2026-09-08.md` 9-3）。**適用不能ではない。**まだ一度も
  当てていないファイルなので、版番号を付け替えれば普通に押せる。付け替えは
  一巡ドローの作業線の判断なので、こちらでは触っていない。
- 作業ツリーに2つの作業線が混ざっていたので、HEAD から切った worktree へ
  こちらのぶんだけを組み直し、そこで型検査・lint・build・DB試験・
  ブラウザ試験を通してから、その内容だけをコミットした。相手のファイルは
  1つも消していない・戻していない（`git status` に残っている）。
- 実測: 当てる前の本番 `db:verify` は 合格181・不合格6（6件はすべて
  「art_first がまだ無い」ため）。当てた後は **187項目すべて合格**。
  デプロイ後にもう一度回して、同じく 187項目すべて合格。
  `verify:launch` は前後とも 18項目すべて合格。
  組み直した木では test:db 165件・db:verify:local 176件・test:e2e **61件**が
  すべて合格し、build も通った。

次の一手。

- 本番で持ち込みを1往復する（実際に絵を出して答えてもらう）は**やっていない。**
  持ち込み用のスモークが無く、作ると本番に公開作品が1件増えるため。
  作るかどうかはユーザーの判断。
- `smoke:draft` / `smoke:play` の本番実行も、いまはできない。作業ツリーの
  スモークが `pick_card` を前提にしていて、本番のDBにその関数がまだ無い。
  一巡ドローが本番へ入ってから。
- 一巡ドローと長押し回答は、別の作業線の書きかけのまま。

触ったファイル。

- `supabase/migrations/20260908090000_art_first.sql`（新規・本番へ適用済み）
- `scripts/db-apply-one.mjs`（新規）、`package.json`（`db:apply:one` を追加）
- `docs/prod-apply-2026-09-08.md`（9節に実測を追記）
- 画面・受け口・試験は前回の項目（下）と同じ

---
## 2026-09-08（3回目）重い検査の排他を広げ、本番へ出す migration を1本に確定した



### 終えたこと

- **重い検査の札を build と型検査へ広げた。**もとはブラウザ試験・スモーク・
  DB試験だけが札を取っていて、`npm run build` と `npm run typecheck` は
  取らずに走れた。別の窓のブラウザ試験と計算機を奪い合う入口がそこだった。
  いまは両方とも `scripts/heavy.mjs` を通る。実際に待つことを実測で確かめた
  （札を持った偽の相手を立てると、型検査が22秒待ってから走った）。
  Vercel と CI では札を取らない。親が札を持っているときも取らない。
  **試験の待ち時間・判定・件数は1つも変えていない。**
- `E2E_ONLY` の決まりを文書に残した（未指定なら全件・判定は不変・
  一部実行を全体検査の代わりにしない・前提の群を足して流す）。
- **「本番へ当てるのは4本」は私の間違いだった。**9月7日ぶんの4本は
  その日のうちに本番へ入っている（本番44本。出所: docs/verify-2026-09-07.md）。
  いま本番に入っていないのは2本で、当てるのは art_first の1本だけ。
  一巡ドローの書きかけ1本は本番から外す。
- **art_first が、その書きかけに依存していないことを実測した。**まっさらなDBへ
  本番と同じ44本だけを当て、そのうえで art_first を当てて13項目を確かめた
  （`node scripts/verify-art-first-prod-order.mjs` 13件中13件合格）。
  2本のあいだに、触る表も関数も重なりが1つも無いことも数えた。
- 本番の鍵が要る4本の性質を整理した。db:verify と verify:launch は読むだけ。
  smoke:draft と smoke:play は書き込み、しかも**いまは本番へ向けられない**
  （どちらも一巡ドローの `pick_card` を前提に書き換わっているため）。
  控えは docs/prod-apply-2026-09-08.md。

### 検査（すべて実測）

- test/db/run.mjs 175件中175件合格
- scripts/db-verify-local.mjs 合格176・不合格0（判定しない11件は本番データ前提）
- scripts/verify-art-first-prod-order.mjs 13件中13件合格（本番と同じ44本＋art_first）
- npm run typecheck 終了コード0 ／ npm run lint エラー0・警告3（すべて既存）
- npm run build 成功
- test/e2e/browser.mjs 63件中63件合格（全件実行）

### 次の一手

- 本番へ当てるのは `20260908090000_art_first.sql` の1本だけ。
  **まだ当てていない。**コミットもデプロイもしていない。
- 当てる前に `npm run db:status`／`db:audit:prod` で本番側を読む。
  当てた後に `npm run db:verify`。
- smoke:draft と smoke:play は、一巡ドローが本番へ入るまで実行しない。

### 触ったファイル

- scripts/heavy.mjs（札を取らない場面と、子への印）
- package.json（build と typecheck を包む。build:raw を足した）
- scripts/run-all-checks.mjs（札を持ったまま起動する子へ印を渡す）
- scripts/verify-art-first-prod-order.mjs（新規。本番と同じ並びでの確認）
- docs/test-layers.md（札の範囲と E2E_ONLY の決まり）
- docs/prod-apply-2026-09-08.md（新規。本番へ当てる前の控え）
- PROGRESS.md

---
## 2026-09-08（2回目）E2E の不合格4件を切り分け、いまの基準状態を確定した

### 終えたこと

- **いまの作業ツリーは、全部の検査が緑になる。**ブラウザ試験は63件中63件合格を
  2回続けて出した。落ちていた4件（C16 帯の未同期／E22 ゲストの持ち出し／
  R54 一巡ドロー／Q58 確認メールの合図）は、どれも実装の問題ではなかった。
- 原因は**計算機の奪い合い**だった。この端末は8コア・8GBで、検証用サーバー
  （next dev）は1本あたり4GBを上限に動く。2つの作業線が同時にブラウザ試験や
  ビルドを回すと、画面が15秒〜30秒返らなくなり、待ち時間で組んだ判定が落ちる。
  実測: 落ちた回の負荷は14〜20、緑になった回は5〜8。落ちた理由はどれも
  「部品が現れない」「ページが返らない」で、判定の中身の食い違いではない。
- 群ごとに前提を付けて流し直したら、2回とも全部通った。
  A,B,C 群 22件／E 群 2件／F,R 群 12件／Q 群 3件／F,H 群 13件／F,S 群 12件。
- **書きかけが1つも無い状態（HEAD の作業コピー）でも57件中57件合格。**
  いまの作業ツリー（持ち込み＋一巡ドローの両方あり）で63件中63件なので、
  どちらの書きかけも回帰を持ち込んでいない。
- 切り分けのために、ブラウザ試験へ `E2E_ONLY` を足した。群の記号や試験名の
  一部を渡すと、それだけ流す。**未設定なら今までどおり全部流す**（63件のまま）。
  流さなかった件数は最後に出し、件数の記録には残さない。

### 検査（すべて実測。実行して成功したものだけ）

- test/e2e/browser.mjs 63件中63件合格（いまの作業ツリー・2回連続）
- test/e2e/browser.mjs 57件中57件合格（HEAD の作業コピー。書きかけ無し）
- test/db/run.mjs 175件中175件合格
- scripts/db-verify-local.mjs 合格176・不合格0（判定しない11件は本番データ前提）
- npm run typecheck 終了コード0 ／ npm run lint エラー0・警告3（すべて既存）
- npm run build 成功

### 次の一手

- 本番へ当てる migration は4本のまま（9-07 の3本 ＋ 20260908090000_art_first.sql）。
  一巡ドローの migration は別作業線のもので、まだ書きかけ。
- **本番適用・デプロイ・コミットはしていない。**本番の鍵が要る検査4本も未実行。
- 重い検査を2つの作業線が同時に回すと結果が汚れる。回すときは、
  相手のブラウザ試験が動いていないことを確かめてから始める。

### 触ったファイル

- test/e2e/browser.mjs（E2E_ONLY の仕掛けだけ。試験の中身は1件も変えていない）
- PROGRESS.md

