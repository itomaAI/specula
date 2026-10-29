// CliAlloyAdapter のテスト（M3 の設計 3.1・3.3）。Java も Alloy も使わない。
// receipt.json は、2026-10-30 に CI の試しのジョブで Alloy 6.2.0 が実際に出したものを短くしたもの。
// 本物のエンジンでの確かめは tests/m3_alloy_integration.test.ts（ALLOY_JAR があるときだけ走る）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { CliAlloyAdapter, errorMessage, interpretReceipt } from "../src/adapters/CliAlloyAdapter.js";
import type { EngineInfo, SolverRequest } from "../src/ports/SolverPort.js";

const ENGINE: EngineInfo = { alloyVersion: "6.2.0", satSolver: "sat4j", satSolverVersion: null };

function request(command: string): SolverRequest {
  return { source: "", command, steps: 3, bitwidth: 4, preventOverflow: true, timeoutMs: 1000 };
}

function receipt(command: string, extra: Record<string, unknown>): string {
  return JSON.stringify({
    commands: {
      [command]: { bitwidth: 4, expects: -1, maxprefix: 3, minprefix: 1, name: command, overall: 3, type: "check", ...extra },
    },
    solver: "sat4j",
  });
}

const COVER_SOLUTION = {
  duration: 59,
  incremental: true,
  instances: [
    { values: { "0": {}, "1": {}, "2": {}, False$0: {}, System$0: { v1: [["False$0"]] }, True$0: {} } },
    { state: 1, values: { "0": {}, "1": {}, "2": {}, False$0: {}, System$0: { v1: [["True$0"]] }, True$0: {} } },
  ],
};

test("反例があれば SAT。時点 0 の state が省かれていても順に並べ、`System$0` の v1 を `System.v1` にする", () => {
  const response = interpretReceipt(receipt("m3_cover", { solution: [COVER_SOLUTION] }), request("m3_cover"), ENGINE);
  assert.equal(response.kind, "SAT");
  if (response.kind !== "SAT") return;
  assert.deepEqual(response.instance.states, [{ "System.v1": [["False$0"]] }, { "System.v1": [["True$0"]] }]);
  assert.equal(response.instance.loopBack, null);
  assert.equal(response.engine.satSolver, "sat4j");
});

test("solution が無ければ UNSAT（反例も実例も無い）", () => {
  const response = interpretReceipt(receipt("m3_holds", {}), request("m3_holds"), ENGINE);
  assert.equal(response.kind, "UNSAT");
});

test("receipt に頼んだコマンドが無ければ ENGINE_ERROR（知らないコマンド名を UNSAT と取り違えない）", () => {
  const response = interpretReceipt(receipt("m3_other", {}), request("m3_cover"), ENGINE);
  assert.equal(response.kind, "ENGINE_ERROR");
});

test("範囲（bitwidth・ステップ数）が依頼と違えば ENGINE_ERROR", () => {
  const wide = interpretReceipt(receipt("m3_cover", { bitwidth: 5 }), request("m3_cover"), ENGINE);
  assert.equal(wide.kind, "ENGINE_ERROR");
  const long = interpretReceipt(receipt("m3_cover", { maxprefix: 4 }), request("m3_cover"), ENGINE);
  assert.equal(long.kind, "ENGINE_ERROR");
});

test("整数は文字列のまま渡し、時点の番号が順でなければ ENGINE_ERROR", () => {
  const ints = {
    instances: [{ values: { C$0: { n: [["7"]] } } }, { state: 1, values: { C$0: { n: [["-8"]] } } }],
  };
  const ok = interpretReceipt(receipt("m3_wrap", { solution: [ints] }), request("m3_wrap"), ENGINE);
  assert.equal(ok.kind, "SAT");
  if (ok.kind === "SAT") assert.deepEqual(ok.instance.states, [{ "C.n": [["7"]] }, { "C.n": [["-8"]] }]);

  const shuffled = { instances: [{ state: 1, values: {} }, { state: 0, values: {} }] };
  const bad = interpretReceipt(receipt("m3_wrap", { solution: [shuffled] }), request("m3_wrap"), ENGINE);
  assert.equal(bad.kind, "ENGINE_ERROR");
});

test("JSON として読めない receipt は ENGINE_ERROR", () => {
  assert.equal(interpretReceipt("{", request("m3_cover"), ENGINE).kind, "ENGINE_ERROR");
});

test("誤りのメッセージは Syntax error の行と、その次の理由の行を取る", () => {
  const stderr = [
    "[main] ERROR alloy - excuting sub command CLI:exec error Syntax error in /tmp/model.als at line 2 column 12:",
    'The name "no_such_pred" cannot be found.',
    "\tat edu.mit.csail.sdg.parser.CompModule.hint(CompModule.java:975)",
  ].join("\n");
  const message = errorMessage("", stderr, 1);
  assert.match(message, /^終了コード 1: /);
  assert.match(message, /line 2 column 12/);
  assert.match(message, /no_such_pred/);
  assert.doesNotMatch(message, /CompModule\.hint/);
});

test("jar が無ければ UNREACHABLE", async () => {
  const adapter = new CliAlloyAdapter({ jarPath: "/no/such/alloy.jar" });
  const response = await adapter.run(request("m3_cover"));
  assert.equal(response.kind, "UNREACHABLE");
});

test("java を起動できなければ UNREACHABLE", async () => {
  const jarPath = fileURLToPath(import.meta.url); // 在ることだけ要る（中身は読まない）
  const adapter = new CliAlloyAdapter({ jarPath, javaPath: "/no/such/java-for-specula-test" });
  const response = await adapter.run(request("m3_cover"));
  assert.equal(response.kind, "UNREACHABLE");
});