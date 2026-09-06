# 本番適用前の事前監査（2026-09-06）

この文書が**正本**である。次の4つはここにしか書かない。他の文書からはここへ入る。

1. 本番DBを読むだけで測った実測値
2. 新旧の互換表（旧い画面と新しいDBを組み合わせたときに何が起きるか）
3. 未適用 migration 18本の影響表（破壊・更新の全件）
4. ロックと所要時間の見立て

適用手順とロールバック手順は `docs/prod-runbook.md`（別の正本）にある。

測った日: 2026-09-06 ／ 測った方法: `npm run db:audit:prod`（読むだけ）
この監査では**本番へ1文字も書いていない。**`begin transaction read only` の中で
すべて実行し、最後は commit ではなく rollback で閉じている。

---

## 0. 言葉

この文書で繰り返し出てくる3つだけ、先に決めておく。

- **旧い画面** … いま Vercel で動いている、Git に取り込み済み（HEAD）のコード。
- **新しい画面** … 作業ツリーにある、まだデプロイしていないコード。
- **DB先行** … 本番へは「DBを先に更新し、そのあと画面を差し替える」順で当てる。
  この順である以上、**旧い画面と新しいDBが同時に動く時間帯が必ずできる。**
  その時間帯を壊さないことが、この監査の目的である。

---

## 1. 本番の実測（2026-09-06）

### 1-1. migration の履歴

| 項目 | 実測 |
|---|---|
| 本番に入っている migration | 22 本 |
| 手元のファイル | 40 本 |
| 本番に未適用 | **18 本** |
| 本番にあるが手元に無い（欠番） | 0 本 |
| 同じ version で**名前**が違うもの | 0 本 |
| 同じ version で**本文**が違うもの | **判定していない**（下記） |
| 履歴と実スキーマのずれ | **0**（下記 1-3） |

「18本」は本番の履歴表 `supabase_migrations.schema_migrations` を数えた結果であり、
手元の差分から推定した数ではない。未適用の18本は次のとおり。

```
20260904090000_draw_categories                20260905090500_draft_expiry_guards
20260904091000_draw_vocabulary_seed           20260905091000_carry_scopes
20260904092000_carryover                      20260905092000_vocab_readings
20260904093000_two_stage_draft                20260905093000_renewal_history
20260904094000_time_overrun_renewal           20260905094000_carry_slots
20260904095000_flavor_text                    20260905095000_d165_all_words_quiz
20260904096000_usage_events                   20260905096000_vocab_provenance
20260904097000_next_work_and_cleanup          20260905097000_mode_split_and_color_kind
20260905090000_challenge_clock                20260906090000_d169_next_work_division_and_unanswered
```

適用済みの22本は `20260803013433_baseline_applied_schema` から
`20260808200000_legal_v1` まで。version も名前も手元のファイルと1つずつ一致する。

**同じ version で本文が違うかは、この監査では判定していない。**
本番側は SQL を「文の配列」として保持していて、手元のファイルと同じ形に
揃えられないため。version の一致・名前の一致・欠番の有無までを確かめた。

### 1-2. 既存データの件数（本文・個人情報は取っていない）

| 対象 | 件数 |
|---|---|
| profiles | 622 |
| そのうち匿名（auth.users.is_anonymous） | 11 |
| prompts | 995 |
| prompts / status = active | 106 |
| draft_sessions | 974 |
| works | 889 |
| works / 公開 | **0** |
| works / 未削除 | **0** |
| works / 公開かつ審査OKかつ未削除 | **0** |
| answers | 648 |
| answer_items | 1,944 |
| tags | 156（最大id 202） |
| draft_modes | 2 |
| saves | 96 |
| prompt_cards | 3,803 |
| quiz_questions | 2,985 |
| work_slot_stats | 915 |

部門別の公開作品数は**全部門0件。**回答0件帯・回答1件以上帯も0件。
出題が3問（旧方式）の作品は 889 件。
`draft_sessions.quiz_question_count` は NULL 0 ／ 3 が 974 ／ 3以外 0。
`draft_modes.quiz_question_count` は NULL 0 ／ 3 が 2 ／ 3以外 0。

