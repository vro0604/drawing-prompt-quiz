-- ============================================================================
-- consent_gate_and_flavor_compose ／ 規約同意の関門と、文章の組み立て（P5）
-- ============================================================================
--
-- 【この1本で入るもの】
--   1. 規約同意の関門     … 「いつ同意を求めるか」を DB 側で決める
--   2. 語彙の分類         … 語を探すための入れ物。**枠（何語まで）ではない**
--   3. 助詞               … 語彙の一員として足す。別の入力欄は作らない
--   4. 文の区切り         … 作者が「ここで文が終わる」を決められるようにする
--
--   時計（制作中の残り時間）は DB を変えない。既に get_active_challenge 1本が
--   持っていて、増やす必要が無い。
--
-- 【1. 同意の関門が答えたい問い】
--   「いま有効な版に同意していない人を、どの時点で止めるか」。
--
--   止める時点を間違えると2つの事故が起きる。
--     ・早すぎる … この migration を当てた瞬間、いま作業中の人が全員止まる
--     ・遅すぎる … 登録したばかりの人が、同意しないまま使い始める
--
--   分かれ目は「そのセッションが、いつ始まったか」。
--
--   【iat（発行時刻）ではなく amr を見る理由】
--     iat は**アクセス券そのものが作られた時刻**で、券は1時間ごとに
--     作り直される。iat を使うと、ログインしっぱなしの人でも1時間後には
--     「たったいま始まったセッション」に見えてしまい、
--     **作業の途中で同意画面へ飛ばすことになる。**
--
--     amr（どうやって本人だと確かめたか）には、その確認をした時刻が入っていて、
--     券を作り直しても変わらない。**ログインした時刻そのもの。**
--     ここが見たいのはそちらなので、amr を使う。
--     amr が無いときだけ iat に落とす（そのときは1時間ぶんの粗さが残る）。
--
--   この時刻と
--     ・関門を置いた時刻（consent_gate.installed_at）
--     ・未同意の版を掲示した時刻（published_at）
--   の遅いほうを比べる。**セッションのほうが後なら止める。**
--
--     登録したばかり           iat は今 → 止める
--     いま作業中の既存利用者   iat は関門より前 → 止めない
--     その人が次にログインする iat は関門より後 → 止める
--     規約を改定した直後       改定前に始まったセッションは止めない
--     改定後にログインした人   止める
--
--   これで「migration を当てた瞬間に全員が使えなくなる」ことも、
--   「作業の途中で画面が同意画面に変わる」ことも起きない。
--
--   **iat が読めないときは止めない。**止める根拠が無いのに止めると、
--   作業中の人を巻き込む。投稿そのものは app_guard_works が別に止めている。
--
-- 【2〜4. 文章の組み立て】
--   これまで作者が作れたのは「語を12個並べたもの」だけだった。
--   足りていなかったのは3つ。
--     ・語を探す道 … 90語が品詞ごとに一列に並ぶだけで、探せない
--     ・助詞       … 「影 消える」としか書けない
--     ・文の区切り … 何語並べても1文
--
--   分類は探すためだけに使う。**分類ごとに何語まで、という枠は作らない。**
--   同じ分類から5語選んで、他の分類が0語でもよい。
--
--   助詞は語彙の一員にした。別の入力欄にしない理由は、
--   **正解を漏らさないための関門（①〜④）を1本のままにする**ため。
--   入力の道が2本あると、片方だけ関門を通ることになる。
--
--   句読点は語彙に入れない。文の終わりは語の属性（break_after）として持つ。
--   「。」は表示のときに付ける。**作者が打つ記号ではなく、区切りの結果。**
-- ============================================================================


-- ============================================================================
-- 1. 規約同意の関門
-- ============================================================================

-- 関門を置いた時刻。**1行しか入らない。**
-- この時刻より前に始まったセッションは、関門の対象にしない。
create table if not exists public.consent_gate (
  id boolean primary key default true
    constraint consent_gate_single_row check (id),
  installed_at timestamptz not null default now()
);

comment on table public.consent_gate is
  '規約同意の関門を置いた時刻（P5）。この時刻より前に始まったセッションは止めない。'
  '当てた瞬間に作業中の利用者を巻き込まないための基準点。1行だけ。';

