#!/usr/bin/env node
/**
 * smoke-profile-avatar.mjs ／ プロフィールのアイコンと得意分野を往復させる（D176）
 *
 * 【なぜブラウザの試験と別に要るか】
 *   手元のブラウザ試験（V群）は、擬似の Supabase を相手にしている。
 *   画像の置き場（Storage）も、画像を縮めて配る仕組み（next/image）も、
 *   本物ではない。**置いた画像が本当に配られるかは、本番でしか分からない。**
 *   実際、手元の検証環境では next/image が 127.0.0.1 の画像を
 *   「私設アドレス」と見て最適化しない（resolved to private ip）。
 *
 * 【何を通すか】
 *   /account を開く → プロフィールを保存する → アイコンを置く →
 *   公開プロフィールに出る → next/image 経由でも出る → 差し替える →
 *   古いファイルが消えている → 外す → 既定の表示に戻る、まで。
 *   得意分野は 0件 → 5件 → 両方に同じ語 → 0件 の順に往復する。
 *
 * 【この検査が触るもの】
 *   **検査用の固定利用者1人のプロフィールだけ。**
 *   作品は1件も作らない。他人のプロフィールは読み書きしない。
 *   終わったらアイコンを外し、得意分野を0件へ戻す。
 *
 * 【使い方】
 *   本番:   SMOKE_BASE_URL=https://<本番> npm run smoke:prod -- profile-avatar
 *   ローカル: npm run smoke:profile-avatar   （npm run dev を動かしておくこと）
 */

import { createClient } from "@supabase/supabase-js";

import {
  BASE,
  accountUserId,
  clean,
  finish,
  fixtureSession,
  forms,
  makePng,
  must,
  section,
  targetEnv,
  textOf,
} from "./_smoke-http.mjs";

const env = targetEnv();
const stamp = `${process.pid}${Math.floor(Math.random() * 1000)}`.slice(-8);
const HANDLE = `smoke-av${stamp}`;
const DISPLAY_NAME = `アイコン検査${stamp}`;
const BIO = `これは検査用の自己紹介です（${stamp}）。`;
const LINK = "https://example.com/smoke-avatar";

/** service_role のクライアント。語彙の取得と Storage の実測にだけ使う */
function admin() {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error("接続先と秘密鍵がありません（本番へ向けるなら npm run smoke:prod）。");
  }
  return createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── 画面の道具 ────────────────────────────────────────

/**
 * 自己紹介欄の中身を HTML から読む。
 *
 * forms() は input しか拾わない（textarea には value 属性が無い）。
 * ブラウザは textarea の中身も一緒に送るので、こちらも同じように送る。
 * 送らないと「空にした」ことになって、確かめたい保存と別のことが起きる。
 */
function textareaValue(html, name) {
  const m = new RegExp(`<textarea[^>]*name="${name}"[^>]*>([\\s\\S]*?)</textarea>`).exec(
    clean(html),
  );
  if (!m) return null;
  return m[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 「プロフィールを保存する」を押す。
 *
 * 画面が出している値をそのまま持ち上げてから、変えたいところだけ差し替える。
 * **アイコンを外す印だけは持ち上げない。**あの印は、いまアイコンがあるときだけ
 * 画面に出る。持ち上げると、押していないのに毎回外れてしまう。
 */
async function saveProfile(s, changes = {}, file) {
  const page = await s.get("/account");
  const form = forms(page.html).find((f) => /プロフィールを保存する/.test(f.text));
  if (!form?.actionId) {
    throw new Error("/account に「プロフィールを保存する」のフォームがありません");
  }

  const fields = { ...form.fields };
  delete fields.avatarRemove;

  const bio = textareaValue(page.html, "bio");
  if (bio !== null) fields.bio = bio;

  return s.post("/account", { [form.actionId]: "", ...fields, ...changes }, file);
}

/** 公開プロフィールを取ってくる（サインインしていない人として） */
async function publicProfile(handle) {
  const res = await fetch(`${BASE}/u/${handle}`, { redirect: "manual" });
  return { status: res.status, html: clean(await res.text()) };
}

/** アイコンの img から、next/image 経由の URL を1つ取り出す */
function avatarImageUrl(html) {
  const tag = /<img[^>]*data-testid="profile-avatar"[^>]*>/.exec(html)?.[0];
  if (!tag) return null;
  const src = /\ssrc="([^"]+)"/.exec(tag)?.[1];
  if (!src) return null;
  return src.replace(/&amp;/g, "&");
}

