-- ============================================================================
-- 007_read_rpcs.sql  ／ Step 3C: 取得系RPC（公開取得経路の実装）
-- ============================================================================
--
-- 【このファイルがやること】
--   遮断11表からデータを取り出す **唯一の入口** を13本の関数として作る。
--   これで「テーブルは誰も読めないが、必要な情報は取れる」状態が完成する。
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない・消さない・変更しない
--   ・書き込み系RPC（start_draft / complete_draft / create_work /
--     submit_answer / toggle_like など）を作らない。
--     それぞれの機能Stepで実装する（spec §9-2 の方針）
--   ・テーブル・列・制約・権限を一切変更しない
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 全部貼って Run
--   全体が begin / commit で囲まれているため、途中で失敗すれば何も残らない。
--
-- 【前提】
--   006_likes_saves_reports.sql まで実行済み（全21表）。
--   tags は0行のままでよい（3D で投入）。関数の作成には影響しない。
--
-- 【取り消し】
--   007_read_rpcs_rollback.sql を実行する。
--
--
-- 【security definer とは何か・なぜ必要か】
--
--   通常、関数は「呼び出した人の権限」で動く。それだと works に権限が無い以上、
--   関数の中からも works を読めない。
--
--   security definer を付けると「関数を作った人（postgres）の権限」で動く。
--   だから遮断表を読める。**その代わり、誰に何を返すかの判断は
--   すべて関数の中に書く必要がある。** RLS は効かないため。
--
--   このファイルの13本は次の3つを必ず守る。
--
--     1. set search_path = ''
--        検索パスを空にし、すべての表を public.xxx と完全に書く。
--        これをしないと、悪意ある利用者が自分のスキーマに同名の偽テーブルを
--        作って関数に読ませることができてしまう。
--
--     2. 返す列を1つずつ書く（select * を使わない）
--        後から列を足したときに、勝手に外へ出ないようにする。
--
--     3. revoke all ... from public のあと、必要なロールにだけ grant execute
--        Postgres は新しい関数の実行権限を自動的に PUBLIC へ与えるため、
--        明示的に取り消さないと誰でも呼べる。
--
--
-- 【絶対に外へ出さないもの】
--
--   works.prompt_id      … 作品からお題へ辿る足がかり（D23）
--   quiz_choices.is_correct … クイズの正解そのもの
--   prompt_cards の中身  … お題の答え。本人の get_my_prompt でだけ返す
--   tags.weight          … 出やすさ。正解の推測材料になる（D21）
--   answer_items の他人分 … selected_tag_id と is_correct の組から正解が判明する
--
--
-- 【13本の一覧】
--
--   ■ 誰でも（anon + authenticated）
--     get_public_works(division, sort, limit, offset)  作品一覧
--     get_work_detail(work_id)                         作品1件の詳細
--     get_work_quiz(work_id)                           クイズの問題文と選択肢
--     get_public_saves(user_id, limit, offset)         公開設定ONの人の保存一覧
--
--   ■ 本人のみ（authenticated）※ 他人のIDを渡しても0件／null が返る
--     get_my_works(limit, offset)        自分の作品一覧（非公開・削除済みも）
--     get_my_work(work_id)               自分の作品1件（編集画面用）
--     get_my_prompts(limit, offset)      自分が引いたお題の一覧
--     get_my_prompt(prompt_id)           お題1件。答えのカード＋開示済みなら未選択も
--     get_my_answers(limit, offset)      自分の回答履歴
--     get_my_answer(work_id)             自分の回答1件。選択・正誤・正解を含む
--     get_my_likes(limit, offset)        いいねした作品
--     get_my_saves(limit, offset)        保存した作品
--     get_my_reaction(work_id)           その作品にいいね／保存したか、回答済みか
--
--
-- 【本人確認のやりかた：エラーにせず空を返す】
--
--   他人のお題IDを get_my_prompt に渡した場合、エラーではなく **null** を返す。
--   「権限がありません」と返すと、そのIDが存在することを教えてしまうため。
--   存在しないIDと他人のIDの区別がつかない状態にする。
--
-- ============================================================================


begin;


