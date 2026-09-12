# D194〜D196 を本番へ着地させる手順

2026-09-12 作成・同日に版番号を振り直した（D198）。**この文書の手順は、まだ1つも本番で実行していない。**
本番へ当てること・push・deploy・merge・repair は、どれも人の承認のあとに行う。

対象の3本（どれもシステム回答の仕組み。本番ではまだ何も動かさない）

| 順 | ファイル | 決定 | sha256 |
|---|---|---|---|
| 1 | `20260912110000_answer_source.sql` | D194 回答に「何が答えたか」を持たせる | `49e927619166f1db777592947eacadce08db7a838c5e0bc1a7727e2359d33ce6` |
| 2 | `20260912120000_system_answer_queue.sql` | D195 システム回答の待ち行列（サーバー専用） | `f35c9bcde5aa970cf77e953b339475f5901852a7eff7f8d9bf68ce2dc2c7a83c` |
| 3 | `20260912130000_system_answer_out_of_analysis_and_import.sql` | D196 システム回答を分析と取り込み枠から外す | `03b0bea019f5c51b3233191fc9b510e18814073d5386327b17367c720700e579` |

旧版番号は 20260911090000 / 20260912090000 / 20260912100000。本文は1文字も変えていないので sha256 は旧版と同じ。
そのため SQL の中のコメントには古い番号が残っている（各ファイル1行目のファイル名など）。

---

## 0. 前提

### 確定（ユーザー発言 2026-09-12）

- 「着地方式は案A」
- 「D194〜D196は実装・互換性検証完了」
- 「get_usage_summaryは将来C」: answer_completed = human、answer_completed_system = system。システム回答の自動化を始める前に作る
- 「180000 repairはD194〜D196の後」
- 「D194だけを古い番号 20260911090000 のまま後追い適用する案は採用しない」「3本とも新しい未使用versionへ振り直す」（D198）
- 20260911120000 は別の作業線のもの。本番へ当たっている。rename も repair も rollback もしない

### 2026-09-12 に読み取りで確認した事実

- 本番の履歴は **60本・最大 20260911120000**。2026-09-11 に写した60行と、版・名前・中身まで同じ
- 別の作業線が p0-p5-production-integration を `6f4521a` まで進め、**origin/main も 6f4521a になっている**
  （ls-remote で確認）。`fe642c3` は本番の Vercel へ deploy 済み（6f4521a の PROGRESS.md、00:55 JST）
- 同じ作業線が本番の検査用の利用者330人とその検査データを消した。本番の回答は 679 → 324 件
- 同じ PROGRESS.md に「db:verify:keychain は205項目が合格、4項目（A8 / A21 / A24 / A32）が期待と違う」とある。
  回答を消しても集計が減らない既知の問題（D70）によるもので、D194〜D196 とは無関係。4節の手順で、当てる前にも同じ検査を流して比べる
- **上の4項目は、この工程でも自分で測り直した**（2026-09-12 21時台 JST、着地前の 6f4521a の checkout から
  `npm run db:verify:keychain`）。205項目が合格、4項目（A8 / A21 / A24 / A32）が期待と違う、で一致した
- 同じ時間帯の本番の実測（読み取り専用）: 回答 324・作品 566・利用者 32。履歴 60本・最大 20260911120000。
  `answers` に `answer_source` 列は無く、`system_answer_queue` も無い（＝ D194〜D196 は未適用）
- **merge 後の木から同じ検査を流すと不合格は14項目になる。**増える10項目
  （表が64個 / RLS が64表 / A50 / A51 / A52 / A53 / A54 / A56 / A57 / A62）は、
  merge が持ち込む `scripts/db-checks.mjs` が D194〜D196 の適用後を前提に見るために出る。
  3本を当てれば消える。**合否の基準は「既知の4項目のほかに不合格が増えないこと」**

案Aの「p0-p5-production-integration を main へ」の段は、別の作業線がすでに済ませた。
残りは「main（6f4521a）へ onboarding-phase12-integration を merge する」だけ。

---

## 1. 着地の形（案A）

```
origin/main = 6f4521a ─ …（fe642c3 を含む）
                 └─ merge ← onboarding-phase12-integration（8a8a947 から分かれた D194〜D196 の作業線）
```

