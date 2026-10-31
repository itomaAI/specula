// 画面すべてのビューモデルを束ねる buildRunView のテスト（SpecViewer 基本設計 1.2・6.11）。
// ほかの viewer のテストと同じく、コマンドラインの入口で一時ディレクトリに実際の出力を書き、読み戻してから組み立てる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { main } from "../src/cli.js";
import { readRunOutputs } from "../src/lib/read_outputs.js";
import { checkRunOutputs } from "../src/viewer/check.js";
import { buildGlossaryView } from "../src/viewer/glossary.js";
import { buildIssueList } from "../src/viewer/issues.js";
import { buildMapView } from "../src/viewer/map.js";
import { buildRunView } from "../src/viewer/run_view.js";
import { buildCommandDetails, buildCommandList } from "../src/viewer/commands.js";

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

const REPO: Record<string, string> = {
  "src/index.ts": 'export { openIt } from "./a.js";\n',
  "src/a.ts": OPEN_SOURCE,
};

const fs = new NodeFsAdapter();

async function withOutputs(body: (out: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-viewer-run-view-"));
  try {
    await mkdir(join(root, "repo", "src"), { recursive: true });
    for (const [path, text] of Object.entries(REPO)) await writeFile(join(root, "repo", path), text, "utf8");
    const out = join(root, "out");
    const io = { stdout: (): void => {}, stderr: (): void => {} };
    assert.equal(await main([join(root, "repo"), "--out", out], io), 0);
    await body(out);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("4 つの画面とコマンドの詳細を、画面ごとの関数と同じ値で束ねる（役割ごと）", async () => {
  await withOutputs(async (out) => {
    const outputs = await readRunOutputs(fs, out);
    assert.deepEqual(checkRunOutputs(outputs), { ok: true, problems: [] });
    for (const viewRole of ["BUSINESS", "IMPLEMENTATION"] as const) {
      const view = buildRunView(outputs, viewRole);
      assert.equal(view.viewRole, viewRole);
      assert.deepEqual(view.commandList, buildCommandList(outputs, viewRole));
      assert.deepEqual(view.commandDetails, buildCommandDetails(outputs, viewRole));
      assert.deepEqual(view.issues, buildIssueList(outputs, viewRole));
      assert.deepEqual(view.glossary, buildGlossaryView(outputs, viewRole));
      assert.deepEqual(view.map, buildMapView(outputs, viewRole));
    }
  });
});

test("コマンドの詳細は、コマンド一覧の行と同じ順・同じ数", async () => {
  await withOutputs(async (out) => {
    const outputs = await readRunOutputs(fs, out);
    const view = buildRunView(outputs, "BUSINESS");
    assert.ok(view.commandList.rows.length > 0);
    assert.deepEqual(
      view.commandDetails.map((d) => d.displayId),
      view.commandList.rows.map((r) => r.displayId),
    );
  });
});

test("事前条件を満たさない入力（実行の報告が無い）では、画面を作らずに例外を投げる", async () => {
  await withOutputs(async (out) => {
    await rm(join(out, "run_report.json"));
    const outputs = await readRunOutputs(fs, out);
    assert.equal(checkRunOutputs(outputs).ok, false);
    assert.throws(() => buildRunView(outputs, "BUSINESS"), /画面を作れない（事前条件の破れ）: REPORT_MISSING run_report\.json/);
  });
});