alter table public.consent_gate enable row level security;
revoke all on table public.consent_gate from public, anon, authenticated;

insert into public.consent_gate (id) values (true) on conflict (id) do nothing;


-- --- 1-b. consent_status ／ いまの同意の状態と、止めるべきかを返す -------------
--
-- **画面が判定しない。**画面はこの関数が返した gate_required を見るだけで、
-- 版の比較も時刻の比較もしない。

create or replace function public.consent_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid            uuid := (select auth.uid());
  v_anon           boolean;
  v_terms_ver      text;
  v_terms_at       timestamptz;
  v_privacy_ver    text;
  v_privacy_at     timestamptz;
  v_terms_ok       boolean := false;
  v_privacy_ok     boolean := false;
  v_iat            timestamptz;
  v_installed      timestamptz;
  v_since          timestamptz;
  v_needs          boolean;
  v_started        double precision;
begin
  if v_uid is null then
    return null;
  end if;

  select tv.version, tv.published_at into v_terms_ver, v_terms_at
    from public.terms_versions tv where tv.is_current;
  select pv.version, pv.published_at into v_privacy_ver, v_privacy_at
    from public.privacy_versions pv where pv.is_current;

  v_anon := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);

  -- ゲストは登録していない。**同意の対象ではない。**
  -- ここで止めると、ゲストのまま遊べるという入口の仕様（spec 11-1）が壊れる。
  if v_anon then
    return jsonb_build_object(
      'is_anonymous',       true,
      'terms_version',      v_terms_ver,
      'privacy_version',    v_privacy_ver,
      'terms_agreed',       false,
      'privacy_agreed',     false,
      'needs_consent',      false,
      'gate_required',      false,
      'session_started_at', null
    );
  end if;

  select exists (
    select 1 from public.terms_agreements ta
     where ta.user_id = v_uid and ta.doc_kind = 'terms' and ta.version = v_terms_ver
  ) into v_terms_ok;

  select exists (
    select 1 from public.terms_agreements ta
     where ta.user_id = v_uid and ta.doc_kind = 'privacy' and ta.version = v_privacy_ver
  ) into v_privacy_ok;

  v_needs := not (v_terms_ok and v_privacy_ok);

  -- ログインした時刻。amr（本人確認の記録）にある時刻を使う。
  -- **券を作り直しても変わらない値。**無ければ iat に落とし、
  -- どちらも無ければ null（＝止める根拠が無い）。
  select max((e ->> 'timestamp')::double precision) into v_started
    from jsonb_array_elements(
           case when jsonb_typeof((select auth.jwt()) -> 'amr') = 'array'
                then (select auth.jwt()) -> 'amr'
                else '[]'::jsonb end
         ) e
   where jsonb_typeof(e -> 'timestamp') = 'number';

  if v_started is null then
    v_started := nullif((select auth.jwt()) ->> 'iat', '')::double precision;
  end if;

  v_iat := to_timestamp(v_started);

  select g.installed_at into v_installed from public.consent_gate g where g.id;

  -- 止める基準の時刻。**未同意の版の掲示時刻と、関門を置いた時刻の遅いほう。**
  -- greatest は null を読み飛ばすので、片方だけ未同意でも正しく取れる。
  v_since := greatest(
    v_installed,
    case when not v_terms_ok   then v_terms_at   end,
    case when not v_privacy_ok then v_privacy_at end
  );

  return jsonb_build_object(
    'is_anonymous',       false,
    'terms_version',      v_terms_ver,
    'privacy_version',    v_privacy_ver,
    'terms_agreed',       v_terms_ok,
    'privacy_agreed',     v_privacy_ok,
    'needs_consent',      v_needs,
    'gate_required',
      v_needs and v_iat is not null and v_since is not null and v_iat >= v_since,
    'session_started_at', v_iat
  );
end;
$fn$;

comment on function public.consent_status() is
  'いま有効な版への同意の有無と、この場で止めるべきか（P5）。'
  '止めるのは、ログインが関門より後で、かつ未同意のときだけ。'
  'ログインの時刻は amr（本人確認の記録）から取る。iat は券を作り直すたびに変わるため。';