有限時間のお題は、いま active が 106 件、うち7日より古い未投稿が 104 件。
**この104件に期限を遡って入れることは、今回の migration では行わない**
（遡及は `supabase/manual/` に分離してある。実行するかは別の判断）。

持ち出し関連表（carry_slots / saved_elements）とフレーバー関連表
（prompt_flavor / flavor_replies）、usage_events、draw_categories、
draft_session_slots、prompt_renewals は**どれも本番に存在しない。**今回作る。

### 1-3. 履歴と実スキーマのずれ（0件）

「22本入っている」という履歴を信じるだけでは足りない。
**その22本を当てた姿が、本当に本番に出来ているか**を突き合わせた。
比べる相手は、PGlite に追跡済み22本だけを当てて作ったDBである。

| 比べたもの | 本番に足りない | 本番にだけある |
|---|---|---|
| 関数（署名単位。68本） | 0 | 0 |
| 表（29個） | 0 | 0 |
| 列（193個） | 0 | 0 |

**ずれは1つも無い。**手で当てた SQL も、履歴だけ進んで中身が入っていない箇所も
見つからなかった。

### 1-4. drop する関数への依存（0件）

今回の束が drop する関数のうち、本番に実在するのは
`start_draft(text,int)` だけ（残り4本はこの束の中で作った関数なので空振り）。
これに依存しているオブジェクトは0件。**drop が依存で失敗することは無い。**
`get_public_works(text,text,int,int,text)` も依存0件だが、**今回は drop しない。**

### 1-5. 置き換える関数の署名・持ち主・権限（本番の現在値）

すべて owner = postgres、SECURITY DEFINER、PUBLIC からの実行権限は無し。
`search_path` も全件で設定済み。**同名で引数だけ違う関数は、いま本番に1本も無い。**

| 関数（本番の現在の署名） | 既定値の数 | anon | authenticated |
|---|---|---|---|
| `get_public_works(text,text,int,int,text)` | 5 | ○ | ○ |
| `get_rankings(text,text,text,int,int)` | 5 | ○ | ○ |
| `start_draft(text,int)` | 1 | × | ○ |
| `complete_draft(uuid)` / `reroll_draft(uuid)` / `reveal_card(uuid,text,int)` | 0 | × | ○ |
| `submit_answer(uuid,jsonb)` | 0 | × | ○ |
| `get_work_quiz(uuid)` / `get_work_detail(uuid)` / `get_public_profile(text)` | 0 | ○ | ○ |
| `get_my_answer(uuid)` / `get_my_work(uuid)` / `get_my_work_result(uuid)` | 0 | × | ○ |
| `draft_state_json(uuid)` / `cleanup_status()` / `answer_items_after_insert_stats()` | 0 | × | × |

`get_next_work` と `next_work_candidates` は**本番にまだ存在しない。**

### 1-6. RLS

29 表すべてで RLS が有効。無効の表は0。

今回**新しく足すポリシーは1件だけ**で、対象は今回作る `draw_categories`
（本番にまだ無い表）である。**既存の表のポリシーは1つも足さず、変えず、消さない。**
したがって「RLS を足したせいで旧い画面の操作が拒まれる」ことは起きない
（実測: `npm run audit:schema-diff` のポリシー差分が「消えた0／増えた1／変わった0」）。

### 1-7. 当てる前の当たり判定（既存の行が新しい決まりに違反しないか）