-- ----------------------------------------------------------------------------
-- 1. get_public_works ／ 公開作品の一覧
-- ----------------------------------------------------------------------------
--
-- 誰でも呼べる。返すのは次を **すべて** 満たす作品だけ。
--   is_published = true / review_status = 'ok' / deleted_at is null
--
-- p_sort: 'new'（新着）/ 'likes'（いいね順）/ 'answers'（回答数順）
-- p_division: null なら全部門、'original' / 'fanart' / 'ai' で絞り込み
-- p_limit: 1〜50 に丸める（大量取得によるDB負荷と、全件収集を防ぐ）

create function public.get_public_works(
  p_division text default null,
  p_sort     text default 'new',
  p_limit    int  default 24,
  p_offset   int  default 0
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  was_rerolled        boolean,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.source_title,
    w.source_character,
    w.fanart_note,
    w.actual_time_seconds,
    p.time_limit_seconds,   -- お題の制限時間。時間別ランキングの分類基準（D25）
    p.mode_key,
    p.was_rerolled,
    w.likes_count,
    w.saves_count,
    w.answers_count,
    w.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
    and (p_division is null or w.division = p_division)
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_works(text, text, int, int) is
  '公開作品の一覧。prompt_id は返さない（D23）。';


-- ----------------------------------------------------------------------------
-- 2. get_work_detail ／ 作品1件の詳細
-- ----------------------------------------------------------------------------
--
-- 誰でも呼べる。公開条件を満たさない作品には null を返す
-- （「非公開です」と返すと、その作品の存在を教えてしまうため）。
--
-- 伝達率（枠別の正答率）もここに含める。work_slot_stats を直接公開すると
-- 作品IDの総当たりで非公開作品の存在が漏れるため（D36）。

create function public.get_work_detail(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                  w.id,
    'title',               w.title,
    'image_path',          w.image_path,
    'image_width',         w.image_width,
    'image_height',        w.image_height,
    'division',            w.division,
    'source_title',        w.source_title,
    'source_character',    w.source_character,
    'fanart_note',         w.fanart_note,
    'actual_time_seconds', w.actual_time_seconds,
    'time_limit_seconds',  p.time_limit_seconds,
    'mode_key',            p.mode_key,
    'was_rerolled',        p.was_rerolled,
    'likes_count',         w.likes_count,
    'saves_count',         w.saves_count,
    'answers_count',       w.answers_count,
    'created_at',          w.created_at,
    'author', jsonb_build_object(
      'id',           pr.id,
      'handle',       pr.handle,
      'display_name', pr.display_name,
      'bio',          pr.bio,
      'links',        pr.links
    ),
    -- 呼び出した人自身の状態。ゲスト（auth.uid() が null）は全部 false。
    'is_author',   (select auth.uid()) = w.user_id,
    'liked_by_me', exists (
      select 1 from public.likes l
       where l.work_id = w.id and l.user_id = (select auth.uid())
    ),
    'saved_by_me', exists (
      select 1 from public.saves s
       where s.work_id = w.id and s.user_id = (select auth.uid())
    ),
    'answered_by_me', exists (
      select 1 from public.answers a
       where a.work_id = w.id and a.user_id = (select auth.uid())
    ),
    -- 枠別の伝達率。回答が無ければ空配列。
    'slot_stats', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   st.card_slot_key,
                 'card_slot_label', cs.label,
                 'attempts',        st.attempts,
                 'corrects',        st.corrects
               )
               order by cs.quiz_priority nulls last, st.card_slot_key
             )
        from public.work_slot_stats st
        join public.card_slots cs on cs.card_slot_key = st.card_slot_key
       where st.work_id = w.id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.id = p_work_id
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null;
$$;

comment on function public.get_work_detail(uuid) is
  '公開作品1件の詳細。prompt_id は返さない。非公開・削除済みには null を返す。';


-- ----------------------------------------------------------------------------
-- 3. get_work_quiz ／ クイズの問題と選択肢
-- ----------------------------------------------------------------------------
--
-- 誰でも呼べる（ゲストも回答できるため）。
--
-- 【この関数がいちばん危険】
--   quiz_choices から取り出すのは tag_id / label / position の3つだけ。
--   **is_correct は1文字も触れない。**
--   選択肢は保存されている position の順に返す。並びをここで変えないのは、
--   毎回シャッフルすると「毎回位置が変わる選択肢が正解」といった
--   別の手がかりを与えかねないため。position の混ぜ方は
--   complete_draft（Step 5）が確定時に1度だけ行う。