merge の結果（git merge-tree で計算。ブランチは1つも動かしていない）は 7節の末尾に書く。

---

## 2. 本番で実行するときの規則: 着地後の main の clean checkout からだけ打つ

### なぜ要るか（7節の再現で実測）

`db:apply:one` も `supabase migration repair` も、**打った場所の `supabase/migrations/` のファイルを読む。**
DB に何が当たっているかは見ない。そのため、打つ場所を間違えると、エラーにならずに黙って食い違う。

| 打った場所 | 起きたこと（使い捨ての DB で実測） |
|---|---|
| ファイルを書き換えた checkout | repair が書き換えた中身を履歴へ書いた。apply-one も書き換えた中身を当てようとした |
| 同じ版で別の名前・中身のファイルがある checkout | repair が別の名前（other_line）で履歴へ書いた。180000 の偽の履歴と同じ形 |
| 同じ版のファイルが2つある checkout | repair がエラーを出さず、片方を選んで書いた |
| その版のファイルが無い checkout | repair がエラーで止まった（これだけは安全側） |
| 20260911120000 を持たない checkout（onboarding の作業線だけ） | db push が止まり、CLI が `migration repair --status reverted 20260911120000` を勧めた。**これに従うと、本番で当たっている別の作業線の履歴を消すことになる。従わない** |

### 規則

1. 着地後の main を、新しい場所へ clone（または `git worktree add`）する。ほかの作業木は使わない
2. 打つ前に次を全部確かめる。1つでも違えば打たない

```sh
git status --porcelain                                   # 何も出ない
git status --porcelain --ignored supabase/migrations     # 何も出ない（無視されたファイルも無い）
git rev-parse HEAD                                       # 承認された着地コミットと同じ
ls supabase/migrations/*.sql | wc -l                     # 63
shasum -a 256 supabase/migrations/2026091{2110000,2120000,2130000}_*.sql   # 上の表と同じ
ls supabase/migrations | cut -c1-14 | sort | uniq -d     # 何も出ない（同じ版のファイルが無い）
ls supabase/migrations | tail -4                         # 20260911120000 → 20260912110000 → 120000 → 130000
```

3. `npm ci` と `npm run db:link` をその場所で行う（`supabase/.temp` は git の外なので、status は汚れない）
4. 停止条件の控え（`--out`）は、checkout の外（例 `~/dpq-landing/`）へ書く
5. 使わない場所: onboarding の作業木（wt7）、dpq-integration、local main（課金の同じ版のファイルがある）、
   migration が 63本でない checkout、未追跡のファイルがある checkout

---

## 3. DB と Vercel の順番

推奨（ユーザーの第一候補のまま）:

1. main への merge を終える（push はまだ）
2. clean checkout を作り、2節の確認をする
3. DB へ3本を1本ずつ当て、1本ごとに停止条件を確かめる（4節）
4. 本番スモーク（6節）
5. push → Vercel の deploy

### DB を先に固めても安全か

安全と判断した。根拠は次の4つ。

- アプリはシステム回答の窓口を1か所も呼ばない（`src` 全体で読み込む場所0）
- 3本が「変えた」関数は、名前と引数の型が前と同じ（部品の一覧の鍵が同じ）。
  返す型は `create or replace` では変えられない（変えようとすると PostgreSQL がエラーにする）。
  つまり今の本番のアプリの呼び方は、そのまま通る
- システム回答が0件のあいだは、変えた関数の返す値が前と同じ。
  使い捨ての DB で、95個の指紋が当てる前と一致した。本番でも同じ比較を1本ごとに行う（4節）
- 3本は D194〜D196 のアプリの変更を必要としない。deploy が後になっても、画面は今のまま動く

### DB を当ててから push までのあいだに気をつけること

- 本番の履歴は63本、GitHub の main は60本のまま、という時間ができる。
  このあいだに誰かが古い checkout から `db push` を打つと、CLI は止まる（安全側）。
  ただし CLI が勧める `repair --status reverted` には従わない（2節の表）
- 振り直したので、3本とも本番の最大（20260911120000）より新しい。
  `db push` でも `--include-all` なしで順に当たる（7節で実測）。それでも 4節の1本ずつの手順を使う