revoke all on function public.consent_status() from public, anon;
grant execute on function public.consent_status() to authenticated;


-- ============================================================================
-- 2. 語彙の分類（探すための入れ物。枠ではない）
-- ============================================================================
--
-- 【分類ごとの上限を作らない】
--   同じ分類から5語、別の分類から0語でもよい。
--   分類は「どこを探せばあるか」を示すためだけに置く。
--   お題の語彙（draw_categories）は分類ごとに枠を持っているが、
--   **あれとは別のもの。**同じ形にしない。

create table if not exists public.flavor_vocab_categories (
  key text primary key
    constraint flavor_vocab_categories_key_format check (key ~ '^[a-z_]{2,24}$'),
  label text not null
    constraint flavor_vocab_categories_label_length check (char_length(label) between 1 and 20),
  hint text
    constraint flavor_vocab_categories_hint_length check (hint is null or char_length(hint) <= 60),
  sort_order int not null default 100
);

comment on table public.flavor_vocab_categories is
  'フレーバー語彙の分類（P5）。語を探すための入れ物で、選べる数の枠ではない。';

alter table public.flavor_vocab_categories enable row level security;
revoke all on table public.flavor_vocab_categories from public, anon, authenticated;

insert into public.flavor_vocab_categories (key, label, hint, sort_order) values
  ('thing',      'もの',   '手に取れるもの、名づけられるもの',      10),
  ('place',      '場所',   'どこか。位置と向き',                    20),
  ('phenomenon', '現象',   '起きていること。光・音・気配',          30),
  ('motion',     '動き',   'すること。起きること',                  40),
  ('state',      'ようす', 'どんなふうか',                          50),
  ('relation',   '関係',   '数、対応、どちらか',                    60),
  ('particle',   '助詞',   '語と語をつなぐ「が」「を」「に」など',  70),
  ('connective', 'つなぎ', '文と文の間に置く語',                    80),
  ('proper',     '名',     '固有の名前',                            90)
on conflict (key) do update
  set label = excluded.label, hint = excluded.hint, sort_order = excluded.sort_order;


-- 語に分類を持たせる。**品詞（kind）とは別の軸。**
-- kind は並べ方に使い、分類は探し方に使う。
alter table public.flavor_vocab
  add column if not exists category_key text
    references public.flavor_vocab_categories (key) on update restrict;

comment on column public.flavor_vocab.category_key is
  '語を探すための分類（P5）。選べる数の枠ではない。品詞（kind）とは別の軸。';


-- 品詞に「助詞」と「状態語」を足す。
-- **形容詞中心にしない**ため、形容詞に寄せずに別の値として持つ。
alter table public.flavor_vocab drop constraint if exists flavor_vocab_kind_valid;
alter table public.flavor_vocab
  add constraint flavor_vocab_kind_valid
    check (kind in ('connective', 'noun', 'verb', 'adjective', 'particle', 'state'));


-- --- 2-b. いまある90語に分類を振る -------------------------------------------
--
-- まず品詞から機械的に振り、そのあと場所・現象・関係にあたる語だけを直す。

update public.flavor_vocab set category_key =
  case kind
    when 'connective' then 'connective'
    when 'verb'       then 'motion'
    when 'adjective'  then 'state'
    else 'thing'
  end
 where category_key is null;

update public.flavor_vocab set category_key = 'place'
 where label in ('境界','余白','中心','端','裏','表','間','方角','輪郭');

update public.flavor_vocab set category_key = 'phenomenon'
 where label in ('影','音','匂い','気配','痕跡');

update public.flavor_vocab set category_key = 'relation'
 where label in ('距離','順番','理由','答え','問い');


-- --- 2-c. 足す語 --------------------------------------------------------------
--
-- 【選び方は既存90語と同じ】
--   どの1語も、単独では特定の正解タグを指さないものだけ。
--   狭い語（そのまま正解になりうる語）は入れない。
--
-- 【is_reviewed = true の意味】
--   **私が1語ずつ目で見た**、という意味であって、
--   ユーザーの承認を受けたという意味ではない。ここは既存90語と同じ扱い。
--
-- 【「名」（固有名詞）は0語で置く】
--   分類は作るが、語は入れない。**安全だと1語ずつ確かめられた固有名詞が
--   まだ無いため。**固有名詞は、正解タグとの関係が語ごとに違う。
--   構造としては受け入れられる（分類も品詞もある）ので、
--   確かめた語ができたときに insert 1本で足せる。

