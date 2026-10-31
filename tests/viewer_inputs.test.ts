// 画面の入力（readRunOutputs）と事前条件（checkRunOutputs）のテスト（SpecViewer 仕様 3.1、基本設計 6.1・6.2）。
// コマンドラインの入口で一時ディレクトリに実際の出力を書き、それを読み戻す（writeOutputs と対になっていることを確かめるため）。
// 事前条件の破れは、書いた出力のファイルを消したり書き換えたりして作る。
// 役割で中身が変わるファイルは views/<役割>/ の下にある（全体設計 4.1）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { main, safeName } from "../src/cli.js";
import { readRunOutputs } from "../src/lib/read_outputs.js";
import { VIEW_ROLES } from "../src/types/projection.js";
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

interface CommandTarget {
  commandId: string;
  displayId: string;
  kind: string;
}

/** 一時ディレクトリでリポジトリにかけ、出力先と報告のコマンドを渡す。終わったら消す。 */
async function withOutputs(body: (out: string, commands: CommandTarget[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-viewer-"));
  try {
    await mkdir(join(root, "repo", "src"), { recursive: true });
    for (const [path, text] of Object.entries(REPO)) await writeFile(join(root, "repo", path), text, "utf8");
    const out = join(root, "out");
    const io = { stdout: (): void => {}, stderr: (): void => {} };
    assert.equal(await main([join(root, "repo"), "--out", out], io), 0);
    const report = JSON.parse(await readFile(join(out, "run_report.json"), "utf8"));
    await body(out, report.commands as CommandTarget[]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const fs = new NodeFsAdapter();

function commandOfKind(commands: CommandTarget[], kind: string): CommandTarget {
  const found = commands.find((s) => s.kind === kind);
  assert.ok(found, `${kind} のコマンドが無い: ${JSON.stringify(commands)}`);
  return found;
}

test("書いた出力を両方の役割で読み戻せて、事前条件を満たす", async () => {
  await withOutputs(async (out, commands) => {
    commandOfKind(commands, "COMPLETED");
    commandOfKind(commands, "AMBIGUOUS");

    for (const viewRole of VIEW_ROLES) {
      const outputs = await readRunOutputs(fs, out, viewRole);
      assert.equal(outputs.viewRole, viewRole);
      for (const read of [outputs.report, outputs.systemMap, outputs.glossary, outputs.intents, outputs.implementationMap]) {
        assert.equal(read.kind, "OK", viewRole);
      }
      assert.equal(outputs.systemMap.kind === "OK" ? outputs.systemMap.value.viewRole : null, viewRole);
      // コマンドは報告の順・同じ id で、kind から決まるファイルがそろう
      assert.deepEqual(
        outputs.commands.map((s) => [s.commandId, s.displayId, s.kind]),
        commands.map((s) => [s.commandId, s.displayId, s.kind]),
      );
      for (const commandTarget of outputs.commands) {
        if (commandTarget.kind === "COMPLETED") {
          for (const read of [commandTarget.spec, commandTarget.document, commandTarget.matrix, commandTarget.flow, commandTarget.source, commandTarget.ledger]) {
            assert.equal(read.kind, "OK", viewRole);
          }
        } else if (commandTarget.kind === "AMBIGUOUS") {
          assert.equal(commandTarget.ambiguity.kind, "OK");
        }
      }

      assert.deepEqual(checkRunOutputs(outputs), { ok: true, problems: [] });
    }
  });
});

test("役割で中身が変わるファイルは役割ごとに違い、内部の記録は同じものを読む", async () => {
  await withOutputs(async (out, commands) => {
    const completed = commandOfKind(commands, "COMPLETED");
    const business = await readRunOutputs(fs, out, "BUSINESS");
    const implementation = await readRunOutputs(fs, out, "IMPLEMENTATION");
    const documentOf = (outputs: typeof business): string | null => {
      const found = outputs.commands.find((s) => s.commandId === completed.commandId);
      return found?.kind === "COMPLETED" && found.document.kind === "OK" ? found.document.value : null;
    };
    // IMPLEMENTATION の仕様書だけが形式仕様のソースの付録を持つ（SpecViewer 仕様 1.3）
    assert.ok(!(documentOf(business) ?? "").includes("## 付録"));
    assert.ok((documentOf(implementation) ?? "").includes("## 付録: 形式仕様のソース"));
    assert.deepEqual(implementation.glossary, business.glossary);
    assert.deepEqual(implementation.report, business.report);
  });
});

test("出力先の末尾に / があっても同じように読む", async () => {
  await withOutputs(async (out) => {
    assert.deepEqual(await readRunOutputs(fs, `${out}/`, "BUSINESS"), await readRunOutputs(fs, out, "BUSINESS"));
  });
});

test("実行の報告が無ければ、コマンドを読まずに REPORT_MISSING を返す", async () => {
  await withOutputs(async (out) => {
    await rm(join(out, "run_report.json"));
    const outputs = await readRunOutputs(fs, out, "BUSINESS");
    assert.equal(outputs.report.kind, "MISSING");
    assert.deepEqual(outputs.commands, []);
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
    for (const name of ["glossary.json", "intents.json", "implementation_map.json", join("views", "business", "system_map.json")]) {
      await rm(join(out, name));
    }
    const outputs = await readRunOutputs(fs, out, "BUSINESS");
    assert.equal(outputs.glossary.kind, "MISSING");
    assert.equal(outputs.systemMap.kind, "MISSING");
    assert.deepEqual(checkRunOutputs(outputs), { ok: true, problems: [] });
  });
});

test("basis が実行の報告と違うファイルは BASIS_MISMATCH", async () => {
  await withOutputs(async (out) => {
    const path = join(out, "intents.json");
    const intents = JSON.parse(await readFile(path, "utf8"));
    intents.basis.documentsHash = "0".repeat(64);
    await writeFile(path, JSON.stringify(intents), "utf8");

    const check = checkRunOutputs(await readRunOutputs(fs, out, "BUSINESS"));
    assert.equal(check.ok, false);
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file, p.commandTarget]),
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

    const check = checkRunOutputs(await readRunOutputs(fs, out, "BUSINESS"));
    assert.equal(check.ok, false);
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file]),
      [["NO_BASIS", "run_report.json"]],
    );
  });
});