---

## 4. 1本ずつの手順と停止条件

停止条件は `scripts/landing-d194-check.mjs` が判定する。**読むだけの道具**
（読み取り専用のトランザクションで開き、最後は rollback で閉じる。DB へは1バイトも書かない）。

終了コード: 0 = 満たした（次へ進む）/ 1 = 停止条件に当たった（止まる。5節の取り消しを検討）/
2 = 判定できない（本番で利用者が動いた等。人が見て決める）/ 3 = 接続・実行の失敗

### 手順

```sh
D=~/dpq-landing; mkdir -p $D
npm run db:verify:keychain > $D/verify-before.txt                        # 当てる前の構造検査（既知の4項目を控える）
node scripts/landing-d194-check.mjs check pre --out $D/s0.json          # 0 で進む

npm run db:apply:one -- 20260912110000_answer_source.sql
npx supabase migration repair 20260912110000 --status applied --linked
node scripts/landing-d194-check.mjs check phase1 --before $D/s0.json --out $D/s1.json

npm run db:apply:one -- 20260912120000_system_answer_queue.sql
npx supabase migration repair 20260912120000 --status applied --linked
node scripts/landing-d194-check.mjs check phase2 --before $D/s1.json --out $D/s2.json

npm run db:apply:one -- 20260912130000_system_answer_out_of_analysis_and_import.sql
npx supabase migration repair 20260912130000 --status applied --linked
node scripts/landing-d194-check.mjs check d196 --before $D/s2.json --out $D/s3.json

npm run db:verify:keychain > $D/verify-after.txt                         # 当てる前と比べ、増えた不合格が0
```

`npm run db:deploy`（= db push）は使わない。1本ずつ止まれないため。

### 停止条件と、道具が何を見るか

どの段でも共通で見るもの

- 履歴の本数と最大の版、版の並び（D194 のあと 61本・最大 20260912110000、D195 のあと 62本・最大 20260912120000、
  D196 のあと 63本・最大 20260912130000）
- 数字の指紋を失敗なしで読めたか。鍵の数は**本番のデータ量で決まる**ので、日によって変わる
  （2026-09-11 は 2253個、検査用の330人を消したあとの 2026-09-12 は 851個。どちらも失敗0）。
  判定は「当てる前と当てた後で同じか」の突き合わせなので、鍵の数そのものは合否に使わない。
  期待値の JSON（scripts/landing-d194-expected.json）にも、回答件数のような**データ量は1つも書いていない**
  （書いてあるのは部品の一覧と履歴の版だけ）

| 段 | ユーザーが決めた停止条件 | 道具の判定 |
|---|---|---|
| Phase 1 後 | answers 全件が human | 回答の全件数と human の件数が同じ |
| | human 以外0 | answer_source が human 以外の行が0 |
| | stats fingerprint 一致 | 作品ごとの回答数・枠ごと・ヒント別・回答者の成績・作者の分析・掘り下げ・回答一覧・枠の状態・作者の結果・答えた本人の集計・回答の履歴・順位が、当てる前と同じ |
| | objects/ACL 一致 | 増えた部品5・変わった関数9が、使い捨ての DB で当てたものと定義も権限も同じ。ほかの部品と権限は1つも変わっていない |
| Phase 2 後 | queue 0 | system_answer_queue が0行 |
| | anon/auth から queue RPC 不可 | 7つの窓口の実行権が anon・authenticated に無い。表の読み書き権も無い |
| | system answer 自動生成0 | human 以外の回答が0。積む窓口を呼ぶ関数・引き金が DB に0 |
| D196 後 | human-only 分析値不変 | 作者の分析・掘り下げ・回答一覧・枠の状態・答えた本人の集計の指紋が、当てる前と同じ |
| | import 値不変 | 取り込み・除外・枠の状態・枠の付与・残量の知らせの行が、当てる前と同じ |
| | ACL 不変 | 変わった部品が8関数だけで、定義と権限が使い捨ての DB と同じ。権限はどれも当てる前と同じ |
| | compatibility 検査合格 | migration 自身の自己検算（通らなければ commit されない）＋ 8本すべてが人の回答に絞っている（構造検査 A62 と同じ）＋ db:verify:keychain で増えた不合格が0 |

