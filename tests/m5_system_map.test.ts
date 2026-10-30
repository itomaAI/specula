// SpecProjector の全体の俯瞰図（projectSystemMap）のテスト（SpecProjector の設計 4.4・7.7・8.1）。
// 表示名は辞書の term.label から取る。辞書は手で組み、basis.mapHash は GlossaryBuilder と同じ方法で計算する。

import { test } from "node:test";
import assert from "node:assert/strict";

import { mapHashOf } from "../src/core/glossary_builder.js";
import { projectSystemMap } from "../src/core/spec_projector.js";
import type { Glossary, GlossaryEntry, PresentedEntryKind } from "../src/types/glossary.js";
import { ProjectionContractError, type SystemProjectionRequest } from "../src/types/projection.js";
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
    return {
      id,
      kind,
      scope: "PRESENTED",
      term:
        label === undefined
          ? { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "test" }
          : { status: "GENERATED", term: "Term", label, recordKey: `k:${id}` },
      implementation: { names: [], locations: [] },
      sources: [],
    };
  });
  return {
    entries,
    gaps: { undocumentedEntries: [], unmatchedDocumentNames: [], sharedTerms: [], multiSourceEntries: [] },
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

test("俯瞰図（Mermaid）: Bounded Context ごとにまとめ、題とノードの文は辞書の表示名で、地図の id を出さない", async () => {
  const glossary = await glossaryOf(MAP, LABELS);
  const a = await projectSystemMap(MAP, glossary, { format: "SYSTEM_MERMAID" });
  const b = await projectSystemMap(MAP, glossary, { format: "SYSTEM_MERMAID" });
  assert.equal(a.content, b.content);
  assert.equal(a.scenarioId, null);
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
});

test("俯瞰図: Bounded Context の用語が未生成なら、実装の名前を出さずに「Bounded Context cN（名前は未生成）」", async () => {
  const glossary = await glossaryOf(MAP, {});
  const view = await projectSystemMap(MAP, glossary, { format: "SYSTEM_MERMAID" });
  assert.ok(view.content.includes('subgraph c1["Bounded Context c1（名前は未生成）"]'));
  assert.ok(!view.content.includes('"order"'));
  const json = JSON.parse((await projectSystemMap(MAP, glossary, { format: "SYSTEM_JSON" })).content) as {
    nodes: Array<Record<string, unknown>>;
  };
  assert.equal(json.nodes[0]!.context, "Bounded Context c1（名前は未生成）");
});

test("俯瞰図（JSON）: ノードとつながりを決まった順で返し、context は Bounded Context の表示名", async () => {
  const view = await projectSystemMap(MAP, await glossaryOf(MAP, LABELS), { format: "SYSTEM_JSON" });
  assert.equal(view.mediaType, "application/json");
  const value = JSON.parse(view.content) as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(value.nodes[0]!), ["id", "kind", "label", "context"]);
  assert.deepEqual(value.nodes.map((node) => node.kind), ["EVENT", "EVENT", "COMMAND", "POLICY"]);
  assert.equal(value.nodes[0]!.context, "注文");
  assert.equal(value.nodes[3]!.context, null);
  assert.deepEqual(value.edges, [
    { from: "n3", to: "n1", kind: "EMITS" },
    { from: "n1", to: "n2", kind: "AFTER" },
    { from: "n1", to: "n4", kind: "TRIGGERS" },
    { from: "n4", to: "n3", kind: "INVOKES" },
  ]);
});

test("俯瞰図: 別の全体マップから作った辞書は GLOSSARY_STALE、対応外の形式は UNSUPPORTED_FORMAT", async () => {
  const other: EventStormingMap = { ...MAP, policies: [] };
  const stale = await glossaryOf(other, LABELS);
  await assert.rejects(projectSystemMap(MAP, stale, { format: "SYSTEM_MERMAID" }), (error: unknown) => {
    return error instanceof ProjectionContractError && error.reason === "GLOSSARY_STALE";
  });
  const glossary = await glossaryOf(MAP, LABELS);
  await assert.rejects(
    projectSystemMap(MAP, glossary, { format: "SYSTEM_SVG" } as unknown as SystemProjectionRequest),
    (error: unknown) => error instanceof ProjectionContractError && error.reason === "UNSUPPORTED_FORMAT",
  );
});