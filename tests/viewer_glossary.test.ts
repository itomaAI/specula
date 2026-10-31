// 用語辞典のビューモデルのテスト（SpecViewer 仕様 3.3、基本設計 3.5・6.8）。
// viewer_issues.test と同じく、コマンドラインの入口で一時ディレクトリに実際の出力を書き、読み戻してから組み立てる。
// この入力では資料も LLM も無く、用語と意味が出ないので、区切り・またぐ印・確定の状態の印は辞書を差し替えて確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeFsAdapter } from "../src/adapters/NodeFsAdapter.js";
import { main } from "../src/cli.js";
import { readRunOutputs } from "../src/lib/read_outputs.js";
import type { Glossary, GlossaryEntry, PresentedEntryKind } from "../src/types/glossary.js";
import type { ImplementationMap } from "../src/types/projection.js";
import type { RunReport } from "../src/types/run.js";
import { checkRunOutputs } from "../src/viewer/check.js";
import { buildGlossaryView, hideSourcePaths, sourceOf } from "../src/viewer/glossary.js";
import type { RunOutputs } from "../src/viewer/types.js";

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

async function withOutputs(body: (out: string, report: RunReport) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "specula-viewer-glossary-"));
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

// ---- 差し替える辞書（Bounded Context 2 つ、またぐポリシー、所属の無いポリシー） ----
const SECTION = "docs/a#b.md#概要 > 使い方";

function entry(
  id: string,
  kind: PresentedEntryKind,
  contextId: string | null,
  label: string,
  extra: Partial<GlossaryEntry> = {},
): GlossaryEntry {
  return {
    id,
    kind,
    scope: "PRESENTED",
    term: { status: "GENERATED", term: "Term", label, recordKey: `k-${id}` },
    implementation: { names: [`impl_${id}`], locations: [{ file: "src/x.ts", line: 1 }] },
    sources: [SECTION],
    contextId,
    crossesTo: null,
    termStatus: "CANDIDATE",
    excerpt: { text: `${label}の説明。`, source: SECTION, truncated: false, status: "CANDIDATE" },
    ...extra,
  };
}

const IDS = ["ctxA", "ctxB", "cmdB", "polAB", "polX"];

function syntheticGlossary(basis: Glossary["basis"]): Glossary {
  return {
    entries: [
      entry("cmdB", "COMMAND", "ctxB", "出荷を指示する", { termStatus: "CONFIRMED" }),
      entry("ctxA", "BOUNDED_CONTEXT", "ctxA", "受注"),
      entry("ctxB", "BOUNDED_CONTEXT", "ctxB", "出荷"),
      entry("polAB", "POLICY", "ctxA", "受注のあと出荷する", { crossesTo: "ctxB", excerpt: null }),
      entry("polX", "POLICY", null, "", {
        term: { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "" },
        termStatus: "NOT_GENERATED",
      }),
    ],
    gaps: {
      undocumentedEntries: ["polAB"],
      unmatchedDocumentNames: [{ name: "fooBar", sections: [SECTION] }],
      sharedTerms: [],
      contextHomonyms: [],
      multiSourceEntries: [],
    },
    documents: { read: ["docs/a#b.md"], truncated: [], omitted: [] },
    basis,
  };
}

function syntheticMap(basis: ImplementationMap["basis"]): ImplementationMap {
  const row = (displayId: string, kind: PresentedEntryKind, id: string) => ({
    displayId,
    kind,
    internalId: id,
    glossaryEntryId: id,
    implementation: { names: [`impl_${id}`], locations: [] },
  });
  return {
    entries: [
      row("c1", "BOUNDED_CONTEXT", "ctxA"),
      row("c2", "BOUNDED_CONTEXT", "ctxB"),
      row("n1", "COMMAND", "cmdB"),
      row("n2", "POLICY", "polAB"),
      row("n3", "POLICY", "polX"),
    ],
    basis,
  };
}

function withSynthetic(outputs: RunOutputs, map: boolean): RunOutputs {
  assert.ok(outputs.glossary.kind === "OK");
  const basis = outputs.glossary.value.basis;
  return {
    ...outputs,
    glossary: { kind: "OK", value: syntheticGlossary(basis) },
    implementationMap: map ? { kind: "OK", value: syntheticMap(basis) } : { kind: "MISSING" },
  };
}

