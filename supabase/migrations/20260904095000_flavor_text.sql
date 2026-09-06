-- ============================================================================
-- flavor_text ／ 制限語彙のフレーバーテキスト・ヒント・返歌（D162 / D164）
-- ============================================================================
--
-- 【この機能がやること（D162 の時系列）】
--   1. 作者が制限語彙で文章を作る
--   2. 鑑賞者は回答前に、任意でそれをヒントとして開ける
--   3. 開けずに回答してもよい
--   4. 回答後、正解のお題と作者の文章を一緒に必ず開示する
--   5. ヒントを使わなかった人は、ここで初めて文章を見る
--   6. ヒントを使った人は、同じ文章を二度見る
--   7. 開示後、鑑賞者は自分の意思で返歌するかを選ぶ
--   8. 返歌に正誤判定は設けない
--
-- 【誰が使えるか（D164 と、2026-09-04 のユーザー指示）】
--   フレーバー機能は**登録者のみ。**ゲストには作成もヒントも開示も返歌も許可しない。
--   ただし**ゲストの作品鑑賞と通常のクイズ回答は止めない。**
--   判定は JWT の is_anonymous で行う（profiles.is_anonymous では判定しない）。
--
-- 【回答前に正解を漏らさない仕組み（D162）】
--   自由入力にしない。作者が選べるのは flavor_vocab の語だけで、
--   1語ずつ次の4段の関門を通す。
--
--     ① 目で確認していない語は使えない（is_reviewed = false を弾く）
--     ② 正解タグと文字が重なる語は使えない
--        完全一致だけでなく、**どちらかがどちらかを含む**場合も弾く。
--        これが「馬」に対する「駿馬」を止める関門。
--        「駿馬」は「馬」を含むので、難しい語でも通らない。
--     ③ 正解タグと同じ同義グループの語は使えない
--        文字が重ならなくても意味が同じなら弾く（「暗い」と「暗闇」など）。
--     ④ 人が明示的に禁止した (語, 正解タグ) の組は使えない
--        ①〜③では拾えないものを1件ずつ登録する。
--
--   **文字列が一致しないことだけで安全と判定しない。**②だけでは足りないので
--   ③と④を置いている。
--
-- 【返歌は別扱い】
--   回答後なので、正解タグをそのまま使ってよい（D162）。
--   その代わり、**返歌は回答していない人には見せない。**
--   見せると、返歌に含まれる正解タグが未回答者へ漏れる。
--
-- 【ヒントを使ったかどうかの記録】
--   クライアントの申告を信じない。ヒントを開く RPC が
--   flavor_hint_views へ行を入れ、submit_answer はその行の有無を見る。
--   画面が嘘をついても記録は変わらない。
--
--   ヒントの使用は**減点にしない**（D162）。集計を2つに分けるだけ。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 制限語彙
-- ----------------------------------------------------------------------------

create table if not exists public.flavor_vocab (
  id bigint generated always as identity primary key,

  label text not null unique
    constraint flavor_vocab_label_length check (char_length(label) between 1 and 20),

  -- 文章の組み立てに使う品詞。画面の並べ方に使う
  kind text not null
    constraint flavor_vocab_kind_valid
      check (kind in ('connective', 'noun', 'verb', 'adjective')),

  -- tags.synonym_group と**同じ名前空間**を使う。
  -- 同じ値を持つ語とタグは「意味が同じ」とみなして弾く
  synonym_group text,

  -- **目で1語ずつ確認したか。**false の語はどのお題にも使えない。
  -- 「未整備の語を無条件に通さない」ための関門（D162）
  is_reviewed boolean not null default false,

  is_active boolean not null default true,

  note text
    constraint flavor_vocab_note_length check (note is null or char_length(note) <= 200),

  created_at timestamptz not null default now()
);

comment on table public.flavor_vocab is
  'フレーバーテキストで使える制限語彙（D162）。is_reviewed = false の語は使えない。';
comment on column public.flavor_vocab.synonym_group is
  'tags.synonym_group と同じ名前空間。同じ値のタグが正解のとき、この語は使えない。';
comment on column public.flavor_vocab.is_reviewed is
  '目で1語ずつ確認したか。未確認の語を無条件に通さないための関門。';

alter table public.flavor_vocab enable row level security;
revoke all on table public.flavor_vocab from public, anon, authenticated;


-- 人が明示的に登録した「この語は、この正解タグには使わせない」の組
create table if not exists public.flavor_vocab_blocks (
  vocab_id bigint not null
    references public.flavor_vocab (id) on delete cascade on update restrict,
  tag_id bigint not null
    references public.tags (id) on delete cascade on update restrict,
  reason text not null
    constraint flavor_vocab_blocks_reason_length check (char_length(reason) between 1 and 200),
  constraint flavor_vocab_blocks_pkey primary key (vocab_id, tag_id)
);

comment on table public.flavor_vocab_blocks is
  '人が1件ずつ確認した禁止関係（D162 の④）。文字の重なりでも同義グループでも'
  '拾えない組を登録する。';

alter table public.flavor_vocab_blocks enable row level security;
revoke all on table public.flavor_vocab_blocks from public, anon, authenticated;