insert into public.flavor_vocab (label, kind, category_key, reading, is_reviewed) values
  -- 助詞（16）。**別の入力欄にせず語彙の一員にする**
  ('が','particle','particle','が',true), ('を','particle','particle','を',true),
  ('に','particle','particle','に',true), ('へ','particle','particle','へ',true),
  ('と','particle','particle','と',true), ('の','particle','particle','の',true),
  ('も','particle','particle','も',true), ('は','particle','particle','は',true),
  ('で','particle','particle','で',true), ('から','particle','particle','から',true),
  ('まで','particle','particle','まで',true), ('より','particle','particle','より',true),
  ('ほど','particle','particle','ほど',true), ('だけ','particle','particle','だけ',true),
  ('ながら','particle','particle','ながら',true), ('ずつ','particle','particle','ずつ',true),

  -- 場所（14）。**指し示す語と相対的な位置だけ。**地名や地形は入れない
  ('ここ','noun','place','ここ',true), ('そこ','noun','place','そこ',true),
  ('あそこ','noun','place','あそこ',true), ('どこか','noun','place','どこか',true),
  ('奥','noun','place','おく',true), ('手前','noun','place','てまえ',true),
  ('上','noun','place','うえ',true), ('下','noun','place','した',true),
  ('外','noun','place','そと',true), ('内','noun','place','うち',true),
  ('隅','noun','place','すみ',true), ('先','noun','place','さき',true),
  ('後ろ','noun','place','うしろ',true), ('向こう','noun','place','むこう',true),

  -- 関係（14）
  ('誰か','noun','relation','だれか',true), ('何か','noun','relation','なにか',true),
  ('ひとつ','noun','relation','ひとつ',true), ('ふたつ','noun','relation','ふたつ',true),
  ('いくつ','noun','relation','いくつ',true), ('すべて','noun','relation','すべて',true),
  ('どれも','noun','relation','どれも',true), ('互い','noun','relation','たがい',true),
  ('ほか','noun','relation','ほか',true), ('同じ','noun','relation','おなじ',true),
  ('別','noun','relation','べつ',true), ('隣','noun','relation','となり',true),
  ('片方','noun','relation','かたほう',true), ('両方','noun','relation','りょうほう',true),

  -- 現象（12）
  ('光','noun','phenomenon','ひかり',true), ('風','noun','phenomenon','かぜ',true),
  ('熱','noun','phenomenon','ねつ',true), ('揺れ','noun','phenomenon','ゆれ',true),
  ('響き','noun','phenomenon','ひびき',true), ('静けさ','noun','phenomenon','しずけさ',true),
  ('ざわめき','noun','phenomenon','ざわめき',true), ('傷','noun','phenomenon','きず',true),
  ('ひび','noun','phenomenon','ひび',true), ('反射','noun','phenomenon','はんしゃ',true),
  ('沈黙','noun','phenomenon','ちんもく',true), ('残響','noun','phenomenon','ざんきょう',true),

  -- もの（8）
  ('もの','noun','thing','もの',true), ('こと','noun','thing','こと',true),
  ('ところ','noun','thing','ところ',true), ('ひと','noun','thing','ひと',true),
  ('数','noun','thing','かず',true), ('形','noun','thing','かたち',true),
  ('色','noun','thing','いろ',true), ('跡','noun','thing','あと',true),

  -- 動き（8）
  ('探す','verb','motion','さがす',true), ('待つ','verb','motion','まつ',true),
  ('越える','verb','motion','こえる',true), ('くぐる','verb','motion','くぐる',true),
  ('戻る','verb','motion','もどる',true), ('進む','verb','motion','すすむ',true),
  ('隠す','verb','motion','かくす',true), ('見失う','verb','motion','みうしなう',true),

  -- ようす（10）。**形容詞ではない状態語**を別の品詞として持つ
  ('そのまま','state','state','そのまま',true), ('ひとりきり','state','state','ひとりきり',true),
  ('半ば','state','state','なかば',true), ('途中','state','state','とちゅう',true),
  ('逆さ','state','state','さかさ',true), ('裏返し','state','state','うらがえし',true),
  ('まっすぐ','state','state','まっすぐ',true), ('ばらばら','state','state','ばらばら',true),
  ('ひとつづき','state','state','ひとつづき',true), ('かすか','state','state','かすか',true),

  -- つなぎ（6）
  ('あるいは','connective','connective','あるいは',true), ('しかし','connective','connective','しかし',true),
  ('ときに','connective','connective','ときに',true), ('いまも','connective','connective','いまも',true),
  ('なぜなら','connective','connective','なぜなら',true), ('ふたたび','connective','connective','ふたたび',true)