create function public.get_work_quiz(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'work_id',       w.id,
    'mode_key',      p.mode_key,
    'answered_by_me', exists (
      select 1 from public.answers a
       where a.work_id = w.id and a.user_id = (select auth.uid())
    ),
    -- 作者本人は自作に回答できない（D28）。画面側で入力を出さないための印。
    'is_author', (select auth.uid()) = w.user_id,
    'questions', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'question_id',     q.id,
                 'position',        q.position,
                 'card_slot_key',   q.card_slot_key,
                 'card_slot_label', cs.label,
                 'choices', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'tag_id',   ch.tag_id,
                              'label',    tg.label,
                              'position', ch.position
                            )
                            order by ch.position
                          )
                     from public.quiz_choices ch
                     join public.tags tg on tg.id = ch.tag_id
                    where ch.question_id = q.id
                 ), '[]'::jsonb)
               )
               order by q.position
             )
        from public.quiz_questions q
        join public.card_slots cs on cs.card_slot_key = q.card_slot_key
       where q.prompt_id = w.prompt_id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.id = p_work_id
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null;
$$;

comment on function public.get_work_quiz(uuid) is
  'クイズの問題と選択肢。is_correct を一切参照しない。正解は submit_answer が返す。';


-- ----------------------------------------------------------------------------
-- 4. get_public_saves ／ 公開設定がONの人の保存一覧
-- ----------------------------------------------------------------------------
--
-- 誰でも呼べるが、profiles.show_saved_works = true の登録ユーザーの分だけ返す。
-- 保存された作品自体も公開条件を満たすものだけに絞る。