-- 人が明示的に登録した「この語は、この正解タグの間接表現として使える」の組。
-- **関門ではない。**作者へ候補を先に見せるための並べ替えに使う。
create table if not exists public.flavor_vocab_allows (
  vocab_id bigint not null
    references public.flavor_vocab (id) on delete cascade on update restrict,
  tag_id bigint not null
    references public.tags (id) on delete cascade on update restrict,
  note text not null
    constraint flavor_vocab_allows_note_length check (char_length(note) between 1 and 200),
  constraint flavor_vocab_allows_pkey primary key (vocab_id, tag_id)
);

comment on table public.flavor_vocab_allows is
  '人が確認した「間接表現として有効」の組（D162）。関門ではなく、'
  '作者に候補を先に見せるための並べ替えに使う。';

alter table public.flavor_vocab_allows enable row level security;
revoke all on table public.flavor_vocab_allows from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. 初期語彙 90語
-- ----------------------------------------------------------------------------
--
-- 【選び方】
--   どの1語も、単独では特定の正解タグを指さないものだけにした。
--   ・つなぎの語（そして／やがて）
--   ・輪郭の語（影／音／気配／境界）
--   ・広い動き（見える／消える／残る）
--   ・広い形容（遠い／深い／暗い）
--
--   狭い語（「溶ける」「主従」のように、そのまま正解になりうる語）は入れない。
--
-- 【is_reviewed = true の意味】
--   **私が1語ずつ目で見た**、という意味であって、
--   ユーザーの承認を受けたという意味ではない。
--   限定公開前にユーザーが読み直す前提の初期セット。

insert into public.flavor_vocab (label, kind, is_reviewed) values
  -- つなぎ（18）
  ('そして','connective',true), ('けれど','connective',true), ('だが','connective',true),
  ('やがて','connective',true), ('ふいに','connective',true), ('なお','connective',true),
  ('ゆえに','connective',true), ('まだ','connective',true), ('もう','connective',true),
  ('いつか','connective',true), ('ここで','connective',true), ('そこに','connective',true),
  ('かつて','connective',true), ('ついに','connective',true), ('ならば','connective',true),
  ('それでも','connective',true), ('ただ','connective',true), ('さらに','connective',true),

  -- 輪郭の語（30）
  ('影','noun',true), ('音','noun',true), ('匂い','noun',true), ('気配','noun',true),
  ('記憶','noun',true), ('時間','noun',true), ('距離','noun',true), ('輪郭','noun',true),
  ('境界','noun',true), ('余白','noun',true), ('痕跡','noun',true), ('方角','noun',true),
  ('順番','noun',true), ('理由','noun',true), ('答え','noun',true), ('問い','noun',true),
  ('言葉','noun',true), ('息','noun',true), ('声','noun',true), ('名前','noun',true),
  ('夢','noun',true), ('約束','noun',true), ('秘密','noun',true), ('始まり','noun',true),
  ('終わり','noun',true), ('中心','noun',true), ('端','noun',true), ('裏','noun',true),
  ('表','noun',true), ('間','noun',true),

  -- 広い動き（24）
  ('いる','verb',true), ('ある','verb',true), ('なる','verb',true), ('見える','verb',true),
  ('聞こえる','verb',true), ('消える','verb',true), ('残る','verb',true), ('触れる','verb',true),
  ('向かう','verb',true), ('帰る','verb',true), ('覚える','verb',true), ('忘れる','verb',true),
  ('数える','verb',true), ('選ぶ','verb',true), ('開く','verb',true), ('閉じる','verb',true),
  ('過ぎる','verb',true), ('続く','verb',true), ('止まる','verb',true), ('始まる','verb',true),
  ('終わる','verb',true), ('変わる','verb',true), ('知る','verb',true), ('問う','verb',true),

  -- 広い形容（18）
  ('遠い','adjective',true), ('近い','adjective',true), ('深い','adjective',true),
  ('浅い','adjective',true), ('高い','adjective',true), ('低い','adjective',true),
  ('長い','adjective',true), ('短い','adjective',true), ('白い','adjective',true),
  ('黒い','adjective',true), ('明るい','adjective',true), ('暗い','adjective',true),
  ('早い','adjective',true), ('遅い','adjective',true), ('多い','adjective',true),
  ('少ない','adjective',true), ('新しい','adjective',true), ('古い','adjective',true)
on conflict (label) do nothing;


-- 明示的な禁止関係。
-- **文字が重ならず、同義グループでも拾えないが、意味がほぼ同じ組**だけを入れる。
-- 1件ずつ確認したものだけ。ここに無いことは「安全を確認した」という意味ではない。
insert into public.flavor_vocab_blocks (vocab_id, tag_id, reason)
select v.id, t.id, r.reason
  from (values
    ('暗い',   'environment',  '暗闇',   'ほぼ同義。回答前に出すと正解が確定する'),
    ('高い',   'environment',  '高所',   'ほぼ同義。回答前に出すと正解が確定する'),
    ('古い',   'property',     '古びた', 'ほぼ同義。語尾が違うだけ'),
    ('新しい', 'property',     '真新しい','ほぼ同義。接頭辞が違うだけ'),
    ('遅い',   'property',     '静か',   '否定的な近さは無いが、動作の遅さと静けさは同時に読まれやすい'),
    ('消える', 'change',       '透明化', '結果がほぼ同じ。回答前だと言い換えになる'),
    ('終わり', 'social_state', '葬送',   '上位概念だが、この語彙の中では他に候補が無く言い換えになる'),
    ('黒い',   'morph',        '黒猫',   '正解語を部分として含む方向の言い換え'),
    ('白い',   'body_state',   '白髪',   '正解語を部分として含む方向の言い換え')
  ) as r(vocab_label, pool_key, tag_label, reason)
  join public.flavor_vocab v on v.label = r.vocab_label
  join public.tags t on t.pool_key = r.pool_key and t.label = r.tag_label
