// 使い捨ての PostgreSQL 17.6 を 55433 番で立て、全文をログに残す。本番とは無関係。
import EmbeddedPostgres from "embedded-postgres";
import fs from "node:fs"; import path from "node:path";
const H = process.argv[2];
const dir = path.join(H, "pgdata");
fs.rmSync(dir, { recursive: true, force: true });
const log = fs.createWriteStream(path.join(H, "pg-statements.log"), { flags: "a" });
const s = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "pw", port: 55433, persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale-provider=icu", "--icu-locale=en-US", "--locale=en_US.UTF-8"],
  postgresFlags: ["-c", "log_statement=all", "-c", "log_line_prefix=@@[%d|%a|%p] ", "-c", "max_connections=200"],
  onLog: (m) => log.write(m.endsWith("\n") ? m : m + "\n"), onError: (m) => log.write("ERR " + m + "\n") });
await s.initialise(); await s.start();
console.log("READY");
const stop = async () => { await s.stop(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
setInterval(() => {}, 1e9);
