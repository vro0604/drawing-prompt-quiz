# 決定ログ

決めたことと、その理由を残す。あとで「なぜこうしたんだっけ」となったときに読む。

## 2026-08-03

### D1. MVPのモードは「お手軽3枚」「標準5枚」の2つだけ
本格8枚・フル10枚はカードスロットを足すだけで実装できる構造にしてあるため、後回しにできる。
まず一連の流れ（引く→描く→投稿→当てる）を通すことを優先する。

### D2. クイズはMVPでは3問固定
「3項目前後」だと集計テーブルと画面のパターンが増える。
`quiz_priority` で出題スロットを決める仕組みは可変対応済みなので、問数だけ後から緩められる。

### D3. 匿名IDは Supabase 匿名サインインを使う
自前でcookieに匿名IDを持つ方式に比べて、
- RLSを `auth.uid()` で一本化できる
- 新規アカウントへの昇格が「同じuidのまま」行われるので移行処理が要らない
代償として匿名ユーザーがMAUに計上されるため、30日での自動削除とCAPTCHAが必要。

### D4. 既存アカウントへの履歴統合はMVP後
uidが変わるため、衝突処理とカウンタ減算を含むトランザクションが必要になる。
初回リリースの複雑さに見合わないと判断した。MVPではログイン前に警告を出す。

### D5. 制作時間はカードではなくユーザーの選択
「10分で描く」は挑戦の設定であって、運任せにする対象ではない。
また `time_limit` を抽選対象から外すことで、タグプールの構造が単純になる。

### D6. タグプールとカードスロットを分離
`motif_a` / `motif_b` にそれぞれタグを登録すると、同じ「傘」を二重管理することになる。
プール（motif, color, ...）にタグを置き、スロットは「どのプールから引くか」だけを持つ。
これにより、同一プールを使うスロット間の重複排除も抽選時にまとめて処理できる。

### D7. 匿名のいいねを廃止
匿名はブラウザデータを消せば作り直せるため、いいねの水増しが容易。
人気ランキングの信頼性を優先し、いいね・保存・投稿を登録必須にした。
回答は「統計に厚みを出す」ことが目的なので匿名のままにする。

### D8. 未選択カードは自動開示しない
ドラフト直後に見せると「引かなかった方が良かった」という気持ちが先に来て、
描くモチベーションを削ぐ。描き終えた後・諦めた後・本人が望んだときだけ見せる。

### D9. リロールはドラフト全体で1回まで
無制限だと「当たりが出るまで回す」ゲームになり、正答率という指標の意味が薄れる。
0回（一発ドラフト）にもできるよう `ruleset` 列で制御する。

> **D19 で改訂**: `ruleset` 列は廃止し、`draft_modes.max_rerolls` で制御する。
> 一発ドラフトの持たせ方（モードにするか独立設定にするか）は未確定。

### D10. 回答履歴の公開は「正答数」までにする
`answer_items` には選択タグと正誤が両方入っているため、他人に見せると
`is_correct = true` の行からクイズの正解が判明してしまう。
公開設定に関わらず `answer_items` は本人限定とし、公開履歴はビューで正答数のみ出す。

### D11. 公開設定は3つとも初期値を非公開にする
何を保存したか・何を間違えたかは、本人が見せると決めるまでは見せない。

当初は成績（`show_answer_stats`）だけ初期値を公開にする案だったが、取りやめた。
この設定が公開するのは**そのユーザーがクイズ回答者として持つ成績**
（総回答数・総合正答率・分野別正答率）であって、
そのユーザーが投稿した作品の伝達率ではない。両者は別物。

ポートフォリオとして見せたい「作品がどれだけ伝わったか」は、
作品側の統計（`work_slot_stats`）として公開されるので、そちらで足りる。
回答者としての個人成績は本人が明示的にオンにしたときだけ公開する。

→ `show_answer_stats` / `show_answer_history` / `show_saved_works` すべて既定 `false`。

