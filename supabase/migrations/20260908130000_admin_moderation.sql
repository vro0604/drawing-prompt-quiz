-- ============================================================================
-- admin_moderation ／ 通報を閉じ、作品を非表示にする経路を1本だけ作る（管理 v0）
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 監査記録の表を1つ足す（public.admin_audit_log）
--   2. 運営専用の RPC を4本足す（一覧・詳細・作品の非表示・通報の処理）
--
-- 【このファイルがやらないこと】
--   ・既存の表・列・制約を1つも変えない
--   ・既存の RPC を1本も書き換えない
--   ・RLS のポリシーを1本も足さない・変えない
--   ・役割（role）の列を作らない。**管理者が誰かを DB は知らない**
--   ・作品の行を消さない。deleted_at を触らない。Storage の画像を消さない
--   ・通報の行を消さない
--
-- 【なぜ役割の列を作らないか】
--   管理者は1人で、その1人を見分けるのはアプリ側（サーバー専用の環境変数）。
--   DB に role を持たせると、**その列を誰が書き換えられるかという問題が新しく増える**
--   （account_status のときは列権限を revoke する手当てが要った）。
--   下の4本は service_role にしか grant しないので、
--   呼べる時点で「秘密鍵を持っている」ことが確定している。
--   **DB 側の関門は「鍵を持っているか」まで。「誰か」はアプリが決めてここへ渡す。**
--
-- 【なぜ管理者の ID を引数で受け取るか】
--   service_role で呼ぶと auth.uid() は null になる。誰が操作したかは
--   引数でしか渡せない。既存の finish_account_deletion(p_user_id) と同じ形。
--
-- 【なぜ hide と resolve を別の関数にするか】
--   「問題投稿だったので下げて、通報を閉じる」と
--   「通報に理由が無かったので、作品はそのままで通報だけ却下する」は別の判断。
--   1本にまとめると、片方だけしたいときに必ず引数で分岐が生まれる。
--   **判断が2つなら関数も2つにする。**
--
-- 【実行方法】
--   npm run db:deploy
--
-- ============================================================================




-- ============================================================================
-- 1. admin_audit_log ／ 運営が行った危険な書き込みの記録
-- ============================================================================
--
-- 【何を書くか】
--   誰が・いつ・何に・どの操作を・何から何へ・なぜ。この6つだけ。
--
-- 【何を書かないか】
--   作品の題名・本文・画像・メールアドレス・通報者の ID。
--   記録が個人情報の写しになると、消せない場所に個人情報が溜まる。
--   **持つのは ID と、変わった1つの値だけ。**
--
-- 【なぜ admin_user_id に外部キーを張らないか】
--   profiles を参照すると、その行が消えたときに記録まで巻き込まれるか
--   （cascade）、null になる（set null）。どちらも
--   「誰がやったか分からない記録」になる。
--   **記録は、参照先の生死と無関係に残らなければ記録ではない。**
--   だから uuid をそのまま持つ。
--
-- 【なぜ target_id が text か】
--   作品は uuid、通報は bigint。1列にまとめるには text しかない。
--   型で守れないぶん、target_type との組み合わせを CHECK で縛る。
--
-- 【消す経路を作らない】
--   この migration は delete の RPC を1本も作らない。
--   表への権限も与えない。**運営自身にも消させない。**

create table if not exists public.admin_audit_log (

  id bigint generated always as identity primary key,

  -- 操作した運営の Supabase user id。外部キーは張らない（上記）
  admin_user_id uuid not null,

  -- 何をしたか。**自由文字列にしない。**増やすときは migration が要る形にする
  action text not null,

  -- 何に対してか
  target_type text not null,
  target_id   text not null
    constraint admin_audit_log_target_id_length
      check (char_length(target_id) between 1 and 64),

  -- 変わった1つの値。ここに本文や画像を入れない
  old_value text
    constraint admin_audit_log_old_value_length
      check (old_value is null or char_length(old_value) <= 64),
  new_value text
    constraint admin_audit_log_new_value_length
      check (new_value is null or char_length(new_value) <= 64),

  -- なぜそうしたか。**必須**。空欄では後から判断を追えない
  reason text not null
    constraint admin_audit_log_reason_length
      check (char_length(btrim(reason)) between 1 and 1000),

  created_at timestamptz not null default now(),

  constraint admin_audit_log_action_valid check (
    action in ('hide_work', 'resolve_report', 'reject_report')
  ),

  constraint admin_audit_log_target_type_valid check (
    target_type in ('work', 'report')
  ),

  -- 操作と対象の組み合わせを縛る。
  -- 「作品を却下する」「通報を非表示にする」のような記録が入らないようにする
  constraint admin_audit_log_action_matches_target check (
    (action = 'hide_work'      and target_type = 'work')
    or
    (action in ('resolve_report', 'reject_report') and target_type = 'report')
  )
);