/** その人の avatar フォルダにいま何が置かれているか（Storage の実測） */
async function avatarFiles(userId) {
  const { data, error } = await admin().storage.from("works").list(`${userId}/avatar`, {
    limit: 100,
  });
  if (error) return null;
  return (data ?? []).map((f) => f.name).sort();
}

/** いま DB に入っているアイコンの置き場所と得意分野 */
async function profileRow(userId) {
  const { data } = await admin()
    .from("profiles")
    .select("avatar_path, handle, display_name, bio, links, show_saved_works")
    .eq("id", userId)
    .maybeSingle();
  return data ?? null;
}

async function specialtyRows(userId) {
  const { data } = await admin()
    .from("profile_specialties")
    .select("specialty_type, tag_id, sort_order")
    .eq("user_id", userId)
    .order("specialty_type")
    .order("sort_order");
  return data ?? [];
}

// ── 本編 ──────────────────────────────────────────────

const s = await fixtureSession("avatar");

section("1. アカウント画面が開く");

const account = await s.get("/account");
must(account.status === 200, "/account が開く", `status=${account.status}`);
must(/プロフィールアイコン/.test(textOf(account.html)), "アイコンの欄がある");
must(/描くのが得意/.test(textOf(account.html)), "「描くのが得意」の欄がある");
must(/見るのが得意/.test(textOf(account.html)), "「見るのが得意」の欄がある");
must(
  /プロフィール/.test(textOf(account.html)) &&
    /公開設定/.test(textOf(account.html)) &&
    /サインアウト/.test(textOf(account.html)),
  "3つのまとまり（プロフィール／公開設定／アカウント）がそろっている",
);

const userId = accountUserId(account.html);
must(Boolean(userId), "自分の利用者IDを読める", userId ?? "(読めない)");
if (!userId) await finish();

section("2. 名前・自己紹介・外部リンクを保存する（アイコンはまだ置かない）");

await saveProfile(s, {
  handle: HANDLE,
  displayName: DISPLAY_NAME,
  bio: BIO,
  link_site: LINK,
  drawingTagIds: "",
  viewingTagIds: "",
});

const afterBasics = await profileRow(userId);
must(afterBasics?.handle === HANDLE, "ID が保存された", afterBasics?.handle ?? "");
must(afterBasics?.display_name === DISPLAY_NAME, "表示名が保存された");
must(afterBasics?.bio === BIO, "自己紹介が保存された");
must(afterBasics?.links?.site === LINK, "外部リンクが保存された", afterBasics?.links?.site ?? "");
must(afterBasics?.avatar_path === null, "アイコンはまだ未設定", String(afterBasics?.avatar_path));

section("3. アイコンが無いときは既定の表示になる");

const before = await publicProfile(HANDLE);
must(before.status === 200, `/u/${HANDLE} が開く`, `status=${before.status}`);
must(
  /data-testid="profile-avatar-default"/.test(before.html),
  "既定のアイコン（頭文字）が出ている",
);
must(!/data-testid="profile-avatar"/.test(before.html), "画像のアイコンは出ていない");
must(new RegExp(DISPLAY_NAME).test(textOf(before.html)), "表示名が出ている");
must(new RegExp(BIO.slice(0, 12)).test(textOf(before.html)), "自己紹介が出ている");

section("4. アイコンを置く（2MiB 以下の PNG）");

const first = makePng(240, 240);
must(first.length <= 2 * 1024 * 1024, "送る画像は 2MiB 以下", `${first.length} バイト`);

await saveProfile(s, {}, { field: "avatar", bytes: first, type: "image/png", name: "a.png" });

const set = await profileRow(userId);
must(Boolean(set?.avatar_path), "アイコンの置き場所が DB に入った", set?.avatar_path ?? "");
must(
  new RegExp(`^${userId}/avatar/[0-9a-f-]{36}\\.png$`).test(set?.avatar_path ?? ""),
  "置き場所が <利用者ID>/avatar/<乱数>.png の形",
  set?.avatar_path ?? "",
);
must(set?.display_name === DISPLAY_NAME, "表示名は消えていない");
must(set?.bio === BIO, "自己紹介は消えていない");

const filesAfterSet = await avatarFiles(userId);
must(filesAfterSet?.length === 1, "Storage にアイコンが1つだけある", String(filesAfterSet));

section("5. 公開プロフィールに実物が出る");

