-- ============================================================================
-- 006_likes_saves_reports.sql  ／ Step 3B-3b: 反応・通報3表
-- ============================================================================
--
-- 【このファイルがやること】
--   1. likes（いいね）を作る
--   2. saves（保存）を作る
--   3. reports（通報）【機密】を作る
--   4. RLS と権限を設定する
--
--   これで **全21表がそろう**（12 + 6 + 3）。
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない（3表とも 0 行のまま）
--   ・likes_count / saves_count を同期するトリガーを作らない。
--     Step 11 の toggle_like / toggle_save と同時に作る（D38 と同じ方針）
--   ・いいね・保存・通報の処理（RPC）を作らない
--   ・既存18表に一切触れない
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query
--   → このファイルの中身を全部貼り付けて Run（⌘+Enter）
--
--   全体が begin / commit で囲まれているため、途中で1つでも失敗すると
--   **何も変更されずに巻き戻る**。
--
-- 【前提】
--   005_works_answers.sql まで実行済みであること（3表とも works を参照する）。
--
-- 【取り消し】
--   006_likes_saves_reports_rollback.sql を実行する。
--
--
-- 【権限の方針：3表とも完全遮断】
--
--   表        anon      authenticated
--   --------  --------  -------------
--   likes     権限なし  権限なし
--   saves     権限なし  権限なし
--   reports   権限なし  権限なし
--
--   RLS を有効にし、ポリシーは1つも作らない。直接触ると permission denied。
--
--   【なぜ本人にも直接読ませないか】
--     likes / saves は work_id しか持たない。作品名や画像を出すには
--     works が要るが、works には権限が無い（D23 / D35）。
--     結局 RPC を通すことになるため、経路を1本に統一する。
--
--     saves の公開（show_saved_works = true）も同じ理由で RPC 側で判定する。
--     ポリシーで公開条件を書くと、work_slot_stats と同じ問題
--     （非公開・削除済み作品の存在が漏れる）が起きる（D36）。
--
--   【取得経路】
--     toggle_like(work_id) / toggle_save(work_id)   … 押す・外す
--     get_my_likes() / get_my_saves()               … 本人の一覧
--     get_public_saves(user_id)                     … show_saved_works = true のみ
--     get_work_detail / get_my_work                 … liked_by_me / saved_by_me を含む
--     create_report(work_id, reason, detail)        … 匿名も可
--
--   公開するいいね数は works.likes_count（キャッシュ。D24）だけ。
--   「誰がいいねしたか」は見せない（D26）。
--
--
-- 【DB では防げないこと（RPC が保証する）】
--
--   ・いいね・保存は **正式登録ユーザーのみ**（D7）。
--     匿名かどうかは profiles を見ないと分からず、CHECK では書けない。
--     toggle_like / toggle_save が JWT の is_anonymous を検査する。
--     壊れていないかは Step 3E の診断 A10 で確認する。
--   ・works.likes_count / saves_count とこの表の実件数の一致（診断 A11）。
--
-- ============================================================================


begin;


-- ----------------------------------------------------------------------------
-- 1. likes ／ いいね
-- ----------------------------------------------------------------------------
--
-- 正本はこの表の行。works.likes_count はトリガーで同期するキャッシュ（D24）。
-- ずれた場合はこの表を数え直せば復旧できる。
--
-- **正式登録ユーザーのみ**（D7）。匿名はブラウザデータを消せば作り直せるため、
-- いいねの水増しが容易で人気ランキングの信頼性が落ちる。

create table public.likes (

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  -- ON DELETE CASCADE:
  --   いいねは本人の行動記録。本人が消えれば一緒に消える。
  --   （作品は他人が見るコンテンツなので works.user_id は RESTRICT。扱いが違う）
  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  created_at timestamptz not null default now(),

  -- 同じ作品に2回いいねできない
  constraint likes_pkey primary key (work_id, user_id)
);

comment on table public.likes is
  'いいね。正式登録ユーザーのみ（D7）。anon / authenticated とも権限なし。'
  '公開するのは works.likes_count だけで、誰が押したかは見せない（D26）。';