comment on table public.admin_audit_log is
  '運営が行った危険な書き込みの記録。誰も直接読み書きできない（RPC のみ）。'
  '本文・画像・メールアドレスは持たない。消す経路を作らない。';
comment on column public.admin_audit_log.admin_user_id is
  '外部キーを張らない。参照先が消えても記録は残らなければならないため。';
comment on column public.admin_audit_log.reason is
  '必須。空白だけの理由も CHECK が拒む。';

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);

create index if not exists admin_audit_log_target_idx
  on public.admin_audit_log (target_type, target_id, created_at desc);


-- --- 遮断 ---------------------------------------------------------------------
--
-- RLS を有効にしてポリシーを1本も作らない。さらに権限も与えない。
-- 既存の12表と同じ扱い（D31）。

alter table public.admin_audit_log enable row level security;

revoke all on table public.admin_audit_log from public, anon, authenticated;




-- ============================================================================
-- 2. admin_list_reports ／ 通報の一覧
-- ============================================================================
--
-- 【返さないもの】
--   reporter_id … 誰が通報したかは当事者にも運営の画面にも出さない
--                  （reports の表コメント「誰が何を通報したかは当事者にも見せない」）。
--                  下げるか却下するかの判断に、通報者が誰かは要らない。
--   prompt_id   … D23。管理画面も例外にしない
--   detail      … 一覧には出さない。詳細を開いたときだけ読む
--
-- 【全件を一度に返さない】
--   limit と offset を取る。limit は 1〜100 に丸める。
--   総数も一緒に返して、画面が「次がある」を出せるようにする。

create or replace function public.admin_list_reports(
  p_status text default 'open',
  p_limit  int  default 20,
  p_offset int  default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_status text := coalesce(nullif(btrim(p_status), ''), 'open');
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_total  int;
  v_rows   jsonb;
begin
  if v_status not in ('open', 'reviewing', 'resolved', 'rejected', 'all') then
    raise exception 'INVALID_STATUS: 状態の指定が正しくありません（%）。', v_status;
  end if;

  select count(*)::int into v_total
    from public.reports r
   where v_status = 'all' or r.status = v_status;

  select coalesce(jsonb_agg(x order by x_created_at desc, x_id desc), '[]'::jsonb)
    into v_rows
  from (
    select
      r.id         as x_id,
      r.created_at as x_created_at,
      jsonb_build_object(
        'report_id',   r.id,
        'status',      r.status,
        'reason',      r.reason,
        'created_at',  r.created_at,
        'resolved_at', r.resolved_at,
        'work', jsonb_build_object(
          'work_id',       w.id,
          'title',         w.title,
          'image_path',    w.image_path,
          'division',      w.division,
          'review_status', w.review_status,
          'is_published',  w.is_published,
          'is_deleted',    (w.deleted_at is not null)
        ),
        'author', case
          when w.user_id is null then null
          else jsonb_build_object(
            'user_id',      p.id,
            'handle',       p.handle,
            'display_name', p.display_name
          )
        end,
        'open_reports_for_work', (
          select count(*)::int from public.reports r2
           where r2.work_id = r.work_id and r2.status = 'open')
      ) as x
      from public.reports r
      join public.works    w on w.id = r.work_id
      left join public.profiles p on p.id = w.user_id
     where v_status = 'all' or r.status = v_status
     order by r.created_at desc, r.id desc
     limit v_limit offset v_offset
  ) q;

  return jsonb_build_object(
    'status', v_status,
    'limit',  v_limit,
    'offset', v_offset,
    'total',  v_total,
    'rows',   v_rows
  );
end;
$fn$;

comment on function public.admin_list_reports(text, int, int) is
  '通報の一覧（運営用）。通報者の ID とお題の ID は返さない。'
  'limit / offset で区切る。全件は返さない。';

revoke all on function public.admin_list_reports(text, int, int)
  from public, anon, authenticated;
grant execute on function public.admin_list_reports(text, int, int) to service_role;




-- ============================================================================
-- 3. admin_get_report ／ 通報1件と、判断に要るものだけ
-- ============================================================================
--
-- 【取らないもの】
--   prompt_cards（＝クイズの答え）と answer_items（＝機密の内訳）は
--   1行も読まない。モデレーションの判断に要らない。
--
-- 【同じ作品への他の通報】
--   理由と日時と状態だけを並べる。通報者は出さない。

create or replace function public.admin_get_report(p_report_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_report public.reports%rowtype;
  v_work   public.works%rowtype;
  v_author jsonb;
  v_others jsonb;
begin
  select * into v_report from public.reports r where r.id = p_report_id;
  if not found then
    raise exception 'REPORT_NOT_FOUND: その通報は見つかりません（%）。', p_report_id;
  end if;

  select * into v_work from public.works w where w.id = v_report.work_id;
  if not found then
    raise exception 'WORK_NOT_FOUND: その通報の対象作品は見つかりません。';
  end if;

  if v_work.user_id is null then
    v_author := null;
  else
    select jsonb_build_object(
             'user_id',      p.id,
             'handle',       p.handle,
             'display_name', p.display_name,
             'is_anonymous', p.is_anonymous
           )
      into v_author
      from public.profiles p where p.id = v_work.user_id;
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'report_id',   r.id,
             'status',      r.status,
             'reason',      r.reason,
             'detail',      r.detail,
             'created_at',  r.created_at,
             'resolved_at', r.resolved_at
           ) order by r.created_at desc, r.id desc), '[]'::jsonb)
    into v_others
    from public.reports r
   where r.work_id = v_report.work_id and r.id <> v_report.id;

  return jsonb_build_object(
    'report', jsonb_build_object(
      'report_id',   v_report.id,
      'status',      v_report.status,
      'reason',      v_report.reason,
      'detail',      v_report.detail,
      'created_at',  v_report.created_at,
      'resolved_at', v_report.resolved_at
    ),
    'work', jsonb_build_object(
      'work_id',       v_work.id,
      'title',         v_work.title,
      'image_path',    v_work.image_path,
      'image_width',   v_work.image_width,
      'image_height',  v_work.image_height,
      'division',      v_work.division,
      'source_title',  v_work.source_title,
      'review_status', v_work.review_status,
      'is_published',  v_work.is_published,
      'is_deleted',    (v_work.deleted_at is not null),
      'created_at',    v_work.created_at,
      'answers_count', v_work.answers_count
    ),
    'author', v_author,
    'same_work_reports', v_others,
    'same_work_open_count', (
      select count(*)::int from public.reports r
       where r.work_id = v_report.work_id and r.status = 'open')
  );
