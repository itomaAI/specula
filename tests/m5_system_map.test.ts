// SpecProjector の全体の俯瞰図（projectSystemMap）のテスト（SpecProjector の設計 4.4・7.7・8.1・8.3）。
// 表示名は辞書の term.label から取る。辞書は手で組み、basis.mapHash は GlossaryBuilder と同じ方法で計算する。

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapHashOf } from "../src/core/glossary_builder.js";
import { projectSystemMap } from "../src/core/spec_projector.js";
import type { LlmText } from "../src/types/index.js";
import type { Glossary, GlossaryEntry, GlossaryLocation, PresentedEntryKind } from "../src/types/glossary.js";
import type { IntentCatalog } from "../src/types/intent.js";
import { ProjectionContractError, type SystemProjectionRequest, type SystemViewFormat, type ViewRole } from "../src/types/projection.js";
import type { EventStormingMap } from "../src/types/scenario.js";

const LOC = { file: "src/order.ts", symbol: "f", line: 1 };
const MAP: EventStormingMap = {
  boundedContexts: [{ id: "src_order", name: "order", rootPaths: ["src/order"], isDefaultFallback: false }],
  events: [
    { id: "src/order.ts#close", contextId: "src_order", handler: LOC, signal: { kind: "DB_MUTATION", callee: "db.update", label: null, line: 1 }, after: [] },
    { id: "src/order.ts#notify", contextId: "src_order", handler: LOC, signal: { kind: "EVENT_EMIT", callee: "emit", label: "notify", line: 2 }, after: ["src/order.ts#close"] },
  ],
  commands: [{ id: "src/order.ts#closeOrder", contextId: "src_order", actorId: "Caller", eventIds: ["src/order.ts#close"], handler: LOC }],
  policies: [{ id: "src/order.ts#onClose", triggerEventId: "src/order.ts#close", actionCommandId: "src/order.ts#closeOrder", listener: LOC }],
  readModels: [],
  actors: [{ id: "Caller", name: "Caller" }],
  diagnostics: { mode: "STATE_SIGNALS", entryFiles: [], parsedFileCount: 1, parseFailures: [], unattributedSignals: [] },
};

/** 実装の所在を持たせる項目（ほかは空）。 */
const LOCATIONS: Record<string, GlossaryLocation[]> = {
  "src/order.ts#closeOrder": [{ file: "src/order.ts", symbol: "closeOrder", line: 10 }],
};

/** labels に無い要素は用語が未生成（UNREACHABLE）。 */
async function glossaryOf(map: EventStormingMap, labels: Record<string, string>): Promise<Glossary> {
  const presented: Array<[string, PresentedEntryKind]> = [
    ...map.boundedContexts.map((c) => [c.id, "BOUNDED_CONTEXT"] as [string, PresentedEntryKind]),
    ...map.events.map((e) => [e.id, "EVENT"] as [string, PresentedEntryKind]),
    ...map.commands.map((c) => [c.id, "COMMAND"] as [string, PresentedEntryKind]),
    ...map.policies.map((p) => [p.id, "POLICY"] as [string, PresentedEntryKind]),
  ];
  const entries: GlossaryEntry[] = presented.map(([id, kind]) => {
    const label = labels[id];
    const locations = LOCATIONS[id] ?? [];
    return {
      id,
      kind,
      scope: "PRESENTED",
      term:
        label === undefined
          ? { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" }
          : { status: "GENERATED", term: "Term", label, recordKey: `k:${id}` },
      implementation: { names: locations.map((location) => location.symbol!), locations },
      sources: [],
      contextId: null,
      crossesTo: null,
      termStatus: label === undefined ? "NOT_GENERATED" : "CANDIDATE",
      excerpt: null,
    };
  });
  return {
    entries,
    gaps: { undocumentedEntries: [], unmatchedDocumentNames: [], sharedTerms: [], contextHomonyms: [], multiSourceEntries: [] },
    documents: { read: [], truncated: [], omitted: [] },
    basis: { mapHash: await mapHashOf(map), documentsHash: "0" },
  };
}

const LABELS = {
  src_order: "注文",
  "src/order.ts#close": "注文が締められた",
  "src/order.ts#closeOrder": "注文を締める",
  "src/order.ts#onClose": "締めたら知らせる",
};

function intentsOf(glossary: Glossary, intent: LlmText): IntentCatalog {
  return { contexts: [{ contextId: "src_order", intent, intentStatus: "CANDIDATE" }], scenarios: [], basis: { ...glossary.basis } };
}

const INTENT: LlmText = { status: "GENERATED", text: "注文を受け付けてから締めるまでを扱う", recordKey: "intent-1" };

function request(format: SystemViewFormat, viewRole: ViewRole = "PdM"): SystemProjectionRequest {
  return { format, viewRole };
}

type JsonView = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };

test("俯瞰図（Mermaid）: Bounded Context ごとにまとめ、題とノードの文は辞書の表示名で、地図の id を出さない", async () => {
  const glossary = await glossaryOf(MAP, LABELS);
  const a = await projectSystemMap(MAP, glossary, null, request("SYSTEM_MERMAID"));
  const b = await projectSystemMap(MAP, glossary, null, request("SYSTEM_MERMAID"));
  assert.equal(a.content, b.content);
  assert.equal(a.scenarioId, null);
  assert.equal(a.displayId, null);
  assert.equal(a.viewRole, "PdM");
  assert.equal(a.mediaType, "text/vnd.mermaid");
  assert.ok(a.content.includes('subgraph c1["注文"]'));
  assert.ok(a.content.includes('n1["イベント: 注文が締められた"]'));
  assert.ok(a.content.includes('n2["イベント: イベント n2（名前は未生成）"]'));
  assert.ok(a.content.includes('n3["コマンド: 注文を締める"]'));
  assert.ok(a.content.includes('n4["ポリシー: 締めたら知らせる"]'));
  assert.ok(a.content.includes("n3 -->|発生させる| n1"));
  assert.ok(a.content.includes("n1 -->|このあとに起きる| n2"));
  assert.ok(a.content.includes("n1 -->|反応する| n4"));
  assert.ok(a.content.includes("n4 -->|起動する| n3"));
  assert.ok(!a.content.includes("src/order.ts"));
  assert.ok(!a.content.includes("src_order"));
  assert.ok(!a.content.includes("closeOrder"));
});

test("俯瞰図: Bounded Context の用語が未生成なら、実装の名前を出さずに「Bounded Context cN（名前は未生成）」", async () => {
  const glossary = await glossaryOf(MAP, {});
  const view = await projectSystemMap(MAP, glossary, null, request("SYSTEM_MERMAID"));
  assert.ok(view.content.includes('subgraph c1["Bounded Context c1（名前は未生成）"]'));
  assert.ok(!view.content.includes('"order"'));
  const json = JSON.parse((await projectSystemMap(MAP, glossary, null, request("SYSTEM_JSON"))).content) as JsonView;
  assert.equal(json.nodes[0]!.label, "Bounded Context c1（名前は未生成）");
  assert.equal(json.nodes[1]!.context, "Bounded Context c1（名前は未生成）");
});

test("俯瞰図（JSON）: Bounded Context のノードを先に置き、ノードとつながりを決まった順で返す", async () => {
  const glossary = await glossaryOf(MAP, LABELS);
  const view = await projectSystemMap(MAP, glossary, intentsOf(glossary, INTENT), request("SYSTEM_JSON"));
  assert.equal(view.mediaType, "application/json");
  const value = JSON.parse(view.content) as JsonView;
  assert.deepEqual(value.nodes.map((node) => node.id), ["c1", "n1", "n2", "n3", "n4"]);
  assert.deepEqual(value.nodes.map((node) => node.kind), ["BOUNDED_CONTEXT", "EVENT", "EVENT", "COMMAND", "POLICY"]);
  assert.deepEqual(Object.keys(value.nodes[0]!), ["id", "kind", "label", "context", "intent"]);
  assert.deepEqual(Object.keys(value.nodes[1]!), ["id", "kind", "label", "context"]);
  assert.equal(value.nodes[0]!.label, "注文");
  assert.equal(value.nodes[0]!.context, null);
  assert.equal(value.nodes[1]!.context, "注文");
  assert.equal(value.nodes[4]!.context, null);
  assert.deepEqual(value.edges, [
    { from: "n3", to: "n1", kind: "EMITS" },
    { from: "n1", to: "n2", kind: "AFTER" },
    { from: "n1", to: "n4", kind: "TRIGGERS" },
    { from: "n4", to: "n3", kind: "INVOKES" },
  ]);
});