補足

- 本番は動いている。当てているあいだに利用者が回答すると、その作品・その人の指紋は変わる。
  道具はそれを「判定できない」へ分け（終了コード 2）、どの鍵かを出す。止まる理由にはしない。
  ほかの鍵が1つでも違えば止まる（終了コード 1）
- 本番の取り込み枠の表は0行（2026-09-11 の pre で、取り込みに関わる鍵が0個）。
  そのため本番の「import 値不変」は、比べる行が無い。取り込みの振る舞いは、
  使い捨ての DB（取り込み9件・除外1件）と縦断試験 SC 群で確かめてある
- 道具が本当に止まるかは、使い捨ての DB でわざと壊して確かめた（7節）

---

## 5. 取り消し

### ファイル

| 順 | ファイル（supabase/rollback/） | 戻す先 |
|---|---|---|
| 1 | `20260912130000_system_answer_out_of_analysis_and_import_rollback.sql` | D196 を当てる前 |
| 2 | `20260912120000_system_answer_queue_rollback.sql` | D195 を当てる前 |
| 3 | `20260912110000_answer_source_rollback.sql` | D194 を当てる前 |

**まだ本番へ流していない。**使い捨ての DB でだけ流した（7節）。
振り直しで変わったのは、ファイル名と、中の版番号の文字（案内・順番の条件の文言・repair で指す版）だけ。
旧版の取り消し SQL と比べ、旧番号を新番号へ置き換えると1文字も違わないことを確かめた。

### 安全条件（どれか1つでも満たさなければ、何も変えずに止まる。ファイルの先頭で判定する）

- システム回答が0件（answers.answer_source が human 以外の行が無い）
- 待ち行列が0行（system_answer_queue に行が無い）

どちらかが1以上になるのは、システム回答の仕組みを動かし始めたあと。そのあとで戻すと、
システム回答が「人の回答」と見分けられなくなる（D194 の列が消える）か、
分析と取り込み枠へ混ざる（D196 が戻る）。そうなったら、この3本では戻さない。

### 推奨の順番: D196 → D195 → D194（依存を調べて決めた）

- D196 の8関数は D194 の列（answer_source）を読み、D195 のシステム回答の保存はその列へ書く。
  D194 を先に消すと、それらが実行時に壊れる。だから D194 は最後
- D195 と D196 は互いを呼ばない。ただ、履歴を「最後に当てたものから外す」形に保つため、D196 を先にする
- 順番を飛ばすと止まる（D194 のファイルは D195・D196 が残っていれば止まり、
  D195 のファイルは D196 が残っていれば止まる）

### 1本ずつの流し方

1. そのファイルを SQL Editor で流す（`begin` / `commit` で包んであり、最後に自己検算がある。
   自己検算が通らなければ、何も変わらずに巻き戻る）
2. 着地後の main の clean checkout から、履歴を外す:
   `npx supabase migration repair <版> --status reverted --linked`
   （D196 は 20260912130000、D195 は 20260912120000、D194 は 20260912110000）
3. 戻ったことを、1つ前の段の判定で確かめる:
   - D196 を戻したあと: `check phase2 --before s1.json --out r2.json`
   - D195 を戻したあと: `check phase1 --before s0.json --out r1.json`
   - D194 を戻したあと: `check pre --out r0.json`

### 戻したときに失うもの

- D196: 何も失わない（関数の定義を書き戻すだけ）
- D195: 待ち行列の表（0行のときだけ流れる）
- D194: answer_source の列（全行が human のときだけ流れる。値は全部 human なので情報は失わない）

---

## 6. 本番スモーク（smoke:prod）の副作用

`npm run smoke:prod -- <名前>` は本番へ書き込む（run-production-smoke.mjs:17-18）。
2026-09-12 に全スモークの中身を読んで数えた（実行はしていない）。

### 作るもの・片づけ・残るもの