end;
$fn$;

comment on function public.admin_get_report(bigint) is
  '通報1件と対象作品（運営用）。通報者の ID・お題・回答の内訳は返さない。';

revoke all on function public.admin_get_report(bigint)
  from public, anon, authenticated;
grant execute on function public.admin_get_report(bigint) to service_role;




-- ============================================================================
-- 4. admin_hide_work ／ 作品を運営の判断で非表示にする
-- ============================================================================
--
-- 【何をするか】
--   works.review_status を 'hidden' にする。**それだけ。**
--
-- 【何をしないか】
--   ・行を消さない
--   ・deleted_at を触らない（あれは本人が消したという意味で、別の事実）
--   ・is_published を触らない（あれは本人の公開設定で、別の事実）
--   ・Storage の画像を消さない（取り消せる操作にしておくため）
--   ・通報の状態を変えない（別の判断なので admin_resolve_report に任せる）
--
-- 【なぜ review_status だけで消えるか】
--   一覧・詳細・出題・ランキング・次の作品・いいね・保存・フレーバーの
--   取得系がすべて `review_status = 'ok'` で絞っている（既存の実装）。
--   **この列に 'hidden' を入れるだけで、公開経路から全部消える。**
--   本人のマイページ（get_my_work / get_my_works）は review_status を返すので、
--   作者には「運営の審査により表示を止めています」と出る（既存の画面）。
--
-- 【記録と操作は同じ取引の中にある】
--   plpgsql の関数は1つの取引で走る。update と insert のどちらかが失敗すれば
--   両方とも無かったことになる。**片方だけ残ることが起きない。**