const shown = await publicProfile(HANDLE);
must(/data-testid="profile-avatar"/.test(shown.html), "画像のアイコンが出ている");
must(
  !/data-testid="profile-avatar-default"/.test(shown.html),
  "既定の表示には戻っていない",
);

const imgUrl = avatarImageUrl(shown.html);
must(Boolean(imgUrl), "アイコンの画像URLを読める", imgUrl ?? "(読めない)");
must(
  Boolean(imgUrl) && imgUrl.startsWith("/_next/image"),
  "next/image を通している（原寸を直接配っていない）",
  imgUrl ?? "",
);

if (imgUrl) {
  const res = await fetch(imgUrl.startsWith("http") ? imgUrl : BASE + imgUrl);
  const type = res.headers.get("content-type") ?? "";
  const bytes = Buffer.from(await res.arrayBuffer());
  must(res.status === 200, "next/image 経由で画像が返る", `status=${res.status}`);
  must(type.startsWith("image/"), "返ってきたのが画像", type);
  must(bytes.length > 0, "中身がある", `${bytes.length} バイト`);
  must(
    bytes.length <= first.length,
    "配られたのは原寸そのままではない（縮めたぶん）",
    `原寸 ${first.length} → 配信 ${bytes.length}`,
  );
}

section("6. 置き場所そのものからも取れる（Storage が公開されている）");

const direct = `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/works/${set?.avatar_path}`;
const directRes = await fetch(direct);
must(directRes.status === 200, "Storage の公開URLから取れる", `status=${directRes.status}`);
must(
  (directRes.headers.get("content-type") ?? "").startsWith("image/"),
  "Storage が返すのも画像",
  directRes.headers.get("content-type") ?? "",
);

section("7. アイコンを差し替える");

const second = makePng(180, 180);
await saveProfile(s, {}, { field: "avatar", bytes: second, type: "image/png", name: "b.png" });

const swapped = await profileRow(userId);
must(Boolean(swapped?.avatar_path), "差し替え後も置き場所がある", swapped?.avatar_path ?? "");
must(
  swapped?.avatar_path !== set?.avatar_path,
  "名前が変わっている（同じ名前に上書きしていない）",
);

const filesAfterSwap = await avatarFiles(userId);
must(
  filesAfterSwap?.length === 1 &&
    filesAfterSwap[0] === swapped?.avatar_path.split("/").pop(),
  "古いファイルが消えて、新しいものだけが残っている",
  String(filesAfterSwap),
);

// 消えたかどうかは**置き場そのもの**に聞く。
//
// 公開URLで見てはいけない。あれは配信の途中に控え（CDN）が挟まっていて、
// 消した直後はまだ古い中身を返す。2026-09-09 の本番実測では、
// 差し替えた直後は 200、しばらくして 400 になった。
// **控えが返した 200 は「まだ置いてある」ことの証拠ではない。**
const { error: oldError } = await admin().storage.from("works").download(set?.avatar_path);
must(Boolean(oldError), "古いファイルは置き場から消えている", oldError?.message ?? "まだある");

// 控えの窓は消せないので、消さずに測って記録だけ残す。
const cached = await fetch(
  `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/works/${set?.avatar_path}`,
);
console.log(
  `      （参考）古い公開URLはいま status=${cached.status}。` +
    `200 なら配信の控えが残っているだけで、置き場からは消えている。` +
    `差し替えは毎回新しい名前になるので、いまのアイコンが古いままになることはない。`,
);

const { data: queued } = await admin()
  .from("storage_cleanup_queue")
  .select("path, deleted_at")
  .like("path", `${userId}/avatar/%`);
must(
  (queued ?? []).length === 0,
  "掃除待ちに積まれていない（その場で消せた）",
  `${(queued ?? []).length} 件`,
);

section("8. 得意分野を保存する");

const { data: vocab, error: vocabError } = await admin().rpc("get_art_first_vocabulary");
must(!vocabError, "語彙を読めた", vocabError?.message ?? "");
const cats = vocab?.categories ?? [];
const allTags = cats.flatMap((c) => c.tags.map((t) => ({ ...t, cat: c.label })));
must(allTags.length > 0, "選べる語がある", `${cats.length} 分類 / ${allTags.length} 語`);

const drawing = allTags.slice(0, 5);
const viewing = [allTags[0], ...allTags.slice(5, 9)]; // 先頭は描く側と同じ語
must(
  viewing[0].id === drawing[0].id,
  "見る側の1件目は、描く側と同じ語にしてある（両方に入れられるかを見る）",
);

