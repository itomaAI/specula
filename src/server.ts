// Node.js の画面つきの入口（standalone 版）。clone して npm install・npm run build:itera のあと、node dist/src/server.js で開く。
// アダプターの組み立てはコマンドライン（cli.ts）と同じで、解析の処理は持たない。画面から実行を始め、結果は SpecViewer（itera/spec_viewer.html）で見る。
//
// 使い方: node dist/src/server.js [--port 8787] [--host 127.0.0.1] [--repo <dir>] [--out <dir>] [--alloy-jar <jar>] [--records <dir>]
//   --repo・--out・--alloy-jar はダッシュボードの入力欄の初めの値。画面で変えてよい。
//
// 守り（手元の PC で動かす道具なので、外から操作されないようにする）:
// - 既定では 127.0.0.1 だけで待つ。
// - Host ヘッダーが自分の待ち受けの名前でなければ断る（DNS rebinding で別のサイトから読まれないため）。
// - POST は Content-Type が application/json のときだけ受ける。CORS の許可は返さないので、別のサイトのページからは送れない。
// - 出力を読む口（/api/out/...）は、いまの出力先の中だけを読む。
// - 書き出しと読み込み（/api/export・/api/import）は、画面で指定した 2 つのディレクトリだけに書く。互いの中に入るディレクトリは断る。
//
// このファイルは Itera 向けの bundle（index.ts から）に入らないので、node: のモジュールを静的に import してよい。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CliAlloyAdapter } from "./adapters/CliAlloyAdapter.js";
import { NodeFsAdapter } from "./adapters/NodeFsAdapter.js";
import { readRepository } from "./adapters/NodeRepositoryReader.js";
import { RecordingLanguageModel } from "./adapters/RecordingLanguageModel.js";
import { runPipeline } from "./core/orchestrator.js";
import { withRoot } from "./lib/rooted_file_system.js";
import { exportRun, importRun } from "./lib/transfer_outputs.js";
import { writeOutputs } from "./lib/write_outputs.js";

const USAGE =
  "使い方: node dist/src/server.js [--port 8787] [--host 127.0.0.1] [--repo <dir>] [--out <dir>] [--alloy-jar <jar>] [--records <dir>]";

/** dist/src/server.js から見たパッケージの根（web/・itera/・dist/ がある場所）。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BODY_LIMIT = 64 * 1024;
const LOG_LIMIT = 500;

export interface ServerOptions {
  host?: string;
  /** 0 なら空いている番号を使う（テスト用）。 */
  port?: number;
  repo?: string;
  out?: string;
  alloyJar?: string;
  /** LLM の記録の置き場所。無ければ <出力先>/llm_records。 */
  records?: string;
  /** web/・itera/・dist/ を探す根。テストで差し替える。 */
  root?: string;
}

export interface RunState {
  state: "IDLE" | "RUNNING" | "DONE" | "FAILED";
  repo: string | null;
  out: string | null;
  alloyJar: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  totals: unknown;
  error: string | null;
}

export interface RunningServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

interface RunSettings {
  repo: string;
  out: string;
  alloyJar: string | null;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const host = options.host ?? "127.0.0.1";
  const root = options.root ?? PACKAGE_ROOT;
  const defaults = {
    repo: options.repo ?? "",
    out: options.out ?? "",
    alloyJar: options.alloyJar ?? "",
  };
  const recordsOption = options.records ?? null;
  const version = await readVersion(root);

  let run: RunState = {
    state: "IDLE",
    repo: null,
    out: null,
    alloyJar: null,
    startedAt: null,
    finishedAt: null,
    log: [],
    totals: null,
    error: null,
  };
  // 結果の画面が読む出力先。実行が終わればその出力先、まだなら --out。
  let currentOut: string | null = defaults.out === "" ? null : resolve(defaults.out);