### D12. profiles は「完成した公開プロフィール」だけを見せる（spec 9-3 の変更）
当初は `profiles` の SELECT を全員に開放する想定だったが、匿名ユーザーの行まで
誰でも一覧取得できると、「いま何人がゲストで来ているか」「いつ発行されたか」が
外から数えられる。また、登録直後の handle 未設定の状態で中身の無いプロフィールが
他人の目に触れるのも避けたい。SELECT ポリシーを次の形にした。

```
(is_anonymous = false and handle is not null)   -- 公開してよいプロフィール
or auth.uid() = id                              -- 自分のものは常に見られる
```

### D13. profiles の書き込み経路を DB 側の1本に絞る
`is_anonymous` は D12 で閲覧範囲の判定に使うため、自己申告で変えられてはいけない。
当初は「JWT の値と一致する場合だけ書き込みを許す」検査関数を置いたが、
検査を足すより**書き込み経路そのものを無くす**ほうが確実だと判断した。

- INSERT ポリシーを作らない ＝ クライアントから行を作れない。
  行を作るのは `auth.users` の AFTER INSERT トリガーだけ
- `is_anonymous` の更新も `auth.users` の AFTER UPDATE トリガーだけが行う。
  匿名 → 正式登録の昇格に自動で追随する
- `grant update (...)` で本人が変更できる列を6つに限定する
  （`display_name` `bio` `links` `show_*` 3種）。
  RLS は行しか見ないため、handle の先取りを防ぐには列単位の権限が要る

結果として検査関数 `is_falsely_public` は不要になり、削除した。

---

## Step 3A（スキーマ設計の確定）で決めたこと

### D14. 識別子は text のキーで統一する
`card_slots` の主キーを数値 ID ではなく `card_slot_key`（text）にする。
マスタは行数が少なく性能差が無視できる一方、SQL やログを読んだときに
`motif_a` とそのまま読めることの価値が大きい。
`tag_pools.key` / `draft_modes.mode_key` も同じ方針。

### D15. クイズの選択肢数は candidate_count と独立させる
伏せカードの枚数（`candidate_count`）をモードごとに変えられるようにしたが、
クイズは **4択で固定**する。両者は別の体験であり、連動させると
「必要なタグ数」の計算が複雑になるうえ、モードによって難度が変わってしまう。

### D16. モードは「枠の構成」と「候補枚数」を別々に持つ
当初は「お手軽3枚／標準5枚」の数字が枠数と候補枚数のどちらを指すのか
曖昧だった。`draft_modes.candidate_count`（1枠あたりの伏せカード枚数）と
`draft_mode_slots`（使う枠の一覧）に分離し、両方をマスタに置く。

- easy = 3項目 × 候補3枚（motif_a / main_color / genre_type）
- standard = 5項目 × 候補5枚（motif_a / motif_b / main_color / species / genre_type）

`draft_candidates` も `card_slot_key`（枠）と `candidate_index`（枠内の位置）に分ける。
`advanced` / `full` は候補枚数が未確定なため、MVPでは行を登録しない。

### D17. MVPでは 1つのお題から作れる作品を最大1件にする
`works.prompt_id` に UNIQUE を張り、作れるのはお題の作成者本人だけとする。

理由は正解の保護。同じお題を複数人が描けるようにすると、
そのお題の内容を共有する必要が生じ、共有された時点でその全作品のクイズが成立しなくなる。

あわせて共有コード（`prompts.code`）と `get_prompt_by_code` を廃止した。
SNS共有は「作品ページ」または「お題カード画像」で行う。
同じお題を複数人が描くチャレンジ機能は、将来、通常のお題とは別の機能として設計する。

### D18. 時間は秒数の1列だけで持つ
`time_limit_type` と `time_limit_minutes` の2列に分けると、
「`custom` のときだけ分が入る」という取り扱いが全経路に波及する。
`time_limit_seconds`（null = 無制限）を唯一の正本とし、表示区分は画面側で導く。

