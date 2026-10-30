// コマンドラインの入口（全体設計 4.1）のテスト。main を直接呼び、一時ディレクトリに置いた小さなリポジトリにかける。
// エンジンは渡さない（--alloy-jar 無し → M3 は UNVERIFIED）。LLM のクライアントも無いので、LLM の項目は NOT_GENERATED。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, safeName, type CliIo } from "../src/cli.js";

// 真偽値の旗を 1 つ持つ関数（オーケストレーターのテストと同じ）。
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

interface Captured {
  io: CliIo;
  stdout: string[];
  stderr: string[];
}

function capture(): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
}

/** 一時ディレクトリに repo/（小さなリポジトリ）を作り、そのルートを返す。終わったら消す。 */
async function withTempRepo(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-cli-"));
  try {
    await mkdir(join(root, "repo", "src"), { recursive: true });
    await writeFile(join(root, "repo", "src", "index.ts"), 'export { openIt } from "./a.js";\n', "utf8");
    await writeFile(join(root, "repo", "src", "a.ts"), OPEN_SOURCE, "utf8");
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

test("リポジトリにかけると終了コード 0 で、報告・全体マップ・シナリオの成果物を書く", async () => {
  await withTempRepo(async (root) => {
    const out = join(root, "out");
    const captured = capture();
    const code = await main([join(root, "repo"), "--out", out], captured.io);
    assert.equal(code, 0, captured.stderr.join("\n"));

    const report = JSON.parse(await readFile(join(out, "run_report.json"), "utf8"));
    assert.deepEqual(report.totals, {
      completed: 1,
      ambiguous: 0,
      stopped: 0,
      ambiguity: { UNDETERMINED_VALUE: 0, EXTERNAL_EFFECT: 0, CONFLICTING_SLICES: 0 },
      verification: { FOUND: 0, NONE_FOUND_WITHIN_SCOPE: 0, UNVERIFIED: 1 },
    });
    assert.deepEqual(captured.stdout, [JSON.stringify(report.totals)]);

    assert.ok(await isFile(join(out, "system_map.mmd")));
    assert.ok(await isFile(join(out, "system_map.json")));

    const [scenario] = report.scenarios;
    assert.equal(scenario.kind, "COMPLETED");
    assert.equal(scenario.unverifiedReason, "NO_SOLVER");
    const dir = join(out, "scenarios", safeName(scenario.scenarioId));
    for (const name of ["spec.json", "spec.als", "solver_report.json", "ledger.json", "spec.md", "matrix.md", "flow.mmd"]) {
      assert.ok(await isFile(join(dir, name)), name);
    }
    assert.ok((await readFile(join(dir, "spec.als"), "utf8")).endsWith("\n"));
  });
});

test("同じリポジトリに 2 回かけると、同じ報告になる", async () => {
  await withTempRepo(async (root) => {
    const first = capture();
    const second = capture();
    assert.equal(await main([join(root, "repo"), "--out", join(root, "out1")], first.io), 0);
    assert.equal(await main([join(root, "repo"), "--out", join(root, "out2")], second.io), 0);
    assert.equal(
      await readFile(join(root, "out2", "run_report.json"), "utf8"),
      await readFile(join(root, "out1", "run_report.json"), "utf8"),
    );
  });
});

test("引数の誤りは終了コード 2 で、使い方を出す", async () => {
  const cases: string[][] = [
    ["repo"], // --out が無い
    ["--out", "out"], // リポジトリが無い
    ["a", "b", "--out", "out"], // リポジトリが 2 つ
    ["repo", "--out", "out", "--unknown"], // 知らない引数
  ];
  for (const argv of cases) {
    const captured = capture();
    assert.equal(await main(argv, captured.io), 2, argv.join(" "));
    assert.ok(captured.stderr.some((line) => line.startsWith("使い方:")), argv.join(" "));
    assert.deepEqual(captured.stdout, []);
  }
});

test("リポジトリのディレクトリが無いときは、環境の故障として終了コード 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "specula-cli-"));
  try {
    const captured = capture();
    const code = await main([join(root, "no_such_repo"), "--out", join(root, "out")], captured.io);
    assert.equal(code, 1);
    assert.ok(captured.stderr.some((line) => line.startsWith("実行を止めた（環境の故障）")));
    assert.equal(await isFile(join(root, "out", "run_report.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("safeName は英数字・-・_・. 以外を _ にする", () => {
  assert.equal(safeName("src/a.ts#openIt"), "src_a.ts_openIt");
  assert.equal(safeName("abc-1_2.x"), "abc-1_2.x");
  assert.equal(safeName("名前 1"), "___1");
});