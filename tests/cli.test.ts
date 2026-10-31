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

test("リポジトリにかけると終了コード 0 で、報告・全体マップ・辞書・意図の候補・対応表・コマンドの成果物を書く", async () => {
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

    for (const name of ["glossary.json", "intents.json", "implementation_map.json"]) {
      assert.ok(await isFile(join(out, name)), name);
    }
    // 利用者向けの出力は両方の役割で、views/<役割>/ の下に書く（全体設計 4.1）。出力先の直下には書かない。
    for (const role of ["business", "implementation"]) {
      for (const name of ["system_map.mmd", "system_map.json"]) {
        assert.ok(await isFile(join(out, "views", role, name)), `${role}/${name}`);
      }
    }
    assert.ok(!(await isFile(join(out, "system_map.json"))));

    const [commandTarget] = report.commands;
    assert.equal(commandTarget.kind, "COMPLETED");
    assert.equal(commandTarget.unverifiedReason, "NO_SOLVER");
    const dir = join(out, "commands", safeName(commandTarget.commandId));
    for (const name of ["spec.json", "spec.als", "solver_report.json", "ledger.json"]) {
      assert.ok(await isFile(join(dir, name)), name);
    }
    for (const name of ["spec.md", "matrix.md", "flow.mmd"]) {
      assert.ok(!(await isFile(join(dir, name))), name);
      for (const role of ["business", "implementation"]) {
        assert.ok(await isFile(join(out, "views", role, "commands", safeName(commandTarget.commandId), name)), `${role}/${name}`);
      }
    }
    assert.ok((await readFile(join(dir, "spec.als"), "utf8")).endsWith("\n"));

    // 対応表で、報告の表示の id から内部の識別子を引ける（全体設計 4.1）。
    const map = JSON.parse(await readFile(join(out, "implementation_map.json"), "utf8"));
    const entry = map.entries.find((item: { kind: string }) => item.kind === "COMMAND_TARGET");
    assert.equal(entry.displayId, commandTarget.displayId);
    assert.equal(entry.internalId, commandTarget.commandId);
    const glossary = JSON.parse(await readFile(join(out, "glossary.json"), "utf8"));
    assert.deepEqual(map.basis, { mapHash: glossary.basis.mapHash, documentsHash: glossary.basis.documentsHash });

    // 俯瞰図は地図 1 と Bounded Context ごとの地図 2 を束ねた 1 つの JSON（全体設計 4.1）。
    const systemMap = JSON.parse(await readFile(join(out, "views", "business", "system_map.json"), "utf8"));
    assert.equal(systemMap.viewRole, "BUSINESS");
    const systemMapForImplementation = JSON.parse(await readFile(join(out, "views", "implementation", "system_map.json"), "utf8"));
    assert.equal(systemMapForImplementation.viewRole, "IMPLEMENTATION");
    assert.deepEqual(systemMapForImplementation.basis, glossary.basis);
    assert.deepEqual(systemMap.basis, glossary.basis);
    assert.ok(Array.isArray(systemMap.contextMap.nodes));
    assert.deepEqual(
      systemMap.details.map((detail: { context: string }) => detail.context),
      systemMap.contextMap.nodes.map((node: { id: string }) => node.id),
    );
    for (const detail of systemMap.details) {
      assert.ok(Array.isArray(detail.core.nodes) && Array.isArray(detail.supporting.nodes));
    }
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

test("仕様書は BUSINESS では付録を載せず、IMPLEMENTATION では形式仕様のソースの付録を載せる（1 回の実行で両方を書く）", async () => {
  await withTempRepo(async (root) => {
    const out = join(root, "out");
    assert.equal(await main([join(root, "repo"), "--out", out], capture().io), 0);

    const report = JSON.parse(await readFile(join(out, "run_report.json"), "utf8"));
    const name = safeName(report.commands[0].commandId);
    const business = await readFile(join(out, "views", "business", "commands", name, "spec.md"), "utf8");
    const implementation = await readFile(join(out, "views", "implementation", "commands", name, "spec.md"), "utf8");
    assert.ok(!business.includes("## 付録: 形式仕様のソース"));
    assert.ok(implementation.includes("## 付録: 形式仕様のソース"));
  });
});

test("曖昧さで止まったコマンドは ambiguity.json と曖昧さの一覧 ambiguity.md を書き、所在は IMPLEMENTATION のときだけ出す", async () => {
  await withTempRepo(
    async (root) => {
      const out = join(root, "out");
      assert.equal(await main([join(root, "repo"), "--out", out], capture().io), 0);

      const report = JSON.parse(await readFile(join(out, "run_report.json"), "utf8"));
      const [commandTarget] = report.commands;
      assert.equal(commandTarget.kind, "AMBIGUOUS", JSON.stringify(report.commands));
      const name = safeName(commandTarget.commandId);
      assert.ok(await isFile(join(out, "commands", name, "ambiguity.json")));
      assert.ok(!(await isFile(join(out, "commands", name, "ambiguity.md"))));
      const pdm = await readFile(join(out, "views", "business", "commands", name, "ambiguity.md"), "utf8");
      const eng = await readFile(join(out, "views", "implementation", "commands", name, "ambiguity.md"), "utf8");
      // BUSINESS は「エンジニアの確認待ち: N 件」だけ、IMPLEMENTATION は曖昧さごとに表示の id と所在を書く（SpecProjector の設計 8.9）
      assert.ok(pdm.includes("エンジニアの確認待ち: "));
      assert.ok(!pdm.includes(`${commandTarget.displayId}-A-001`));
      assert.ok(eng.includes(`${commandTarget.displayId}-A-001`));
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
    ["repo", "--out", "out", "--view-role", "business"], // 役割は受け取らない（両方の役割で書く。全体設計 4.1）
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