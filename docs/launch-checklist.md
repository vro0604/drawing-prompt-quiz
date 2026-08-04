# 公開前の最終チェックリスト

**このファイルの項目が全部済むまで、一般公開しない。**

コードで解決できるものは Step 16 までに済ませた。
ここに残っているのは、**外部の画面での操作**と**中身の差し替え**だけ。

最終更新: 2026-08-04

---

## 1. 差し替えが必要なもの（いちばん重い）

### 1-1. 利用規約とプライバシーポリシーの本文

**いまは雛形。この状態で公開しない。**

本文は DB にある（`terms_versions` / `privacy_versions`）。
版 `2026-08-04` が有効になっている。

- [ ] 法務の確認を受けた本文を用意する
- [ ] 新しい版を `insert` し、`is_current` を付け替える
- [ ] プライバシーポリシーに**連絡先**を書く（雛形では「公開前に記載します」のまま）
- [ ] 同意記録の保存目的と期間（5年）の記載が、実際の運用と合っているか確認する

**古い版は消さないこと。**過去の同意がどの本文に対するものだったかを
示せなくなる。`is_current` を false にするだけでよい。

差し替えると、既存の利用者は次に投稿しようとした時点で
新しい版への同意を求められる（`app_guard_works`）。

```sql
-- 例。本文は別途用意したものに置き換える
update public.terms_versions set is_current = false where is_current;
insert into public.terms_versions (version, body_md, is_current)
values ('2026-09-01', $doc$...$doc$, true);
```

---

## 2. 外部の画面で行う設定

### 2-1. Supabase ダッシュボード

- [ ] **Authentication → Email → Confirm email を ON に戻す**
      スモークテストのため OFF にしてある。**ON に戻さずに公開すると、
      他人のメールアドレスで登録できてしまう。**
- [ ] Authentication → URL Configuration → Site URL を本番URLにする
- [ ] Authentication → Rate limits を確認する（既定のままでよいか）
- [ ] Database → Backups が有効か確認する
      （退会は取り消せない。誤操作の復旧手段はバックアップだけ）

### 2-2. Cloudflare Turnstile（P6）

通報の CAPTCHA。**鍵が無いと通報が 503 になる**（素通しはしない。D78）。

つまり、鍵を入れ忘れたまま公開しても穴は開かない。
代わりに**通報機能が丸ごと使えない**ので、必ず入れること。

- [ ] Turnstile でサイトを登録する（ドメインは本番のもの）
- [ ] `NEXT_PUBLIC_TURNSTILE_SITE_KEY` を Vercel に設定する
- [ ] `TURNSTILE_SECRET_KEY` を Vercel に設定する（`NEXT_PUBLIC_` を付けない）
- [ ] **テスト鍵（`1x000…` など）を本番に入れない**。設定の誤りとして 503 になる
- [ ] 通報画面が 200 で開き、widget が出ることを本番で確認する
- [ ] 確認を通さずに送ると断られることを確認する

**動作の確かめかた**（本番URLで）

```
# 鍵が正しく入っていれば 200
curl -o /dev/null -w "%{http_code}\n" https://<本番>/works/<作品ID>/report
```

503 が返るときは鍵が足りないか、テスト鍵が入っている。

### 2-3. Vercel

**環境変数**（すべて Production に設定する）

| 変数 | 公開 | 用途 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ○ | 接続先 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ○ | ブラウザ用の鍵 |
| `SUPABASE_SECRET_KEY` | **×** | 退会と掃除。`sb_secret_` 形式。**`NEXT_PUBLIC_` を付けない** |
| `NEXT_PUBLIC_SITE_URL` | ○ | 共有カードの絶対URL |
| `CRON_SECRET` | **×** | 掃除の入口を守る。**未設定だと掃除が 503 で動かない** |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | ○ | 通報の CAPTCHA |
| `TURNSTILE_SECRET_KEY` | **×** | 同上 |

- [ ] 上の7つを設定する
- [ ] `SUPABASE_SECRET_KEY` に `NEXT_PUBLIC_` が**付いていない**ことを二度確認する
- [ ] **`npm run check:env:prod` が通ることを確認する**
      （本番のビルドは自動でこれを通る。足りなければビルドが止まる。D80）
- [ ] Cron が登録されていることを確認する（`vercel.json` の `/api/cron/cleanup`、毎日 03:17 UTC）
- [ ] 鍵なしで `/api/cron/cleanup` を叩くと 401 になることを確認する

---

## 3. 本番URLでの縦断試験

ローカルのスモークと同じ道筋を、**本番URLで手で1回通す。**
スモークは Confirm email が OFF の前提で作ってあるため、
ON に戻したあとはそのままでは動かない。

- [ ] ゲストとしてお題を引く（お手軽・標準の両方）
- [ ] 引き直しが1回だけできる
- [ ] 登録する（**確認メールが届く**）
- [ ] ゲストのまま登録して、引いたお題が引き継がれる
- [ ] 規約への同意を求められる
- [ ] 同意して作品を投稿する（画像が表示される）
- [ ] 別の端末・別のアカウントでクイズに答える
- [ ] 正答率が動く
- [ ] いいね・お気に入りが押せる（ゲストでは押せない）
- [ ] ランキングに出る
- [ ] プロフィールが公開設定どおりに見える
- [ ] 通報が送れる（**CAPTCHA を通る**。画面が 503 でないこと）
- [ ] 作品を非公開にできる／削除できる
- [ ] 共有カードが SNS で正しく出る（**お題の答えが入っていない**）
- [ ] 退会できる（**テスト用のアカウントで**）
- [ ] 退会後に再ログインできない
- [ ] 掃除 Cron を手で1回叩き、残り件数が減る

---

## 4. 公開後すぐに見るもの

- [ ] `npm run db:verify:keychain` が全項目通る
- [ ] `[参考]` の3つが 0 になっている
      - auth.users をまだ消せていない退会
      - Storage からまだ消せていない画像
      - 退会処理中のまま止まっている人
- [ ] Vercel の Cron ログに成功が記録されている
- [ ] Supabase の Logs にエラーが溜まっていない

---

## 5. まだ決めていないこと（公開の条件ではない）

- 通報が一定件数を超えた作品の扱い（自動で非公開にするか、運営が見るまで何もしないか）。
  **いまは何件集まっても自動では何も起きない**
- 類型プール `archetype` の新設（設計課題 A1）
- 「解釈」「意外性」のランキング（評価データが未実装）
- 一発ドラフト（引き直し0回）をモードにするか

---

## 6. 済んでいること（記録）

| 項目 | いつ | どこ |
|---|---|---|
| P1 退会・アカウント削除 | Step 15-B | D70〜D73 / spec 12-7 |
| P2 匿名化 | Step 15-B | D70 / spec 12-7 |
| P3 規約と同意 | Step 15-B | D74 / spec 12-8 |
| P4 持ち主のいないお題の掃除 | Step 16 | `cleanup_orphan_prompts` |
| P5 手放した ID の再取得 | Step 15 | D62 / D73 |
| P6 通報の CAPTCHA | Step 16 | D78 / D79 / `src/features/report/captcha.ts` |
| 環境変数の不足をビルドで止める | Step 16 | D80 / `scripts/check-env.mjs` |
| 匿名ユーザーの掃除 | Step 16 | `list_stale_guests` |
| 画像の消し残しの掃除 | Step 16 | `storage_cleanup_queue` |
| 退会の後始末の再試行 | Step 16 | `account_deletions` |
| 期限切れ同意記録の掃除 | Step 16 | `cleanup_expired_agreements` |