保持するのは次の3つだけ。確定時に draft から prompt へコピーする。

- `draft_sessions.time_limit_seconds`
- `prompts.time_limit_seconds`
- `works.actual_time_seconds`

サーバータイマー（`uses_server_timer`）はMVPから削除した。
使う予定が立っていない列を先に作らない。

### D19. ruleset 列を廃止し、max_rerolls で制御する
引き直し回数は `draft_modes.max_rerolls` が持ち、セッション開始時に写しを保存する。

ただし**一発ドラフトをモードとして追加することは確定しない**。
「お手軽・一発」「標準・一発」のようにモードが倍増する形は避けたい。
モードとは独立した引き直し設定として持つ案を含め、実装時に改めて設計する。

### D20. 機密テーブルは権限そのものを与えない
`draft_candidates` / `prompt_cards` / `quiz_questions` / `quiz_choices` / `reports` は、
RLS ポリシーを作らないことに加えて `anon` / `authenticated` への `grant` を一切行わない。

ポリシーの有無だけに頼ると、誰かが「読めないので」とポリシーを1本足した瞬間に
機密が開く。権限が無ければポリシーを足しても読めない。

`quiz_questions` を新たに機密へ移したのは、「どのお題のどの枠が出題されているか」
自体が推測材料になるうえ、クライアントは `get_work_quiz` だけを使うため
直接読む必要がないから。

### D21. tags の weight は公開しない
公開取得で返すのは `id` / `pool_key` / `label` の3列だけ。
`weight`（出やすさ）が見えると「このタグは重みが小さいから正解ではなさそう」
といった推測ができてしまう。`is_active` は RLS の条件で使い、列自体は返さない。

### D22. 公開ビューを作らず、すべて RPC に統一する
ビューは作成者の権限で動くため、下のテーブルの RLS を素通りしうる。
`security_invoker` の指定を忘れると即座に穴になる。

決め手は `prompt_id` の隠蔽。クイズと作品を結ぶビューを作ると
`prompt_id` を含めざるを得ず、D23 の要件を満たせない。
`work_id` を引数に取る RPC なら内部で解決して外に出さずに済む。

`public_quiz_view` → `get_work_quiz(work_id)`、
`public_answer_history` → `get_public_answer_history(user_id)` に置き換える。
最終判断は Step 3C で行う。

### D23. works は直接読ませず、4つの取得 RPC に分ける
`works.prompt_id` が漏れると、作品からお題へ辿って正解に到達できてしまう。
列単位で隠す方法もあるが、取得経路が増えるたびに隠し忘れる危険がある。
テーブルへの権限を与えず、返す内容を関数側で固定する。

- `get_public_works` / `get_work_detail` … 誰でも。
  `is_published = true` かつ `review_status = 'ok'` かつ `deleted_at is null` のみ
- `get_my_works` / `get_my_work` … 本人のみ。非公開・審査中・削除済みも含む

いずれも `prompt_id` を返さない。
SELECT 権限が無いと `update ... where id = ?` も書けないため、更新も
`update_work` RPC に統一する。

### D24. カウンタ列はキャッシュとして扱う
`likes` の行を正本とし、`works.likes_count` はトリガーで同期するキャッシュとする。
`saves_count` / `answers_count` も同じ。ずれた場合は元の行を数え直せば復旧できる。

### D25. actual_time_seconds は公開前だけ変更できる
投稿直後の書き間違いは直せるべきだが、公開後に変えられると
表示されている実績が後から書き換わる。公開前に限って本人が修正できる。

**時間別ランキングの分類基準には使わない。** 分類は
`prompts.time_limit_seconds`（お題を引いた時点で確定している制限時間）で行う。
`actual_time_seconds` は作品ページに出す自己申告の補助情報という位置づけ。

### D26. likes の行は本人しか読めない
公開するのは `works.likes_count` だけ。「誰がいいねしたか」を見せる機能は
MVPに含めない。誰が何を好んだかは本人が明示的に見せると決めるまで出さない
（D11 と同じ考え方）。人気ランキングの集計はサーバー側で行うため支障はない。

