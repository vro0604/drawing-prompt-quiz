-- ============================================================================
-- 既存の制作挑戦が、期限の遡及でどうなるかを「数えるだけ」の SQL
-- ============================================================================
--
-- **1行も書き換えない。**select しかない。
-- 本番へ当てる前に、この結果を読んでから遡及するかどうかを決める。
--
-- 使い方（どちらでもよい）
--   psql "$SUPABASE_DB_URL" -f supabase/manual/20260905_inspect_prompt_deadlines.sql
--   Supabase の SQL Editor に貼り付けて実行
--
-- 読み方
--   already_has_deadline  すでに期限が入っているお題。遡及の対象外
--   unlimited             無制限。期限も猶予も時間切れも無い。対象外
--   would_get_deadline    遡及すると期限が入るお題（＝対象の総数）
--   still_inside          遡及しても、まだ予定終了時刻の中に収まるお題
--   would_be_overrun      予定終了時刻を過ぎるお題。**失敗にはならない**
--   would_fail            0 で固定（2026-09-09 に「超過＝失敗」を撤去した）
--   oldest / newest       対象のお題が引かれた日時の幅
--
-- 【2026-09-09 に意味が変わった】
--   以前は「猶予も過ぎたお題は次の掃除で時間切れになる」ため、
--   遡及すると投稿できなくなるお題があった。いまは超過しても失敗にしない。
--   遡及で起きるのは「超過中と表示される」ことだけで、投稿も延長もできる。
--   したがって would_fail は常に 0。列は、前と見比べられるよう残してある。

with target as (
  select p.id,
         p.created_at,
         p.time_limit_seconds,
         p.created_at + make_interval(secs => p.time_limit_seconds) as would_be_deadline,
         0::numeric as grace_ratio   -- 猶予は撤去された（2026-09-09）
    from public.prompts p
   where p.status = 'active'
     and p.time_limit_seconds is not null
     and p.deadline_at is null
)
select
  (select count(*) from public.prompts p
    where p.status = 'active' and p.deadline_at is not null)        as already_has_deadline,
  (select count(*) from public.prompts p
    where p.status = 'active' and p.time_limit_seconds is null)     as unlimited,
  (select count(*) from target)                                      as would_get_deadline,
  (select count(*) from target t
    where now() <= t.would_be_deadline)                              as still_inside,
  (select count(*) from target t
    where now() > t.would_be_deadline)                              as would_be_overrun,
  -- 超過で失敗になるお題はもう無い（2026-09-09）
  0::bigint                                                          as would_fail,
  (select min(created_at) from target)                               as oldest,
  (select max(created_at) from target)                               as newest;


-- 制限時間ごとの内訳。どの長さの挑戦が落ちるのかを見る
with target as (
  select p.id,
         p.time_limit_seconds,
         p.created_at + make_interval(secs => p.time_limit_seconds) as would_be_deadline,
         0::numeric as grace_ratio   -- 猶予は撤去された（2026-09-09）
    from public.prompts p
   where p.status = 'active'
     and p.time_limit_seconds is not null
     and p.deadline_at is null
)
select time_limit_seconds,
       count(*) as prompts,
       count(*) filter (
         where now() > would_be_deadline
                       + make_interval(secs => (time_limit_seconds * grace_ratio)::double precision)
       ) as would_fail
  from target
 group by time_limit_seconds
 order by time_limit_seconds;


-- 遡及で投稿できなくなるお題のうち、作者がまだ生きているもの。
-- 「誰に影響するか」を人数で見る（お題IDも作者IDも出さない）
with target as (
  select p.created_by,
         p.time_limit_seconds,
         p.created_at + make_interval(secs => p.time_limit_seconds) as would_be_deadline,
         0::numeric as grace_ratio   -- 猶予は撤去された（2026-09-09）
    from public.prompts p
   where p.status = 'active'
     and p.time_limit_seconds is not null
     and p.deadline_at is null
     and p.created_by is not null
)
select count(distinct created_by) as affected_users
  from target
 where now() > would_be_deadline
               + make_interval(secs => (time_limit_seconds * grace_ratio)::double precision);