test("俯瞰図の役割が置き場所の役割と違えば VIEW_ROLE_MISMATCH", async () => {
  await withOutputs(async (out) => {
    const path = join(out, "views", "implementation", "system_map.json");
    const systemMap = JSON.parse(await readFile(path, "utf8"));
    systemMap.viewRole = "BUSINESS";
    await writeFile(path, JSON.stringify(systemMap), "utf8");

    const check = checkRunOutputs(await readRunOutputs(fs, out, "IMPLEMENTATION"));
    assert.equal(check.ok, false);
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file, p.commandTarget]),
      [["VIEW_ROLE_MISMATCH", "views/implementation/system_map.json", null]],
    );
    // もう一方の役割は影響を受けない
    assert.deepEqual(checkRunOutputs(await readRunOutputs(fs, out, "BUSINESS")), { ok: true, problems: [] });
  });
});

test("役割ごとに書き出す前の古い出力（views/ が無い）は、役割で変わるファイルが無いとして返す", async () => {
  await withOutputs(async (out, commands) => {
    await rm(join(out, "views"), { recursive: true });
    commandOfKind(commands, "COMPLETED");

    const check = checkRunOutputs(await readRunOutputs(fs, out, "BUSINESS"));
    assert.equal(check.ok, false);
    // 俯瞰図は任意のファイルなので理由にしない。コマンドの仕様書・一覧表・流れ図は必ずあるはずなので理由にする。
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file, p.commandTarget]),
      commands
        .filter((s) => s.kind === "COMPLETED")
        .flatMap((s) => ["spec.md", "matrix.md", "flow.mmd"].map((name) => ["COMMAND_FILE_MISSING", `views/business/ の ${name}`, s.displayId])),
    );
    assert.ok(check.problems.every((p) => p.detail.includes("実行し直して")));
  });
});

test("壊れた JSON と、無いコマンドのファイルは、コマンドの表示の id を付けて返す（内部の識別子は出さない）", async () => {
  await withOutputs(async (out, commands) => {
    const completed = commandOfKind(commands, "COMPLETED");
    const ambiguous = commandOfKind(commands, "AMBIGUOUS");
    await writeFile(join(out, "commands", safeName(completed.commandId), "ledger.json"), "{ not json", "utf8");
    await rm(join(out, "commands", safeName(ambiguous.commandId), "ambiguity.json"));
    await rm(join(out, "views", "business", "commands", safeName(completed.commandId), "flow.mmd"));
    await rm(join(out, "commands", safeName(completed.commandId), "spec.json"));

    const outputs = await readRunOutputs(fs, out, "BUSINESS");
    const completedRead = outputs.commands.find((s) => s.commandId === completed.commandId);
    assert.equal(completedRead?.kind === "COMPLETED" ? completedRead.ledger.kind : null, "INVALID");

    const check = checkRunOutputs(outputs);
    assert.equal(check.ok, false);
    // 並びは報告のコマンドの順、コマンドの中はファイルの決まった順
    const expected = commands.flatMap((s) =>
      s.commandId === completed.commandId
        ? [
            ["COMMAND_FILE_MISSING", "spec.json", s.displayId],
            ["COMMAND_FILE_MISSING", "views/business/ の flow.mmd", s.displayId],
            ["INVALID_JSON", "ledger.json", s.displayId],
          ]
        : s.commandId === ambiguous.commandId
          ? [["COMMAND_FILE_MISSING", "ambiguity.json", s.displayId]]
          : [],
    );
    assert.deepEqual(
      check.problems.map((p) => [p.reason, p.file, p.commandTarget]),
      expected,
    );
    for (const problem of check.problems) {
      assert.ok(!problem.detail.includes(completed.commandId) && !problem.detail.includes(ambiguous.commandId));
    }
  });
});