| 見たもの | 実測 | 判定 |
|---|---|---|
| `prompts.started_at` を埋められない行（created_at が無い） | 0 | 通る |
| `draft_sessions.started_at` を埋められない行 | 0 | 通る |
| `card_slots` で優先度 24〜47 を既に使っている行 | 0 | ずらす対象なし |
| `card_slots` に `color_1..3` が既にある | 0 | 衝突なし |
| `card_slots` に `morph_1` が既にある | 0 | 衝突なし |
| `answers` で回答項目が1つも無い行 | 0 | 埋め残しなし |
| `answers` で `correct_count` が項目数を超える行 | 0 | 範囲違反なし |
| `work_slot_stats` で corrects > attempts の行 | 0 | 範囲違反なし |
| `user_slot_stats` で corrects > attempts の行 | 0 | 範囲違反なし |
| `tags` の次の番号（203）が既存の最大id（202）と衝突するか | しない | 通る |
| `draft_modes` に normal / hard が既にある | 0 | 衝突なし |
| `prompts` に status='failed' の行が既にある | 0 | 衝突なし |

追加予定の表21個・列177個のうち、**本番に既にある名前は0個。**

---

## 2. 新旧の互換表

「旧い画面＋新しいDB」を壊さないことが最低条件である。
比べたのは HEAD のコードと作業ツリーのコードで、DBの側は
`npm run audit:schema-diff` が2つのDBを実際に作って突き合わせた結果を使っている
（推測ではなく実測）。

### 2-1. 実測で見つかった差（DBの側）

| 種類 | 消えた | 増えた | 変わった |
|---|---|---|---|
| 関数（署名単位） | 1（`start_draft(text,int)`） | 53 | 0 |
| 表 | 0 | 21 | 0 |
| 列 | 0 | 177 | 1（`draft_sessions.quiz_question_count` が NULL 可へ） |
| 制約 | 1（同列の NOT NULL） | 262 | 4（どれも許す値が増える向き） |
| ポリシー | 0 | 1 | 0 |
| トリガー | 0 | 9 | 0 |
| jsonb の鍵 | **0** | — | — |

「変わった 0」は、**両方のDBに在る関数について、返す型も権限も
SECURITY DEFINER も search_path も1つも変わっていない**という意味である。

### 2-2. 呼び出しごとの互換表

○＝通る ／ △＝通るが振る舞いが変わる ／ ×＝失敗する

| 呼び出し | 旧画面＋旧DB | 旧画面＋新DB | 新画面＋旧DB | 新画面＋新DB | 対策 |
|---|---|---|---|---|---|
| `get_public_works`（5引数） | ○ | ○ | 呼ばない | 呼ばない | 旧5引数版を**互換ラッパーとして残した**（当初は drop する内容だった） |
| `get_public_works`（6引数） | 呼ばない | 呼ばない | × 関数が無い | ○ | 新6引数版は**既定値を1つも持たない。**5引数の呼び出しと行き先が割れない |
| `get_next_work`（2引数） | 旧画面は呼んでいない | ○ | 呼ばない | 呼ばない | 互換ラッパーを置いた（部門引数は受け取るだけで使わない） |
| `get_next_work`（1引数） | — | — | × 関数が無い | ○ | — |
| `next_work_candidates(uuid)` | — | — | × 関数が無い | ○ | — |
| `start_draft`（名前付き2個） | ○ | ○ | — | — | 3引数版の3番目に既定値があるので、2個でも行き先が1つに決まる |
| `start_draft`（名前付き3個） | — | — | × | ○ | — |
| `submit_answer(uuid, jsonb)` | ○ | ○ | × 2択の列が無い | ○ | 新実装は `tag_id_2` を任意項目として読む。旧い形（`tag_id` だけ）はビタ当てとして通る |
| `get_work_quiz` / `get_my_answer` / `get_my_work_result` | ○ | ○ | △ | ○ | 返す鍵は1つも減っていない（実測） |
| `get_current_draft` → `draft_state_json` | ○ | ○ | △ | ○ | 旧い鍵 `quiz_question_count` を**互換期間だけ返し続ける** |
| `draft_modes` を表から直に読む（`quiz_question_count` 込み） | ○ | ○ | 読まない | 読まない | 列を**落とさず**、列の読み取り権限も外さない |
| `get_work_detail` / `get_public_profile` / `get_rankings` / `get_user_works` / `get_saved_works` / `get_public_answers` | ○ | ○ | ○ | ○ | 署名も返す列も変わらない |
| 掃除の7本（`cleanup_*` / `list_*` / `mark_*` / `finish_*` / `fail_*` / `enqueue_*`） | ○ | ○ | ○ | ○ | 18本のどれも再定義していない。`cleanup_status` だけ数え方が1項目増える（鍵は減らない） |
| `profiles` を `select *` で読む | ○ | ○ | ○ | ○ | profiles に列を1つも足していない |
| `account_deletions` / `storage_cleanup_queue` の直接更新 | ○ | ○ | ○ | ○ | 列も権限も変えていない |
| Storage（`works` バケットの upload / remove） | ○ | ○ | ○ | ○ | DB側の変更と無関係 |
| 認証・匿名判定（`auth.uid()` / `is_anonymous`） | ○ | ○ | ○ | ○ | 変えていない |
| OGP 画像（`opengraph-image`） | ○ | ○ | ○ | ○ | 使うのは `get_work_detail` だけ |
| Cron `/api/cron/cleanup` | ○ | ○ | ○ | ○ | 呼ぶ RPC の署名も権限も変わらない |
| スモークが直に叩く経路 | ○ | ○ | ○ | ○ | HTTP と RPC の両方とも上の行に含まれる |
| 作品の投稿（`create_work`） | ○ | **△** | ○ | ○ | 下の 2-4 に書いた。**唯一、互換化しきれない箇所** |