on conflict (label) do nothing;


-- 分類の無い語を残さない。**後から足した語が一覧から消えるのを防ぐ**
--
-- 【既定を置く理由】
--   分類を書き忘れて足した語は、どの分類にも入らないので
--   **画面の一覧から静かに消える。**消えたことは誰も気づけない。
--   既定を置けば、少なくとも「もの」の中に出てくるので見つかる。
--   分類が違うのは直せるが、消えているものは探せない。
update public.flavor_vocab set category_key = 'thing' where category_key is null;
alter table public.flavor_vocab alter column category_key set default 'thing';
alter table public.flavor_vocab alter column category_key set not null;


-- ============================================================================
-- 3. 文の区切りと、語数の上限
-- ============================================================================
--
-- 【2つの上限は別のもの】
--   ・技術上の上限（24語）… DOM と DB を守るための数。
--                            これを超えると保存を断る
--   ・文章としての上限（3文）… 仕様として決まっている数
--
--   語数のほうは**プロダクトとしての上限が未決**なので、技術上の上限と
--   同じ 24 にしてある。**暫定（私が設定）。**decisions に残す。
--   もとの 12 から広げたのは、3文にすると 12 語では1文4語になるため。
--
-- 【区切りは語の属性にする】
--   「この語のあとで文が終わる」を語ごとに持つ。別の表を作らない。
--   最後の語は必ず文の終わりなので、印は付けない。
--   したがって印は最大2つ（＝3文）。

alter table public.flavor_text_tokens
  drop constraint if exists flavor_text_tokens_position_range;
alter table public.flavor_text_tokens
  add constraint flavor_text_tokens_position_range check (position between 0 and 23);

alter table public.flavor_text_tokens
  add column if not exists break_after boolean not null default false;

comment on column public.flavor_text_tokens.break_after is
  'この語のあとで文が終わるか（P5）。作者が決める。最後の語には付けない。'
  '句読点そのものは保存しない。「。」は表示のときに付ける。';


-- --- 3-b. 助詞を、語の重なりの関門から外す ------------------------------------
--
-- 【なぜ外すか】
--   関門は「その語が正解の言い換えになっていないか」を見るためのもの。
--   ところが助詞は、正解タグの中にたまたま入っていることがある
--   （正解が「のこぎり」のとき、助詞の「の」が文字として含まれてしまう）。
--   **助詞が正解を言い換えることはありえない**ので、
--   これは誤って弾いているだけで、守りにはなっていない。
--   全部の助詞が消えると、文が「影 消える」の形からいつまでも出られない。
--
--   外すのは自動の判定（表記・部分一致・読み・漢字・同義グループ）だけ。
--   **人が1件ずつ登録した禁止（manual）は助詞にも効く。**
--   自動で拾えないものを止めるための欄なので、ここは残す。
--
-- 【この関数を作り直す理由】
--   判定は flavor_block_reason 1本に集めてある（2026-09-05）。
--   助詞の扱いも、その1本の中に置く。呼ぶ側（候補の提示・保存・検査）は
--   どれも変えない。**判定を2か所に分けない。**

