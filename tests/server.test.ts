// standalone 版のサーバー（src/server.ts）のテスト。空いている番号で起動し、HTTP で叩く。
// エンジンは渡さない（jar 無し → FormalSolver は UNVERIFIED）。LLM のクライアントも無いので、LLM の項目は NOT_GENERATED。

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { insideOf, startServer, type RunningServer } from "../src/server.js";

// 真偽値の旗を 1 つ持つ関数（コマンドラインのテストと同じ）。
const OPEN_SOURCE = [
  "let open = false;",
  "export function openIt() {",
  "  if (open) {",
  '    return "already";',
  "  }",
  "  open = true;",
  '  return "opened";',
  "}",
  "",
].join("\n");

interface Fixture {
  dir: string;
  root: string;
  repo: string;
  out: string;
}

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "specula-server-"));
  const root = join(dir, "pkg");
  const repo = join(dir, "repo");
  const out = join(dir, "out");
  await mkdir(join(root, "web"), { recursive: true });
  await mkdir(join(root, "itera"), { recursive: true });
  await writeFile(join(root, "web", "index.html"), "<!DOCTYPE html><title>dashboard</title>");
  await writeFile(join(root, "itera", "spec_viewer.html"), "<!DOCTYPE html><title>viewer</title>");
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "open.ts"), OPEN_SOURCE);
  return { dir, root, repo, out };
}

async function withServer(fn: (server: RunningServer, f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  const server = await startServer({ port: 0, root: f.root, repo: f.repo, out: f.out });
  try {
    await fn(server, f);
  } finally {
    await server.close();
    await rm(f.dir, { recursive: true, force: true });
  }
}

/** Host ヘッダーを自分で決めて GET する（fetch では Host を変えられないため）。 */
function getWithHost(url: string, hostHeader: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const u = new URL(url);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "GET", headers: { host: hostHeader } }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

interface StatusBody {
  version: string;
  bundle: { ready: boolean };
  run: { state: string; error: string | null; totals: unknown };
  lastRun: { out: string; totals: unknown } | null;
}

async function statusOf(base: string): Promise<StatusBody> {
  const res = await fetch(new URL("/api/status", base));
  assert.equal(res.status, 200);
  return (await res.json()) as StatusBody;
}

async function waitFinished(base: string): Promise<StatusBody> {
  for (let i = 0; i < 300; i++) {
    const s = await statusOf(base);
    if (s.run.state !== "RUNNING") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("実行が終わらない");
}

test("insideOf は出力先の中のパスだけを返す", () => {
  const base = resolve("/tmp/specula-out");
  assert.equal(insideOf(base, "run_report.json"), join(base, "run_report.json"));
  assert.equal(insideOf(base, "./commands/a/spec.json"), join(base, "commands", "a", "spec.json"));
  assert.equal(insideOf(base, "/run_report.json"), join(base, "run_report.json"));
  assert.equal(insideOf(base, "."), base);
  assert.equal(insideOf(base, "../secret"), null);
  assert.equal(insideOf(base, "commands/../../secret"), null);
  assert.ok(!(insideOf(base, "a") ?? "").includes(`..${sep}`));
});

test("ステータスは版・bundle の有無・実行の状態を返す", async () => {
  await withServer(async (server) => {
    const s = await statusOf(server.url);
    assert.equal(s.version, "9.9.9");
    assert.equal(s.bundle.ready, false);
    assert.equal(s.run.state, "IDLE");
    assert.equal(s.lastRun, null);
  });
});

test("画面のファイルを配り、bundle が無ければ 404 で理由を返す", async () => {
  await withServer(async (server) => {
    const dashboard = await fetch(new URL("/", server.url));
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /dashboard/);
    const viewer = await fetch(new URL("/viewer", server.url));
    assert.equal(viewer.status, 200);
    assert.match(await viewer.text(), /viewer/);
    const bundle = await fetch(new URL("/bundle.js", server.url));
    assert.equal(bundle.status, 404);
    assert.match(await bundle.text(), /build:itera/);
  });
});

test("Host ヘッダーが自分の名前でなければ断る", async () => {
  await withServer(async (server) => {
    const port = new URL(server.url).port;
    assert.equal(await getWithHost(new URL("/api/status", server.url).href, "evil.example"), 403);
    assert.equal(await getWithHost(new URL("/api/status", server.url).href, `localhost:${port}`), 200);
  });
});

test("実行の開始は JSON だけを受け、足りない設定は理由を返す", async () => {
  await withServer(async (server, f) => {
    const form = await fetch(new URL("/api/run", server.url), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ repo: f.repo, out: f.out }),
    });
    assert.equal(form.status, 415);
    const noRepo = await fetch(new URL("/api/run", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ out: f.out }),
    });
    assert.equal(noRepo.status, 400);
    const sameDir = await fetch(new URL("/api/run", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: f.repo, out: f.repo }),
    });
    assert.equal(sameDir.status, 400);
    const get = await fetch(new URL("/api/run", server.url));
    assert.equal(get.status, 405);
  });
});

test("画面から始めた実行が終わると、出力を出力先の中からだけ読める", async () => {
  await withServer(async (server, f) => {
    const started = await fetch(new URL("/api/run", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: f.repo, out: f.out, alloyJar: "" }),
    });
    assert.equal(started.status, 202);
    const s = await waitFinished(server.url);
    assert.equal(s.run.state, "DONE", String(s.run.error));
    assert.notEqual(s.run.totals, null);
    assert.equal(s.lastRun?.out, f.out);

    const exists = await fetch(new URL("/api/out/exists?path=run_report.json", server.url));
    assert.deepEqual(await exists.json(), { exists: true });
    const read = await fetch(new URL("/api/out/read?path=./run_report.json", server.url));
    assert.equal(read.status, 200);
    assert.ok(typeof JSON.parse(await read.text()) === "object");
    const list = await fetch(new URL("/api/out/list?path=.", server.url));
    const entries = ((await list.json()) as { entries: string[] }).entries;
    assert.ok(entries.includes("run_report.json"));
    const outside = await fetch(new URL(`/api/out/read?path=${encodeURIComponent("../repo/src/open.ts")}`, server.url));
    assert.equal(outside.status, 403);
  });
});