  const log = (line: string): void => {
    run.log.push(`${new Date().toISOString()} ${line}`);
    if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT);
  };

  async function startRun(settings: RunSettings): Promise<void> {
    run = {
      state: "RUNNING",
      repo: settings.repo,
      out: settings.out,
      alloyJar: settings.alloyJar,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: [],
      totals: null,
      error: null,
    };
    try {
      const fs = new NodeFsAdapter();
      const recordsDir = recordsOption ?? join(settings.out, "llm_records");
      log(`リポジトリを読む: ${settings.repo}`);
      const repo = await readRepository(settings.repo);
      log(`ファイル ${repo.files.length} 件、仕様の資料 ${repo.documents.length} 件`);
      log(settings.alloyJar === null ? "jar の指定が無いので、検証（FormalSolver）はしない" : `検証（FormalSolver）は ${settings.alloyJar} で行う`);
      log("LLM は記録の再生だけ（記録が無い項目は「未生成」になる）");
      log("解析を始める");
      const result = await runPipeline(repo, {
        fs: withRoot(fs, settings.repo),
        llm: new RecordingLanguageModel(null, fs, recordsDir),
        solver: settings.alloyJar === null ? null : new CliAlloyAdapter({ jarPath: settings.alloyJar }),
      });
      const written = await writeOutputs(fs, settings.out, result);
      log(`出力 ${written.length} 件を書いた: ${settings.out}`);
      run.totals = result.report.totals;
      run.state = "DONE";
      currentOut = settings.out;
    } catch (error) {
      run.error = messageOf(error);
      run.state = "FAILED";
      log(`実行を止めた（環境の故障）: ${run.error}`);
    } finally {
      run.finishedAt = new Date().toISOString();
    }
  }

  async function status(): Promise<unknown> {
    const bundleReady = await isFile(join(root, "dist", "specula.itera.js"));
    const jar = defaults.alloyJar === "" ? null : resolve(defaults.alloyJar);
    let lastRun: unknown = null;
    if (currentOut !== null) {
      const reportPath = join(currentOut, "run_report.json");
      if (await isFile(reportPath)) {
        try {
          const report = JSON.parse(await readFile(reportPath, "utf8")) as { totals?: unknown };
          lastRun = { out: currentOut, totals: report.totals ?? null };
        } catch (error) {
          lastRun = { out: currentOut, totals: null, error: `run_report.json を読めない: ${messageOf(error)}` };
        }
      }
    }
    return {
      version,
      defaults,
      bundle: { ready: bundleReady },
      solver: { jar, jarExists: jar === null ? false : await isFile(jar) },
      llm: { mode: "REPLAY" },
      run,
      lastRun,
    };
  }

  async function handle(req: IncomingMessage, res: ServerResponse, allowedHosts: ReadonlySet<string>): Promise<void> {
    if (!allowedHosts.has(String(req.headers.host ?? ""))) {
      sendText(res, 403, "Host が違う");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/") return sendFile(res, join(root, "web", "index.html"), "text/html; charset=utf-8");
    if (req.method === "GET" && path === "/viewer") return sendFile(res, join(root, "itera", "spec_viewer.html"), "text/html; charset=utf-8");
    if (req.method === "GET" && path === "/bundle.js") {
      return sendFile(res, join(root, "dist", "specula.itera.js"), "text/javascript; charset=utf-8", "bundle が無い（npm run build:itera を実行する）");
    }
    if (req.method === "GET" && path === "/api/status") return sendJson(res, 200, await status());

    if (path === "/api/run") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST だけを受ける" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return sendJson(res, 415, { error: "Content-Type は application/json" });
      }
      if (run.state === "RUNNING") return sendJson(res, 409, { error: "実行中" });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, BODY_LIMIT));
      } catch (error) {
        return sendJson(res, 400, { error: `本文を読めない: ${messageOf(error)}` });
      }
      const settings = await settingsOf(body);
      if (typeof settings === "string") return sendJson(res, 400, { error: settings });
      void startRun(settings);
      return sendJson(res, 202, { ok: true });
    }

    // 書き出しと読み込み（standalone 版の C）。本文は { dir, out, replace? }。dir は書き出し先（読み込みでは読み込み元）。
    if (path === "/api/export" || path === "/api/import") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "POST だけを受ける" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return sendJson(res, 415, { error: "Content-Type は application/json" });
      }
      if (run.state === "RUNNING") return sendJson(res, 409, { error: "実行中" });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req, BODY_LIMIT));
      } catch (error) {
        return sendJson(res, 400, { error: `本文を読めない: ${messageOf(error)}` });
      }
      const record = (body !== null && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string).trim() : "");
      if (text("dir") === "") return sendJson(res, 400, { error: "dir（書き出し先・読み込み元のディレクトリ）が無い" });
      if (text("out") === "") return sendJson(res, 400, { error: "out（出力先）が無い" });
      const dir = resolve(text("dir"));
      const out = resolve(text("out"));
      // 片方がもう片方の中にあると、書いたファイルを読み直したり、出力先の中身を壊したりするので断る。
      if (dir === out || dir.startsWith(out + sep) || out.startsWith(dir + sep)) {
        return sendJson(res, 400, { error: "書き出し先と出力先は、互いの中に入らない別のディレクトリにする" });
      }
      const fs = new NodeFsAdapter();
      const transfer = recordsOption === null ? {} : { recordsDir: resolve(recordsOption) };
      if (path === "/api/export") {
        const result = await exportRun(fs, out, dir, transfer);
        return sendJson(res, result.ok ? 200 : 422, result);
      }
      if (!(await isDirectory(dir))) return sendJson(res, 400, { error: `読み込み元がディレクトリではない: ${dir}` });
      const result = await importRun(fs, dir, out, { ...transfer, replace: record.replace === true });
      if (result.ok) currentOut = out;
      return sendJson(res, result.ok ? 200 : 422, result);
    }

    if (req.method === "GET" && path.startsWith("/api/out/")) {
      if (currentOut === null) return sendJson(res, 404, { error: "出力先がまだ無い" });
      const target = insideOf(currentOut, url.searchParams.get("path") ?? "");
      if (target === null) return sendJson(res, 403, { error: "出力先の外は読まない" });
      if (path === "/api/out/exists") return sendJson(res, 200, { exists: await exists(target) });
      if (path === "/api/out/list") {
        try {
          return sendJson(res, 200, { entries: await readdir(target) });
        } catch (error) {
          return sendJson(res, 404, { error: messageOf(error) });
        }
      }
      if (path === "/api/out/read") {
        if (!(await isFile(target))) return sendJson(res, 404, { error: "ファイルが無い" });
        return sendFile(res, target, "text/plain; charset=utf-8");
      }
    }
    sendText(res, 404, "無い");
  }

  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => resolveListen());
  });
  const port = (server.address() as AddressInfo).port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${host}:${port}`]);
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res, allowedHosts).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { error: messageOf(error) });
      else res.end();
    });
  });
  const shownHost = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    url: `http://${shownHost}:${port}/`,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