### 2-3. 何を直したか（この作業で入れた互換の仕掛け）

1. **`get_public_works` の旧5引数版を残した。**
   当初の 20260906090000 は旧5引数版を drop していた。drop すると、
   DBだけ先に更新した時間帯に旧い画面の作品一覧が丸ごと落ちる。
   旧5引数版は `create or replace` で中身だけ差し替え、
   新6引数版を `p_unanswered_only = false` で呼ぶだけにした。
   **返す21列も、既定値も、権限も、関数のOIDも変わらない。**

2. **新6引数版から既定値を全部外した。**
   ここが要である。Postgres は既定値つきの引数を「数」に入れて呼び先を選ぶ。
   6引数版の6番目に既定値を付けたまま5引数版と並べると、
   5引数の呼び出しが**両方に当てはまり、`function is not unique` で
   新旧どちらの画面も落ちる**（PGlite 上で実測した）。
   また Postgres は「既定値のある引数の後ろに、既定値の無い引数」を許さない
   （実測: `42P13 input parameters after one with a default value must also
   have defaults`）ので、6番目だけ外すこともできない。
   **6つとも既定値を持たない**形にして、引数5個以下は旧版、6個は新版、と
   行き先が重ならないようにした。

3. **`get_next_work` の旧2引数版を、部門を使わないラッパーとして置いた。**
   2番目の引数は受け取るが、条件にも変数にも一切使わず、新1引数版へ素通しする。
   部門は新版が現在の作品の行から取る。だから**旧い画面から部門を改ざんしても、
   返るのは同じ部門の作品**になる（D169 の12を DB 側で守る）。
   既定値は付けていない（付けると引数1個の呼び出しが曖昧になる）。

4. **D165 の列削除を、今回の適用束から外した。**
   `draft_sessions.quiz_question_count` と `draft_modes.quiz_question_count` を
   落とす2行を消し、`comment on column` で「互換期間だけ残す旧列」と明記した。
   読み取り権限（`draft_modes` の列権限）からも外していない。
   旧い画面がモード一覧でこの列を読んでいるため
   （実測: HEAD の `src/features/draft/rpc.ts` が
   `select mode_key, label, candidate_count, max_rerolls, quiz_question_count,
   sort_order` を投げている）。

5. **`draft_sessions.quiz_question_count` の NOT NULL だけ外した。**
   この列は NOT NULL で既定値が無く、新しい `start_draft` は値を入れない。
   残したままだと**投入が失敗する。**そこで NOT NULL を外した。
   既存の行の値は1つも書き換えていない。D165 以後に作られる行は NULL になり、
   「この方式では使っていない」ことがそのまま残る。適当な数を入れて
   使っているように見せることはしない。