test("表示の id: 実装との対応表で引き、俯瞰図（system_map.json）の同じ種類の要素を指す", async () => {
  await withOutputs(async (out) => {
    const outputs = await checkedOutputs(out);
    assert.ok(outputs.implementationMap.kind === "OK" && outputs.systemMap.kind === "OK");
    const view = buildGlossaryView(outputs, "BUSINESS");
    assert.equal(view.unavailable, null);
    assert.equal(view.displayIdNote, null);

    const rows = new Map(outputs.implementationMap.value.entries.map((row) => [row.displayId, row.kind] as const));
    // 俯瞰図の要素（地図 1 の Bounded Context と、地図 2 の足す要素なしの版）
    const bundle = outputs.systemMap.value as unknown as {
      contextMap: { nodes: Array<{ id: string; kind: string }> };
      details: Array<{ core: { nodes: Array<{ id: string; kind: string }> } }>;
    };
    const mapKinds = new Map<string, string>();
    for (const node of bundle.contextMap.nodes) mapKinds.set(node.id, node.kind);
    for (const detail of bundle.details) for (const node of detail.core.nodes) mapKinds.set(node.id, node.kind);

    const entries = view.sections.flatMap((section) => section.entries);
    assert.ok(entries.length > 0, "項目が無い");
    for (const item of entries) {
      assert.ok(item.displayId !== null, `${item.term} の表示の id が無い`);
      assert.equal(rows.get(item.displayId), item.kind);
      assert.equal(mapKinds.get(item.displayId), item.kind, `${item.displayId} が俯瞰図に無いか、種類が違う`);
      // BUSINESS では実装の名前と所在を持たない
      assert.equal(item.implementation, null);
    }
    assert.ok(!JSON.stringify(view).includes("src/a.ts"));
  });
});

test("区切り: Bounded Context ごとに俯瞰図の順で並べ、またぐポリシーは両方に出し、所属の無い項目は最後に置く", async () => {
  await withOutputs(async (out) => {
    const view = buildGlossaryView(withSynthetic(await checkedOutputs(out), true), "BUSINESS");
    assert.equal(view.showContextSections, true);
    assert.ok(view.statusNote?.includes("候補"));
    assert.deepEqual(
      view.sections.map((s) => [s.displayId, s.title, s.entries.map((e) => e.displayId)]),
      [
        ["c1", "受注", ["c1", "n2"]],
        ["c2", "出荷", ["c2", "n1", "n2"]],
        [null, "所属する Bounded Context が無い", ["n3"]],
      ],
    );
    const [a, b, none] = view.sections;
    assert.equal(a!.entries[1]!.crossing, "出荷へまたぐ");
    assert.equal(b!.entries[2]!.crossing, "受注からまたいでくる");
    assert.equal(b!.entries[1]!.crossing, null);

    const command = b!.entries[1]!;
    assert.equal(command.kindText, "コマンド");
    assert.equal(command.term, "出荷を指示する（確定）");
    assert.equal(command.termStatus, "CONFIRMED");
    assert.equal(command.meaning, "出荷を指示するの説明。");
    assert.deepEqual(command.sources, [{ document: "docs/a#b.md", heading: "概要 > 使い方" }]);
    // 抜粋の無い項目、用語が未生成の項目
    assert.equal(a!.entries[1]!.meaning, "資料に記述が無い");
    assert.equal(none!.entries[0]!.term, "（名前は未生成）");
    assert.equal(none!.entries[0]!.termStatus, "NOT_GENERATED");

    assert.deepEqual(view.gaps?.undocumented, [{ displayId: "n2", term: "受注のあと出荷する" }]);
    // 項目に対応しない資料の名前は BUSINESS では持たない（Q8）
    assert.equal(view.gaps?.unmatchedDocumentNames, null);

    // 内部の識別子（地図の id）と実装の名前は出ない
    const text = JSON.stringify(view);
    for (const id of IDS) assert.ok(!text.includes(id), id);
    assert.ok(!text.includes("impl_"));
    assert.ok(!text.includes("fooBar"));
  });
});

test("IMPLEMENTATION: 項目に実装の名前と所在を持ち、項目に対応しない資料の名前の件数と一覧を持つ", async () => {
  await withOutputs(async (out) => {
    const view = buildGlossaryView(withSynthetic(await checkedOutputs(out), true), "IMPLEMENTATION");
    const command = view.sections.flatMap((s) => s.entries).find((e) => e.displayId === "n1");
    assert.deepEqual(command?.implementation, { names: ["impl_cmdB"], locations: [{ file: "src/x.ts", line: 1 }] });
    assert.equal(view.gaps?.unmatchedDocumentNames?.count, 1);
    assert.deepEqual(view.gaps?.unmatchedDocumentNames?.items[0], {
      name: "fooBar",
      sources: [{ document: "docs/a#b.md", heading: "概要 > 使い方" }],
    });
  });
});

