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

// 値が決まらない書き込みと外への作用がある関数（オーケストレーターのテストと同じ。AmbiguityReport になる）。
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

/**
 * 一時ディレクトリに repo/（小さなリポジトリ）を作り、そのルートを返す。終わったら消す。
 * files を渡さなければ、旗を 1 つ持つ関数だけのリポジトリにする。
 */
async function withTempRepo(
  body: (root: string) => Promise<void>,
  files: Record<string, string> = { "src/index.ts": 'export { openIt } from "./a.js";\n', "src/a.ts": OPEN_SOURCE },
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-cli-"));
  try {
    await mkdir(join(root, "repo", "src"), { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      await writeFile(join(root, "repo", path), text, "utf8");
    }
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

test("リポジトリにかけると終了コード 0 で、報告・全体マップ・辞書・意図の候補・対応表・シナリオの成果物を書く", async () => {
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

    for (const name of ["system_map.mmd", "system_map.json", "glossary.json", "intents.json", "implementation_map.json"]) {
      assert.ok(await isFile(join(out, name)), name);
    }

    const [scenario] = report.scenarios;
    assert.equal(scenario.kind, "COMPLETED");
    assert.equal(scenario.unverifiedReason, "NO_SOLVER");
    const dir = join(out, "scenarios", safeName(scenario.scenarioId));
    for (const name of ["spec.json", "spec.als", "solver_report.json", "ledger.json", "spec.md", "matrix.md", "flow.mmd"]) {
      assert.ok(await isFile(join(dir, name)), name);
    }
    assert.ok((await readFile(join(dir, "spec.als"), "utf8")).endsWith("\n"));

    // 対応表で、報告の表示の id から内部の識別子を引ける（全体設計 4.1）。
    const map = JSON.parse(await readFile(join(out, "implementation_map.json"), "utf8"));
    const entry = map.entries.find((item: { kind: string }) => item.kind === "SCENARIO");
    assert.equal(entry.displayId, scenario.displayId);
    assert.equal(entry.internalId, scenario.scenarioId);
    const glossary = JSON.parse(await readFile(join(out, "glossary.json"), "utf8"));
    assert.deepEqual(map.basis, { mapHash: glossary.basis.mapHash, documentsHash: glossary.basis.documentsHash });
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

test("--view-role が無ければ PdM で付録を載せず、Eng なら仕様書に形式仕様のソースの付録を載せる", async () => {
  await withTempRepo(async (root) => {
    assert.equal(await main([join(root, "repo"), "--out", join(root, "pdm")], capture().io), 0);
    assert.equal(await main([join(root, "repo"), "--out", join(root, "eng"), "--view-role", "Eng"], capture().io), 0);

    const report = JSON.parse(await readFile(join(root, "pdm", "run_report.json"), "utf8"));
    const name = safeName(report.scenarios[0].scenarioId);
    const pdm = await readFile(join(root, "pdm", "scenarios", name, "spec.md"), "utf8");
    const eng = await readFile(join(root, "eng", "scenarios", name, "spec.md"), "utf8");
    assert.ok(!pdm.includes("## 付録: 形式仕様のソース"));
    assert.ok(eng.includes("## 付録: 形式仕様のソース"));

    // 対応表と内部の記録は、役割で変わらない。
    for (const file of ["implementation_map.json", "glossary.json", "run_report.json"]) {
      assert.equal(await readFile(join(root, "eng", file), "utf8"), await readFile(join(root, "pdm", file), "utf8"), file);
    }
  });
});

test("曖昧さで止まったシナリオは ambiguity.json と曖昧さの一覧 ambiguity.md を書き、所在は Eng のときだけ出す", async () => {
  await withTempRepo(
    async (root) => {
      assert.equal(await main([join(root, "repo"), "--out", join(root, "pdm")], capture().io), 0);
      assert.equal(await main([join(root, "repo"), "--out", join(root, "eng"), "--view-role", "Eng"], capture().io), 0);

      const report = JSON.parse(await readFile(join(root, "pdm", "run_report.json"), "utf8"));
      const [scenario] = report.scenarios;
      assert.equal(scenario.kind, "AMBIGUOUS", JSON.stringify(report.scenarios));
      const dir = (out: string): string => join(root, out, "scenarios", safeName(scenario.scenarioId));
      assert.ok(await isFile(join(dir("pdm"), "ambiguity.json")));
      const pdm = await readFile(join(dir("pdm"), "ambiguity.md"), "utf8");
      const eng = await readFile(join(dir("eng"), "ambiguity.md"), "utf8");
      assert.ok(pdm.includes(`${scenario.displayId}-A-001`));
      assert.ok(!pdm.includes("src/g.ts"));
      assert.ok(eng.includes("src/g.ts"));
    },
    { "src/index.ts": 'export { go } from "./g.js";\n', "src/g.ts": AMBIGUOUS_SOURCE },
  );
});

test("引数の誤りは終了コード 2 で、使い方を出す", async () => {
  const cases: string[][] = [
    ["repo"], // --out が無い
    ["--out", "out"], // リポジトリが無い
    ["a", "b", "--out", "out"], // リポジトリが 2 つ
    ["repo", "--out", "out", "--unknown"], // 知らない引数
    ["repo", "--out", "out", "--view-role", "pdm"], // 役割は PdM か Eng だけ（大文字小文字も区別する）
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