6. **`draft_state_json` の旧い鍵 `quiz_question_count` を残した。**
   旧い画面は二重送信で衝突したときに、進行中のドラフトと始めようとした条件が
   同じかをこの値で見比べている。鍵を消すと比較が必ず不一致になり、
   合流できるはずの場面で案内文が出る。値の出どころは `draft_modes` にしてある
   （旧い画面が比べる相手も `draft_modes` なので、比較は今までどおり成立する）。
   **この値は出題数の決定にも採点にも使っていない。**

### 2-4. 互換化しきれない箇所（1つある）

**作品の投稿が、制作の期限を過ぎていると弾かれることがある。**

- 何が起きるか …
  新しいDBには `works_guard_prompt_deadline_trigger` と
  `prompts_set_initial_deadline_trigger` が入る。DB更新のあとに
  **新しく引かれたお題**には期限（`deadline_at`）が付く。
  旧い画面には制作タイマーも更新ボタンも無いので、
  利用者は期限があることを知らないまま描き続ける可能性がある。
  期限＋猶予（0.5T）を過ぎてから投稿すると、投稿が拒まれる。
- 壊れる画面 … 作品の投稿画面（旧い画面のみ）
- 壊れる時間 … DB更新から新しい画面のデプロイ完了まで、かつ
  その時間内に**新しくお題を引いた人**に限る。
  既存の 106 件の active なお題には期限を入れないので、そちらは影響を受けない。
- データの損失 … 無い。失敗するのはお題の状態だけで、works にも Storage にも触れない。
- 必要な保守状態 … **DB更新とデプロイを続けて行い、間を空けない。**
  制限時間 T は 30〜60 分が既定なので、期限＋猶予は 45〜90 分。
  デプロイが数分で終われば、この窓に入る利用者はまず出ない。
- なぜ消せないか … 期限を付けないようにすると、この機能そのものが入らない。
  「旧い画面のために新機能を無効にしておく」なら、それは別の判断であり、
  ユーザーの承認が要る。**私の判断では止めない。**

これ以外に、互換化できなかった箇所は無い。

---

## 3. 未適用 18本の影響表

数え方は `npm run audit:migration-ops`。
**当てた瞬間に走る文**と、**関数の定義に書かれているだけの文**を分けて数えている。

### 3-1. 当てた瞬間に走る、破壊・更新にあたる文（全件）