await saveProfile(s, {
  drawingTagIds: drawing.map((t) => t.id).join(","),
  viewingTagIds: viewing.map((t) => t.id).join(","),
});

const rows = await specialtyRows(userId);
const drawRows = rows.filter((r) => r.specialty_type === "drawing");
const viewRows = rows.filter((r) => r.specialty_type === "viewing");
must(drawRows.length === 5, "描くのが得意が5件", `${drawRows.length} 件`);
must(viewRows.length === 5, "見るのが得意が5件", `${viewRows.length} 件`);
must(
  drawRows.some((r) => Number(r.tag_id) === drawing[0].id) &&
    viewRows.some((r) => Number(r.tag_id) === drawing[0].id),
  "同じ語を描く側と見る側の両方に入れられた",
);

section("9. 公開プロフィールに得意分野が出る");

const withSpecialties = await publicProfile(HANDLE);
must(
  /data-testid="specialty-drawing"/.test(withSpecialties.html),
  "「描くのが得意」の節が出ている",
);
must(
  /data-testid="specialty-viewing"/.test(withSpecialties.html),
  "「見るのが得意」の節が出ている",
);
const shownText = textOf(withSpecialties.html);
must(
  drawing.every((t) => shownText.includes(t.label)),
  "描く側に選んだ5語がすべて出ている",
);
must(
  !/実際の正解率|正答率/.test(shownText.split("描くのが得意")[1] ?? ""),
  "成績として書かれていない",
);

section("10. 0件にすると、その節ごと消える");

await saveProfile(s, { drawingTagIds: "", viewingTagIds: viewing.map((t) => t.id).join(",") });

const halfEmpty = await publicProfile(HANDLE);
must(
  !/data-testid="specialty-drawing"/.test(halfEmpty.html),
  "0件にした側は、見出しごと出ていない",
);
must(
  /data-testid="specialty-viewing"/.test(halfEmpty.html),
  "残した側は出たまま",
);

section("11. 公開設定は今までどおり動く");

const visibilityPage = await s.get("/account");
const visibilityForm = forms(visibilityPage.html).find((f) =>
  /公開設定を保存する/.test(f.text),
);
must(Boolean(visibilityForm?.actionId), "公開設定のフォームがある");
if (visibilityForm?.actionId) {
  await s.post("/account", { [visibilityForm.actionId]: "", show_saved_works: "on" });
  const afterVisibility = await profileRow(userId);
  must(afterVisibility?.show_saved_works === true, "お気に入りの公開設定が保存された");

  await s.post("/account", { [visibilityForm.actionId]: "" });
  const backOff = await profileRow(userId);
  must(backOff?.show_saved_works === false, "外すほうも効く");
}

section("12. アイコンを外すと、既定の表示に戻る");

await saveProfile(s, { avatarRemove: "1" });

const removed = await profileRow(userId);
must(removed?.avatar_path === null, "DB のアイコンが空になった", String(removed?.avatar_path));

const filesAfterRemove = await avatarFiles(userId);
must(
  (filesAfterRemove ?? []).length === 0,
  "Storage のファイルも消えている",
  String(filesAfterRemove),
);

const back = await publicProfile(HANDLE);
must(
  /data-testid="profile-avatar-default"/.test(back.html),
  "公開プロフィールが既定の表示に戻った",
);
must(!/data-testid="profile-avatar"/.test(back.html), "画像のアイコンは出ていない");
must(removed?.display_name === DISPLAY_NAME, "名前は残っている");
must(removed?.bio === BIO, "自己紹介は残っている");

section("13. 既存の道が壊れていない");

const list = await fetch(`${BASE}/works`, { redirect: "manual" });
must(list.status === 200, "作品の一覧が開く", `status=${list.status}`);
const listHtml = clean(await list.text());
must(/\/works\/[0-9a-f-]{36}/.test(listHtml), "一覧に作品が並んでいる");

const stillThere = await publicProfile(HANDLE);
must(/これまでの内容|投稿した作品|作品/.test(textOf(stillThere.html)), "公開プロフィールの下の内容も出ている");

section("14. 片づけ");

await saveProfile(s, { drawingTagIds: "", viewingTagIds: "" });
const leftovers = await specialtyRows(userId);
must(leftovers.length === 0, "得意分野を0件に戻した", `${leftovers.length} 件`);

const leftFiles = await avatarFiles(userId);
must((leftFiles ?? []).length === 0, "アイコンのファイルは残っていない", String(leftFiles));

await finish();
