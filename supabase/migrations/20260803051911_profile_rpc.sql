-- ============================================================================
-- profile_rpc ／ Step 6 本体: 表示名・ID・自己紹介・外部リンクの設定
-- ============================================================================
--
-- 【このファイルがやること】
--   update_my_profile を1本作る。
--
-- 【このファイルがやらないこと】
--   ・**表・列・制約・既存の権限に一切触れない**
--   ・データを1行も消さない・書き換えない
--   ・ほかの関数に触れない
--   ・退会・アカウント削除を作らない（公開前必須課題 P1）
--   ・ID の変更回数を制限しない（下記）
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/013_profile_rpc_rollback.sql
--
--
-- 【なぜ関数が要るのか（display_name は直接更新できるのに）】
--
--   001 は列単位で更新権限を配ってある。
--
--     更新できる  display_name / bio / links / show_* 3つ
--     更新できない **handle** / id / created_at / is_anonymous
--
--   handle を外してあるのは意図的で、001 のコメントにこうある。
--   「handle を許すと、ゲストのうちに好きな handle を先取りできてしまう」
--
--   つまり handle だけは、どうしてもサーバー側の関数を通すしかない。
--   そのついでに display_name / bio / links も同じ関数で受けることにした。
--   画面のフォームは1つなので、**1回の呼び出しでまとめて更新できたほうが
--   途中で失敗して片方だけ変わる、という状態を作らずに済む**。
--
--   001 が配った直接更新の権限はそのまま残す。取り上げると
--   Step 14（公開設定）の作りまで変わってしまうため、この工程では触らない。
--
--
-- 【ID（handle）についての決まり】
--
--   形式 … 3〜20字・小文字の英数字とハイフン・先頭と末尾はハイフン不可
--          （001 の profiles_handle_format と同じ。ここでは分かりやすい
--            日本語のエラーにするために、同じ条件をもう一度見る）
--   重複 … 表の UNIQUE が拒否する。索引違反のメッセージは利用者に
--          通じないので、捕まえて日本語にする
--   資格 … **登録ユーザーだけ**。ゲストは取れない
--
--   【変更できる回数を制限しない】
--     いまは何度でも変えられる。変えた瞬間に古い ID が空くので、
--     他人がすぐ取れる。なりすましの余地になるが、
--     ID を使った公開ページ（Step 14）がまだ無いため実害が出ない。
--     制限するかは Step 14 で決める。
--
--   【予約語を持たない】
--     admin や official のような ID も取れてしまう。
--     どの語を禁じるかは製品側の判断なので、この工程では決めない。
--     Step 14 で公開ページの URL を決めるときに合わせて扱う。
--
--
-- 【null は「変更しない」（D49 と同じ）】
--
--   渡さなかった項目は触らない。そのため「入っている値を空へ戻す」操作は
--   この関数ではできない。必要になったら空文字で消す形にはせず、
--   専用の引数を足して区別する（空文字と未指定を同じ記号に載せると
--   あとで必ず取り違える）。
--
--
-- 【外部リンクを検査する理由】
--
--   links は {"x": "https://...", "pixiv": "..."} の形で、画面では
--   リンクとして表示する。ここで javascript: で始まる値を入れられると、
--   それを踏んだ人のブラウザで任意の処理が動きうる。
--
--   001 の制約は「オブジェクトであること」と「4096バイト以内」しか見ない。
--   **値が http:// か https:// で始まること**は、ここで見る。
--
-- ============================================================================


