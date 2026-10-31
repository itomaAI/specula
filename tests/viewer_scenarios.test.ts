// シナリオ一覧とシナリオの詳細のビューモデルのテスト（SpecViewer 仕様 3.2・3.3、基本設計 3.1・3.2・6.5）。
// viewer_inputs.test と同じく、コマンドラインの入口で一時ディレクトリに実際の出力を書き、読み戻してから組み立てる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { main } from "../src/cli.js";
import { issueDisplayIds, issueGroupsOf, verificationView } from "../src/core/m5/view_model.js";
import { readRunOutputs } from "../src/lib/read_outputs.js";
import type { RunReport } from "../src/types/run.js";
import { checkRunOutputs } from "../src/viewer/check.js";
import { buildScenarioDetails, buildScenarioList } from "../src/viewer/scenarios.js";
import type { RunOutputs } from "../src/viewer/types.js";

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

const fs = new NodeFsAdapter();

/** 一時ディレクトリでリポジトリにかけ、出力先と実行の報告を渡す。終わったら消す。 */
async function withOutputs(body: (out: string, report: RunReport) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-viewer-scenarios-"));
  try {
    await mkdir(join(root, "repo", "src"), { recursive: true });
    for (const [path, text] of Object.entries(REPO)) await writeFile(join(root, "repo", path), text, "utf8");
    const out = join(root, "out");
    const io = { stdout: (): void => {}, stderr: (): void => {} };
    assert.equal(await main([join(root, "repo"), "--out", out], io), 0);
    const report = JSON.parse(await readFile(join(out, "run_report.json"), "utf8")) as RunReport;
    await body(out, report);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 読み戻して事前条件を確かめた入力。 */
async function checkedOutputs(out: string): Promise<RunOutputs> {
  const outputs = await readRunOutputs(fs, out);
  assert.deepEqual(checkRunOutputs(outputs), { ok: true, problems: [] });
  return outputs;
}

function rowOfKind<K extends RunReport["scenarios"][number]["kind"]>(
  report: RunReport,
  kind: K,
): Extract<RunReport["scenarios"][number], { kind: K }> {
  const found = report.scenarios.find((s) => s.kind === kind);
  assert.ok(found, `${kind} のシナリオが無い`);
  return found as Extract<RunReport["scenarios"][number], { kind: K }>;
}

test("シナリオ一覧: すべてのシナリオが実行の報告の順に出て、件数の文が役割で変わる", async () => {
  await withOutputs(async (out, report) => {
    const outputs = await checkedOutputs(out);
    const completed = rowOfKind(report, "COMPLETED");
    const ambiguous = rowOfKind(report, "AMBIGUOUS");
    const ambiguousTotal = Object.values(ambiguous.counts).reduce((sum, n) => sum + n, 0);

    const pdm = buildScenarioList(outputs, "BUSINESS");
    assert.deepEqual(
      pdm.rows.map((r) => [r.displayId, r.kind]),
      report.scenarios.map((s) => [s.displayId, s.kind]),
    );
    const pdmCompleted = pdm.rows.find((r) => r.displayId === completed.displayId)!;
    assert.equal(pdmCompleted.kindText, "仕様になった");
    assert.equal(pdmCompleted.countText, `論点 ${completed.issueCount} 件`);
    assert.ok(pdmCompleted.verificationText !== null);
    const pdmAmbiguous = pdm.rows.find((r) => r.displayId === ambiguous.displayId)!;
    assert.equal(pdmAmbiguous.kindText, "曖昧さで止まった");
    assert.equal(pdmAmbiguous.countText, `エンジニアの確認待ち: ${ambiguousTotal} 件`);
    assert.equal(pdmAmbiguous.verificationText, null);
    assert.equal(pdm.summary.ambiguity.byKind, null);
    assert.equal(pdm.showContextColumn, report.system.boundedContextCount > 1);
    assert.ok(pdm.summary.inspectionScope[0]?.includes("シナリオどうしの矛盾は見ていない"));

    const eng = buildScenarioList(outputs, "IMPLEMENTATION");
    assert.equal(eng.rows.find((r) => r.displayId === ambiguous.displayId)!.countText, `曖昧さ ${ambiguousTotal} 件`);
    assert.deepEqual(
      eng.summary.ambiguity.byKind?.map((k) => [k.kind, k.count]),
      (["UNDETERMINED_VALUE", "EXTERNAL_EFFECT", "CONFLICTING_SLICES"] as const).map((kind) => [kind, report.totals.ambiguity[kind]]),
    );
  });
});

test("BUSINESS の一覧と詳細の冒頭には、内部の識別子と所在が出ない", async () => {
  await withOutputs(async (out, report) => {
    const outputs = await checkedOutputs(out);
    const list = buildScenarioList(outputs, "BUSINESS");
    // 論点と検証の状態は SpecProjector の文そのもの（次のテストで同じことを確かめる）なので、ここでは冒頭だけを見る
    const headers = buildScenarioDetails(outputs, "BUSINESS").map((detail) => ({ ...detail, verification: null, issueGroups: null, tabs: null }));
    const text = JSON.stringify({ list, headers });
    for (const scenario of report.scenarios) {
      assert.ok(!text.includes(scenario.scenarioId), `内部の識別子が出ている: ${scenario.scenarioId}`);
    }
    assert.ok(!text.includes("src/a.ts") && !text.includes("src/g.ts"));
    assert.ok(list.rows.every((r) => r.inletLocations === null));
    assert.ok(headers.every((h) => h.inletLocations === null));
  });
});

test("IMPLEMENTATION では起点の所在を一覧と詳細に持つ", async () => {
  await withOutputs(async (out) => {
    const outputs = await checkedOutputs(out);
    const list = buildScenarioList(outputs, "IMPLEMENTATION");
    assert.ok(list.rows.every((r) => Array.isArray(r.inletLocations)));
    assert.ok(list.rows.some((r) => (r.inletLocations ?? []).some((l) => l.file.endsWith("src/a.ts"))));
    assert.ok(buildScenarioDetails(outputs, "IMPLEMENTATION").every((d) => Array.isArray(d.inletLocations)));
  });
});

test("詳細: 仕様になったシナリオは SpecProjector と同じ検証の状態と論点を持ち、ほかは文を出す", async () => {
  await withOutputs(async (out, report) => {
    const outputs = await checkedOutputs(out);
    const completed = rowOfKind(report, "COMPLETED");
    const ambiguous = rowOfKind(report, "AMBIGUOUS");
    const details = buildScenarioDetails(outputs, "BUSINESS");
    assert.deepEqual(
      details.map((d) => d.displayId),
      report.scenarios.map((s) => s.displayId),
    );

    const files = outputs.scenarios.find((s) => s.displayId === completed.displayId);
    assert.ok(files?.kind === "COMPLETED" && files.spec.kind === "OK" && files.ledger.kind === "OK");
    const spec = files.spec.value;
    const ledger = files.ledger.value;
    const detail = details.find((d) => d.displayId === completed.displayId)!;
    assert.deepEqual(detail.verification, verificationView(spec, ledger));
    assert.deepEqual(detail.issueGroups, issueGroupsOf(spec, ledger, issueDisplayIds(ledger, completed.displayId)));
    assert.equal(detail.issueCount, ledger.issues.length);
    // 検査の範囲の文（設計 3.2）は verificationView の lines に入っている。画面で別に持たない
    assert.ok(detail.verification?.lines.includes("検査はこのシナリオだけで行った。ほかのシナリオとの矛盾は見ていない。"));
    assert.equal(detail.notice, null);
    // タブ: 仕様書は題の見出しから始まり、一覧表は操作ごとに 1 行。ソースは IMPLEMENTATION だけ
    const firstBlock = detail.tabs?.document[0];
    assert.ok(firstBlock?.kind === "heading" && firstBlock.level === 1 && firstBlock.text.startsWith("仕様書: "));
    const table = detail.tabs?.matrix.find((b) => b.kind === "table");
    assert.ok(table?.kind === "table");
    assert.equal(table.header[0], "表示名");
    assert.equal(table.rows.length, spec.operations.length);
    assert.equal(detail.tabs?.source, null);
    // 流れ図: 起点が 1 つと、操作ごとに操作・条件と書き込み・結果のノード（render_flow.ts）
    const flow = detail.tabs?.flow;
    assert.ok(flow?.kind === "OK");
    assert.equal(flow.nodes.length, 1 + spec.operations.reduce((sum, operation) => sum + operation.steps.length + 2, 0));
    assert.equal(flow.nodes[0]?.kind, "START");
    assert.equal(flow.layout.layers[0]?.length, 1);
    const engDetail = buildScenarioDetails(outputs, "IMPLEMENTATION").find((d) => d.displayId === completed.displayId)!;
    const engSource = engDetail.tabs?.source;
    assert.ok(typeof engSource === "string" && engSource.length > 0);
    assert.ok(!/^\s*--\s*@source:/m.test(engSource));
    assert.equal(detail.inletTypeText, completed.inletType === "COMMAND" ? "操作" : "反応");
    assert.equal(detail.actor, completed.actor.name);
    assert.equal(detail.route, completed.route);

    const total = Object.values(ambiguous.counts).reduce((sum, n) => sum + n, 0);
    const stopped = details.find((d) => d.displayId === ambiguous.displayId)!;
    assert.equal(stopped.verification, null);
    assert.equal(stopped.issueGroups, null);
    assert.equal(stopped.tabs, null);
    assert.equal(stopped.notice, `このシナリオは、エンジニアの確認待ちの箇所が ${total} 件あるため、形式仕様にできなかった。`);
  });
});

test("辞書や対応表が無いときは、名前を「未生成」ではなく引けない理由で出す", async () => {
  await withOutputs(async (out, report) => {
    await rm(join(out, "glossary.json"));
    const noGlossary = buildScenarioList(await checkedOutputs(out), "BUSINESS");
    for (const row of noGlossary.rows) {
      assert.equal(row.title, `${row.displayId}（名前を引けない: 辞書が無い）`);
      assert.equal(row.boundedContext, "（名前を引けない: 辞書が無い）");
    }

    await rm(join(out, "implementation_map.json"));
    const noMap = buildScenarioList(await checkedOutputs(out), "IMPLEMENTATION");
    assert.deepEqual(
      noMap.rows.map((r) => r.title),
      report.scenarios.map((s) => `${s.displayId}（名前を引けない: 実装との対応表が無い）`),
    );
    // 対応表が無ければ所在は空（IMPLEMENTATION でも推測で埋めない）
    assert.ok(noMap.rows.every((r) => Array.isArray(r.inletLocations) && r.inletLocations.length === 0));
  });
});

test("事前条件を通っていない入力では例外を投げる", async () => {
  await withOutputs(async (out) => {
    await rm(join(out, "run_report.json"));
    const outputs = await readRunOutputs(fs, out);
    assert.throws(() => buildScenarioList(outputs, "BUSINESS"), /checkRunOutputs/);
    assert.throws(() => buildScenarioDetails(outputs, "BUSINESS"), /checkRunOutputs/);
  });
});