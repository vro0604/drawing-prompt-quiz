-- 新規登録の表示名をDB境界でも必須にし、分類の表示名を「モチーフ」に統一する。
-- 既存プロフィールは書き換えず、既存行の今後の更新も妨げない。
-- 新規登録は作成トリガー、匿名利用者の昇格は専用RPCで検証する。

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_anonymous boolean := coalesce(new.is_anonymous, false);
  v_display_name text;
begin
  if v_anonymous then
    v_display_name := 'ゲスト';
  else
    v_display_name := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
    if v_display_name = '' then
      raise exception 'DISPLAY_NAME_REQUIRED: 表示名を入力してください。';
    end if;
    if char_length(v_display_name) > 30 then
      raise exception 'DISPLAY_NAME_TOO_LONG: 表示名は30文字以内で入力してください。';
    end if;
    if v_display_name = 'ゲスト' or lower(v_display_name) = 'guest' then
      raise exception 'DISPLAY_NAME_RESERVED: この名前は使用できません。';
    end if;
  end if;

  insert into public.profiles (id, is_anonymous, display_name)
  values (new.id, v_anonymous, v_display_name)
  on conflict (id) do nothing;
  return new;
end;
$fn$;

comment on function public.handle_new_user() is
  'auth.usersの作成時にプロフィールを作る。登録者はmetadataで検証済み表示名が必須。匿名利用者だけ「ゲスト」を使う。';

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- 匿名利用者を同じuidのまま昇格させる直前に、表示名だけを確定する入口。
-- 引数にuser idを取らず、呼び出した本人の行しか更新しない。
create or replace function public.set_registration_display_name(p_display_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;
  if v_name = '' then
    raise exception 'DISPLAY_NAME_REQUIRED: 表示名を入力してください。';
  end if;
  if char_length(v_name) > 30 then
    raise exception 'DISPLAY_NAME_TOO_LONG: 表示名は30文字以内で入力してください。';
  end if;
  if v_name = 'ゲスト' or lower(v_name) = 'guest' then
    raise exception 'DISPLAY_NAME_RESERVED: この名前は使用できません。';
  end if;

  update public.profiles
     set display_name = v_name
   where id = v_uid
     and is_anonymous;
  if not found then
    raise exception 'GUEST_PROFILE_NOT_FOUND: 登録前のゲスト情報が見つかりません。';
  end if;
end;
$fn$;

revoke all on function public.set_registration_display_name(text)
  from public, anon, authenticated;
grant execute on function public.set_registration_display_name(text)
  to authenticated;

-- 既存の単一更新口を通し、抽選側と画面側の表示名を同時に変更する。
select public.set_category_label('morph', 'モチーフ');

-- 問いに使う枠名も同じ語へそろえる。お題・回答のキーは一切変えない。
update public.card_slots
   set label = 'モチーフ'
 where pool_key = 'morph'
   and label is distinct from 'モチーフ';

-- 共有カードだけは表示文を履歴として控えているため、既存の控えも表示語だけ直す。
-- work_id / question_id / share_event はそのまま維持する。
update public.share_card_revisions
   set question_text_snapshot = replace(question_text_snapshot, 'モーフ', 'モチーフ'),
       content_key = replace(content_key, 'モーフ', 'モチーフ')
 where question_text_snapshot like '%モーフ%';