/** 画面から受けた設定を確かめる。誤りなら理由の文を返す。 */
async function settingsOf(body: unknown): Promise<RunSettings | string> {
  if (body === null || typeof body !== "object") return "本文は JSON のオブジェクト";
  const record = body as Record<string, unknown>;
  const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string).trim() : "");
  if (text("repo") === "") return "repo（解析するリポジトリ）が無い";
  if (text("out") === "") return "out（出力先）が無い";
  const repo = resolve(text("repo"));
  const out = resolve(text("out"));
  if (!(await isDirectory(repo))) return `repo がディレクトリではない: ${repo}`;
  if (out === repo) return "out を repo と同じにしない";
  const jarText = text("alloyJar");
  const alloyJar = jarText === "" ? null : resolve(jarText);
  if (alloyJar !== null && !(await isFile(alloyJar))) return `jar が無い: ${alloyJar}`;
  return { repo, out, alloyJar };
}

/** base の中のパスにする。外へ出るなら null。 */
export function insideOf(base: string, relative: string): string | null {
  const root = resolve(base);
  const target = resolve(root, relative.replace(/^\/+/, ""));
  if (target === root || target.startsWith(root + sep)) return target;
  return null;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("本文が大きすぎる"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function sendFile(res: ServerResponse, path: string, type: string, missing = "無い"): Promise<void> {
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch {
    sendText(res, 404, missing);
    return;
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(content);
}

function sendJson(res: ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function sendText(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readVersion(root: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: ServerOptions;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        repo: { type: "string" },
        out: { type: "string" },
        "alloy-jar": { type: "string" },
        records: { type: "string" },
      },
    });
    const v = parsed.values;
    options = {};
    if (v.port !== undefined) {
      const port = Number(v.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port は 0〜65535 の整数（${v.port}）`);
      options.port = port;
    }
    if (v.host !== undefined) options.host = v.host;
    if (v.repo !== undefined) options.repo = v.repo;
    if (v.out !== undefined) options.out = v.out;
    if (v["alloy-jar"] !== undefined) options.alloyJar = v["alloy-jar"];
    if (v.records !== undefined) options.records = v.records;
  } catch (error) {
    process.stderr.write(`引数の誤り: ${messageOf(error)}\n${USAGE}\n`);
    return 2;
  }
  try {
    const running = await startServer(options);
    process.stdout.write(`specula を開く: ${running.url}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`起動できなかった: ${messageOf(error)}\n`);
    return 1;
  }
}

// スクリプトとして実行されたときだけ動かす（テストからは startServer を直接呼ぶ）。
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}