### D27. create_work は6つの検査を必ず通す
```
1. 登録済みユーザーであること（JWT の is_anonymous が false）
2. 対象 prompt の作成者本人であること
3. prompt が完成済みであること（status = 'active'）
4. その prompt がまだ別の作品に使われていないこと
5. division と source_title / source_character / fanart_note が整合していること
6. image_path が本人の Storage 領域を指していること
```
4はDBの UNIQUE でも守られるが、エラーメッセージを分かりやすくするため関数側でも見る。
6を入れないと、他人のフォルダのパスを指定して他人の画像を自作として掲載できてしまう。

### D28. 作者は自作のクイズに回答できない
`submit_answer` が作品の作者本人を拒否する。
作者は答えを知っているため、回答すると正答率の統計が歪む。
DBの制約では表現できないので RPC 側で強制する。

---

## Step 3B-1（マスタ5表）で確認できたこと

### D29. RLS ポリシーは、利用者に列権限が無い列も条件に使える（実地検証済み）
`draft_modes` は `is_active` の列権限を `anon` / `authenticated` に与えていないが、
SELECT ポリシーの条件には `is_active = true` を使っている。
この組み合わせが正しく働くかは事前に確証が無かったため、
3B-1 の実行時に `set local role anon` で実際に確かめた。

```
結果: anon から select mode_key, label, candidate_count → easy と standard の2行が返った
      anon から select weight from tags       → ERROR 42501: permission denied
```

**分かったこと**

- ポリシーの条件式に使う列と、利用者が読める列は independent。
  「絞り込みには使うが値は見せない」列を作れる
- 列権限は利用者が書いたクエリに対して効く。ポリシーの内部評価には効かない

**この事実に依存する設計**（以降の工程でも同じ形を使う）

- `tags` … `is_active` で絞り込むが値は返さない
- `works` … `is_published` / `review_status` / `deleted_at` で絞り込むが、
  他人にはこれらの値を返さない（D23）

### D30. 列単位の grant を使うと `select *` が権限エラーになる
`grant select (列名, ...)` で列を絞ると、`select *` は「読めない列を含む」ため
`permission denied for table ...` になる。データが一部だけ返るのではなく、
クエリ全体が失敗する。

アプリ側では列名を必ず列挙する。

```
NG:  .from("tags").select("*")
OK:  .from("tags").select("id, pool_key, label")
```

Step 2 の `profiles` は表全体に SELECT を与えているため `*` が使える。
この差は混乱しやすいので、コード側にも注意書きを残す。

### D31. 「読めない」には2種類ある（当初の記述の訂正）
当初は機密テーブルを直接SELECTすると「0件が返る」と書いていたが、これは誤り。
拒否のされ方は2種類あり、区別しないと動作確認の判定を誤る。

| 状態 | 結果 |
|---|---|
| **テーブル権限を与えていない** | `permission denied for table ...`（エラー。42501） |
| **権限はあるがRLSが行を除外** | **0件**（エラーにならない） |

- `draft_candidates` `prompt_cards` `quiz_questions` `quiz_choices` `works` `reports`
  … 権限なし → **エラー**
- `profiles` `tags` `draft_modes` `answer_items` `likes`
  … 権限あり＋RLSで絞る → **0件**

動作確認では「エラーが出るのが正解」の場面と「0件が正解」の場面がある。
3B-1 の確認でも、`tags.weight` は 42501 エラー、`draft_modes` は2行という
異なる結果をそれぞれ正解として確認した。

---

## Step 3B-2a（ドラフト2表）で決めたこと・確認できたこと

### D32. `is_chosen` と `revealed_at` を分ける
「選ばれたか」と「中身が本人に見えたか」は別の事実。1つの列で兼ねると
未選択カードの後日開示（spec 4-4）を表現できない。

