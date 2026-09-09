#!/usr/bin/env node
/**
 * concurrency.mjs ／ 本物の Postgres を立てて、**同時に来た2つの要求**を試す
 *
 * 実行: npm run test:db:concurrent
 *
 * 【なぜ縦断試験（test:db）と別に要るか】
 *   縦断試験が使っている PGlite は Postgres を WebAssembly に固めたもので、
 *   **接続が1本しかない。**2つの取引を同時に走らせられないので、
 *   「片方が待たされる」「後から来たほうが弾かれる」を再現できない。
 *   あちらで確かめられるのは「順に呼んだら片方だけ通る」ところまで。
 *
 *   課金でいちばん危ないのは、そこで起きる。30枠に31人が同時に来る、
 *   2つの決済が同時に確定して同じ Founder 番号を取り合う。
 *   **お金が動いたあとで謝ることになる。**だからここだけは本物を立てる。
 *
 * 【何を立てているか】
 *   embedded-postgres が持っている PostgreSQL 18 の実体を、この端末の
 *   一時フォルダで動かす。Docker も管理者権限も要らない。
 *   本番にもクラウドにも1バイトも送らない。終わったらフォルダごと消す。
 *
 * 【試すこと】
 *   C1 錠が本当に効く（押さえている間、後続は待たされる）
 *   C2 残り1枠へ2つ同時に来ると、通るのは1つだけ
 *   C3 弾かれた側に、購入の行も権限も残らない
 *   C4 同時に確定しても Founder 番号が重複しない
 *   C5 同じ人が2つの接続から同時に押さえても、購入の行は1つ
 *   C6 同じ知らせが2つの接続から同時に来ても、処理するのは1つ
 */

import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPABASE_STUB } from "./harness.mjs";
import { recordCount } from "../counts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "supabase", "migrations");

const FOUNDER = "founding_creator_v0";

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ○ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, why: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/* ---------------------------------------------------------------------------
 * 立ち上げ
 * ------------------------------------------------------------------------- */

/** 空いている番号を1つ選ぶ（他の Postgres と当たらないように） */
function pickPort() {
  return 55_000 + Math.floor(Math.random() * 5_000);
}

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "billing-pg-"));
  const port = pickPort();

  const pg = new EmbeddedPostgres({
    databaseDir: join(dir, "data"),
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();

  return { pg, dir, port };
}

/** 接続を1本開く。**試験ごとに複数開くのが、この試験の目的そのもの。** */
async function open(pg) {
  const client = pg.getPgClient();
  await client.connect();
  return client;
}

/** migration を全部当てる */
async function applyAll(client) {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = await readFile(join(MIGRATIONS, f), "utf8");
    try {
      await client.query(sql);
    } catch (e) {
      throw new Error(`migration ${f} が当てられません:\n${e.message}`);
    }
  }
  return files.length;
}

/* ---------------------------------------------------------------------------
 * 呼び出しの道具
 * ------------------------------------------------------------------------- */