create or replace function public.flavor_block_reason(
  p_vocab_id bigint,
  p_tag_id   bigint
)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select case
    when v.label is null or t.label is null then null

    -- 助詞は自動の判定を通さない。**人が登録した禁止だけ見る**（P5）
    when v.kind = 'particle' then (
      select case when exists (
        select 1 from public.flavor_vocab_blocks b
         where b.vocab_id = p_vocab_id and b.tag_id = p_tag_id
      ) then 'manual' else null end
    )

    when public.flavor_normalize(v.label) = public.flavor_normalize(t.label)
      then 'exact'

    when position(t.label in v.label) > 0
      or position(v.label in t.label) > 0
      or position(public.flavor_normalize(t.label) in public.flavor_normalize(v.label)) > 0
      or position(public.flavor_normalize(v.label) in public.flavor_normalize(t.label)) > 0
      then 'substring'

    -- 読みが同じ（漢字とかなの言い換え。「馬」と「うま」）
    when v.reading is not null and t.reading is not null
     and public.flavor_normalize(v.reading) = public.flavor_normalize(t.reading)
      then 'reading'

    -- 漢字を1文字でも共有する（「古い」と「古書」）
    when exists (
      select 1
        from regexp_split_to_table(v.label, '') c
       where c ~ '[一-鿿]'
         and position(c in t.label) > 0
    ) then 'kanji'

    when v.synonym_group is not null and t.synonym_group is not null
     and v.synonym_group = t.synonym_group
      then 'synonym'

    when exists (
      select 1 from public.flavor_vocab_blocks b
       where b.vocab_id = p_vocab_id and b.tag_id = p_tag_id
    ) then 'manual'

    else null
  end
  from (select label, reading, synonym_group, kind
          from public.flavor_vocab where id = p_vocab_id) v
  full outer join (select label, reading, synonym_group
                     from public.tags where id = p_tag_id) t
    on true;
$fn$;

comment on function public.flavor_block_reason(bigint, bigint) is
  'そのヒント語を、その正解語のお題で使えない理由を1語で返す（使えるなら null）。'
  '助詞は自動の判定を通さず、人が登録した禁止だけを見る（P5）。'
  '候補の提示・保存・検査の3つが、この1本だけを見る。';

revoke all on function public.flavor_block_reason(bigint, bigint)
  from public, anon, authenticated;


-- --- 3-c. 上限を1か所で決める -------------------------------------------------
--
-- 画面にも試験にも数を書き写さない。**ここが唯一の出どころ。**

create or replace function public.flavor_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'max_tokens',    24,   -- 技術上の上限。DOM と DB を守るための数
    'max_sentences', 3     -- 文章としての上限（仕様）
  );
$fn$;

comment on function public.flavor_limits() is
  'フレーバーの上限（P5）。語数は技術上の上限、文数は仕様上の上限。'
  '画面も試験もこの値を読む。書き写さない。';

revoke all on function public.flavor_limits() from public, anon, authenticated;


