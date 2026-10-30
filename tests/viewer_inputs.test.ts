// 画面の入力（readRunOutputs）と事前条件（checkRunOutputs）のテスト（SpecViewer 仕様 3.1、基本設計 6.1・6.2）。
// コマンドラインの入口で一時ディレクトリに実際の出力を書き、それを読み戻す（writeOutputs と対になっていることを確かめるため）。
// 事前条件の破れは、書いた出力のファイルを消したり書き換えたりして作る。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { main, safeName } from "../src/cli.js";
import { readRunOutputs } from "../src/lib/read_outputs.js";
import { checkRunOutputs } from "../src/viewer/check.js";

// 旗を 1 つ持つ関数（仕様になる）と、値が決まらない書き込みと外への作用がある関数（曖昧さで止まる）。cli.test と同じ。
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

const AMBIGUOUS_SOURCE = [
  'let state = "a";',
  "export function go(x: number) {",
  "  state = compute(x);",
  "  save(state);",
  "  state.trim();",
  "  log(x);",
  "  return 1;",
  "}",
  "",
].join("\n");

const REPO: Record<string, string> = {
  "src/index.ts": 'export { openIt } from "./a.js";\nexport { go } from "./g.js";\n',
  "src/a.ts": OPEN_SOURCE,
  "src/g.ts": AMBIGUOUS_SOURCE,
};

interface Scenario {
  scenarioId: string;
  displayId: string;
  kind: string;
}

/** 一時ディレクトリでリポジトリにかけ、出力先と報告のシナリオを渡す。終わったら消す。 */
async function withOutputs(body: (out: string, scenarios: Scenario[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-viewer-"));
  try {
    await mkdir(join(root, "repo", "src"), { recursive: true });
    for (const [path, text] of Object.entries(REPO)) await writeFile(join(root, "repo", path), text, "utf8");
    const out = join(root, "out");
    const io = { stdout: (): void => {}, stderr: (): void => {} };
    assert.equal(await main([join(root, "repo"), "--out", out], io), 0);
    const report = JSON.parse(await readFile(join(out, "run_report.json"), "utf8"));
    await body(out, report.scenarios as Scenario[]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const fs = new NodeFsAdapter();

function scenarioOfKind(scenarios: Scenario[], kind: string): Scenario {
  const found = scenarios.find((s) => s.kind === kind);
  assert.ok(found, `${kind} のシナリオが無い: ${JSON.stringify(scenarios)}`);
  return found;
}

test("書いた出力をすべて読み戻せて、事前条件を満たす", async () => {
  await withOutputs(async (out, scenarios) => {
    scenarioOfKind(scenarios, "COMPLETED");
    scenarioOfKind(scenarios, "AMBIGUOUS");

    const outputs = await readRunOutputs(fs, out);
    for (const read of [outputs.report, outputs.systemMap, outputs.glossary, outputs.intents, outputs.implementationMap]) {
      assert.equal(read.kind, "OK");
    }
    // シナリオは報告の順・同じ id で、kind から決まるファイルがそろう
    assert.deepEqual(
      outputs.scenarios.map((s) => [s.scenarioId, s.displayId, s.kind]),
      scenarios.map((s) => [s.scenarioId, s.displayId, s.kind]),
    );
    for (const scenario of outputs.scenarios) {
      if (scenario.kind === "COMPLETED") {
        for (const read of [scenario.spec, scenario.document, scenario.matrix, scenario.flow, scenario.source, scenario.ledger]) {
          assert.equal(read.kind, "OK");
        }
      } else if (scenario.kind === "AMBIGUOUS") {
        assert.equal(scenario.ambiguity.kind, "OK");
      }
    }

    assert.deepEqual(checkRunOutputs(outputs), { ok: true, problems: [] });
  });
});

test("出力先の末尾に / があっても同じように読む", async () => {
  await withOutputs(async (out) => {
    assert.deepEqual(await readRunOutputs(fs, `${out}/`), await readRunOutputs(fs, out));
  });
});

test("実行の報告が無ければ、シナリオを読まずに REPORT_MISSING を返す", async () => {
  await withOutputs(async (out) => {
    await rm(join(out, "run_report.json"));
    const outputs = await readRunOutputs(fs, out);
    assert.equal(outputs.report.kind, "MISSING");
    assert.deepEqual(outputs.scenarios, []);
    const check = checkRunOutputs(outputs);
    assert.equal(check.ok, false);
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file]),
      [["REPORT_MISSING", "run_report.json"]],
    );
  });
});

test("任意のファイル（辞書・意図の候補・対応表・俯瞰図）が無くても、画面を作れる", async () => {
  await withOutputs(async (out) => {
    for (const name of ["glossary.json", "intents.json", "implementation_map.json", "system_map.json"]) {
      await rm(join(out, name));
    }
    const outputs = await readRunOutputs(fs, out);
    assert.equal(outputs.glossary.kind, "MISSING");
    assert.deepEqual(checkRunOutputs(outputs), { ok: true, problems: [] });
  });
});

test("basis が実行の報告と違うファイルは BASIS_MISMATCH", async () => {
  await withOutputs(async (out) => {
    const path = join(out, "intents.json");
    const intents = JSON.parse(await readFile(path, "utf8"));
    intents.basis.documentsHash = "0".repeat(64);
    await writeFile(path, JSON.stringify(intents), "utf8");

    const check = checkRunOutputs(await readRunOutputs(fs, out));
    assert.equal(check.ok, false);
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file, p.scenario]),
      [["BASIS_MISMATCH", "intents.json", null]],
    );
    assert.ok(check.problems[0]?.detail.includes("documentsHash"));
    assert.ok(!check.problems[0]?.detail.includes("mapHash"));
  });
});