/** 運営の鍵で1回呼ぶ（取引を開いて閉じるまで） */
async function svc(client, sql, params = []) {
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const r = await client.query(sql, params);
    await client.query("commit");
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

/** 所有者のまま1つの値を読む */
async function own(client, sql, params = []) {
  const r = await client.query(sql, params);
  return r.rows[0] ? Object.values(r.rows[0])[0] : null;
}

/**
 * 登録利用者を1人作る。**いま有効な規約とポリシーに同意させておく。**
 *
 * 規約 13-6 で、同意していない人は枠を押さえられない。
 * ここで見たいのは同意の関門ではなく錠のほうなので、先に通しておく。
 * （同意そのものは縦断試験の W1-b が見る）
 */
async function member(client, handle) {
  const { rows } = await client.query(
    `insert into auth.users (email, is_anonymous)
     values ($1, false) returning id`,
    [`${handle}@example.test`],
  );
  const uid = rows[0].id;
  await client.query(`update public.profiles set handle = $2 where id = $1`, [uid, handle]);

  await client.query(
    `insert into public.terms_agreements (user_id, doc_kind, version, retain_until)
     select $1::uuid, 'terms', tv.version, now() + interval '5 years'
       from public.terms_versions tv where tv.is_current
     union all
     select $1::uuid, 'privacy', pv.version, now() + interval '5 years'
       from public.privacy_versions pv where pv.is_current
     on conflict do nothing`,
    [uid],
  );

  return uid;
}

/** 押さえて、決済ページを結び、払い終えるまで一気に進める */
async function buy(client, uid, tag, code = FOUNDER) {
  const r = await svc(client, `select public.billing_reserve_slot($1, $2)`, [uid, code]);
  const cus = await svc(client, `select public.billing_upsert_customer($1, $2)`, [
    uid,
    `cus_${tag}`,
  ]);
  await svc(
    client,
    `select public.billing_attach_checkout($1, $2, $3, now() + interval '30 minutes')`,
    [r.purchase_id, cus.billing_customer_id, `cs_${tag}`],
  );
  const done = await svc(
    client,
    `select public.billing_complete_checkout($1, $2, $3, 'payment', 'paid', 3000, 'jpy', $4)`,
    [`cs_${tag}`, r.purchase_id, code, `pi_${tag}`],
  );
  return { purchaseId: r.purchase_id, ...done };
}

/** 押さえて決済ページまで結ぶ（確定はしない） */
async function reserveAndAttach(client, uid, tag, code) {
  const r = await svc(client, `select public.billing_reserve_slot($1, $2)`, [uid, code]);
  const cus = await svc(client, `select public.billing_upsert_customer($1, $2)`, [
    uid,
    `cus_${tag}`,
  ]);
  await svc(
    client,
    `select public.billing_attach_checkout($1, $2, $3, now() + interval '30 minutes')`,
    [r.purchase_id, cus.billing_customer_id, `cs_${tag}`],
  );
  return r.purchase_id;
}

/** 待っているか（まだ返ってきていないか）を確かめる */
function pending(promise, ms) {
  const mark = Symbol("まだ");
  return Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    new Promise((res) => setTimeout(() => res(mark), ms)),
  ]).then((v) => v === mark);
}

/* ---------------------------------------------------------------------------
 * 本体
 * ------------------------------------------------------------------------- */

let started = null;