| 状況 | `is_chosen` | `revealed_at` |
|---|---|---|
| めくって選んだ | `true` | めくった時刻 |
| 選ばなかった（開示前） | `false` | `null` |
| 選ばなかった（後日開示した） | `false` | 開示した時刻 |

CHECK で「選んだのに見ていない」状態を作れないようにする。

あわせて `draft_candidates.slot_order`（開始時点の枠の提示順）も持たせる。
`draft_mode_slots` の並び順は将来変更され得るため、写しが無いと
後日の開示で当時と違う順番になる。

### D33. `updated_at` の自動更新には `clock_timestamp()` を使う
`now()` は**トランザクション開始時刻**を返すため、同じトランザクション内で
INSERT と UPDATE を行うと `created_at` と `updated_at` が同値になる。
RPC は1つのトランザクションで複数の更新を行うので、これでは
「最後に操作した時刻」として機能せず、30日掃除の基準が壊れる。

`clock_timestamp()` は呼んだ瞬間の実時刻を返すのでこの問題が起きない。
`created_at` 側は `now()` のままでよい（`clock_timestamp()` は必ずそれ以降に
なるため `updated_at >= created_at` の CHECK と矛盾しない）。

更新はトリガーで行う。RPC の中に書くと、書き忘れても**エラーにならず静かに壊れる**。
関数名は表専用（`draft_sessions_set_updated_at`）にして、
各工程の取り消しSQLが独立して動くようにする。

### D34. RLS の動作確認には JWT クレームの設定が要る（実地検証済み）
`set local role authenticated` だけでは `auth.uid()` が null のままで、
「本人の行だけ見える」ことの確認にならない。行が0件でも、それが
RLS のせいか表が空なだけかを区別できない。

`auth.uid()` は JWT の `sub` を読む関数なので、SQL Editor では手で設定する。

```sql
select set_config('request.jwt.claim.sub', '<profiles.id>', true);
set local role authenticated;
```

3B-2a ではこの方法で、本人 → 1行 / 別人 → 0行 を確認した。
以降の工程でも、RLS を持つ表はこの形でテストする。
`set_config(..., true)` の第3引数 true はトランザクション内限定の意味で、
`rollback` すれば設定も行も残らない。

### D35. works / answers / answer_items は完全遮断し、回答履歴は他人へ公開しない

`works` に SELECT 権限を与えないため（D23）、`answers` だけ直接読ませても
「どの作品への回答か」を辿れず、結局RPCが要る。取得条件を一系統にするため
両方とも遮断する。`answer_items` は `selected_tag_id` と `is_correct` を
併せ持つため元から機密。

回答履歴（誰がいつ何に答えたか）は `show_answer_stats` で公開する集計値とは別の
**個人の行動履歴**であり、MVPでは他人へ公開しない。`get_public_answer_history` は作らない。

- 本人：`get_my_answers` / `get_my_answer`
- 他人へ見せるもの：`user_stats` / `user_slot_stats` の集計値だけ

### D36. work_slot_stats も直接公開しない

§9-3 では当初「全員 SELECT 可」としていたが、2つの理由で遮断へ変更した。

1. **正しい公開条件が書けない。** 「公開中の作品だけ」を条件にするには RLS の中で
   `works` を読む必要があるが、`works` には権限が無いため
   **ポリシーの評価時点で permission denied になる**（ポリシー内の select は
   呼び出した人の権限で実行される）。
2. **無条件公開は情報が漏れる。** 作品IDを総当たりすれば
   「この非公開作品には50件の回答がある」と読めてしまう。

伝達率・枠別正答率は `get_work_detail` / `get_my_work` の返り値に含める。

### D37. user_stats / user_slot_stats は anon からも読める

統計の閲覧に登録も匿名サインインも不要とする（ページ訪問だけで匿名アカウントを
作らない方針のため）。したがって `authenticated` だけでなく `anon` にも
SELECT を与える。