create function public.get_public_saves(
  p_user_id uuid,
  p_limit   int default 24,
  p_offset  int default 0
)
returns table (
  work_id             uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  likes_count         int,
  saved_at            timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.likes_count,
    sv.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.saves sv
  join public.works    w  on w.id  = sv.work_id
  join public.profiles pr on pr.id = w.user_id
  where sv.user_id = p_user_id
    -- 保存した本人が公開を許可していること
    and exists (
      select 1 from public.profiles sv_owner
       where sv_owner.id = p_user_id
         and sv_owner.is_anonymous = false
         and sv_owner.show_saved_works
    )
    -- 保存された作品自体が公開されていること
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
  order by sv.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_saves(uuid, int, int) is
  '公開設定がONの人の保存一覧。設定がOFFなら0件（エラーにしない）。';


-- ----------------------------------------------------------------------------
-- 5. get_my_works ／ 自分の作品一覧
-- ----------------------------------------------------------------------------
--
-- 非公開・審査中・論理削除済みも含めて全部返す。
-- ゲスト（auth.uid() が null）が呼ぶと0件。

create function public.get_my_works(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  is_published        boolean,
  review_status       text,
  deleted_at          timestamptz,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.source_title,
    w.source_character,
    w.fanart_note,
    w.actual_time_seconds,
    p.time_limit_seconds,
    p.mode_key,
    w.is_published,
    w.review_status,
    w.deleted_at,
    w.likes_count,
    w.saves_count,
    w.answers_count,
    w.created_at
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.user_id = (select auth.uid())
  order by w.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_works(int, int) is
  '自分の作品一覧。非公開・審査中・削除済みも含む。prompt_id は返さない。';


-- ----------------------------------------------------------------------------
-- 6. get_my_work ／ 自分の作品1件（編集画面用）
-- ----------------------------------------------------------------------------
--
-- 他人の作品IDを渡すと null。存在しないIDと区別がつかない。

create function public.get_my_work(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                  w.id,
    'title',               w.title,
    'image_path',          w.image_path,
    'image_width',         w.image_width,
    'image_height',        w.image_height,
    'division',            w.division,
    'source_title',        w.source_title,
    'source_character',    w.source_character,
    'fanart_note',         w.fanart_note,
    'actual_time_seconds', w.actual_time_seconds,
    'time_limit_seconds',  p.time_limit_seconds,
    'mode_key',            p.mode_key,
    'is_published',        w.is_published,
    'review_status',       w.review_status,
    'deleted_at',          w.deleted_at,
    'likes_count',         w.likes_count,
    'saves_count',         w.saves_count,
    'answers_count',       w.answers_count,
    'created_at',          w.created_at,
    -- actual_time_seconds を変更できるのは公開前だけ（D25）。
    -- 画面で入力欄を出すかどうかの判断に使う。
    'can_edit_actual_time', (w.is_published = false),
    'slot_stats', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   st.card_slot_key,
                 'card_slot_label', cs.label,
                 'attempts',        st.attempts,
                 'corrects',        st.corrects
               )
               order by cs.quiz_priority nulls last, st.card_slot_key
             )
        from public.work_slot_stats st
        join public.card_slots cs on cs.card_slot_key = st.card_slot_key
       where st.work_id = w.id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.id = p_work_id
    and w.user_id = (select auth.uid());
$$;

comment on function public.get_my_work(uuid) is
  '自分の作品1件。他人のIDには null を返す（存在の有無を漏らさない）。';


-- ----------------------------------------------------------------------------
-- 7. get_my_prompts ／ 自分が引いたお題の一覧
-- ----------------------------------------------------------------------------
--
-- 一覧では答えのカードを返さない（画面に並べる必要が無いため）。
-- 中身は get_my_prompt で1件ずつ取る。

create function public.get_my_prompts(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  id                     uuid,
  mode_key               text,
  mode_label             text,
  time_limit_seconds     int,
  was_rerolled           boolean,
  reroll_count           int,
  status                 text,
  candidates_revealed_at timestamptz,
  created_at             timestamptz,
  work_id                uuid,
  work_title             text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.mode_key,
    dm.label,
    p.time_limit_seconds,
    p.was_rerolled,
    p.reroll_count,
    p.status,
    p.candidates_revealed_at,
    p.created_at,
    w.id,
    w.title
  from public.prompts p
  join public.draft_modes dm on dm.mode_key = p.mode_key
  left join public.works w   on w.prompt_id = p.id
  where p.created_by = (select auth.uid())
  order by p.created_at desc, p.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_prompts(int, int) is
  '自分が引いたお題の一覧。答えのカードは含めない。';


-- ----------------------------------------------------------------------------
-- 8. get_my_prompt ／ お題1件（答えのカードを含む）
-- ----------------------------------------------------------------------------
--
-- **prompt_cards の中身を外へ出す唯一の場所。** 作成者本人にのみ返す。
--
-- 未選択カード（draft_candidates）は
-- candidates_revealed_at が入っているときだけ返す（§9-4 の開示制御）。
-- まだ開示していない場合は空配列を返す。

create function public.get_my_prompt(p_prompt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                     p.id,
    'mode_key',               p.mode_key,
    'mode_label',             dm.label,
    'time_limit_seconds',     p.time_limit_seconds,
    'was_rerolled',           p.was_rerolled,
    'reroll_count',           p.reroll_count,
    'status',                 p.status,
    'candidates_revealed_at', p.candidates_revealed_at,
    'reveal_reason',          p.reveal_reason,
    'created_at',             p.created_at,
    'work_id', (select w.id from public.works w where w.prompt_id = p.id),

    -- 確定カード＝お題の答え
    'cards', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   pc.card_slot_key,
                 'card_slot_label', cs.label,
                 'slot_order',      pc.slot_order,
                 'tag_id',          pc.tag_id,
                 'tag_label',       tg.label,
                 'pool_key',        tg.pool_key
               )
               order by pc.slot_order
             )
        from public.prompt_cards pc
        join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
        join public.tags       tg on tg.id            = pc.tag_id
       where pc.prompt_id = p.id
    ), '[]'::jsonb),

    -- 引かなかったカード。開示済みのときだけ。
    'unchosen', case
      when p.candidates_revealed_at is null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'card_slot_key',   dc.card_slot_key,
                   'card_slot_label', cs.label,
                   'slot_order',      dc.slot_order,
                   'candidate_index', dc.candidate_index,
                   'tag_id',          dc.tag_id,
                   'tag_label',       tg.label
                 )
                 order by dc.slot_order, dc.candidate_index
               )
          from public.draft_candidates dc
          join public.draft_sessions ds on ds.id = dc.session_id
          join public.card_slots cs on cs.card_slot_key = dc.card_slot_key
          join public.tags       tg on tg.id            = dc.tag_id
         where ds.id = p.draft_session_id
           and dc.generation = ds.current_generation   -- 最終世代だけ
           and dc.is_chosen = false
      ), '[]'::jsonb)
    end
  )
  from public.prompts p
  join public.draft_modes dm on dm.mode_key = p.mode_key
  where p.id = p_prompt_id
    and p.created_by = (select auth.uid());