-- 「いいねした作品一覧」用
create index likes_user_created_idx
  on public.likes (user_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 2. saves ／ 保存（ブックマーク）
-- ----------------------------------------------------------------------------
--
-- likes とほぼ同じ形。違いは公開設定を持つこと
-- （profiles.show_saved_works = true なら他人にも見せられる）。
-- ただし公開判定は RPC 側で行い、この表自体は誰にも読ませない。

create table public.saves (

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  created_at timestamptz not null default now(),

  constraint saves_pkey primary key (work_id, user_id)
);

comment on table public.saves is
  '保存。正式登録ユーザーのみ。公開判定（show_saved_works）は RPC 側で行う。';


create index saves_user_created_idx
  on public.saves (user_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 3. reports ／ 通報【機密】
-- ----------------------------------------------------------------------------
--
-- 誰が何を通報したかは、通報者にも被通報者にも見せない。
-- 見るのは運営だけ（管理経路は Step 15）。
--
-- **匿名ユーザーも通報できる**（D7 では投稿系だけを登録必須にした。
-- 通報は権利侵害の申告経路なので、登録を必須にすると通報されにくくなる）。

create table public.reports (

  id bigint generated always as identity primary key,

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  -- ON DELETE SET NULL:
  --   ゲストが30日で掃除されても通報自体は残す。
  --   通報内容は運営の判断材料であり、通報者が消えても価値が残る。
  reporter_id uuid
    references public.profiles (id) on delete set null on update restrict,

  reason text not null,

  -- 補足。reason = 'other' のときは必須（下の CHECK）。
  detail text
    constraint reports_detail_length check (
      detail is null or char_length(detail) between 1 and 1000
    ),

  status text not null default 'open',

  created_at timestamptz not null default now(),

  -- 処理し終えた日時。status と対で埋まる。
  resolved_at timestamptz,

  -- --- 表全体にかかる検査 -------------------------------------------------

  constraint reports_reason_valid check (
    reason in ('copyright', 'inappropriate', 'spam', 'ai_undeclared', 'other')
  ),

  constraint reports_status_valid check (
    status in ('open', 'reviewing', 'resolved', 'rejected')
  ),

  -- 「その他」を選んだなら、何が問題なのかを書いてもらう
  constraint reports_other_requires_detail check (
    reason <> 'other' or detail is not null
  ),

  -- 処理済みなら日時が入り、未処理なら入っていない
  constraint reports_resolved_pair check (
    (status in ('open', 'reviewing') and resolved_at is null)
    or
    (status in ('resolved', 'rejected') and resolved_at is not null)
  ),

  constraint reports_resolved_after_created check (
    resolved_at is null or resolved_at >= created_at
  ),

  -- 同じ人が同じ作品を何度も通報できない。
  --
  -- 【注意】answers と同じく、reporter_id が null になった行には効かない。
  --   ゲスト掃除後に同一作品への null 通報が複数残ることは許容する。
  constraint reports_one_per_reporter_per_work unique (work_id, reporter_id)
);

comment on table public.reports is
  '通報【機密】。誰が何を通報したかは当事者にも見せない。運営のみが RPC で扱う。';


-- 運営が未処理を拾うため
create index reports_status_created_idx
  on public.reports (status, created_at);

-- 作品単位の通報件数を見るため
create index reports_work_idx
  on public.reports (work_id);


-- ----------------------------------------------------------------------------
-- 4. RLS（行の絞り込み）
-- ----------------------------------------------------------------------------
--
-- 3表ともポリシーを1つも作らない。
-- RLS が有効でポリシーが無い表は、所有者以外から見ると常に「対象行なし」。
-- さらに権限も与えないため、実際には permission denied で止まる（D31）。

alter table public.likes   enable row level security;
alter table public.saves   enable row level security;
alter table public.reports enable row level security;


-- ----------------------------------------------------------------------------
-- 5. 権限
-- ----------------------------------------------------------------------------
--
-- revoke all を先に流すのは、以前の実行で広い権限が付いていた場合に
-- 確実に消すため。新規作成なら何も起きない。

revoke all on public.likes   from anon, authenticated;
revoke all on public.saves   from anon, authenticated;
revoke all on public.reports from anon, authenticated;

-- grant は1つも書かない。すべて RPC 経由。


commit;


-- ============================================================================
-- Step 3E の必須診断（追加分 A10・A11）
-- ============================================================================
--
-- **すべて 0 行が返れば正常。1行でも返れば壊れたデータ。**
--
--
-- A10. いいね・保存の持ち主が匿名ユーザー（登録必須のはず。D7）
-- select 'likes' as t, l.work_id, l.user_id
--   from public.likes l
--   join public.profiles p on p.id = l.user_id
--  where p.is_anonymous
-- union all
-- select 'saves', s.work_id, s.user_id
--   from public.saves s
--   join public.profiles p on p.id = s.user_id
--  where p.is_anonymous;
--
--
-- A11. works のカウンタが実件数と一致しない作品
-- select w.id,
--        w.likes_count,
--        (select count(*) from public.likes l where l.work_id = w.id) as actual_likes,
--        w.saves_count,
--        (select count(*) from public.saves s where s.work_id = w.id) as actual_saves
--   from public.works w
--  where w.likes_count <> (select count(*) from public.likes l where l.work_id = w.id)
--     or w.saves_count <> (select count(*) from public.saves s where s.work_id = w.id);


-- ============================================================================
-- 確認用クエリ
-- ============================================================================
--
-- supabase/migrations/006_likes_saves_reports_verify.sql を使う。
--
-- ============================================================================