-- ============================================================================
-- 4. 語彙の一覧を、分類ごとに返す
-- ============================================================================
--
-- **数を画面へ書き写さない。**選べる語も、上限も、分類の並びも、
-- この関数が返した値をそのまま使う。

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
  v_limits       jsonb := public.flavor_limits();
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
    'work_id',       p_work_id,
    'max_tokens',    v_limits -> 'max_tokens',
    'max_sentences', v_limits -> 'max_sentences',
    'categories', coalesce((
      select jsonb_agg(c.entry order by c.sort_order, c.key)
        from (
          select cat.key,
                 cat.sort_order,
                 jsonb_build_object(
                   'key',   cat.key,
                   'label', cat.label,
                   'hint',  cat.hint,
                   'words', coalesce((
                     select jsonb_agg(
                              jsonb_build_object(
                                'id',    v.id,
                                'label', v.label,
                                'kind',  v.kind,
                                -- 人が「この正解の間接表現として有効」と登録した語
                                'suggested', exists (
                                  select 1 from public.flavor_vocab_allows a
                                    join public.prompt_cards pc on pc.tag_id = a.tag_id
                                   where a.vocab_id = v.id and pc.prompt_id = v_prompt_id
                                )
                              )
                              order by v.id
                            )
                       from public.flavor_vocab v
                      where v.is_active
                        and v.category_key = cat.key
                        and public.flavor_vocab_is_allowed(v.id, v_prompt_id)
                   ), '[]'::jsonb)
                 ) as entry
            from public.flavor_vocab_categories cat
        ) c
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.get_flavor_vocab(uuid) is
  '作者が自作のフレーバーに使える語彙を、分類ごとに返す（D162 / P5）。'
  '分類は探すためだけのもので、分類ごとの選択数の枠は無い。登録者のみ・作者のみ。';

grant execute on function public.get_flavor_vocab(uuid) to authenticated;


-- ============================================================================
-- 5. 保存（語の並び ＋ 文の区切り）
-- ============================================================================
--
-- 古い受け口（語の並びだけ）は落とす。**2本あると、区切りを持たない
-- 経路が残ってしまう。**

drop function if exists public.set_flavor_text(uuid, bigint[]);

create or replace function public.set_flavor_text(
  p_work_id   uuid,
  p_vocab_ids bigint[],
  p_breaks    int[] default '{}'::int[]
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
  v_max_tokens   int := (public.flavor_limits() ->> 'max_tokens')::int;
  v_max_sent     int := (public.flavor_limits() ->> 'max_sentences')::int;
  v_breaks       int[];
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

  if v_count < 1 or v_count > v_max_tokens then
    raise exception 'BAD_TOKEN_COUNT: 語は1〜%個で選んでください（いま %個）。',
      v_max_tokens, v_count;
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

  -- 区切りを片付ける。**重複を落とし、最後の語に付いた印は捨てる。**
  -- 最後の語は必ず文の終わりなので、印を数に入れると1文多く数えてしまう。
  select coalesce(array_agg(distinct b order by b), '{}'::int[]) into v_breaks
    from unnest(coalesce(p_breaks, '{}'::int[])) as u(b)
   where b >= 0 and b < v_count - 1;

  if coalesce(array_length(v_breaks, 1), 0) > v_max_sent - 1 then
    raise exception 'TOO_MANY_SENTENCES: 文は%つまでです。', v_max_sent;
  end if;

  insert into public.flavor_texts (work_id, author_id)
  values (p_work_id, v_uid)
  on conflict (work_id) do update
    set updated_at = clock_timestamp()
  returning id into v_id;

  delete from public.flavor_text_tokens t where t.flavor_text_id = v_id;

  insert into public.flavor_text_tokens (flavor_text_id, position, vocab_id, break_after)
  select v_id, x.ord - 1, x.vocab_id, (x.ord - 1) = any (v_breaks)
    from unnest(p_vocab_ids) with ordinality as x(vocab_id, ord);

  return public.get_work_flavor(p_work_id);
end;
$fn$;

comment on function public.set_flavor_text(uuid, bigint[], int[]) is
  '作者のフレーバーテキストを保存する（D162 / P5）。語の並びと文の区切りを受ける。'
  '保存時にも①〜④の関門を通す。';

revoke all on function public.set_flavor_text(uuid, bigint[], int[]) from public, anon;
grant execute on function public.set_flavor_text(uuid, bigint[], int[]) to authenticated;


-- ============================================================================
-- 6. 読み出し（文ごとに分けて返す）
-- ============================================================================
--
-- 誰に返るかは変えない（作者・回答済み・ヒントを開いた登録者だけ）。
-- 足したのは、語の並びを**文ごとに分けた形**と、
-- 作者が作り直すときに要る語のIDと区切りの位置。
--
-- 【語のIDと区切りを作者にだけ返す理由】
--   読む人には要らない値で、返すと「どの語を選んだか」の内部の番号が
--   外へ出る。表示に使う語そのものは、どちらにも同じものが返る。

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
  v_out          jsonb;
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

  v_out := jsonb_build_object(
    'work_id',   p_work_id,
    'exists',    exists (select 1 from public.flavor_texts f where f.work_id = p_work_id),
    'is_author', v_is_author,
    'hint_used', v_hinted,
    'revealed',  v_answered or v_is_author,
    'tokens', coalesce((
      select jsonb_agg(v.label order by tk.position)
        from public.flavor_texts f
        join public.flavor_text_tokens tk on tk.flavor_text_id = f.id
        join public.flavor_vocab v on v.id = tk.vocab_id
       where f.work_id = p_work_id
    ), '[]'::jsonb),
    'sentences', coalesce((
      select jsonb_agg(s.words order by s.sent)
        from (
          select t.sent, jsonb_agg(t.label order by t.position) as words
            from (
              select v.label,
                     tk.position,
                     (select count(*)
                        from public.flavor_text_tokens b
                       where b.flavor_text_id = tk.flavor_text_id
                         and b.break_after and b.position < tk.position) as sent
                from public.flavor_texts f
                join public.flavor_text_tokens tk on tk.flavor_text_id = f.id
                join public.flavor_vocab v on v.id = tk.vocab_id
               where f.work_id = p_work_id
            ) t
           group by t.sent
        ) s
    ), '[]'::jsonb)
  );

  if v_is_author then
    v_out := v_out || jsonb_build_object(
      'token_ids', coalesce((
        select jsonb_agg(tk.vocab_id order by tk.position)
          from public.flavor_texts f
          join public.flavor_text_tokens tk on tk.flavor_text_id = f.id
         where f.work_id = p_work_id
      ), '[]'::jsonb),
      'breaks', coalesce((
        select jsonb_agg(tk.position order by tk.position)
          from public.flavor_texts f
          join public.flavor_text_tokens tk on tk.flavor_text_id = f.id
         where f.work_id = p_work_id and tk.break_after
      ), '[]'::jsonb)
    );
  end if;

  return v_out;
end;
$fn$;

comment on function public.get_work_flavor(uuid) is
  'フレーバーテキストを返す（D162 / P5）。作者・回答済み・ヒントを開いた人だけ。'
  '文ごとに分けた形も返す。語のIDと区切りは作者にだけ返す。';

grant execute on function public.get_work_flavor(uuid) to authenticated;


-- ============================================================================
-- 7. 入ったことを、この場で確かめる（D69）
-- ============================================================================

do $$
declare
  v_n int;
  v_cats int;
  v_uncat int;
begin
  -- 関門の基準点が1行だけ入っている
  select count(*) into v_n from public.consent_gate;
  if v_n <> 1 then
    raise exception '同意の関門の基準点が % 行あります（1行のはず）', v_n;
  end if;

  -- 読みの無い語を残さない。**漢字とかなの言い換えの判定がすり抜ける**
  select count(*) into v_n from public.flavor_vocab where reading is null;
  if v_n > 0 then
    raise exception '読みの無いヒント語が % 件あります', v_n;
  end if;

  -- 分類が9つ、分類の無い語が0
  select count(*) into v_cats from public.flavor_vocab_categories;
  if v_cats <> 9 then
    raise exception '語彙の分類が % 件あります（9件のはず）', v_cats;
  end if;

  select count(*) into v_uncat from public.flavor_vocab where category_key is null;
  if v_uncat > 0 then
    raise exception '分類の無い語が % 件あります', v_uncat;
  end if;

  -- 助詞が入っている（別の入力欄ではなく語彙の一員として）
  select count(*) into v_n from public.flavor_vocab where kind = 'particle';
  if v_n < 10 then
    raise exception '助詞が % 語しかありません', v_n;
  end if;

  -- 「名」は0語で置いてある。**空であること自体が想定どおり**
  select count(*) into v_n from public.flavor_vocab where category_key = 'proper';
  if v_n <> 0 then
    raise notice '「名」の分類に % 語入りました（当初は0語の想定）', v_n;
  end if;

  -- 上限が1か所から出ている
  if (public.flavor_limits() ->> 'max_tokens')::int <> 24
     or (public.flavor_limits() ->> 'max_sentences')::int <> 3 then
    raise exception '上限の値が想定と違います';
  end if;

  raise notice 'P5 完了: 同意の関門・語彙の分類 %件・助詞・文の区切りを入れました', v_cats;
end $$;


-- ============================================================================
-- rollback（手で流す用）
-- ============================================================================
--
--   drop function if exists public.consent_status();
--   drop table if exists public.consent_gate;
--   -- フレーバー側は 20260904095000_flavor_text.sql の定義を流し直す。
--   -- 足した語と分類は残してよい（使われなくなるだけで、壊れない）。
-- ============================================================================