$$;

comment on function public.get_my_prompt(uuid) is
  'お題1件。prompt_cards を外へ出す唯一の経路。作成者本人にのみ返す。'
  '未選択カードは candidates_revealed_at が入っているときだけ返す。';


-- ----------------------------------------------------------------------------
-- 9. get_my_answers ／ 自分の回答履歴
-- ----------------------------------------------------------------------------
--
-- 他人へは公開しない（D35）。選んだタグは含めず、正答数までにする
-- （一覧に選択内容を並べる必要が無いため。中身は get_my_answer で取る）。

create function public.get_my_answers(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  work_id             uuid,
  work_title          text,
  image_path          text,
  correct_count       int,
  item_count          bigint,
  answered_at         timestamptz,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    a.correct_count,
    (select count(*) from public.answer_items ai where ai.answer_id = a.id),
    a.created_at,
    pr.handle,
    pr.display_name
  from public.answers a
  join public.works    w  on w.id  = a.work_id
  join public.profiles pr on pr.id = w.user_id
  where a.user_id = (select auth.uid())
  order by a.created_at desc, a.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_answers(int, int) is
  '自分の回答履歴。他人へは公開しない（D35）。選んだタグは含めない。';


-- ----------------------------------------------------------------------------
-- 10. get_my_answer ／ 自分の回答1件（結果画面用）
-- ----------------------------------------------------------------------------
--
-- **正解タグを返す唯一の場所（回答者向け）。**
-- 自分が回答済みの作品についてのみ返す。未回答なら null。
--
-- 「正解を見るには回答が必要」という前提が、ここで強制される。
-- answers に自分の行が無ければ結合が成立せず、何も返らない。

create function public.get_my_answer(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'work_id',       w.id,
    'work_title',    w.title,
    'correct_count', a.correct_count,
    'answered_at',   a.created_at,
    'items', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'question_id',       ai.question_id,
                 'card_slot_key',     ai.card_slot_key,
                 'card_slot_label',   cs.label,
                 'selected_tag_id',   ai.selected_tag_id,
                 'selected_label',    sel.label,
                 'is_correct',        ai.is_correct,
                 -- 正解のタグ。回答済みなので見せてよい。
                 'correct_tag_id',    pc.tag_id,
                 'correct_label',     cor.label
               )
               order by q.position
             )
        from public.answer_items ai
        join public.quiz_questions q  on q.id = ai.question_id
        join public.card_slots    cs  on cs.card_slot_key = ai.card_slot_key
        join public.tags          sel on sel.id = ai.selected_tag_id
        join public.prompt_cards  pc  on pc.prompt_id = q.prompt_id
                                     and pc.card_slot_key = q.card_slot_key
        join public.tags          cor on cor.id = pc.tag_id
       where ai.answer_id = a.id
    ), '[]'::jsonb)
  )
  from public.answers a
  join public.works w on w.id = a.work_id
  where a.work_id = p_work_id
    and a.user_id = (select auth.uid());
$$;

comment on function public.get_my_answer(uuid) is
  '自分の回答1件。回答済みの作品にだけ正解タグを返す。未回答なら null。';


-- ----------------------------------------------------------------------------
-- 11. get_my_likes ／ いいねした作品
-- ----------------------------------------------------------------------------
--
-- 相手の作品が後から非公開・削除になった場合も一覧から外す。