| ロール | 見える行 |
|---|---|
| `anon` | `is_anonymous = false` かつ `show_answer_stats = true` の人の行 |
| `authenticated` | 本人の行、または上記の行 |

ポリシーは `profiles` を参照するが、`profiles` には anon にも SELECT 権限があり
公開プロフィールは anon から読めるため、この参照は成立する（実地検証済み）。

### D38. 集計3表の更新はトリガーに一本化し、3B-3a では作らない

`work_slot_stats` / `user_stats` / `user_slot_stats` には
INSERT / UPDATE / DELETE をどのロールにも与えない。更新するのは Step 9 の
回答RPCに付けるトリガーだけ。

トリガーを 3B-3a で先に作っても、回答を入れる手段が無いため動作確認できず、
Step 9 で作り直しになる。**3B-3a 完了時点で集計3表が空なのは意図した状態**。

### D39. likes / saves / reports も完全遮断する

`likes` / `saves` が持つのは `work_id` だけで、作品名や画像を出すには `works` が要る。
その `works` に権限が無い（D23 / D35）以上、どのみち RPC を通ることになるため、
経路を1本に統一する。

`saves` の公開（`show_saved_works = true`）をポリシーで書くと、D36 と同じ問題
（作品IDの総当たりで非公開・削除済み作品の存在が漏れる）が起きる。公開判定は
`get_public_saves` RPC が行う。

`reports` は D20 のとおり元から機密。誰が何を通報したかは当事者にも見せない。

**通報は匿名ユーザーもできる。** D7 で登録必須にしたのは投稿・いいね・保存であり、
通報は権利侵害の申告経路なので、登録を必須にすると通報されにくくなる。

これで21表のうち **11表が完全遮断**（`draft_candidates` / `prompt_cards` /
`quiz_questions` / `quiz_choices` / `works` / `answers` / `answer_items` /
`work_slot_stats` / `likes` / `saves` / `reports`）、
権限を持つのは10表（`profiles` / マスタ5表 / `draft_sessions` / `prompts` /
`user_stats` / `user_slot_stats`）となった。

---

## 公開前の必須課題

MVPでは実装しないが、**一般公開の前に必ず決着させる**もの。

### P1. 退会・アカウント削除
現在はユーザー削除を RESTRICT にしており、作品を持つユーザーは削除できない。
一般公開するなら退会手段は必須。次を決める必要がある。

- 退会時に作品をどうするか（全削除／非公開化／匿名化して残す）
- 作品を消した場合、その作品への回答と `work_slot_stats` をどう扱うか
- 回答者としての記録（`user_stats`）をどうするか

### P2. 匿名化
「アカウントは消すが作品は残したい」という要望への対応。
`works.user_id` を専用の退会済みユーザーへ付け替える案などを検討する。

### P3. 作品の扱いに関する規約
上記の挙動を利用規約に明記する。何が消え、何が残るかを投稿前に示す。

### P4. 持ち主のいないお題の掃除（Step 16 で実装）

`prompts.created_by` は ON DELETE SET NULL のため、ゲストが掃除されると
**誰のものでもないお題**が残る。この行は RLS の `auth.uid() = created_by` が
真にならないため誰からも見えず、放置すると増え続けるだけになる。

**削除対象は次を「すべて」満たす `prompts` に限る**

1. `created_by is null`（持ち主がいない）
2. `works` から参照されていない（作品が付いていない）
3. `status in ('active', 'abandoned')`

`prompts` を削除すれば `prompt_cards` / `quiz_questions` / `quiz_choices` は
ON DELETE CASCADE で一緒に消える。

**`status = 'submitted'` なのに `works` が無い行は、通常の掃除では削除しない。**
投稿済みのはずの作品が失われている状態であり、原因を調べる必要がある。
これは Step 3E の診断 A5（spec.md §13-2）で検出する。

`prompts_orphan_cleanup_idx (status) where created_by is null` を
004 の時点で張ってあるため、対象の抽出は速い。
