// LocalBridgeAlloyAdapter のテスト（M3 の設計 3.4、全体設計 4.1）。
// ブリッジは偽の fetch で置き換える。シェルの往復（base64 の展開・目印の行・一時ディレクトリ）は、
// 偽の fetch が手元の bash でコマンドを実際に動かし、偽の java（シェルスクリプト）を呼んで確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LocalBridgeAlloyAdapter,
  MAX_COMMAND_BYTES,
  base64Utf8,
  buildExecCommand,
  interpretExecOutput,
  shellQuote,
} from "../src/adapters/LocalBridgeAlloyAdapter.js";
import type { BridgeFetch } from "../src/adapters/LocalBridgeAlloyAdapter.js";
import type { EngineInfo, SolverRequest } from "../src/ports/SolverPort.js";

const REQUEST: SolverRequest = {
  source: "module x\n-- 日本語のコメント\nrun m3_cover {} for 3 but 4 Int, 1..1 steps\n",
  command: "m3_cover",
  steps: 1,
  bitwidth: 4,
  preventOverflow: true,
  timeoutMs: 1500,
};
const ENGINE: EngineInfo = { alloyVersion: "6.2.0", satSolver: "sat4j", satSolverVersion: null };
const RECEIPT_UNSAT = JSON.stringify({ solver: "sat4j", commands: { m3_cover: { bitwidth: 4, maxprefix: 1 } } });
const RECEIPT_SAT = JSON.stringify({
  solver: "sat4j",
  commands: {
    m3_cover: { bitwidth: 4, maxprefix: 1, solution: [{ instances: [{ values: { System$0: { v1: [["False$0"]] } } }] }] },
  },
});

function done(stdout: string, stderr = "", exitCode = 0): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode, stdout, stderr };
}

// ---- 純粋な関数 ----

test("base64Utf8 は Node.js の Buffer と同じ結果を返す（空・端数・日本語）", () => {
  for (const text of ["", "a", "ab", "abc", "abcd", "abcde", "日本語の ' と \" と \\", REQUEST.source]) {
    assert.equal(base64Utf8(text), Buffer.from(text, "utf8").toString("base64"), text);
  }
});

