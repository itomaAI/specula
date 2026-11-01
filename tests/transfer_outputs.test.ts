// 出力一式の書き出しと読み込み（src/lib/transfer_outputs.ts）のテスト。
// 小さなリポジトリを解析して出力を書き（jar 無し・LLM 無し）、それを書き出して読み込む。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { readRepository } from "../src/adapters/NodeRepositoryReader.js";
import { RecordingLanguageModel } from "../src/adapters/RecordingLanguageModel.js";
import { runPipeline } from "../src/core/orchestrator.js";
import { readRunOutputs } from "../src/lib/read_outputs.js";
import { withRoot } from "../src/lib/rooted_file_system.js";
import { MANIFEST_NAME, exportRun, importRun, parseManifest, stableJson } from "../src/lib/transfer_outputs.js";
import { writeOutputs } from "../src/lib/write_outputs.js";
import { VIEW_ROLES } from "../src/types/projection.js";
import { checkRunOutputs } from "../src/viewer/check.js";

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

const RECORD_NAME = `${"a".repeat(64)}.json`;

interface Fixture {
  dir: string;
  out: string;
  exported: string;
  imported: string;
}

async function withRun(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "specula-transfer-"));
  const repoDir = join(dir, "repo");
  const out = join(dir, "out");
  await mkdir(join(repoDir, "src"), { recursive: true });
  await writeFile(join(repoDir, "src", "open.ts"), OPEN_SOURCE);
  const fs = new NodeFsAdapter();
  const repo = await readRepository(repoDir);
  const result = await runPipeline(repo, {
    fs: withRoot(fs, repoDir),
    llm: new RecordingLanguageModel(null, fs, join(out, "llm_records")),
    solver: null,
  });
  await writeOutputs(fs, out, result);
  // 記録は中身を読まないので、キーの順が崩れた JSON を置いて整形を確かめる。
  await mkdir(join(out, "llm_records"), { recursive: true });
  await writeFile(join(out, "llm_records", RECORD_NAME), '{"b":1,"a":{"d":2,"c":3}}');
  await writeFile(join(out, "llm_records", "note.txt"), "記録ではない");
  try {
    await fn({ dir, out, exported: join(dir, "exported"), imported: join(dir, "imported") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("stableJson はキーを辞書順に並べ、配列の順は変えない", () => {
  assert.equal(stableJson({ b: [3, 1], a: { d: 1, c: 2 } }), '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": [\n    3,\n    1\n  ]\n}\n');
});

test("parseManifest は外を指すパスと別の形式を断る", () => {
  const base = { format: "specula-export", version: 1, basis: { mapHash: "m", documentsHash: "d" } };
  assert.equal(typeof parseManifest(JSON.stringify({ ...base, files: [{ path: "a/b.json", sha256: "x" }] })), "object");
  assert.equal(typeof parseManifest(JSON.stringify({ ...base, files: [{ path: "../b.json", sha256: "x" }] })), "string");
  assert.equal(typeof parseManifest(JSON.stringify({ ...base, files: [{ path: "/b.json", sha256: "x" }] })), "string");
  assert.equal(typeof parseManifest(JSON.stringify({ ...base, format: "other", files: [] })), "string");
  assert.equal(typeof parseManifest(JSON.stringify({ ...base, version: 2, files: [] })), "string");
});

test("書き出して読み込むと、同じ実行の出力としてそろう", async () => {
  await withRun(async (f) => {
    const fs = new NodeFsAdapter();
    const exported = await exportRun(fs, f.out, f.exported);
    assert.ok(exported.ok, JSON.stringify(exported));
    if (!exported.ok) return;
    assert.ok(exported.files.includes("run_report.json"));
    assert.ok(exported.files.includes(`llm_records/${RECORD_NAME}`));
    assert.ok(!exported.files.some((path) => path.endsWith("note.txt")));
    assert.ok(exported.files.some((path) => path.startsWith("views/business/")));
    assert.ok(exported.files.some((path) => path.startsWith("views/implementation/")));
    // JSON はキーの順を固定して書く。
    assert.equal(await readFile(join(f.exported, "llm_records", RECORD_NAME), "utf8"), stableJson({ a: { c: 3, d: 2 }, b: 1 }));

    // 2 回書き出しても目録は変わらない（差分が出ない）。
    const manifest = await readFile(join(f.exported, MANIFEST_NAME), "utf8");
    const again = await exportRun(fs, f.out, f.exported);
    assert.ok(again.ok);
    assert.equal(await readFile(join(f.exported, MANIFEST_NAME), "utf8"), manifest);
    if (again.ok) assert.deepEqual(again.stale, []);

    const imported = await importRun(fs, f.exported, f.imported);
    assert.ok(imported.ok, JSON.stringify(imported));
    for (const viewRole of VIEW_ROLES) {
      const check = checkRunOutputs(await readRunOutputs(fs, f.imported, viewRole));
      assert.ok(check.ok, JSON.stringify(check.problems));
    }
    assert.ok(await fs.exists(join(f.imported, "llm_records", RECORD_NAME)));
  });
});

test("書き出した後に変わったファイルがあれば、何も読み込まない", async () => {
  await withRun(async (f) => {
    const fs = new NodeFsAdapter();
    assert.ok((await exportRun(fs, f.out, f.exported)).ok);
    const reportPath = join(f.exported, "run_report.json");
    await writeFile(reportPath, (await readFile(reportPath, "utf8")) + " ");
    const imported = await importRun(fs, f.exported, f.imported);
    assert.equal(imported.ok, false);
    if (!imported.ok) assert.ok(imported.problems.some((line) => line.includes("SHA-256")), JSON.stringify(imported.problems));
    assert.equal(await fs.exists(f.imported), false);
  });
});

test("出力先に前の出力があるときは、replace を渡したときだけ読み込む", async () => {
  await withRun(async (f) => {
    const fs = new NodeFsAdapter();
    assert.ok((await exportRun(fs, f.out, f.exported)).ok);
    const refused = await importRun(fs, f.exported, f.out);
    assert.equal(refused.ok, false);
    const replaced = await importRun(fs, f.exported, f.out, { replace: true });
    assert.ok(replaced.ok, JSON.stringify(replaced));
  });
});

test("目録の無い空でないディレクトリには書き出さない", async () => {
  await withRun(async (f) => {
    const fs = new NodeFsAdapter();
    await mkdir(f.exported, { recursive: true });
    await writeFile(join(f.exported, "README.md"), "別のもの");
    const exported = await exportRun(fs, f.out, f.exported);
    assert.equal(exported.ok, false);
    assert.equal(await fs.exists(join(f.exported, MANIFEST_NAME)), false);
  });
});

test("同じ実行の出力としてそろっていない出力先は書き出さない", async () => {
  await withRun(async (f) => {
    const fs = new NodeFsAdapter();
    await rm(join(f.out, "run_report.json"));
    const exported = await exportRun(fs, f.out, f.exported);
    assert.equal(exported.ok, false);
    assert.equal(await fs.exists(f.exported), false);
  });
});