| 種類 | 作るもの | 片づけ | 残るもの |
|---|---|---|---|
| 検査用の固定の利用者（`dpq-fixture-<役>@dpq-smoke.invalid`） | 管理 API で作る | 残す（次の実行で使い回す） | 利用者と、その人の成績（実行のたびに増える） |
| 使い捨ての利用者（social / profile / report / account / consent） | 管理 API で作る | 消さない（account の退会役だけ消える） | 利用者 |
| 作品 | 画面から投稿 | `finish()` が論理削除（公開をやめる）。持ち込み投稿（/works/import）は追っていない | 論理削除した作品と、その回答・集計 |
| お題・ドラフト | /play から | 消さない（sub-directive だけ、自分が作った行を物理削除。e156bda） | 確定済みのお題 |
| 回答 | 作品の画面から | 消さない | 回答と、回答数・枠ごと・成績の集計 |
| 通報 | report / anon | report はサービスの鍵で消す。anon の通報は残る | 1件 |

6f4521a で、検査用の利用者の見分けかたが `scripts/_test-accounts.mjs` の1か所にまとまり、
`smoke:prod -- unseen` が増えた（別の作業線の変更。中身は読んでいない）。

### システム回答と実際の利用者

- **システム回答を呼ぶスモークは0本**（積む・取り出す・保存の窓口と待ち行列の名前は、どのスモークにも出てこない）
- 実際の利用者の作品に答える・いいねする・通報するスモークは0本。
  cutover だけは「次の作品」を開いた記録（usage_events）を、実際の利用者の作品に付けることがある

### D194〜D196 の確認との関係

- スモークは回答を作るので、集計の指紋が変わる。**だから停止条件の確認は、3本とも当て終わってから、スモークの前に済ませる**（4節の手順の順）
- スモークのあとで `check d196 --before s2.json --out s4.json` をもう一度流す。
  指紋はスモークの分だけ「判定できない」になる（終了コード 2）。
  見るのは「待ち行列が0行」「human 以外の回答が0」「積む道が DB に無い」の3つが ○ のままかどうか

### 物理削除と集計の既知の問題（D70・D123）とは切り分ける

- 集計の引き金は、回答が**入ったとき**にしか動かない（消えたときに減らす引き金は無い）
- 作品を物理削除すると、回答と作品ごとの集計は cascade で消えるが、答えた人の成績は残る
  （decisions.md:1250 の D70、smoke-sub-directive.mjs:726-727）。
  2026-09-12 の本番の片づけでも、この形の食い違いが残っている（0節の4項目）
- D194 が変えたのは「入ったときの引き金が、システム回答を数えない」ことだけ。
  消したときの動き・外部キーは1つも変えていない。
  そのため、スモークのあとの集計の残りは D70 の既知の問題であり、D194〜D196 の結果ではない。
  この切り分けができるように、停止条件はスモークの前に確かめ、構造検査は当てる前と後で比べる

---

## 7. 再現試験（使い捨ての PostgreSQL 17.6。本番へは接続しない）

### 作った環境

- PostgreSQL 17.6（embedded-postgres）。文字コード UTF8・照合 ICU en-US（本番と同じ en_US.UTF-8 / ICU）・SSL あり
  （db:apply:one は SSL で接続するため）
- 既定の権限（pg_default_acl）を、本番から読んだ値と1文字まで同じにした
- 本番と同じ60本（本番の履歴と版・名前が一致。違うのは 20260909180000 の名前だけで、
  これは本番の履歴側の既知の食い違い）を、本番と同じ順に当てた
- 履歴表には、本番の60行（版・名前・statements）を読み取りでそのまま写した
- DDL（部品を作る・変える・消す命令）を、段ごとに数える記録を置いた
- 人の回答だけのデータを入れた（回答16・取り込み9・除外1・ゲストの回答1）
- 道具: スクラッチパッドの `pg17/repro.mjs`（repo の外）

### 結果（版を振り直したあと。2026-09-12）

コミットの前に、作業木の中身をそのまま使って流した（68項目）。67項目が ○。
残る1項目は「clean checkout に変更が無い」で、まだコミットしていないのだから当然 ✗ になる。
コミットの後に、きれいな checkout からもう一度流す（その結果は報告と PROGRESS.md に書く）。