create or replace function public.admin_hide_work(
  p_admin_user_id uuid,
  p_work_id       uuid,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    text;
  v_audit  bigint;
begin
  if p_admin_user_id is null then
    raise exception 'ADMIN_REQUIRED: 操作した運営の ID がありません。';
  end if;

  if char_length(v_reason) = 0 then
    raise exception 'REASON_REQUIRED: 理由を書いてください。';
  end if;

  if char_length(v_reason) > 1000 then
    raise exception 'REASON_TOO_LONG: 理由は1000字までです（いま %字）。',
      char_length(v_reason);
  end if;

  -- 行を押さえてから読む。同時に2回押されても2件の記録にならない
  select w.review_status into v_old
    from public.works w
   where w.id = p_work_id
   for update;

  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  if v_old = 'hidden' then
    raise exception 'WORK_ALREADY_HIDDEN: その作品はすでに非表示です。';
  end if;

  update public.works w
     set review_status = 'hidden'
   where w.id = p_work_id;

  insert into public.admin_audit_log
    (admin_user_id, action, target_type, target_id, old_value, new_value, reason)
  values
    (p_admin_user_id, 'hide_work', 'work', p_work_id::text, v_old, 'hidden', v_reason)
  returning id into v_audit;

  return jsonb_build_object(
    'work_id',       p_work_id,
    'review_status', 'hidden',
    'previous',      v_old,
    'audit_id',      v_audit
  );
end;
$fn$;

comment on function public.admin_hide_work(uuid, uuid, text) is
  '作品を運営の判断で非表示にする。review_status のみを変える。'
  '行も deleted_at も画像も触らない。監査記録を同じ取引の中で1行書く。';

revoke all on function public.admin_hide_work(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_hide_work(uuid, uuid, text) to service_role;




-- ============================================================================
-- 5. admin_resolve_report ／ 通報を閉じる
-- ============================================================================
--
-- resolution は 'resolved'（対応した）か 'rejected'（理由が無かった）の2つ。
-- 既存の CHECK が「閉じた状態なら resolved_at が入っている」ことを求めるので、
-- 必ず対で入れる。
--
-- **一度閉じた通報は、この関数では開き直せない。**開き直す用事が
-- いまの運用に無く、経路を増やすと「閉じた」という記録の意味が薄れる。

create or replace function public.admin_resolve_report(
  p_admin_user_id uuid,
  p_report_id     bigint,
  p_resolution    text,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_reason     text := btrim(coalesce(p_reason, ''));
  v_resolution text := btrim(coalesce(p_resolution, ''));
  v_old        text;
  v_action     text;
  v_audit      bigint;
  v_now        timestamptz := now();
begin
  if p_admin_user_id is null then
    raise exception 'ADMIN_REQUIRED: 操作した運営の ID がありません。';
  end if;

  if v_resolution not in ('resolved', 'rejected') then
    raise exception 'INVALID_RESOLUTION: 処理の種類が正しくありません（%）。', v_resolution;
  end if;

  if char_length(v_reason) = 0 then
    raise exception 'REASON_REQUIRED: 理由を書いてください。';
  end if;

  if char_length(v_reason) > 1000 then
    raise exception 'REASON_TOO_LONG: 理由は1000字までです（いま %字）。',
      char_length(v_reason);
  end if;

  select r.status into v_old
    from public.reports r
   where r.id = p_report_id
   for update;

  if not found then
    raise exception 'REPORT_NOT_FOUND: その通報は見つかりません（%）。', p_report_id;
  end if;

  if v_old in ('resolved', 'rejected') then
    raise exception 'REPORT_ALREADY_RESOLVED: その通報はすでに閉じています（%）。', v_old;
  end if;

  update public.reports r
     set status      = v_resolution,
         resolved_at = v_now
   where r.id = p_report_id;

  v_action := case when v_resolution = 'resolved'
                   then 'resolve_report' else 'reject_report' end;

  insert into public.admin_audit_log
    (admin_user_id, action, target_type, target_id, old_value, new_value, reason)
  values
    (p_admin_user_id, v_action, 'report', p_report_id::text, v_old, v_resolution, v_reason)
  returning id into v_audit;

  return jsonb_build_object(
    'report_id',   p_report_id,
    'status',      v_resolution,
    'previous',    v_old,
    'resolved_at', v_now,
    'audit_id',    v_audit
  );
end;
$fn$;

comment on function public.admin_resolve_report(uuid, bigint, text, text) is
  '通報を閉じる（resolved / rejected）。status と resolved_at を対で入れる。'
  '監査記録を同じ取引の中で1行書く。一度閉じた通報は開き直せない。';

revoke all on function public.admin_resolve_report(uuid, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.admin_resolve_report(uuid, bigint, text, text)
  to service_role;




-- ============================================================================
-- 6. 反映後の確認（すべて 0 行が返れば正常）
-- ============================================================================
--
-- M1. 管理RPCに anon / authenticated の実行権限が残っていないか
-- select p.proname, a.rolname
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  cross join lateral (values ('anon'),('authenticated')) as a(rolname)
--  where n.nspname = 'public'
--    and p.proname in ('admin_list_reports','admin_get_report',
--                      'admin_hide_work','admin_resolve_report')
--    and has_function_privilege(a.rolname, p.oid, 'execute');
--
-- M2. 監査記録の表に anon / authenticated の権限が残っていないか
-- select grantee, privilege_type
--   from information_schema.role_table_grants
--  where table_schema = 'public' and table_name = 'admin_audit_log'
--    and grantee in ('anon', 'authenticated', 'PUBLIC');
--
-- M3. 理由が空白だけの記録が入っていないか（CHECK が防ぐが、念のため）
-- select id from public.admin_audit_log where char_length(btrim(reason)) = 0;
