// 仕様不備一覧のビューモデルのテスト（SpecViewer 仕様 3.2・3.3、基本設計 3.3・6.7）。
// viewer_commands.test と同じく、コマンドラインの入口で一時ディレクトリに実際の出力を書き、読み戻してから組み立てる。
// この入力では検査のエンジンが無く論点が出ないので、論点の経路は読み戻した論点カタログに論点を 1 件足して確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { main } from "../src/cli.js";
import { statusMark } from "../src/core/m5/labels.js";
import { issueDisplayIds, issueGroupsOf, llmText } from "../src/core/m5/view_model.js";
import { readRunOutputs } from "../src/lib/read_outputs.js";
import type { AmbiguityReport } from "../src/types/formal.js";
import type { LedgerIssue } from "../src/types/ledger.js";
import type { RunReport } from "../src/types/run.js";
import { checkRunOutputs } from "../src/viewer/check.js";
import { buildIssueList } from "../src/viewer/issues.js";
import type { RunOutputs, CommandOutputs } from "../src/viewer/types.js";

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

async function withOutputs(body: (out: string, report: RunReport) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-viewer-issues-"));
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

async function checkedOutputs(out: string): Promise<RunOutputs> {
  const outputs = await readRunOutputs(fs, out);
  assert.deepEqual(checkRunOutputs(outputs), { ok: true, problems: [] });
  return outputs;
}

function rowOfKind<K extends RunReport["commands"][number]["kind"]>(
  report: RunReport,
  kind: K,
): Extract<RunReport["commands"][number], { kind: K }> {
  const found = report.commands.find((s) => s.kind === kind);
  assert.ok(found, `${kind} のコマンドが無い`);
  return found as Extract<RunReport["commands"][number], { kind: K }>;
}

/** 仕様になったコマンドの論点カタログの末尾に、最後の操作に関わる「到達しない操作」の論点を 1 件足す。 */
function withAddedIssue(outputs: RunOutputs, displayId: string): RunOutputs {
  return {
    ...outputs,
    commands: outputs.commands.map((s): CommandOutputs => {
      if (s.displayId !== displayId || s.kind !== "COMPLETED" || s.spec.kind !== "OK" || s.ledger.kind !== "OK") return s;
      const operations = s.spec.value.operations;
      const last = operations[operations.length - 1];
      assert.ok(last, "操作が無い");
      const issue: LedgerIssue = {
        id: "LEDGER-test-999",
        kind: "UNREACHABLE_OPERATION",
        rootFinding: 0,
        dependentFindings: [1],
        operations: [last.id],
        trace: null,
        claim: { status: "GENERATED", text: "この操作は実行できるはずである", recordKey: "k1" },
        observation: { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "" },
        question: { status: "GENERATED", text: "この操作は要るか", recordKey: "k2" },
        claimStatus: "CANDIDATE",
        observationStatus: "NOT_GENERATED",
        questionStatus: "CANDIDATE",
        options: [{ id: "REMOVE_OPERATION", meaning: "操作を消す" }],
        decision: null,
      };
      return { ...s, ledger: { kind: "OK", value: { ...s.ledger.value, issues: [...s.ledger.value.issues, issue] } } };
    }),
  };
}

test("論点: SpecProjector と同じ組で、論点がある仕様になったコマンドだけが出て、一覧表の行の位置を持つ", async () => {
  await withOutputs(async (out, report) => {
    const completed = rowOfKind(report, "COMPLETED");
    const outputs = withAddedIssue(await checkedOutputs(out), completed.displayId);
    const list = buildIssueList(outputs, "BUSINESS");

    const files = outputs.commands.find((s) => s.displayId === completed.displayId);
    assert.ok(files?.kind === "COMPLETED" && files.spec.kind === "OK" && files.ledger.kind === "OK");
    const spec = files.spec.value;
    const ledger = files.ledger.value;
    const displayIds = issueDisplayIds(ledger, completed.displayId);

    const view = list.commands.find((s) => s.displayId === completed.displayId);
    assert.ok(view, "論点のあるコマンドが出ていない");
    assert.equal(view.issueCount, ledger.issues.length);
    assert.deepEqual(view.groups, issueGroupsOf(spec, ledger, displayIds));
    // 論点はすべて未決（仕様 3.2）
    assert.ok(view.groups.every((g) => g.issues.every((i) => i.status === "未決")));
    // 足した論点は最後の操作に関わるので、一覧表の最後の行を指す
    const added = displayIds.get("LEDGER-test-999")!;
    assert.deepEqual(view.operationRows[added], [spec.operations.length - 1]);
    assert.equal(list.issueTotal, list.commands.reduce((sum, s) => sum + s.issueCount, 0));
    // 論点の無いコマンド・曖昧さで止まったコマンドは論点の側に出ない
    for (const s of list.commands) {
      assert.ok(s.issueCount > 0);
      assert.equal(report.commands.find((r) => r.displayId === s.displayId)?.kind, "COMPLETED");
    }
    // 内部の識別子は出ない
    const text = JSON.stringify(list);
    assert.ok(!text.includes("LEDGER-"));
    for (const commandTarget of report.commands) assert.ok(!text.includes(commandTarget.commandId), commandTarget.commandId);
  });
});

test("曖昧さ: BUSINESS はコマンドごとの件数だけで、質問・箇所・原文を出さない", async () => {
  await withOutputs(async (out, report) => {
    const ambiguous = rowOfKind(report, "AMBIGUOUS");
    const total = Object.values(ambiguous.counts).reduce((sum, n) => sum + n, 0);
    const list = buildIssueList(await checkedOutputs(out), "BUSINESS");

    assert.deepEqual(
      list.ambiguities.map((a) => a.displayId),
      report.commands.filter((s) => s.kind === "AMBIGUOUS").map((s) => s.displayId),
    );
    const view = list.ambiguities.find((a) => a.displayId === ambiguous.displayId)!;
    assert.equal(view.total, total);
    assert.equal(view.countText, `エンジニアの確認待ち: ${total} 件`);
    assert.equal(view.items, null);
    assert.equal(list.ambiguityTotal, list.ambiguities.reduce((sum, a) => sum + a.total, 0));
    const text = JSON.stringify(list.ambiguities);
    assert.ok(!text.includes("src/g.ts"));
    for (const commandTarget of report.commands) assert.ok(!text.includes(commandTarget.commandId), commandTarget.commandId);
  });
});

test("曖昧さ: IMPLEMENTATION は SpecProjector の曖昧さの一覧と同じ番号・種類・質問・所在・原文を持つ", async () => {
  await withOutputs(async (out, report) => {
    const ambiguous = rowOfKind(report, "AMBIGUOUS");
    const outputs = await checkedOutputs(out);
    const files = outputs.commands.find((s) => s.displayId === ambiguous.displayId);
    assert.ok(files?.kind === "AMBIGUOUS" && files.ambiguity.kind === "OK");
    const source: AmbiguityReport = files.ambiguity.value;
    assert.ok(source.issues.length > 0);

    const view = buildIssueList(outputs, "IMPLEMENTATION").ambiguities.find((a) => a.displayId === ambiguous.displayId)!;
    assert.ok(view.countText.startsWith("曖昧さ "));
    assert.equal(view.items?.length, source.issues.length);
    view.items!.forEach((item, index) => {
      const issue = source.issues[index]!;
      assert.equal(item.id, `${ambiguous.displayId}-A-${String(index + 1).padStart(3, "0")}`);
      assert.equal(item.kind, issue.kind);
      assert.ok(["値が決まらない", "外部への作用がある", "同じ条件で別の経路に進む"].includes(item.kindText));
      assert.equal(item.question, `${llmText(issue.question)}${statusMark(issue.questionStatus)}`);
      assert.deepEqual(item.location, { file: issue.location.file, line: issue.location.line });
      assert.ok(item.location.file.endsWith("src/g.ts"));
      assert.ok(!item.detail.endsWith("\n"));
    });
  });
});

test("仕様不備一覧: 事前条件を通っていない入力では例外を投げる", async () => {
  await withOutputs(async (out) => {
    await rm(join(out, "run_report.json"));
    const outputs = await readRunOutputs(fs, out);
    assert.throws(() => buildIssueList(outputs, "BUSINESS"), /checkRunOutputs/);
  });
});