test("俯瞰図（JSON）: 意図の候補は Bounded Context のノードだけに置き、無いか未生成なら null（設計 4.4）", async () => {
  const glossary = await glossaryOf(MAP, LABELS);
  const nodesOf = async (intents: IntentCatalog | null) =>
    (JSON.parse((await projectSystemMap(MAP, glossary, intents, request("SYSTEM_JSON"))).content) as JsonView).nodes;

  const withIntent = await nodesOf(intentsOf(glossary, INTENT));
  assert.equal(withIntent[0]!.intent, "注文を受け付けてから締めるまでを扱う");
  for (const node of withIntent.slice(1)) assert.ok(!("intent" in node), String(node.id));

  const notGenerated = await nodesOf(intentsOf(glossary, { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: "closeOrder を含む" }));
  assert.equal(notGenerated[0]!.intent, null);
  assert.equal((await nodesOf(null))[0]!.intent, null);

  // Mermaid には意図を載せない
  const mermaid = await projectSystemMap(MAP, glossary, intentsOf(glossary, INTENT), request("SYSTEM_MERMAID"));
  assert.ok(!mermaid.content.includes("注文を受け付けてから"));
});

test("俯瞰図: Eng のときは Mermaid のノードに所在を併記し、JSON に implementation を置く（設計 8.3）", async () => {
  const glossary = await glossaryOf(MAP, LABELS);
  const mermaid = await projectSystemMap(MAP, glossary, null, request("SYSTEM_MERMAID", "Eng"));
  assert.equal(mermaid.viewRole, "Eng");
  assert.ok(mermaid.content.includes('n3["コマンド: 注文を締める / src/order.ts#closeOrder"]'));
  // 所在が無いノードは併記しない
  assert.ok(mermaid.content.includes('n1["イベント: 注文が締められた"]'));

  const value = JSON.parse((await projectSystemMap(MAP, glossary, intentsOf(glossary, INTENT), request("SYSTEM_JSON", "Eng"))).content) as JsonView;
  assert.deepEqual(Object.keys(value.nodes[0]!), ["id", "kind", "label", "context", "intent", "implementation"]);
  assert.deepEqual(Object.keys(value.nodes[1]!), ["id", "kind", "label", "context", "implementation"]);
  assert.deepEqual(value.nodes[3]!.implementation, {
    names: ["closeOrder"],
    locations: [{ file: "src/order.ts", symbol: "closeOrder", line: 10 }],
  });
  assert.deepEqual(value.nodes[0]!.implementation, { names: [], locations: [] });
  // 表示の文（label）は役割で変えない
  const pdm = JSON.parse((await projectSystemMap(MAP, glossary, intentsOf(glossary, INTENT), request("SYSTEM_JSON"))).content) as JsonView;
  assert.deepEqual(value.nodes.map((node) => node.label), pdm.nodes.map((node) => node.label));
});

test("俯瞰図: 別の全体マップから作った辞書と、別の辞書から作った意図の候補は GLOSSARY_STALE。対応外の形式と役割は UNSUPPORTED_FORMAT", async () => {
  const reason = (expected: string) => (error: unknown) => error instanceof ProjectionContractError && error.reason === expected;
  const other: EventStormingMap = { ...MAP, policies: [] };
  const stale = await glossaryOf(other, LABELS);
  await assert.rejects(projectSystemMap(MAP, stale, null, request("SYSTEM_MERMAID")), reason("GLOSSARY_STALE"));

  const glossary = await glossaryOf(MAP, LABELS);
  const staleIntents: IntentCatalog = { ...intentsOf(glossary, INTENT), basis: { mapHash: glossary.basis.mapHash, documentsHash: "1" } };
  await assert.rejects(projectSystemMap(MAP, glossary, staleIntents, request("SYSTEM_JSON")), reason("GLOSSARY_STALE"));

  await assert.rejects(
    projectSystemMap(MAP, glossary, null, { format: "SYSTEM_SVG", viewRole: "PdM" } as unknown as SystemProjectionRequest),
    reason("UNSUPPORTED_FORMAT"),
  );
  await assert.rejects(
    projectSystemMap(MAP, glossary, null, { format: "SYSTEM_JSON", viewRole: "Admin" } as unknown as SystemProjectionRequest),
    reason("UNSUPPORTED_FORMAT"),
  );
});