async function main() {
  console.log("\n本物の Postgres を立てています…");
  started = await boot();
  const owner = await open(started.pg);

  await owner.query(SUPABASE_STUB);
  const applied = await applyAll(owner);
  const version = await own(owner, `select current_setting('server_version')`);
  console.log(`  PostgreSQL ${version} ／ migration ${applied}本を当てました\n`);

  // 販売を開ける（既定は閉じている）
  await owner.query(`update public.billing_offers set is_active = true where code = $1`, [
    FOUNDER,
  ]);

  /* -- C1 錠 ------------------------------------------------------------- */

  await test("C1 押さえている間、後から来た予約は待たされる（for update が効く）", async () => {
    const a = await open(started.pg);
    const b = await open(started.pg);
    const ua = await member(owner, "c1-a");
    const ub = await member(owner, "c1-b");

    // A は取引を開いたまま押さえる。**閉じないので商品の行の錠を握り続ける**
    await a.query("begin");
    await a.query("set local role service_role");
    await a.query(`select public.billing_reserve_slot($1, $2)`, [ua, FOUNDER]);

    // B が同じ商品を押さえにいく。錠が効いていれば、ここで待たされる
    const bCall = (async () => {
      await b.query("begin");
      await b.query("set local role service_role");
      const r = await b.query(`select public.billing_reserve_slot($1, $2)`, [ub, FOUNDER]);
      await b.query("commit");
      return r;
    })();

    const stillWaiting = await pending(bCall, 700);
    assert(stillWaiting, "後から来た予約が待たされていない（錠が効いていない）");

    // A が巻き戻すと、B が動き出す
    await a.query("rollback");
    await bCall;

    const rows = await own(
      owner,
      `select count(*)::int from public.billing_purchases p
         join public.billing_offers o on o.id = p.offer_id
        where o.code = $1 and p.profile_id = any($2)`,
      [FOUNDER, [ua, ub]],
    );
    assert(rows === 1, `巻き戻したはずの予約が残っている（${rows}件）`);

    await a.end();
    await b.end();
    await owner.query(
      `update public.billing_purchases set status = 'void' where profile_id = $1`,
      [ub],
    );
  });

  /* -- C2 / C3 残り1枠に2人 ---------------------------------------------- */

  await test("C2 残り1枠へ同時に2件来ると、通るのは1件だけ", async () => {
    // 上限30の商品を1つ作り、29件を払い済みにする
    await owner.query(
      `insert into public.billing_offers (code, name, kind, currency, amount, sales_cap, is_active)
       values ('race_cap_30', '同時実行の試験用（上限30）', 'one_time', 'jpy', 3000, 30, true)
       on conflict (code) do nothing`,
    );

    for (let i = 0; i < 29; i += 1) {
      const u = await member(owner, `c2-paid${i}`);
      await buy(owner, u, `c2p${i}`, "race_cap_30");
    }

    const used = await own(
      owner,
      `select (public.get_founder_offer_status('race_cap_30') ->> 'used')::int`,
    );
    assert(used === 29, `払い済みが29件になっていない（${used}）`);

    const a = await open(started.pg);
    const b = await open(started.pg);
    const ua = await member(owner, "c2-race-a");
    const ub = await member(owner, "c2-race-b");

    // **同時に投げる。**待ち合わせずに両方走らせる
    const [ra, rb] = await Promise.allSettled([
      svc(a, `select public.billing_reserve_slot($1, $2)`, [ua, "race_cap_30"]),
      svc(b, `select public.billing_reserve_slot($1, $2)`, [ub, "race_cap_30"]),
    ]);

    const ok = [ra, rb].filter((r) => r.status === "fulfilled");
    const ng = [ra, rb].filter((r) => r.status === "rejected");
    assert(ok.length === 1, `通ったのが ${ok.length} 件（1件でなければならない）`);
    assert(ng.length === 1, `弾かれたのが ${ng.length} 件`);
    assert(
      ng[0].reason.message.includes("SOLD_OUT"),
      `弾かれた理由が売り切れではない: ${ng[0].reason.message}`,
    );

    const total = await own(
      owner,
      `select (public.get_founder_offer_status('race_cap_30') ->> 'used')::int`,
    );
    assert(total === 30, `枠が30を超えている／足りない（${total}）`);

    // C3 のために、弾かれたほうの人を控えておく
    globalThis.__c3 = {
      loser: ra.status === "rejected" ? ua : ub,
      a,
      b,
    };
  });

  await test("C3 弾かれた側に、購入の行も権限も残らない", async () => {
    const { loser, a, b } = globalThis.__c3;

    const purchases = await own(
      owner,
      `select count(*)::int from public.billing_purchases where profile_id = $1`,
      [loser],
    );
    assert(purchases === 0, `弾かれた人に購入の行が ${purchases} 件残っている`);

    const grants = await own(
      owner,
      `select count(*)::int from public.billing_entitlements where profile_id = $1`,
      [loser],
    );
    assert(grants === 0, `弾かれた人に権限が ${grants} 本残っている`);

    const customers = await own(
      owner,
      `select count(*)::int from public.billing_customers where profile_id = $1`,
      [loser],
    );
    assert(customers === 0, `弾かれた人に Stripe の顧客が ${customers} 件残っている`);

    await a.end();
    await b.end();
  });

  /* -- C4 番号 ------------------------------------------------------------ */

  await test("C4 同時に確定しても、Founder 番号が重複しない", async () => {
    const HOW_MANY = 10;

    await owner.query(
      `insert into public.billing_offers (code, name, kind, currency, amount, sales_cap, is_active)
       values ('race_number', '同時実行の試験用（番号）', 'one_time', 'jpy', 3000, null, true)
       on conflict (code) do nothing`,
    );

    // 先に10件を「決済ページまで結んだ」状態にしておく
    const purchases = [];
    for (let i = 0; i < HOW_MANY; i += 1) {
      const u = await member(owner, `c4-${i}`);
      purchases.push({
        id: await reserveAndAttach(owner, u, `c4n${i}`, "race_number"),
        uid: u,
        tag: `c4n${i}`,
      });
    }

    // 10本の接続から**いっせいに**確定させる
    const clients = [];
    for (let i = 0; i < HOW_MANY; i += 1) clients.push(await open(started.pg));

    const settled = await Promise.allSettled(
      purchases.map((p, i) =>
        svc(
          clients[i],
          `select public.billing_complete_checkout($1, $2, $3, 'payment', 'paid', 3000, 'jpy', $4)`,
          [`cs_${p.tag}`, p.id, "race_number", `pi_${p.tag}`],
        ),
      ),
    );

    const failed = settled.filter((s) => s.status === "rejected");
    assert(
      failed.length === 0,
      `確定が ${failed.length} 件失敗した: ${failed.map((f) => f.reason.message).join(" / ")}`,
    );

    const numbers = settled.map((s) => s.value.founder_number).sort((x, y) => x - y);
    const unique = new Set(numbers);
    assert(
      unique.size === HOW_MANY,
      `番号が重複した（${HOW_MANY}件で ${unique.size}種類）: ${numbers.join(",")}`,
    );
    assert(
      numbers[0] === 1 && numbers[HOW_MANY - 1] === HOW_MANY,
      `番号が 1〜${HOW_MANY} になっていない: ${numbers.join(",")}`,
    );

    // 権限も、1人につき2本ずつ正しく付いている
    const grants = await own(
      owner,
      `select count(*)::int from public.billing_entitlements e
        where e.profile_id = any($1) and e.revoked_at is null`,
      [purchases.map((p) => p.uid)],
    );
    assert(grants === HOW_MANY * 2, `権限が ${grants} 本（${HOW_MANY * 2} 本のはず）`);

    for (const c of clients) await c.end();
  });

  /* -- C5 同じ人の二重購入 ------------------------------------------------ */

  await test("C5 同じ人が2つの接続から同時に押さえても、購入の行は1つ", async () => {
    const a = await open(started.pg);
    const b = await open(started.pg);
    const u = await member(owner, "c5-same");

    const [ra, rb] = await Promise.allSettled([
      svc(a, `select public.billing_reserve_slot($1, $2)`, [u, FOUNDER]),
      svc(b, `select public.billing_reserve_slot($1, $2)`, [u, FOUNDER]),
    ]);

    // どちらも「押さえた」と返ってよいが、**行は1つでなければならない**
    // （2つ目は already_reserved として同じ行を指す）
    const rows = await own(
      owner,
      `select count(*)::int from public.billing_purchases p
         join public.billing_offers o on o.id = p.offer_id
        where o.code = $1 and p.profile_id = $2
          and p.status in ('reserved','paid','refund_pending','disputed')`,
      [FOUNDER, u],
    );
    assert(rows === 1, `生きている購入が ${rows} 件ある（1件でなければならない）`);

    const ids = [ra, rb]
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value.purchase_id);
    if (ids.length === 2) {
      assert(ids[0] === ids[1], "2つの接続が別々の購入を作った");
    }

    await a.end();
    await b.end();
  });

  /* -- C6 同じ知らせが2本同時に ------------------------------------------- */

  await test("C6 同じ知らせが2つの接続から同時に来ても、処理するのは1つだけ", async () => {
    const a = await open(started.pg);
    const b = await open(started.pg);
    const evt = "evt_race_0001";

    const [ra, rb] = await Promise.allSettled([
      svc(a, `select public.billing_claim_webhook_event($1, $2, $3, $4, now())`, [
        evt,
        "checkout.session.completed",
        "cs_race",
        false,
      ]),
      svc(b, `select public.billing_claim_webhook_event($1, $2, $3, $4, now())`, [
        evt,
        "checkout.session.completed",
        "cs_race",
        false,
      ]),
    ]);

    const settled = [ra, rb].filter((r) => r.status === "fulfilled").map((r) => r.value);
    const claimed = settled.filter((v) => v.claimed === true);
    assert(
      claimed.length === 1,
      `押さえられたのが ${claimed.length} 件（1件でなければならない）。` +
        `返り: ${JSON.stringify(settled)}`,
    );

    const rows = await own(
      owner,
      `select count(*)::int from public.billing_webhook_events where stripe_event_id = $1`,
      [evt],
    );
    assert(rows === 1, `知らせの行が ${rows} 件ある`);

    await a.end();
    await b.end();
  });

  await owner.end();
}

/* ---------------------------------------------------------------------------
 * 後片付け
 * ------------------------------------------------------------------------- */

let exitCode = 0;

try {
  await main();
} catch (e) {
  results.push({ name: "試験そのものが止まった", ok: false, why: e.message });
  console.log(`  ✗ 試験そのものが止まった\n      ${e.message}`);
}

if (started) {
  try {
    await started.pg.stop();
  } catch {
    /* 止め損ねても、下でフォルダごと消す */
  }
  await rm(started.dir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(
  `合計 ${results.length} 件 / 合格 ${results.length - failed.length} 件 / 不合格 ${failed.length} 件`,
);
for (const f of failed) console.log(`  ✗ ${f.name}: ${f.why}`);

recordCount("同時実行の試験", results.length);

exitCode = failed.length === 0 ? 0 : 1;
process.exit(exitCode);