| migration | 操作 | 対象 | 既存行への影響 | 可逆性 | 互換対策 |
|---|---|---|---|---|---|
| 20260904090000 | DROP POLICY | `draw_categories` のポリシー | 表そのものが今回作るもの。0行 | 直後に作り直す | 冪等のための空振り |
| 20260904090000 | UPDATE | `tags` | 156行。分類（pool_key）を新体系へ移す。**行は消さない・idも変えない** | 逆SQLで戻せる | 旧タグの削除・分類変更はしない（上書きは pool のみ） |
| 20260904090000 | UPDATE | `draft_modes` | 2行。`easy` / `standard` を `is_active = false` にする。**行は消さない** | 逆SQLで戻せる | 旧い画面のモード一覧は `is_active` で絞っていないので表示は変わらない |
| 20260904091000 | DROP TABLE | `_vocab_before` | 同じ migration が作る一時控え。本番に無い | — | 空振り |
| 20260904091000 | UPDATE ×3 | `tags` | 156行。読みと類義グループを埋める | 逆SQLで戻せる | 追加情報だけ。既存の label / id / pool は触らない |
| 20260904093000 | DROP FUNCTION | `start_draft(text,int)` | 関数1本 | 逆SQLで戻せる | 3引数版の3番目に既定値があるので、旧い画面の2引数呼び出しはそのまま通る |
| 20260904094000 | DROP TRIGGER ×2 | `works` / `prompts` | 本番に無いトリガー | — | 空振り（直後に作る） |
| 20260904095000 | DROP TRIGGER ×2 | `answers` / `answer_items` | 本番に無いトリガー | — | 空振り（直後に作る） |
| 20260905090000 | DROP TRIGGER ×4 | `draft_sessions` / `prompts` | 本番に無いトリガー | — | 空振り（直後に作る） |
| 20260905090000 | UPDATE | `draft_sessions` | 974行。`started_at` を埋める（created_at 由来） | 列ごと落とせば戻る | 旧い画面はこの列を読まない |
| 20260905090000 | UPDATE | `prompts` | 995行。`started_at` を埋める | 同上 | 同上 |
| 20260905090000 | SET NOT NULL ×2 | `draft_sessions.started_at` / `prompts.started_at` | 直前の UPDATE で全行埋まる。**埋め残し0件を本番で実測済み** | DROP NOT NULL で戻る | — |
| 20260905091000 | DROP FUNCTION | `save_prompt_elements(text,uuid,bigint[])` | 本番に無い（今回の束の中で作った関数） | — | 空振り |
| 20260905091000 | UPDATE | `saved_elements` | 今回作る表。0行 | — | — |
| 20260905092000 | UPDATE ×2 | `tags` / `flavor_vocab` | 156行 ／ 今回作る表 | 逆SQLで戻せる | 読みを埋めるだけ |
| 20260905094000 | DROP FUNCTION | `promote_session_elements(bigint[])` | 本番に無い | — | 空振り |
| 20260905094000 | DROP TRIGGER | `saved_elements` | 本番に無い | — | 空振り |
| 20260905094000 | SET NOT NULL ×2 | `saved_elements.carry_slot_id` / `.position` | 今回作る表。0行 | — | — |
| 20260905094000 | UPDATE ×4 | `saved_elements` / `carry_policy` | 今回作る表。0行 | — | — |
| 20260905095000 | DROP FUNCTION | `build_quiz_for_prompt(uuid,int)` | 本番に無い | — | 空振り |
| 20260905095000 | ALTER COLUMN | `draft_sessions.quiz_question_count` の **NOT NULL を外す** | 974行。**値は1つも変えない** | SET NOT NULL で戻る | 旧い画面はこの列を `draft_modes` 側から読む。そちらは無傷 |
| 20260905095000 | ALTER COLUMN | `answers.scoring_version` の既定値を `v2_all_words` に | 既存648行の値は変わらない（既定値は新しい行にだけ効く） | 逆SQLで戻せる | 既存の回答は `v1_fixed_count` のまま残る |
| 20260905095000 | UPDATE | `card_slots` | 優先度 24〜47 を +3 する。**本番の該当行は0件（実測）** | 逆SQLで戻せる | 本番の現在値は 1〜9 と null |
| 20260905095000 | UPDATE | `answers` | 648行。`question_count` / `exact_attempts` / `exact_corrects` を埋める | 列ごと落とせば戻る | 埋める値は既存の `answer_items` と `correct_count` から導く |
| 20260905095000 | UPDATE | `work_slot_stats` | 915行。`exact_*` へ既存の合計を写す | 同上 | 既存の attempts / corrects は変えない |
| 20260905095000 | UPDATE | `user_stats` | 既存行。同上 | 同上 | 同上 |
| 20260905096000 | UPDATE ×6 | `tags` / `flavor_vocab` | 156行 ほか。出所と承認の印を埋める | 列ごと落とせば戻る | 語そのものは変えない |
| 20260905097000 | DROP FUNCTION | `vocab_inventory()` | 本番に無い | — | 空振り |
| 20260905097000 | UPDATE ×3 | `user_slot_stats` / `tags` / `flavor_vocab` | 既存行。方式別の内訳を埋める | 列ごと落とせば戻る | 既存の合計は変えない |
| 20260906090000 | DROP FUNCTION | `get_next_work(uuid,text)` | **本番に無い**（この束の中で作った関数） | — | 同じ migration の中で互換ラッパーとして作り直す |

**当てた瞬間に走る `DELETE` は1本も無い。`TRUNCATE` も無い。**
**`DROP TABLE` は一時控え1本だけ。`DROP COLUMN` は0本**
（当初あった2本は、今回の作業で外した）。

### 3-2. 関数の定義に書かれている書き込み（当てた瞬間は走らない）