create function public.get_my_likes(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  work_id             uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  likes_count         int,
  liked_at            timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.likes_count,
    l.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.likes l
  join public.works    w  on w.id  = l.work_id
  join public.profiles pr on pr.id = w.user_id
  where l.user_id = (select auth.uid())
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
  order by l.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_likes(int, int) is
  'いいねした作品。非公開・削除済みになった作品は除く。';


-- ----------------------------------------------------------------------------
-- 12. get_my_saves ／ 保存した作品
-- ----------------------------------------------------------------------------

create function public.get_my_saves(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  work_id             uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  likes_count         int,
  saved_at            timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.likes_count,
    s.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.saves s
  join public.works    w  on w.id  = s.work_id
  join public.profiles pr on pr.id = w.user_id
  where s.user_id = (select auth.uid())
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
  order by s.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_saves(int, int) is
  '保存した作品。非公開・削除済みになった作品は除く。';


-- ----------------------------------------------------------------------------
-- 13. get_my_reaction ／ その作品への自分の状態
-- ----------------------------------------------------------------------------
--
-- いいね／保存ボタンの見た目を決めるための軽い問い合わせ。
-- get_work_detail にも同じ情報は入っているが、ボタンを押した直後の
-- 再取得で作品全体を取り直さずに済むように分けてある。
-- 作品の公開状態は見ない（自分の状態を返すだけなので漏れる情報が無い）。

create function public.get_my_reaction(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'work_id', p_work_id,
    'liked',   exists (select 1 from public.likes l
                        where l.work_id = p_work_id
                          and l.user_id = (select auth.uid())),
    'saved',   exists (select 1 from public.saves s
                        where s.work_id = p_work_id
                          and s.user_id = (select auth.uid())),
    'answered', exists (select 1 from public.answers a
                        where a.work_id = p_work_id
                          and a.user_id = (select auth.uid()))
  )
  where (select auth.uid()) is not null;
$$;

comment on function public.get_my_reaction(uuid) is
  'その作品に対する自分のいいね／保存／回答済みの状態。ゲストには null。';


-- ----------------------------------------------------------------------------
-- 14. 実行権限
-- ----------------------------------------------------------------------------
--
-- 【重要】Postgres は新しい関数の EXECUTE を自動的に PUBLIC へ与える。
--   revoke しないと、意図しないロール（将来増えるロールも含む）から呼べる。
--   まず全員から取り消し、必要なロールにだけ与え直す。

-- --- 誰でも呼べる4本 -------------------------------------------------------

revoke all on function public.get_public_works(text, text, int, int)
  from public, anon, authenticated;
revoke all on function public.get_work_detail(uuid)
  from public, anon, authenticated;
revoke all on function public.get_work_quiz(uuid)
  from public, anon, authenticated;
revoke all on function public.get_public_saves(uuid, int, int)
  from public, anon, authenticated;

grant execute on function public.get_public_works(text, text, int, int)
  to anon, authenticated;
grant execute on function public.get_work_detail(uuid)
  to anon, authenticated;
grant execute on function public.get_work_quiz(uuid)
  to anon, authenticated;
grant execute on function public.get_public_saves(uuid, int, int)
  to anon, authenticated;


-- --- 本人だけの9本 ---------------------------------------------------------
--
-- anon（未ログイン）には与えない。呼ぶ意味が無く、
-- 与えないほうが「誰が呼べるか」を読み違えにくいため。

revoke all on function public.get_my_works(int, int)     from public, anon, authenticated;
revoke all on function public.get_my_work(uuid)          from public, anon, authenticated;
revoke all on function public.get_my_prompts(int, int)   from public, anon, authenticated;
revoke all on function public.get_my_prompt(uuid)        from public, anon, authenticated;
revoke all on function public.get_my_answers(int, int)   from public, anon, authenticated;
revoke all on function public.get_my_answer(uuid)        from public, anon, authenticated;
revoke all on function public.get_my_likes(int, int)     from public, anon, authenticated;
revoke all on function public.get_my_saves(int, int)     from public, anon, authenticated;
revoke all on function public.get_my_reaction(uuid)      from public, anon, authenticated;

grant execute on function public.get_my_works(int, int)   to authenticated;
grant execute on function public.get_my_work(uuid)        to authenticated;
grant execute on function public.get_my_prompts(int, int) to authenticated;
grant execute on function public.get_my_prompt(uuid)      to authenticated;
grant execute on function public.get_my_answers(int, int) to authenticated;
grant execute on function public.get_my_answer(uuid)      to authenticated;
grant execute on function public.get_my_likes(int, int)   to authenticated;
grant execute on function public.get_my_saves(int, int)   to authenticated;
grant execute on function public.get_my_reaction(uuid)    to authenticated;


commit;


-- ============================================================================
-- Step 3E の必須診断（追加分 A12）
-- ============================================================================
--
-- A12. security definer なのに search_path が固定されていない関数
--      → 0 行が返れば正常。1行でも返れば、その関数は偽テーブルを
--        読まされる危険がある。
--
-- select p.proname
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.prosecdef
--    and not exists (
--      select 1 from unnest(coalesce(p.proconfig, '{}')) c
--       where c like 'search_path=%'
--    );