on conflict (vocab_id, tag_id) do nothing;


-- ----------------------------------------------------------------------------
-- 3. 作者のフレーバーテキスト
-- ----------------------------------------------------------------------------

create table if not exists public.flavor_texts (
  id bigint generated always as identity primary key,

  work_id uuid not null unique
    references public.works (id) on delete cascade on update restrict,

  author_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.flavor_texts is
  '作者が制限語彙で作った文章（D162）。1作品に1つ。'
  '回答前のヒントと回答後の開示で、同じ文章を出す。';

create table if not exists public.flavor_text_tokens (
  flavor_text_id bigint not null
    references public.flavor_texts (id) on delete cascade on update restrict,

  position int not null
    constraint flavor_text_tokens_position_range check (position between 0 and 11),

  vocab_id bigint not null
    references public.flavor_vocab (id) on delete restrict on update restrict,

  constraint flavor_text_tokens_pkey primary key (flavor_text_id, position)
);

comment on table public.flavor_text_tokens is
  'フレーバーテキストの語の並び。最大12語。自由入力は無い（D162）。';

alter table public.flavor_texts       enable row level security;
alter table public.flavor_text_tokens enable row level security;
revoke all on table public.flavor_texts       from public, anon, authenticated;
revoke all on table public.flavor_text_tokens from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. ヒントを開いた記録
-- ----------------------------------------------------------------------------
--
-- **クライアントの申告を信じないための表。**
-- ヒントを開く RPC がここへ行を入れ、submit_answer がこの行を見る。

create table if not exists public.flavor_hint_views (
  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,
  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,
  viewed_at timestamptz not null default now(),
  constraint flavor_hint_views_pkey primary key (work_id, user_id)
);

comment on table public.flavor_hint_views is
  '回答前にヒントを開いた記録（D162）。submit_answer がこの行の有無で'
  'answers.hint_used を決める。画面の申告は使わない。';

alter table public.flavor_hint_views enable row level security;
revoke all on table public.flavor_hint_views from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. 返歌
-- ----------------------------------------------------------------------------
--
-- **正誤判定を設けない**（D162）。採点する列も関数も作らない。
-- 開示済みなので正解タグをそのまま使える。その代わり、
-- 返歌を読めるのは「作者」と「回答済みの人」だけにする。

create table if not exists public.flavor_replies (
  id bigint generated always as identity primary key,

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  created_at timestamptz not null default now(),

  constraint flavor_replies_one_per_user unique (work_id, user_id)
);

comment on table public.flavor_replies is
  '鑑賞者からの返歌（D162）。正誤判定は無い。回答済みの人と作者だけが読める。';

create table if not exists public.flavor_reply_tokens (
  reply_id bigint not null
    references public.flavor_replies (id) on delete cascade on update restrict,

  position int not null
    constraint flavor_reply_tokens_position_range check (position between 0 and 11),

  -- 制限語彙か、開示済みの正解タグか、どちらか一方
  vocab_id bigint
    references public.flavor_vocab (id) on delete restrict on update restrict,
  tag_id bigint
    references public.tags (id) on delete restrict on update restrict,

  constraint flavor_reply_tokens_pkey primary key (reply_id, position),
  constraint flavor_reply_tokens_one_source check (num_nonnulls(vocab_id, tag_id) = 1)
);

comment on table public.flavor_reply_tokens is
  '返歌の語の並び。回答後なので、開示済みの正解タグをそのまま置ける（D162）。';

alter table public.flavor_replies      enable row level security;
alter table public.flavor_reply_tokens enable row level security;
revoke all on table public.flavor_replies      from public, anon, authenticated;
revoke all on table public.flavor_reply_tokens from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. ヒント使用の記録と、使用別の集計
-- ----------------------------------------------------------------------------

alter table public.answers
  add column if not exists hint_used boolean not null default false;

comment on column public.answers.hint_used is
  '回答前にフレーバーをヒントとして開いたか（D162）。'
  'submit_answer が flavor_hint_views を見て決める。減点には使わない。';

create table if not exists public.work_hint_stats (
  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  hint_used boolean not null,

  answers_count int not null default 0
    constraint work_hint_stats_answers_positive check (answers_count >= 0),

  total_items int not null default 0
    constraint work_hint_stats_items_positive check (total_items >= 0),

  correct_items int not null default 0
    constraint work_hint_stats_correct_range check (correct_items between 0 and total_items),

  updated_at timestamptz not null default now(),

  constraint work_hint_stats_pkey primary key (work_id, hint_used)
);

comment on table public.work_hint_stats is
  'ヒントを使った回答と使わなかった回答の、作品ごとの集計（D162）。'
  '作者が「絵だけでどこまで伝わったか」と「文章を添えるとどうか」を分けて見るため。';

alter table public.work_hint_stats enable row level security;
revoke all on table public.work_hint_stats from public, anon, authenticated;


create or replace function public.answers_after_insert_hint_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  insert into public.work_hint_stats (work_id, hint_used, answers_count)
  values (new.work_id, new.hint_used, 1)
  on conflict (work_id, hint_used) do update
    set answers_count = work_hint_stats.answers_count + 1,
        updated_at    = clock_timestamp();
  return null;
end;
$fn$;

drop trigger if exists answers_after_insert_hint_stats_trigger on public.answers;
create trigger answers_after_insert_hint_stats_trigger
  after insert on public.answers
  for each row
  execute function public.answers_after_insert_hint_stats();


create or replace function public.answer_items_after_insert_hint_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_work_id uuid;
  v_hint    boolean;
begin
  select a.work_id, a.hint_used into v_work_id, v_hint
    from public.answers a where a.id = new.answer_id;

  insert into public.work_hint_stats (work_id, hint_used, total_items, correct_items)
  values (v_work_id, v_hint, 1, case when new.is_correct then 1 else 0 end)
  on conflict (work_id, hint_used) do update
    set total_items   = work_hint_stats.total_items + 1,
        correct_items = work_hint_stats.correct_items
                        + case when new.is_correct then 1 else 0 end,
        updated_at    = clock_timestamp();
  return null;
end;
$fn$;

drop trigger if exists answer_items_after_insert_hint_stats_trigger on public.answer_items;
create trigger answer_items_after_insert_hint_stats_trigger
  after insert on public.answer_items
  for each row
  execute function public.answer_items_after_insert_hint_stats();

revoke all on function public.answers_after_insert_hint_stats()
  from public, anon, authenticated;
revoke all on function public.answer_items_after_insert_hint_stats()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. 使える語彙を返す（作者が文章を作るとき）
-- ----------------------------------------------------------------------------
--
-- 【4段の関門をここで通す】
--   関門は「候補を出すとき」と「保存するとき」の両方で同じ条件を使う。
--   片方だけにすると、画面を通さない送信で抜けられる。
--
-- 条件を1か所に置くため、判定は flavor_vocab_is_allowed に集約する。

-- 表記をそろえてから比べるための関数。
--
-- 【なぜ必要か】
--   「文字が重なっていないか」を素の文字列で見ると、
--   カタカナで書いた同じ語をすり抜ける（「傘」は無理でも、
--   カタカナ語では「ソード」と「そーど」が別物として通る）。
--
-- 【ここでできること・できないこと】
--   できる   カタカナ ⇔ ひらがな、長音符・中黒・空白の違い
--   できない 漢字とかなの書き換え（「馬」と「うま」）
--
--   **できない側は、この関数では拾えない。**そちらは同義グループ
--   （tags.synonym_group）と、人が登録する禁止関係で受ける。
--   ここで「全部拾えている」ことにしない。

create or replace function public.flavor_normalize(p_text text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select translate(
           lower(coalesce(p_text, '')),
           'ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロヮワヰヱヲンヴヵヶー・　 ',
           'ぁあぃいぅうぇえぉおかがきぎくぐけげこごさざしじすずせぜそぞただちぢっつづてでとどなにぬねのはばぱひびぴふぶぷへべぺほぼぽまみむめもゃやゅゆょよらりるれろゎわゐゑをんゔゕゖ'
         );
$fn$;

comment on function public.flavor_normalize(text) is
  '比べる前に表記をそろえる（D162）。カタカナをひらがなにし、長音符・中黒・空白を落とす。'
  '漢字とかなの書き換えは拾えない。そちらは同義グループと禁止関係で受ける。';

revoke all on function public.flavor_normalize(text)
  from public, anon, authenticated;


create or replace function public.flavor_vocab_is_allowed(
  p_vocab_id  bigint,
  p_prompt_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    exists (
      select 1 from public.flavor_vocab v
       where v.id = p_vocab_id
         and v.is_active
         -- ① 目で確認していない語は使えない
         and v.is_reviewed
    )
    and not exists (
      -- ② 文字が重なる（どちらかがどちらかを含む）
      -- ③ 同じ同義グループ
      select 1
        from public.prompt_cards pc
        join public.tags t on t.id = pc.tag_id
        join public.flavor_vocab v on v.id = p_vocab_id
       where pc.prompt_id = p_prompt_id
         and (
           position(t.label in v.label) > 0
           or position(v.label in t.label) > 0
           -- 表記をそろえてからも見る。カタカナで書いた同じ語をすり抜けさせない
           or position(public.flavor_normalize(t.label)
                       in public.flavor_normalize(v.label)) > 0
           or position(public.flavor_normalize(v.label)
                       in public.flavor_normalize(t.label)) > 0
           or (t.synonym_group is not null
               and v.synonym_group is not null
               and t.synonym_group = v.synonym_group)
         )
    )
    and not exists (
      -- ④ 人が明示的に禁止した組
      select 1
        from public.prompt_cards pc
        join public.flavor_vocab_blocks b
          on b.tag_id = pc.tag_id and b.vocab_id = p_vocab_id
       where pc.prompt_id = p_prompt_id
    );
$fn$;

comment on function public.flavor_vocab_is_allowed(bigint, uuid) is
  '回答前のフレーバーに、その語をそのお題で使ってよいか（D162 の①〜④）。'
  '候補の提示と保存の両方がこの1本を使う。内部専用。';

revoke all on function public.flavor_vocab_is_allowed(bigint, uuid)
  from public, anon, authenticated;


create or replace function public.get_flavor_vocab(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_prompt_id    uuid;
begin
  if v_uid is null then
    return null;
  end if;

  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
  if v_is_anonymous then
    return null;   -- 登録者のみ（D164）
  end if;

  -- 作者本人の作品だけ。他人の作品の語彙候補は返さない
  -- （どの語が弾かれたかが分かると、正解の輪郭が読めてしまう）
  select w.prompt_id into v_prompt_id
    from public.works w
   where w.id = p_work_id and w.user_id = v_uid and w.deleted_at is null;

  if v_prompt_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'work_id', p_work_id,
    'max_tokens', 12,
    'vocab', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id', v.id,
                 'label', v.label,
                 'kind', v.kind,
                 -- 人が「この正解の間接表現として有効」と登録した語を先に見せる
                 'suggested', exists (
                   select 1 from public.flavor_vocab_allows a
                     join public.prompt_cards pc on pc.tag_id = a.tag_id
                    where a.vocab_id = v.id and pc.prompt_id = v_prompt_id
                 )
               )
               order by v.kind, v.id
             )
        from public.flavor_vocab v
       where v.is_active
         and public.flavor_vocab_is_allowed(v.id, v_prompt_id)
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.get_flavor_vocab(uuid) is
  '作者が自作のフレーバーに使える語彙を返す（D162）。登録者のみ・作者のみ。';


-- ----------------------------------------------------------------------------
-- 8. フレーバーテキストを保存する
-- ----------------------------------------------------------------------------

create or replace function public.set_flavor_text(
  p_work_id   uuid,
  p_vocab_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_prompt_id    uuid;
  v_count        int;
  v_bad          int;
  v_id           bigint;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
  if v_is_anonymous then
    raise exception
      'GUEST_CANNOT_FLAVOR: フレーバーテキストにはアカウント登録が必要です。'
      'ゲストのままでも作品の鑑賞とクイズの回答はできます。';
  end if;

  select w.prompt_id into v_prompt_id
    from public.works w
   where w.id = p_work_id and w.user_id = v_uid and w.deleted_at is null;

  if v_prompt_id is null then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  v_count := coalesce(array_length(p_vocab_ids, 1), 0);

  if v_count < 1 or v_count > 12 then
    raise exception 'BAD_TOKEN_COUNT: 語は1〜12個で選んでください（いま %個）。', v_count;
  end if;

  -- **保存のときも同じ関門を通す。**候補の提示だけで守らない
  select count(*) into v_bad
    from unnest(p_vocab_ids) as x(vocab_id)
   where not public.flavor_vocab_is_allowed(x.vocab_id, v_prompt_id);

  if v_bad > 0 then
    raise exception
      'FLAVOR_LEAK: 回答前に正解が分かってしまう語が%個含まれています。'
      '別の語を選んでください。', v_bad;
  end if;

  insert into public.flavor_texts (work_id, author_id)
  values (p_work_id, v_uid)
  on conflict (work_id) do update
    set updated_at = clock_timestamp()
  returning id into v_id;

  delete from public.flavor_text_tokens t where t.flavor_text_id = v_id;

  insert into public.flavor_text_tokens (flavor_text_id, position, vocab_id)
  select v_id, x.ord - 1, x.vocab_id
    from unnest(p_vocab_ids) with ordinality as x(vocab_id, ord);

  return public.get_work_flavor(p_work_id);
end;
$fn$;

comment on function public.set_flavor_text(uuid, bigint[]) is
  '作者のフレーバーテキストを保存する（D162）。保存時にも①〜④の関門を通す。';


-- ----------------------------------------------------------------------------
-- 9. フレーバーテキストを読む
-- ----------------------------------------------------------------------------
--
-- 【誰に返るか】
--   作者                     … 返る（自分の文章）
--   回答済みの登録者         … 返る（D162 の 4「回答後は必ず開示」）
--   ヒントを開いた登録者     … 返る（D162 の 2）
--   まだ回答もヒントもしていない登録者 … null
--   ゲスト・未サインイン     … null（D164 とユーザー指示）
--
-- 開示の入口を1本にまとめる。open_flavor_hint はこの関数を呼ぶ前に
-- 記録を入れるだけで、文章そのものはここが返す。

create or replace function public.get_work_flavor(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_work         record;
  v_is_author    boolean;
  v_answered     boolean;
  v_hinted       boolean;
begin
  if v_uid is null then
    return null;
  end if;

  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
  if v_is_anonymous then
    return null;   -- 登録者のみ（D164）
  end if;

  select w.id, w.user_id, w.is_published, w.review_status, w.deleted_at
    into v_work
    from public.works w
   where w.id = p_work_id;

  if not found or v_work.deleted_at is not null then
    return null;
  end if;

  v_is_author := v_work.user_id = v_uid;

  -- 作者以外には、公開されている作品だけ
  if not v_is_author
     and not (v_work.is_published and v_work.review_status = 'ok') then
    return null;
  end if;

  select exists (select 1 from public.answers a
                  where a.work_id = p_work_id and a.user_id = v_uid)
    into v_answered;

  select exists (select 1 from public.flavor_hint_views h
                  where h.work_id = p_work_id and h.user_id = v_uid)
    into v_hinted;

  if not v_is_author and not v_answered and not v_hinted then
    return null;
  end if;

  return jsonb_build_object(
    'work_id',    p_work_id,
    'exists',     exists (select 1 from public.flavor_texts f where f.work_id = p_work_id),
    'is_author',  v_is_author,
    'hint_used',  v_hinted,
    'revealed',   v_answered or v_is_author,
    'tokens', coalesce((
      select jsonb_agg(v.label order by tk.position)
        from public.flavor_texts f
        join public.flavor_text_tokens tk on tk.flavor_text_id = f.id
        join public.flavor_vocab v on v.id = tk.vocab_id
       where f.work_id = p_work_id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.get_work_flavor(uuid) is
  'フレーバーテキストを返す（D162）。作者・回答済み・ヒントを開いた人だけ。'
  'ゲストと未サインインには null（D164）。';


-- ----------------------------------------------------------------------------
-- 10. ヒントとして開く
-- ----------------------------------------------------------------------------
--
-- 開いた事実をここで記録する。**画面の申告は使わない。**

create or replace function public.open_flavor_hint(p_work_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_work         record;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
  if v_is_anonymous then
    raise exception
      'GUEST_CANNOT_FLAVOR: ヒントを開くにはアカウント登録が必要です。'
      'ゲストのままでもクイズには回答できます。';
  end if;

  select w.id, w.user_id
    into v_work
    from public.works w
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  if v_work.user_id = v_uid then
    raise exception 'AUTHOR_NO_HINT: 自分の作品にヒントはありません。';
  end if;

  if not exists (select 1 from public.flavor_texts f where f.work_id = p_work_id) then
    raise exception 'NO_FLAVOR: この作品にはフレーバーテキストがありません。';
  end if;

  -- すでに回答済みなら、それは開示であってヒントではない。記録を増やさない
  if not exists (select 1 from public.answers a
                  where a.work_id = p_work_id and a.user_id = v_uid) then
    insert into public.flavor_hint_views (work_id, user_id)
    values (p_work_id, v_uid)
    on conflict (work_id, user_id) do nothing;
  end if;

  return public.get_work_flavor(p_work_id);
end;
$fn$;

comment on function public.open_flavor_hint(uuid) is
  '回答前に任意でフレーバーをヒントとして開く（D162）。開いた事実を記録する。'
  '減点はしない。登録者のみ（D164）。';


-- ----------------------------------------------------------------------------
-- 11. 返歌
-- ----------------------------------------------------------------------------
--
-- **正誤判定を設けない。**開示済みの正解タグを直接使える。

create or replace function public.post_flavor_reply(
  p_work_id uuid,
  p_tokens  jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_work         record;
  v_count        int;
  v_bad          int;
  v_reply_id     bigint;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
  if v_is_anonymous then
    raise exception
      'GUEST_CANNOT_FLAVOR: 返歌にはアカウント登録が必要です。';
  end if;

  select w.id, w.prompt_id, w.user_id
    into v_work
    from public.works w
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  -- 回答してからでないと返歌できない（D162 の 7 は開示のあと）
  if not exists (select 1 from public.answers a
                  where a.work_id = p_work_id and a.user_id = v_uid) then
    raise exception
      'NOT_ANSWERED_YET: 先にクイズへ回答してください。返歌は開示のあとです。';
  end if;

  if p_tokens is null or jsonb_typeof(p_tokens) <> 'array' then
    raise exception 'BAD_TOKENS: 返歌の形式が正しくありません。';
  end if;

  select count(*) into v_count from jsonb_array_elements(p_tokens);

  if v_count < 1 or v_count > 12 then
    raise exception 'BAD_TOKEN_COUNT: 語は1〜12個で選んでください（いま %個）。', v_count;
  end if;

  -- 使えるのは「確認済みの制限語彙」か「そのお題の正解タグ」だけ。
  -- 正解タグは開示済みなので、そのまま置いてよい（D162）。
  -- **他のお題のタグは置けない。**置けると、そこから語彙表を作られる。
  select count(*) into v_bad
    from jsonb_array_elements(p_tokens) x
   where not (
     (x ->> 'vocab_id' is not null
       and exists (select 1 from public.flavor_vocab v
                    where v.id = (x ->> 'vocab_id')::bigint
                      and v.is_active and v.is_reviewed))
     or
     (x ->> 'tag_id' is not null
       and exists (select 1 from public.prompt_cards pc
                    where pc.prompt_id = v_work.prompt_id
                      and pc.tag_id = (x ->> 'tag_id')::bigint))
   );

  if v_bad > 0 then
    raise exception 'BAD_TOKEN: 使えない語が%個含まれています。', v_bad;
  end if;

  insert into public.flavor_replies (work_id, user_id)
  values (p_work_id, v_uid)
  on conflict (work_id, user_id) do update
    set created_at = flavor_replies.created_at
  returning id into v_reply_id;

  delete from public.flavor_reply_tokens t where t.reply_id = v_reply_id;

  insert into public.flavor_reply_tokens (reply_id, position, vocab_id, tag_id)
  select v_reply_id,
         (x.ord - 1)::int,
         nullif(x.value ->> 'vocab_id', '')::bigint,
         nullif(x.value ->> 'tag_id', '')::bigint
    from jsonb_array_elements(p_tokens) with ordinality as x(value, ord);

  return public.get_flavor_replies(p_work_id);
end;
$fn$;

comment on function public.post_flavor_reply(uuid, jsonb) is
  '返歌を送る（D162）。正誤判定は無い。開示済みの正解タグをそのまま使える。'
  '登録者のみ・回答済みのみ。';


-- ----------------------------------------------------------------------------
-- 12. 返歌を読む
-- ----------------------------------------------------------------------------
--
-- **返歌には正解タグが入りうる。**だから読めるのは
-- 「作者」と「その作品に回答済みの人」だけ。
-- ここを緩めると、未回答者が返歌から正解を読めるようになる。

create or replace function public.get_flavor_replies(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_work  record;
begin
  if v_uid is null then
    return null;
  end if;

  select w.id, w.user_id into v_work
    from public.works w
   where w.id = p_work_id and w.deleted_at is null;

  if not found then
    return null;
  end if;

  if v_work.user_id <> v_uid
     and not exists (select 1 from public.answers a
                      where a.work_id = p_work_id and a.user_id = v_uid) then
    return null;
  end if;

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id', r.id,
               'is_mine', r.user_id = v_uid,
               'author_display_name', pr.display_name,
               'author_handle', pr.handle,
               'created_at', r.created_at,
               'tokens', (
                 select coalesce(jsonb_agg(
                          coalesce(v.label, tg.label) order by t.position), '[]'::jsonb)
                   from public.flavor_reply_tokens t
                   left join public.flavor_vocab v on v.id = t.vocab_id
                   left join public.tags tg on tg.id = t.tag_id
                  where t.reply_id = r.id
               )
             )
             order by r.created_at desc
           )
      from public.flavor_replies r
      join public.profiles pr on pr.id = r.user_id
     where r.work_id = p_work_id
  ), '[]'::jsonb);
end;
$fn$;

comment on function public.get_flavor_replies(uuid) is
  '返歌の一覧（D162）。**回答済みの人と作者だけ。**返歌には正解タグが入りうるため。';


-- ----------------------------------------------------------------------------
-- 13. ヒント使用別の集計を作者へ返す
-- ----------------------------------------------------------------------------

create or replace function public.get_my_work_hint_result(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return null;
  end if;

  if not exists (
    select 1 from public.works w
     where w.id = p_work_id and w.user_id = v_uid
  ) then
    return null;
  end if;

  return jsonb_build_object(
    'work_id', p_work_id,
    'rows', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'hint_used',     s.hint_used,
                 'answers_count', s.answers_count,
                 'total_items',   s.total_items,
                 'correct_items', s.correct_items
               )
               order by s.hint_used
             )
        from public.work_hint_stats s
       where s.work_id = p_work_id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.get_my_work_hint_result(uuid) is
  'ヒントを使った回答と使わなかった回答の正答率を分けて返す（D162）。作者のみ。';


-- ----------------------------------------------------------------------------
-- 14. submit_answer ／ ヒント使用をサーバー側で決める
-- ----------------------------------------------------------------------------
--
-- 【旧版からの変更点は2つだけ】
--   ・answers へ hint_used を入れる。値は flavor_hint_views の行の有無から取る
--   ・**引数は増やさない。**画面から「使いました」と申告させない
--
-- 採点・検査の中身は1行も変えていない。

create or replace function public.submit_answer(
  p_work_id    uuid,
  p_selections jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid            uuid := (select auth.uid());
  v_work           record;
  v_question_count int;
  v_sel_count      int;
  v_distinct_count int;
  v_valid_count    int;
  v_correct_count  int;
  v_answer_id      bigint;
  v_hint_used      boolean;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select w.id, w.user_id, w.prompt_id
    into v_work
    from public.works w
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  if v_work.user_id = v_uid then
    raise exception
      'AUTHOR_CANNOT_ANSWER: 自分の作品には回答できません。'
      '答えを知っているため、正答率が実際より高く出てしまいます。';
  end if;

  if exists (
    select 1 from public.answers a
     where a.work_id = p_work_id and a.user_id = v_uid
  ) then
    raise exception
      'ALREADY_ANSWERED: この作品にはもう回答しています。やり直しはできません。';
  end if;

  if p_selections is null or jsonb_typeof(p_selections) <> 'array' then
    raise exception 'BAD_SELECTIONS: 回答の形式が正しくありません。';
  end if;

  select count(*) into v_question_count
    from public.quiz_questions q
   where q.prompt_id = v_work.prompt_id;

  select count(*), count(distinct (x ->> 'question_id'))
    into v_sel_count, v_distinct_count
    from jsonb_array_elements(p_selections) x;

  if v_sel_count <> v_question_count then
    raise exception 'INCOMPLETE_ANSWER: %問すべてに答えてください（いま %問）。',
      v_question_count, v_sel_count;
  end if;

  if v_distinct_count <> v_sel_count then
    raise exception 'DUPLICATE_QUESTION: 同じ問に2回答えることはできません。';
  end if;

  select count(*)
    into v_valid_count
    from jsonb_array_elements(p_selections) x
    join public.quiz_questions q
      on q.id = (x ->> 'question_id')::bigint
     and q.prompt_id = v_work.prompt_id
    join public.quiz_choices ch
      on ch.question_id = q.id
     and ch.tag_id = (x ->> 'tag_id')::bigint;

  if v_valid_count <> v_sel_count then
    raise exception
      'BAD_SELECTION: 選択肢にない答えが含まれています。画面を開き直してください。';
  end if;

  select count(*)
    into v_correct_count
    from jsonb_array_elements(p_selections) x
    join public.quiz_questions q
      on q.id = (x ->> 'question_id')::bigint
     and q.prompt_id = v_work.prompt_id
    join public.quiz_choices ch
      on ch.question_id = q.id
     and ch.tag_id = (x ->> 'tag_id')::bigint
     and ch.is_correct;

  -- **ここがヒント使用の判定。**画面からの申告ではなく記録を見る（D162）
  select exists (
    select 1 from public.flavor_hint_views h
     where h.work_id = p_work_id and h.user_id = v_uid
  ) into v_hint_used;

  -- 【二重送信への備え。20260804160000 で入れた包みを、ここでも保つ】
  --   事前の検査（第4節）と insert の間には、ごく短いすき間がある。
  --   同時に2本届くと両方が検査を通り抜け、あとの1本が一意索引に当たる。
  --   素の Postgres エラーは利用者に意味が通じないので、
  --   **事前検査と同じ文言**へ変換する。速く二度押ししたかどうかで
  --   説明が変わらないようにするため。
  begin
    insert into public.answers (work_id, user_id, correct_count, hint_used)
    values (p_work_id, v_uid, v_correct_count, v_hint_used)
    returning id into v_answer_id;
  exception when unique_violation then
    raise exception
      'ALREADY_ANSWERED: この作品にはもう回答しています。やり直しはできません。';
  end;

  insert into public.answer_items
    (answer_id, question_id, card_slot_key, selected_tag_id, is_correct)
  select v_answer_id,
         q.id,
         q.card_slot_key,
         ch.tag_id,
         ch.is_correct
    from jsonb_array_elements(p_selections) x
    join public.quiz_questions q
      on q.id = (x ->> 'question_id')::bigint
     and q.prompt_id = v_work.prompt_id
    join public.quiz_choices ch
      on ch.question_id = q.id
     and ch.tag_id = (x ->> 'tag_id')::bigint;

  return public.get_my_answer(p_work_id);
end;
$fn$;

comment on function public.submit_answer(uuid, jsonb) is
  'クイズを採点して保存し、正解を返す。ヒントを使ったかは flavor_hint_views から'
  'サーバー側で決める（D162）。減点はしない。';


-- ----------------------------------------------------------------------------
-- 15. 実行権限
-- ----------------------------------------------------------------------------
--
-- authenticated には匿名ゲストも含まれる。ゲストを止めるのは関数の中の
-- is_anonymous 判定で、権限では止めない（既存の create_work と同じ形）。

revoke all on function public.get_flavor_vocab(uuid)          from public, anon, authenticated;
revoke all on function public.set_flavor_text(uuid, bigint[]) from public, anon, authenticated;
revoke all on function public.get_work_flavor(uuid)           from public, anon, authenticated;
revoke all on function public.open_flavor_hint(uuid)          from public, anon, authenticated;
revoke all on function public.post_flavor_reply(uuid, jsonb)  from public, anon, authenticated;
revoke all on function public.get_flavor_replies(uuid)        from public, anon, authenticated;
revoke all on function public.get_my_work_hint_result(uuid)   from public, anon, authenticated;
revoke all on function public.submit_answer(uuid, jsonb)      from public, anon, authenticated;

grant execute on function public.get_flavor_vocab(uuid)          to authenticated;
grant execute on function public.set_flavor_text(uuid, bigint[]) to authenticated;
grant execute on function public.get_work_flavor(uuid)           to authenticated;
grant execute on function public.open_flavor_hint(uuid)          to authenticated;
grant execute on function public.post_flavor_reply(uuid, jsonb)  to authenticated;
grant execute on function public.get_flavor_replies(uuid)        to authenticated;
grant execute on function public.get_my_work_hint_result(uuid)   to authenticated;
grant execute on function public.submit_answer(uuid, jsonb)      to authenticated;


-- ----------------------------------------------------------------------------
-- 16. 「この作品に文章があるか」だけを返す
-- ----------------------------------------------------------------------------
--
-- 【なぜ本文と分けるのか】
--   回答前の画面に「ヒントを開く」を出すかどうかを決めたい。
--   本文を返す get_work_flavor は、まだ開いていない人には null を返すので、
--   「文章が無い」のか「まだ開いていない」のかが画面から区別できない。
--
--   有無だけなら漏れない。**中身は1文字も返さない。**
--   語数も返さない（語数から内容は分からないが、返す理由も無い）。

create or replace function public.work_has_flavor(p_work_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.flavor_texts f
      join public.works w on w.id = f.work_id
     where f.work_id = p_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
  );
$fn$;

comment on function public.work_has_flavor(uuid) is
  '作品にフレーバーテキストがあるかだけを返す（D162）。本文は返さない。';

revoke all on function public.work_has_flavor(uuid)
  from public, anon, authenticated;
grant execute on function public.work_has_flavor(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 17. 返歌で使える語の一覧
-- ----------------------------------------------------------------------------
--
-- 【作者向けの一覧（get_flavor_vocab）と何が違うか】
--   あちらは「そのお題の正解に近すぎる語を外した一覧」。
--   こちらは**外さない。**返歌は回答後なので、正解はもう開示されている。
--   正解の語そのものは、お題のカードから選ばせる（この一覧には入れない）。
--
--   お題に依存しないので、引数も要らない。

create or replace function public.get_reply_vocab()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('id', v.id, 'label', v.label, 'kind', v.kind, 'suggested', false)
      order by v.kind, v.id
    ),
    '[]'::jsonb
  )
  from public.flavor_vocab v
 where v.is_active and v.is_reviewed;
$fn$;

comment on function public.get_reply_vocab() is
  '返歌で使えるつなぎの語の一覧（D162）。お題に依存しない。正解の語は含まない。';

revoke all on function public.get_reply_vocab() from public, anon, authenticated;
grant execute on function public.get_reply_vocab() to authenticated;