`INSERT` 53 本 ／ `UPDATE` 20 本 ／ `DELETE` 12 本。
これらはすべて**利用者が RPC を呼んだときに走る**もので、
migration を当てた瞬間には1行も動かない。
「DELETE が12本ある」と読むと誤る。当てるだけなら0本である。

### 3-3. 名指しで確かめたもの

| 確かめたこと | 結果 |
|---|---|
| 旧モードを非activeにする UPDATE | ある（20260904090000、2行）。**行は消していない** |
| 既存回答を `v1_fixed_count` にする UPDATE | 直接の UPDATE ではなく、列の既定値が `v1_fixed_count` で入る。既存648行はそのまま |
| 既存統計を `exact_*` へ写す UPDATE | ある（20260905095000 と 20260905097000）。**元の合計列は変えない** |
| `saved_elements` を保存枠へ変換する処理 | ある。ただし本番では対象0行（表そのものが今回作るもの） |
| 既存 prompt へ `started_at` を入れる処理 | ある（995行）。値は draft_sessions か created_at 由来。埋め残し0件を実測 |
| `deadline_at` を遡及しないこと | **遡及していない。**`supabase/manual/` に分離済みで、今回の束には入っていない |
| 旧関数の drop | 5本。うち4本は本番に無い関数。残る1本は `start_draft(text,int)` で、3引数版の既定値が受ける |
| 旧列の drop | **0本**（今回の作業で外した） |
| `card_slots.quiz_priority` の変更 | 24〜47 を +3。本番の該当行は0件 |
| 旧タグを削除・分類変更しないこと | **削除は0行。**分類（pool_key）の付け替えはある（新体系への移行）。id と label は変えない |

---

## 4. ロックと所要時間の見立て

正確な秒数は断定しない。**件数と SQL の種類から3段階に分ける。**

| 分類 | 意味 |
|---|---|
| 短い | 表を丸ごと読まない。カタログだけの変更か、数百行の更新 |
| 注意 | 表を1回丸ごと読む。件数が小さいので短時間で終わるが、その間その表は書けない |
| 事前分離が必要 | 表を丸ごと書き換える、または長時間の排他ロックを取る |

| migration | 一番重い操作 | 対象件数 | 分類 |
|---|---|---|---|
| 20260904090000 | `tags` の UPDATE、列追加（既定値なし） | 156 | 短い |
| 20260904091000 | `tags` への INSERT と UPDATE | 156 →474（増分318。実測） | 短い |
| 20260904092000 | 表の新設のみ | 0 | 短い |
| 20260904093000 | 表の新設と関数の置き換え | 0 | 短い |
| 20260904094000 | 列追加（既定値なし）＋トリガー | 995 | 短い |
| 20260904095000 | 表9個の新設 | 0 | 短い |
| 20260904096000 | 表1個の新設 | 0 | 短い |
| 20260904097000 | 関数だけの置き換え | — | 短い |
| 20260905090000 | `prompts` / `draft_sessions` の全行 UPDATE ＋ SET NOT NULL | 995 ／ 974 | **注意**（表を2回読む） |
| 20260905090500 | 関数だけの置き換え | — | 短い |
| 20260905091000 | 列追加と関数の置き換え | 0 | 短い |
| 20260905092000 | `tags` の UPDATE | 156 | 短い |
| 20260905093000 | 表1個の新設 | 0 | 短い |
| 20260905094000 | 新表への UPDATE と NOT NULL | 0 | 短い |
| 20260905095000 | `answers` 648 ／ `work_slot_stats` 915 の UPDATE、列16個追加 | 648／915／1,944 | **注意**（表を数回読む） |
| 20260905096000 | `tags` の UPDATE ×6 | 156 | 短い |
| 20260905097000 | `user_slot_stats` の UPDATE | 既存行 | 短い |
| 20260906090000 | 関数だけの置き換え | — | 短い |

**「事前分離が必要」に当たるものは1本も無い。**
理由は件数である。いちばん大きい表が `answer_items` の 1,944 行、
次が `prompt_cards` の 3,803 行で、全行を読む UPDATE でも桁が小さい。