| 確かめたこと | 結果 |
|---|---|
| 当てる前の停止条件（pre） | ○ |
| 3本とも db:apply:one が成功し、それだけでは履歴に記録されない | ○ |
| repair --status applied が成功し、履歴の name がファイル名と一致 | ○ |
| 1本当てるごとに、履歴の最大がいま当てた版になる（61本・20260912110000 → 62本・20260912120000 → 63本・20260912130000） | ○ |
| 3段とも停止条件をすべて満たす | ○ |
| SQL 本体は1回だけ: apply の DDL の数が、同じファイルを1回当てたときと同じ（16 / 38 / 8） | ○ |
| repair は SQL 本体を流さない: repair の DDL は履歴表の中の2件だけで、外は0 | ○ |
| 3本のあとの部品の一覧が、素直に当てたものと完全に一致 | ○ |
| 63本の木から `db push --dry-run` が、`--include-all` なしで3本を順に当てる計画を出し、実際にそのまま当たる | ○ |
| repair が書いた name・statements が、db push が書いたものと完全に一致（3本とも） | ○ |
| 対照: 本番で db push が書いた 20260910210000 の行と、repair で書き直した行が完全に一致 | ○ |
| 危ない checkout（2節の表） | 表のとおりに振る舞った |
| 停止条件が本当に止まる（待ち行列に1行／authenticated に積む権限／回答数を1ずらす／D196 の関数を人に絞らない形へ戻す） | 4つとも終了コード 1 で止まった |
| 取り消しの安全条件（システム回答1件／待ち行列1行）で止まり、何も変わらない | ○ |
| 取り消しの順番を飛ばすと止まり、何も変わらない | ○ |
| D196 → D195 → D194 の順で戻すと、1本ごとに部品の一覧と数字の指紋が、その1本を当てる前と完全に一致し、1つ前の段の判定も通る | ○ |
| 3本とも戻したあとの履歴が、本番の60行と完全に一致 | ○ |

### CLI（supabase 2.111.0）の振る舞い（CLI の中身を読んで分かり、上の再現で確かめた）

- `repair --status applied`: 手元の `<版>_*.sql` を探し、ファイル名から name を、中身から statements を作って
  `insert … on conflict (version) do update set name, statements` で書く。**すでにある行は上書きされる**
- `repair --status reverted`: その版の行を消すだけ
- repair は migration の SQL を1文も流さない
- 3本とも本番の最大より新しいので、`db push` は `--include-all` なしで3本を順に当てる計画を出し、そのまま当てた

### merge の結果（案A の残り: origin/main 6f4521a へ onboarding を merge）

git merge-tree で計算した（ブランチは1つも動かしていない）。

- 衝突は文書5つ: `PROGRESS.md` / `README.md` / `docs/decisions.md` / `docs/launch-checklist.md` / `docs/test-layers.md`
  （fe642c3 のときは4つ。6f4521a が docs/decisions.md を書き換えたので1つ増えた）
- コードと migration の衝突は0。両側が触った `test/db/run.mjs` は自動で合わさった
- 解くときの件数（合わさった木の実測）: migration 63本、縦断試験 384、道具 37、単体 86、構造 211

合わさった木（版を振り直した3本を含む）を取り出して流した結果（2026-09-12）

| 試験 | 結果 |
|---|---|
| 縦断試験 | 384 / 384 |
| 道具の自己試験 | 37 / 37 |
| 単体試験 | 86 / 86 |
| 柵の自己試験 | 27 / 27（.env.local の無い場所なので 27） |
| アップグレード試験 | 31 / 31 |
| 構造検査（db:verify:local） | 211 合格 / 0 不合格 / 11 判定しない |
| 型検査・lint・build | 終了コード 0（lint の警告2件は smoke-cutover.mjs、以前から） |
| ブラウザ全件試験 | 130 / 130（17:20〜17:32 UTC。始める前の交換領域 12.8 / 13.3 GB、平均の混み具合 5.25） |

意味の衝突（文字は衝突しないが、組み合わせると壊れるもの）: 上の全試験が通った。
掃除の migration（20260911120000）が触る2関数は、D194〜D196 のどれにも出てこない。
合わさった木の migration の並びは 20260911120000 → 20260912110000 → 120000 → 130000 で、本番で当てる順と同じ。

---

## 8. 別の作業線への申し送り（p0-p5-production-integration）

