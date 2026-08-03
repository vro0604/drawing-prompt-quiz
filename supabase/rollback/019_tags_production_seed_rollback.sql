-- ============================================================================
-- 019_tags_production_seed_rollback.sql ／ 本番タグ投入を取り消す
-- ============================================================================
--
-- ============================================================================
-- 【警告】使われたタグは消せない。消してはいけない
-- ============================================================================
--
--   prompt_cards.tag_id と quiz_choices.tag_id は tags.id を
--   **on delete restrict** で参照している。
--
--   つまり、一度でもお題に出たタグを delete しようとすると
--   DB が拒否する。これは邪魔な制約ではなく**正しい守り**で、
--   消せてしまうと過去のお題とクイズが宛先を失う。
--
--   このファイルは**まだ一度も使われていないタグだけ**を消す。
--   使われたものは消さず、`is_active = false` にして
--   「今後は抽選に出ない」状態にする。行は残る。
--
--   **原則として流す必要は無い。** タグが増えて困ることは無く、
--   減らしたいだけなら第3節の停止だけで足りる。
--
-- ============================================================================
--
-- 【使うとき】
--   投入したタグの内容そのものが誤りだったと判断したとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えないもの】
--   ・既存46件のタグ（1行も触らない。id も label も変わらない）
--   ・すべてのお題・クイズ・回答・作品
--   ・表・列・制約・権限・関数
--
-- ============================================================================


-- --- 1. いま何が消せるかを確かめる（先に読むだけ）-----------------------------
--
-- **第2節を流す前に、必ずこれを実行して結果を見ること。**
-- used > 0 の行は第2節では消えず、第3節で停止扱いになる。

-- select t.id, t.pool_key, t.label,
--        (select count(*) from public.prompt_cards pc where pc.tag_id = t.id)
--      + (select count(*) from public.quiz_choices  qc where qc.tag_id = t.id) as used
--   from public.tags t
--  where t.created_at > '2026-08-04'::date   -- 今回入れた110件
--  order by used desc, t.pool_key, t.label;


-- --- 2. 未使用の新規タグだけを消す --------------------------------------------
--
-- 既存46件は created_at が古いので対象に入らない。
-- 使われているタグも not exists で除かれる。
--
-- 日付は投入日。db:deploy を別の日にやり直した場合はここを直す。

delete from public.tags t
 where t.created_at > '2026-08-04'::date
   and not exists (select 1 from public.prompt_cards pc where pc.tag_id = t.id)
   and not exists (select 1 from public.quiz_choices  qc where qc.tag_id = t.id);


-- --- 3. 使われてしまった新規タグは停止する ------------------------------------
--
-- 行は残すが、抽選にも選択肢にも出なくなる。
-- 過去のお題の表示とクイズの採点は、これまでどおり動く。

update public.tags t
   set is_active = false
 where t.created_at > '2026-08-04'::date;


-- --- 4. 既存46件の重みを元に戻す ----------------------------------------------
--
-- 投入前はすべて 100（均一）だった。
--
-- **id も label も変えない。**重みだけを戻す。
-- 過去のお題・クイズ・回答への参照は1件も動かない。

update public.tags t
   set weight = 100
 where t.created_at <= '2026-08-04'::date;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① プール別の有効件数（元の 16 / 10 / 10 / 10 に戻っていること）
--
-- select pool_key, count(*) from public.tags
--  where is_active group by pool_key order by pool_key;
--
-- ② 既存46件の重みが均一に戻っていること（100 が1行だけ出る）
--
-- select weight, count(*) from public.tags
--  where created_at <= '2026-08-04'::date group by weight;
--
-- ③ 過去のお題が宛先を失っていないこと（0件が正常）
--
-- select count(*) from public.prompt_cards pc
--  where not exists (select 1 from public.tags t where t.id = pc.tag_id);