列の追加はすべて**既定値なし、または定数の既定値**である。
Postgres 11 以降、定数の既定値を持つ列の追加は表を書き換えない
（カタログだけで済む）。表の書き換えが起きる形の列追加は無い。

索引の作成は、当てたあとの `public` スキーマ全体で 124 本になる（実測）。今回の18本で増えるぶんは、いずれも新しい表か、上の件数の表に対するもの。
`create index concurrently` は使っていない（トランザクションの中で当てるため
使えない）。件数が小さいので分ける必要は無い。

**それでも分けたい場合の案**（今回は作らない。作れと言われたら作る）:
20260905090000 と 20260905095000 の UPDATE を、
「列を足す」「値を埋める」「NOT NULL を付ける」の3本に割る。
値を埋める部分だけを migration の外（`supabase/manual/`）へ出せば、
本番の書き込みを止めずに少しずつ流せる。
**いまの件数ではその必要が無い**ので、案として置くだけにする。

---

## 5. この監査で使わなかったもの・確かめていないもの

- **同じ version の内容一致**は判定していない（1-1 の理由）。
- **PostgREST を通した呼び出し**は本番でしか確かめられない。
  ここで確かめたのは、Postgres が呼び先を1つに決められることまで
  （PGlite 上で新旧6通り・5通りを実測）。
  PostgREST の関数解決がその上でどう振る舞うかは、本番で当ててから見る。
- **Supabase Auth / Storage / メール / Turnstile 本番鍵**は、この監査の対象外。
- 本番の**画面**は1度も叩いていない（読み取り専用のDB接続だけ）。

---

## 6. この回に走らせた検査（2026-09-06・すべてこの端末で実測）

migration の中身を変えたので、前回と同じ連続試験をやり直した。

| 検査 | 結果 | 連続 |
|---|---|---|
| `npm run test:guard`（本番接続を止める柵） | 30 / 30 | — |
| `npm run test:db`（縦断試験。互換4件を追加） | 119 / 119 | — |
| `npm run test:db:upgrade`（互換3件を追加） | 27 / 27 | — |
| `npm run db:verify:local`（互換10件を追加） | 171 合格 / 0 不合格 / 11 判定しない | — |
| `npm run check:vocab` | 564語が3つとも一致 | — |
| `npm run test:e2e`（ブラウザ） | 51 / 51 | **単独で5回連続** |
| `npm run test:e2e:selftest` | 21 / 21 | — |
| `npm run test:smoke:local` | 11 / 11 | — |
| `tsc --noEmit` ／ `eslint` ／ `check:contrast` ／ `build` | いずれも成功 | — |
| `npm run check:docs` | 21 / 21 一致 | — |
| `npm run test:all` | 13 工程すべて合格 | **単独で3回連続** |
| `npm run audit:schema-diff` | 消えた関数1・消えた鍵0・変わった関数0 | — |
| `npm run db:audit:prod`（本番。読むだけ） | 未適用18本・当たり判定12件すべて通過 | — |

新しく足した検査の中身:

- 縦断試験 … 新旧2つの署名が並ぶこと、既定値の数、旧2引数から部門を改ざんしても
  同じ部門が返ること、旧5引数の一覧が従来表示になること、
  新6引数で未回答フィルタが効くこと。
- アップグレード試験 … 旧列の値が1つも変わらないこと、
  新実装が旧列を（旧い鍵を返す1本以外）参照しないこと、
  旧い画面が投げる形（名前付き5引数・名前付き2引数・表の直読み）が全部通ること。
- DB構造の検査 … 新旧の本数、既定値の数、旧列の存在と読み取り権限、
  そして `anon` で実際に旧い形を呼んでみる3件。

`docs/compat-matrix-data.json` は `npm run audit:schema-diff` が書き出す
機械可読の差分である（手で書き換えない）。`npm run db:audit:prod` が
「これから作る表と列が本番に既に無いか」を突き合わせるのに使う。