test("shellQuote は単一引用符を閉じて埋め直す", () => {
  assert.equal(shellQuote("/opt/alloy.jar"), "'/opt/alloy.jar'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("buildExecCommand: ソースを base64 で埋め、-n とソルバとコマンド名を渡し、目印の行の後ろに receipt を出す", () => {
  const command = buildExecCommand(REQUEST, { javaPath: "/usr/bin/java", jarPath: "/opt/my alloy.jar", satSolver: "sat4j" });
  assert.ok(command.includes(`'${base64Utf8(REQUEST.source)}'`));
  assert.ok(command.includes("'/usr/bin/java' -jar '/opt/my alloy.jar' exec -f -q -n -s 'sat4j' -c 'm3_cover'"));
  assert.ok(command.includes('echo "<<<SPECULA-EXIT $?>>>"'));
  assert.ok(command.indexOf("<<<SPECULA-EXIT") < command.indexOf("receipt.json"));
  const noOverflow = buildExecCommand({ ...REQUEST, preventOverflow: false }, { javaPath: "java", jarPath: "a.jar", satSolver: "sat4j" });
  assert.ok(!noOverflow.includes(" -n "));
});

test("interpretExecOutput: 設計 3.4 の表のとおりに対応させる", () => {
  assert.deepEqual(interpretExecOutput(done("", "[timeout 2s]", 124), REQUEST, ENGINE), { kind: "TIMEOUT", engine: ENGINE });

  const noMark = interpretExecOutput(done("mktemp: failed", "", 70), REQUEST, ENGINE);
  assert.equal(noMark.kind, "ENGINE_ERROR");

  const noJava = interpretExecOutput(done("<<<SPECULA-EXIT 127>>>\n", "bash: java: command not found"), REQUEST, ENGINE);
  assert.equal(noJava.kind, "UNREACHABLE");

  const noJar = interpretExecOutput(done("<<<SPECULA-EXIT 1>>>\n", "Error: Unable to access jarfile /x.jar"), REQUEST, ENGINE);
  assert.equal(noJar.kind, "UNREACHABLE");

  const syntax = interpretExecOutput(
    done("[main] ERROR alloy - Syntax error in /tmp/x/model.als at line 2 column 1:\nThere are 1 possible tokens\n<<<SPECULA-EXIT 1>>>\n"),
    REQUEST,
    ENGINE,
  );
  assert.equal(syntax.kind, "ENGINE_ERROR");
  assert.ok(syntax.kind === "ENGINE_ERROR" && syntax.message.includes("Syntax error"), JSON.stringify(syntax));

  const noReceipt = interpretExecOutput(done("<<<SPECULA-EXIT 0>>>\n"), REQUEST, ENGINE);
  assert.equal(noReceipt.kind, "ENGINE_ERROR");

  assert.deepEqual(interpretExecOutput(done(`alloy says hi\n<<<SPECULA-EXIT 0>>>\n${RECEIPT_UNSAT}`), REQUEST, ENGINE), {
    kind: "UNSAT",
    engine: ENGINE,
  });

  const sat = interpretExecOutput(done(`<<<SPECULA-EXIT 0>>>\n${RECEIPT_SAT}\n`), REQUEST, ENGINE);
  assert.equal(sat.kind, "SAT");
  assert.deepEqual(sat.kind === "SAT" ? sat.instance.states : null, [{ "System.v1": [["False$0"]] }]);
});

// ---- 偽のブリッジ ----

interface Call {
  url: string;
  command: string;
  scope: unknown;
  timeout: unknown;
}

function fakeBridge(answer: (command: string) => unknown, calls: Call[]): BridgeFetch {
  return async (url, init) => {
    const body = JSON.parse(init.body) as { command: string; scope: unknown; timeout: unknown };
    calls.push({ url, command: body.command, scope: body.scope, timeout: body.timeout });
    const value = answer(body.command);
    return { ok: true, status: 200, json: async () => value };
  };
}

test("版はアダプターごとに 1 回だけ取り、本文は scope host と秒の timeout で送る", async () => {
  const calls: Call[] = [];
  const adapter = new LocalBridgeAlloyAdapter({
    fetch: fakeBridge((command) => (command.endsWith(" version") ? done("6.2.0\n") : done(`<<<SPECULA-EXIT 0>>>\n${RECEIPT_UNSAT}`)), calls),
    serverUrl: "http://127.0.0.1:8001/",
    jarPath: "/opt/alloy.jar",
  });
  assert.deepEqual(await adapter.run(REQUEST), { kind: "UNSAT", engine: ENGINE });
  assert.deepEqual(await adapter.run({ ...REQUEST, timeoutMs: 10_000_000 }), { kind: "UNSAT", engine: ENGINE });
  assert.equal(calls.length, 3);
  assert.equal(calls[0]?.command, "'java' -jar '/opt/alloy.jar' version");
  assert.equal(calls[1]?.url, "http://127.0.0.1:8001/api/exec");
  assert.equal(calls[1]?.scope, "host");
  assert.equal(calls[1]?.timeout, 2);
  assert.equal(calls[2]?.timeout, 600);
});

test("通信の失敗・HTTP の誤り・403・形の違う返り値は UNREACHABLE（例外を投げない）", async () => {
  const base = { serverUrl: "http://127.0.0.1:8001", jarPath: "/opt/alloy.jar" };
  const thrown = new LocalBridgeAlloyAdapter({
    ...base,
    fetch: async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    },
  });
  const r1 = await thrown.run(REQUEST);
  assert.equal(r1.kind, "UNREACHABLE");

  const forbidden = new LocalBridgeAlloyAdapter({ ...base, fetch: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
  const r2 = await forbidden.run(REQUEST);
  assert.ok(r2.kind === "UNREACHABLE" && r2.detail.includes("403"), JSON.stringify(r2));

  const malformed = new LocalBridgeAlloyAdapter({ ...base, fetch: fakeBridge(() => ({ exitCode: "0" }), []) });
  assert.equal((await malformed.run(REQUEST)).kind, "UNREACHABLE");
});

test("版が取れないとき: java が無ければ UNREACHABLE、ブリッジの時間切れは TIMEOUT", async () => {
  const base = { serverUrl: "http://127.0.0.1:8001", jarPath: "/opt/alloy.jar" };
  const noJava = new LocalBridgeAlloyAdapter({ ...base, fetch: fakeBridge(() => done("", "bash: java: command not found", 127), []) });
  assert.equal((await noJava.run(REQUEST)).kind, "UNREACHABLE");
  const slow = new LocalBridgeAlloyAdapter({ ...base, fetch: fakeBridge(() => done("", "[timeout 30s]", 124), []) });
  assert.deepEqual(await slow.run(REQUEST), { kind: "TIMEOUT", engine: null });
});

test("コマンドが上限を超えたら送らずに UNREACHABLE を返す", async () => {
  const calls: Call[] = [];
  const adapter = new LocalBridgeAlloyAdapter({
    fetch: fakeBridge(() => done("6.2.0\n"), calls),
    serverUrl: "http://127.0.0.1:8001",
    jarPath: "/opt/alloy.jar",
  });
  const response = await adapter.run({ ...REQUEST, source: "x".repeat(MAX_COMMAND_BYTES) });
  assert.ok(response.kind === "UNREACHABLE" && response.detail.includes("バイト"), JSON.stringify(response));
  assert.equal(calls.length, 1, "版を取る 1 回だけで、exec は送っていない");
});

// ---- シェルの往復（手元の bash で実際に動かす） ----

const FAKE_JAVA = `#!/bin/bash
if [ "$3" = "version" ]; then echo "6.2.0"; exit 0; fi
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
model="\${@: -1}"
cp "$model" "$SPECULA_FAKE_COPY"
echo "$*" > "$SPECULA_FAKE_ARGS"
mkdir -p "$out"
cat "$SPECULA_FAKE_RECEIPT" > "$out/receipt.json"
echo "fake alloy done"
`;

test("bash の往復: ソースがそのまま手元に書き出され、receipt が目印の後ろから読める", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "specula-bridge-test-"));
  try {
    const java = join(dir, "fake java");
    const receiptPath = join(dir, "receipt.json");
    const copyPath = join(dir, "copied.als");
    const argsPath = join(dir, "args.txt");
    await writeFile(java, FAKE_JAVA, "utf8");
    await chmod(java, 0o755);
    await writeFile(receiptPath, RECEIPT_SAT, "utf8");
    const env = { ...process.env, SPECULA_FAKE_COPY: copyPath, SPECULA_FAKE_RECEIPT: receiptPath, SPECULA_FAKE_ARGS: argsPath };

    const bridge: BridgeFetch = async (_url, init) => {
      const body = JSON.parse(init.body) as { command: string };
      const result = spawnSync("bash", ["-c", body.command], { env, encoding: "utf8" });
      return { ok: true, status: 200, json: async () => done(result.stdout, result.stderr, result.status ?? -1) };
    };
    const adapter = new LocalBridgeAlloyAdapter({ fetch: bridge, serverUrl: "http://bridge", jarPath: "/opt/it's alloy.jar", javaPath: java });
    const response = await adapter.run(REQUEST);

    assert.equal(response.kind, "SAT", JSON.stringify(response));
    assert.equal(await readFile(copyPath, "utf8"), REQUEST.source);
    const args = await readFile(argsPath, "utf8");
    assert.ok(args.startsWith("-jar /opt/it's alloy.jar exec -f -q -n -s sat4j -c m3_cover -o "), args);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});