create function public.update_my_profile(
  p_handle       text  default null,
  p_display_name text  default null,
  p_bio          text  default null,
  p_links        jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_handle       text;
  v_display_name text;
  v_bio          text;
  v_bad_link     text;
begin

  -- --- 1. 誰が変更しようとしているか -----------------------------------------

  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception
      'GUEST_CANNOT_SET_PROFILE: プロフィールの設定にはアカウント登録が必要です。';
  end if;


  -- --- 2. ID（handle）-------------------------------------------------------
  --
  -- 大文字で入力されることが多いので、小文字にそろえてから見る。
  -- 「Taro と taro が別人になる」状態を作らないため。

  if p_handle is not null then
    v_handle := lower(btrim(p_handle));

    if v_handle = '' then
      raise exception 'HANDLE_REQUIRED: ID を入力してください。';
    end if;

    if v_handle !~ '^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$' then
      raise exception
        'HANDLE_FORMAT: ID は3〜20字の小文字の英数字とハイフンで、'
        '先頭と末尾にハイフンは使えません（例: my-handle）。';
    end if;
  end if;


  -- --- 3. 表示名 -------------------------------------------------------------

  if p_display_name is not null then
    v_display_name := btrim(p_display_name);

    if v_display_name = '' then
      raise exception 'DISPLAY_NAME_REQUIRED: 表示名は空にできません。';
    end if;

    if char_length(v_display_name) > 30 then
      raise exception 'DISPLAY_NAME_TOO_LONG: 表示名は30字までです（いま %字）。',
        char_length(v_display_name);
    end if;
  end if;


  -- --- 4. 自己紹介 -----------------------------------------------------------
  --
  -- 空文字は null に寄せる。フォームの未入力が空文字で届くため、
  -- そのまま入れると「空文字の自己紹介」という中途半端な値が残る。

  if p_bio is not null then
    v_bio := nullif(btrim(p_bio), '');

    if v_bio is not null and char_length(v_bio) > 500 then
      raise exception 'BIO_TOO_LONG: 自己紹介は500字までです（いま %字）。',
        char_length(v_bio);
    end if;
  end if;


  -- --- 5. 外部リンク ---------------------------------------------------------
  --
  -- 値が http:// か https:// で始まらないものを1つでも見つけたら断る。
  -- javascript: などを入れられると、踏んだ人のブラウザで処理が動きうる。

  if p_links is not null then
    if jsonb_typeof(p_links) <> 'object' then
      raise exception 'LINKS_FORMAT: リンクの形式が正しくありません。';
    end if;

    select e.key
      into v_bad_link
      from jsonb_each_text(p_links) e
     where e.value !~ '^https?://'
     limit 1;

    if v_bad_link is not null then
      raise exception
        'LINK_NOT_HTTP: リンク「%」は http:// または https:// で始まる必要があります。',
        v_bad_link;
    end if;

    if octet_length(p_links::text) > 4096 then
      raise exception 'LINKS_TOO_LARGE: リンクの内容が大きすぎます。';
    end if;
  end if;


  -- --- 6. 反映する -----------------------------------------------------------
  --
  -- 重複した ID は表の UNIQUE が拒否する。そのままだと
  -- 「duplicate key value violates unique constraint ...」という
  -- 利用者に通じないメッセージになるので、捕まえて言い換える。
  --
  -- 例外を捕まえるブロックの中は、失敗しても外側の処理は続けられる形になる。
  -- ここでは言い換えて投げ直すだけなので、結果として全体が巻き戻る。

  begin
    update public.profiles p
       set handle       = coalesce(v_handle, p.handle),
           display_name = coalesce(v_display_name, p.display_name),
           bio          = case when p_bio is null then p.bio else v_bio end,
           links        = coalesce(p_links, p.links)
     where p.id = v_uid;
  exception
    when unique_violation then
      raise exception 'HANDLE_TAKEN: その ID はすでに使われています。別の ID にしてください。';
  end;

  return (
    select jsonb_build_object(
      'id',           p.id,
      'handle',       p.handle,
      'display_name', p.display_name,
      'bio',          p.bio,
      'links',        p.links
    )
    from public.profiles p
    where p.id = v_uid
  );
end;
$fn$;

comment on function public.update_my_profile(text, text, text, jsonb) is
  '自分のプロフィールを更新する。null は「変更しない」。'
  'handle を設定できる唯一の経路（列権限では更新できない。001 の設計）。'
  '登録ユーザーのみ。';


-- ----------------------------------------------------------------------------
-- 実行権限
-- ----------------------------------------------------------------------------
--
-- authenticated だけ。匿名ゲストも Postgres 側では authenticated なので、
-- ゲストを弾くのは関数の中の検査1（JWT の is_anonymous）が担う。

revoke all on function public.update_my_profile(text, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.update_my_profile(text, text, text, jsonb)
  to authenticated;