ユーザーの指示（2026-09-12）は「commit前に20260912100000より後の未使用番号へ変更」と残すことだった。
しかし 20260911120000 はすでに commit され（9b451a1）、本番へ当たっている。
当たった migration の番号は変えない（ユーザー発言「renameしない。repairしない。rollbackしない。」）。

代わりに残すこと

- D194〜D196 は 20260912110000 / 20260912120000 / 20260912130000 を使う（D198）
- これから作る migration の番号は、20260912130000 より後の未使用番号にする（提案。まだ誰も承認していない）
- 番号を決める前に、本番の履歴・全作業木・全ブランチ・リモートを確かめる

---

## 9. この工程で触らないもの

- 20260909180000 の履歴の修復（D194〜D196 を本番へ着地させた後、別の工程で再現 → 本番で修復するかを判断）
- get_usage_summary（将来 C。システム回答の自動化を始める前に作る）
- 20260911120000（別の作業線のもの。本番適用済み）
- 課金・法務・provider・画面

---

## 10. 本番投入の最終チェックリスト（コピーして順に打つ）

**まだ実行していない。**各段の `stop/go` は、直前の道具の終了コードで決める。
0 なら次へ、1 なら止まって5節の取り消しを検討、2 なら人が見て決める、3 は接続の失敗。

```sh
# ─────────── PRE ───────────
cd <着地後の main の clean checkout>          # 2節の規則。他の作業木から打たない
git rev-parse HEAD                            # main の先端であること
git status --porcelain                        # 1行も出ないこと
ls supabase/migrations/*.sql | wc -l          # 63
ls supabase/migrations/*.sql | tail -4        # 20260911120000 / 20260912110000 / 120000 / 130000
shasum -a 256 supabase/migrations/2026091211*.sql supabase/migrations/2026091212*.sql supabase/migrations/2026091213*.sql
#   49e92761... / f35c9bcd... / 03b0bea0...  （D198 で確認した値）

D=~/dpq-landing; mkdir -p $D
npm run db:verify:keychain > $D/verify-before.txt   # 不合格は A8 / A21 / A24 / A32 の4項目だけ
node scripts/landing-d194-check.mjs check pre --out $D/s0.json      # → 0

# ─────────── D194（20260912110000 answer_source）───────────
npm run db:apply:one -- 20260912110000_answer_source.sql
npx supabase migration repair 20260912110000 --status applied --linked
node scripts/landing-d194-check.mjs check phase1 --before $D/s0.json --out $D/s1.json   # → 0 で次へ
#   履歴 61本・最大 20260912110000

# ─────────── D195（20260912120000 system_answer_queue）───────────
npm run db:apply:one -- 20260912120000_system_answer_queue.sql
npx supabase migration repair 20260912120000 --status applied --linked
node scripts/landing-d194-check.mjs check phase2 --before $D/s1.json --out $D/s2.json   # → 0 で次へ
#   履歴 62本・最大 20260912120000

# ─────────── D196（20260912130000 out_of_analysis_and_import）───────────
npm run db:apply:one -- 20260912130000_system_answer_out_of_analysis_and_import.sql
npx supabase migration repair 20260912130000 --status applied --linked
node scripts/landing-d194-check.mjs check d196 --before $D/s2.json --out $D/s3.json     # → 0
npm run db:verify:keychain > $D/verify-after.txt
diff <(grep "✗" $D/verify-before.txt) <(grep "✗" $D/verify-after.txt)                   # 差が0行
#   履歴 63本・最大 20260912130000

# ─────────── POST ───────────
npm run smoke:prod                             # 6節の副作用を読んでから
node scripts/landing-d194-check.mjs check d196 --before $D/s2.json --out $D/s4.json
#   待ち行列 0行 / システム回答 0件 / 既知4項目のほかに不合格 0

# ─────────── その後（別の承認）───────────
git push origin main
#   Vercel の deploy（自動）を待ち、本番の画面を1つ開いて確かめる
```

**db push は使わない。**3本を一括で当てると1本ずつ止まれない。
CLI が既存の 20260911120000 について `repair --status reverted` などを勧めてきても従わない
（あの行は別の作業線が本番へ当てたもの。触らない）。