test("意味の抜粋のコードのパス: BUSINESS では隠し、IMPLEMENTATION では出す（Q6）", async () => {
  // パスを含むインラインコードは囲みごと置き換え、関数名だけのインラインコードは残す
  assert.equal(
    hideSourcePaths("読むのは `src/lib/read_outputs.ts` の `readRunOutputs(fs)` とする。`specula/src/core/` に置く。"),
    "読むのは （コードのパス） の `readRunOutputs(fs)` とする。（コードのパス） に置く。",
  );
  // 囲まれていないパスも置き換える。src/ を区切りに含まない語は残す
  assert.equal(hideSourcePaths("配置は ./src/a.ts と src/b/。resrc/x と src-map は残す"), "配置は （コードのパス） と （コードのパス）。resrc/x と src-map は残す");

  await withOutputs(async (out) => {
    const outputs = withSynthetic(await checkedOutputs(out), true);
    assert.ok(outputs.glossary.kind === "OK");
    const glossary = outputs.glossary.value;
    const withPath: RunOutputs = {
      ...outputs,
      glossary: {
        kind: "OK",
        value: {
          ...glossary,
          entries: glossary.entries.map((e) =>
            e.id === "cmdB" && e.excerpt !== null ? { ...e, excerpt: { ...e.excerpt, text: "`src/ship.ts` で出荷を指示する。" } } : e,
          ),
        },
      },
    };
    const meaningIn = (role: "BUSINESS" | "IMPLEMENTATION") =>
      buildGlossaryView(withPath, role).sections.flatMap((s) => s.entries).find((e) => e.displayId === "n1")?.meaning;
    assert.equal(meaningIn("BUSINESS"), "（コードのパス） で出荷を指示する。");
    assert.equal(meaningIn("IMPLEMENTATION"), "`src/ship.ts` で出荷を指示する。");
  });
});

test("実装との対応表が無いとき: 表示の id を出さずに理由を書き、辞書の順で並べる", async () => {
  await withOutputs(async (out) => {
    const view = buildGlossaryView(withSynthetic(await checkedOutputs(out), false), "BUSINESS");
    assert.equal(view.displayIdNote, "表示の id を引けない: 実装との対応表が無い");
    assert.deepEqual(
      view.sections.map((s) => [s.displayId, s.title, s.entries.map((e) => e.term)]),
      [
        [null, "受注", ["受注", "受注のあと出荷する"]],
        [null, "出荷", ["出荷", "出荷を指示する（確定）", "受注のあと出荷する"]],
        [null, "所属する Bounded Context が無い", ["（名前は未生成）"]],
      ],
    );
  });
});

test("辞書が無いとき: 理由だけを返す", async () => {
  await withOutputs(async (out) => {
    await rm(join(out, "glossary.json"));
    const view = buildGlossaryView(await checkedOutputs(out), "BUSINESS");
    assert.equal(view.unavailable, "辞書（glossary.json）が無いため、用語辞典を出せない。");
    assert.deepEqual(view.sections, []);
    assert.equal(view.gaps, null);
  });
});

test("sourceOf: 節の識別子を、読んだ資料のパスで資料と見出しに分ける", () => {
  assert.deepEqual(sourceOf("docs/a#b.md#概要 > 使い方", ["docs/a#b.md"]), { document: "docs/a#b.md", heading: "概要 > 使い方" });
  assert.deepEqual(sourceOf("README.md#", ["README.md"]), { document: "README.md", heading: "" });
  assert.deepEqual(sourceOf("README.md#導入 (2)", ["README.md", "README"]), { document: "README.md", heading: "導入 (2)" });
  // 読んだ資料に無ければ最初の "#" で分ける
  assert.deepEqual(sourceOf("x.md#見出し", []), { document: "x.md", heading: "見出し" });
});

test("用語辞典: 事前条件を通っていない入力では例外を投げる", async () => {
  await withOutputs(async (out) => {
    await rm(join(out, "run_report.json"));
    const outputs = await readRunOutputs(fs, out);
    assert.throws(() => buildGlossaryView(outputs, "BUSINESS"), /checkRunOutputs/);
  });
});