test("basis を持たない古い出力は NO_BASIS", async () => {
  await withOutputs(async (out) => {
    const path = join(out, "run_report.json");
    const report = JSON.parse(await readFile(path, "utf8"));
    delete report.basis;
    await writeFile(path, JSON.stringify(report), "utf8");

    const check = checkRunOutputs(await readRunOutputs(fs, out));
    assert.equal(check.ok, false);
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file]),
      [["NO_BASIS", "run_report.json"]],
    );
  });
});

test("壊れた JSON と、無いシナリオのファイルは、シナリオの表示の id を付けて返す（内部の識別子は出さない）", async () => {
  await withOutputs(async (out, scenarios) => {
    const completed = scenarioOfKind(scenarios, "COMPLETED");
    const ambiguous = scenarioOfKind(scenarios, "AMBIGUOUS");
    await writeFile(join(out, "scenarios", safeName(completed.scenarioId), "ledger.json"), "{ not json", "utf8");
    await rm(join(out, "scenarios", safeName(ambiguous.scenarioId), "ambiguity.json"));
    await rm(join(out, "scenarios", safeName(completed.scenarioId), "flow.mmd"));
    await rm(join(out, "scenarios", safeName(completed.scenarioId), "spec.json"));

    const outputs = await readRunOutputs(fs, out);
    const completedRead = outputs.scenarios.find((s) => s.scenarioId === completed.scenarioId);
    assert.equal(completedRead?.kind === "COMPLETED" ? completedRead.ledger.kind : null, "INVALID");

    const check = checkRunOutputs(outputs);
    assert.equal(check.ok, false);
    // 並びは報告のシナリオの順、シナリオの中はファイルの決まった順
    const expected = scenarios.flatMap((s) =>
      s.scenarioId === completed.scenarioId
        ? [
            ["SCENARIO_FILE_MISSING", "spec.json", s.displayId],
            ["SCENARIO_FILE_MISSING", "flow.mmd", s.displayId],
            ["INVALID_JSON", "ledger.json", s.displayId],
          ]
        : s.scenarioId === ambiguous.scenarioId
          ? [["SCENARIO_FILE_MISSING", "ambiguity.json", s.displayId]]
          : [],
    );
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file, p.scenario]),
      expected,
    );
    for (const problem of check.problems) {
      assert.ok(!problem.detail.includes(completed.scenarioId) && !problem.detail.includes(ambiguous.scenarioId));
    }
  });
});