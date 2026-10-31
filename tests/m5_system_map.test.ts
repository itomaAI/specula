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
  const intentStatus = intent.status === "GENERATED" ? "CANDIDATE" : "NOT_GENERATED";
  return { contexts: [{ contextId: "src_order", intent, intentStatus }], scenarios: [], basis: { ...glossary.basis } };
}

const INTENT: LlmText = { status: "GENERATED", text: "注文を受け付けてから締めるまでを扱う", recordKey: "intent-1" };

function request(format: SystemViewFormat, viewRole: ViewRole = "BUSINESS"): SystemProjectionRequest {
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
  assert.equal(a.viewRole, "BUSINESS");
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
  assert.deepEqual(Object.keys(value.nodes[0]!), ["id", "kind", "label", "context", "intent", "broken"]);
  assert.deepEqual(Object.keys(value.nodes[1]!), ["id", "kind", "label", "context", "broken"]);
  assert.equal(value.nodes[0]!.label, "注文");
  assert.equal(value.nodes[0]!.context, null);
  assert.equal(value.nodes[1]!.context, "注文");
  assert.equal(value.nodes[4]!.context, null);
  // 壊れた印の欄は、初回は常に null（設計 8.9）
  for (const node of value.nodes) assert.equal(node.broken, null, String(node.id));
  assert.deepEqual(value.edges, [
    { from: "n3", to: "n1", kind: "EMITS", broken: null },
    { from: "n1", to: "n2", kind: "AFTER", broken: null },
    { from: "n1", to: "n4", kind: "TRIGGERS", broken: null },
    { from: "n4", to: "n3", kind: "INVOKES", broken: null },
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

test("俯瞰図: IMPLEMENTATION のときは Mermaid のノードに所在を併記し、JSON に implementation を置く（設計 8.3）", async () => {
  const glossary = await glossaryOf(MAP, LABELS);
  const mermaid = await projectSystemMap(MAP, glossary, null, request("SYSTEM_MERMAID", "IMPLEMENTATION"));
  assert.equal(mermaid.viewRole, "IMPLEMENTATION");
  assert.ok(mermaid.content.includes('n3["コマンド: 注文を締める / src/order.ts#closeOrder"]'));
  // 所在が無いノードは併記しない
  assert.ok(mermaid.content.includes('n1["イベント: 注文が締められた"]'));

  const value = JSON.parse((await projectSystemMap(MAP, glossary, intentsOf(glossary, INTENT), request("SYSTEM_JSON", "IMPLEMENTATION"))).content) as JsonView;
  assert.deepEqual(Object.keys(value.nodes[0]!), ["id", "kind", "label", "context", "intent", "broken", "implementation"]);
  assert.deepEqual(Object.keys(value.nodes[1]!), ["id", "kind", "label", "context", "broken", "implementation"]);
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
    projectSystemMap(MAP, glossary, null, { format: "SYSTEM_SVG", viewRole: "BUSINESS" } as unknown as SystemProjectionRequest),
    reason("UNSUPPORTED_FORMAT"),
  );
  await assert.rejects(
    projectSystemMap(MAP, glossary, null, { format: "SYSTEM_JSON", viewRole: "Admin" } as unknown as SystemProjectionRequest),
    reason("UNSUPPORTED_FORMAT"),
  );
});

// 地図 1・地図 2（設計 8.9）。Bounded Context を 2 つにし、注文から出荷へまたぐポリシーを 1 つ置く。
// 番号: イベント n1・n2、コマンド n3・n4、ポリシー n5（またぐ）・n6、アクター n7（Batch）・n8（Caller）、
// リードモデル n9、アグリゲート n10（注文の Order）・n11（出荷の Shipment）。
const SHIP_LOC = { file: "src/ship.ts", symbol: "f", line: 1 };
const MAP2: EventStormingMap = {
  boundedContexts: [
    { id: "src_order", name: "order", rootPaths: ["src/order"], isDefaultFallback: false },
    { id: "src_ship", name: "ship", rootPaths: ["src/ship"], isDefaultFallback: false },
  ],
  events: [
    { id: "src/order.ts#close", contextId: "src_order", aggregate: "Order", handler: LOC, signal: { kind: "DB_MUTATION", callee: "db.update", label: null, line: 1 }, after: [] },
    { id: "src/ship.ts#shipped", contextId: "src_ship", aggregate: "Shipment", handler: SHIP_LOC, signal: { kind: "DB_MUTATION", callee: "db.insert", label: null, line: 1 }, after: [] },
  ],
  commands: [
    { id: "src/order.ts#closeOrder", contextId: "src_order", actorId: "Caller", readModelId: "rm_orders", eventIds: ["src/order.ts#close"], handler: LOC },
    { id: "src/ship.ts#ship", contextId: "src_ship", actorId: "Batch", eventIds: ["src/ship.ts#shipped"], handler: SHIP_LOC },
  ],
  policies: [
    { id: "src/ship.ts#onClose", triggerEventId: "src/order.ts#close", actionCommandId: "src/ship.ts#ship", listener: SHIP_LOC },
    { id: "src/ship.ts#onShipped", triggerEventId: "src/ship.ts#shipped", actionCommandId: "src/ship.ts#ship", listener: SHIP_LOC },
  ],
  readModels: [{ id: "rm_orders", name: "OrdersPage", route: "/orders", componentFile: "src/pages/orders.tsx" }],
  actors: [
    { id: "Batch", name: "Batch" },
    { id: "Caller", name: "Caller" },
  ],
  diagnostics: { mode: "STATE_SIGNALS", entryFiles: [], parsedFileCount: 2, parseFailures: [], unattributedSignals: [] },
};

const LABELS2 = {
  src_order: "注文",
  src_ship: "出荷",
  "src/order.ts#close": "注文が締められた",
  "src/ship.ts#shipped": "出荷された",
  "src/order.ts#closeOrder": "注文を締める",
  "src/ship.ts#ship": "出荷する",
  "src/ship.ts#onClose": "締めたら出荷する",
  "src/ship.ts#onShipped": "出荷したら次を出荷する",
};

function levelRequest(
  format: SystemViewFormat,
  level: "CONTEXT_MAP" | "CONTEXT_DETAIL",
  extra: Partial<SystemProjectionRequest> = {},
): SystemProjectionRequest {
  return { format, viewRole: "BUSINESS", level, ...extra };
}

test("地図 1（JSON）: Bounded Context のノードと、またぐポリシーのつながりだけを出す（設計 8.9）", async () => {
  const glossary = await glossaryOf(MAP2, LABELS2);
  const view = await projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_JSON", "CONTEXT_MAP"));
  const value = JSON.parse(view.content) as JsonView;
  assert.deepEqual(value.nodes.map((node) => node.id), ["c1", "c2"]);
  assert.deepEqual(Object.keys(value.nodes[0]!), ["id", "kind", "label", "context", "intent", "broken"]);
  assert.deepEqual(value.edges, [
    { from: "c1", to: "c2", kind: "POLICY", policy: "n5", label: "ポリシー: 締めたら出荷する", broken: null },
  ]);
});

test("地図 1（Mermaid）: Bounded Context を箱にし、またぐポリシーを表示名の付いた矢印で描く", async () => {
  const glossary = await glossaryOf(MAP2, LABELS2);
  const view = await projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_MERMAID", "CONTEXT_MAP"));
  assert.equal(view.content, ['flowchart LR', '  c1["注文"]', '  c2["出荷"]', '  c1 -->|"ポリシー: 締めたら出荷する"| c2', ""].join("\n"));
});

test("地図 2（JSON）: 1 つの Bounded Context の中だけを出し、またぐポリシーは両側に出して印を付ける", async () => {
  const glossary = await glossaryOf(MAP2, LABELS2);
  const detail = async (contextId: string) =>
    JSON.parse((await projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_JSON", "CONTEXT_DETAIL", { contextId }))).content) as JsonView;

  const order = await detail("src_order");
  assert.deepEqual(order.nodes.map((node) => node.id), ["c1", "n1", "n3", "n5"]);
  assert.deepEqual(Object.keys(order.nodes[3]!), ["id", "kind", "label", "context", "crossing", "broken"]);
  assert.deepEqual(order.nodes[3]!.crossing, { from: "c1", to: "c2" });
  assert.ok(!("crossing" in order.nodes[1]!));
  // 両端がこの地図 2 にあるつながりだけ（n5 → n4 は出荷の側）
  assert.deepEqual(order.edges, [
    { from: "n3", to: "n1", kind: "EMITS", broken: null },
    { from: "n1", to: "n5", kind: "TRIGGERS", broken: null },
  ]);

  const ship = await detail("src_ship");
  assert.deepEqual(ship.nodes.map((node) => node.id), ["c2", "n2", "n4", "n5", "n6"]);
  assert.deepEqual(ship.nodes[3]!.crossing, { from: "c1", to: "c2" });
  assert.equal(ship.nodes[4]!.crossing, null);
  assert.deepEqual(ship.edges, [
    { from: "n4", to: "n2", kind: "EMITS", broken: null },
    { from: "n5", to: "n4", kind: "INVOKES", broken: null },
    { from: "n2", to: "n6", kind: "TRIGGERS", broken: null },
    { from: "n6", to: "n4", kind: "INVOKES", broken: null },
  ]);
});

test("地図 2（Mermaid）: subgraph 1 つにまとめ、またぐポリシーの文に「（c1 から c2 へまたぐ）」を足す", async () => {
  const glossary = await glossaryOf(MAP2, LABELS2);
  const view = await projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_MERMAID", "CONTEXT_DETAIL", { contextId: "src_ship" }));
  assert.ok(view.content.includes('subgraph c2["出荷"]'));
  assert.ok(!view.content.includes("subgraph c1"));
  assert.ok(view.content.includes('n5["ポリシー: 締めたら出荷する（c1 から c2 へまたぐ）"]'));
  assert.ok(view.content.includes('n6["ポリシー: 出荷したら次を出荷する"]'));
  assert.ok(view.content.includes("n5 -->|起動する| n4"));
  assert.ok(!view.content.includes("n1"));
  assert.ok(!view.content.includes("src_ship"));
});

test("地図 2: includeSupporting でアクター・リードモデル・アグリゲートを足し、実装の名前は BUSINESS に出さない", async () => {
  const glossary = await glossaryOf(MAP2, LABELS2);
  const json = JSON.parse(
    (await projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_JSON", "CONTEXT_DETAIL", { contextId: "src_order", includeSupporting: true }))).content,
  ) as JsonView;
  // Batch（n7）は出荷のコマンドだけを実行するので出さない
  assert.deepEqual(json.nodes.map((node) => node.id), ["c1", "n1", "n3", "n5", "n8", "n9", "n10"]);
  assert.deepEqual(json.nodes.slice(4).map((node) => node.kind), ["ACTOR", "READ_MODEL", "AGGREGATE"]);
  assert.deepEqual(json.nodes.slice(4).map((node) => node.label), ["アクター n8", "リードモデル n9", "アグリゲート n10"]);
  assert.equal(json.nodes[4]!.context, null);
  assert.equal(json.nodes[6]!.context, "注文");
  assert.deepEqual(json.edges.slice(2), [
    { from: "n8", to: "n3", kind: "EXECUTES", broken: null },
    { from: "n9", to: "n3", kind: "VIEWED_FROM", broken: null },
    { from: "n10", to: "n1", kind: "RAISES", broken: null },
  ]);
  for (const name of ["Caller", "OrdersPage", "rm_orders", "Order\""]) assert.ok(!JSON.stringify(json).includes(name), name);

  const mermaid = (
    await projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_MERMAID", "CONTEXT_DETAIL", { contextId: "src_order", includeSupporting: true }))
  ).content;
  // アグリゲートは subgraph の中、アクターとリードモデルは外
  const lines = mermaid.split("\n");
  const end = lines.indexOf("  end");
  assert.ok(lines.indexOf('    n10["アグリゲート n10"]') > 0 && lines.indexOf('    n10["アグリゲート n10"]') < end);
  assert.ok(lines.indexOf('  n8["アクター n8"]') > end);
  assert.ok(lines.indexOf('  n9["リードモデル n9"]') > end);
  assert.ok(mermaid.includes("n9 -->|この画面から操作する| n3"));

  // 既定では足さない
  const plain = JSON.parse(
    (await projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_JSON", "CONTEXT_DETAIL", { contextId: "src_order" }))).content,
  ) as JsonView;
  assert.deepEqual(plain.nodes.map((node) => node.id), ["c1", "n1", "n3", "n5"]);
});

test("地図 2: IMPLEMENTATION のときは、アクター・リードモデル・アグリゲートの implementation に全体マップの名前を置く", async () => {
  const glossary = await glossaryOf(MAP2, LABELS2);
  const json = JSON.parse(
    (
      await projectSystemMap(MAP2, glossary, null, {
        format: "SYSTEM_JSON",
        viewRole: "IMPLEMENTATION",
        level: "CONTEXT_DETAIL",
        contextId: "src_order",
        includeSupporting: true,
      })
    ).content,
  ) as JsonView;
  assert.deepEqual(json.nodes[4]!.implementation, { names: ["Caller"], locations: [] });
  assert.deepEqual(json.nodes[5]!.implementation, { names: ["OrdersPage"], locations: [] });
  assert.deepEqual(json.nodes[6]!.implementation, { names: ["Order"], locations: [] });
  assert.deepEqual(Object.keys(json.nodes[3]!), ["id", "kind", "label", "context", "crossing", "broken", "implementation"]);
});

test("俯瞰図: 番号は形と includeSupporting によらず同じ要素に同じ番号を振る", async () => {
  const glossary = await glossaryOf(MAP2, LABELS2);
  const labelsOf = async (request: SystemProjectionRequest) => {
    const value = JSON.parse((await projectSystemMap(MAP2, glossary, null, request)).content) as JsonView;
    return new Map(value.nodes.map((node) => [node.id, node.label] as const));
  };
  const whole = await labelsOf(request("SYSTEM_JSON"));
  const order = await labelsOf(levelRequest("SYSTEM_JSON", "CONTEXT_DETAIL", { contextId: "src_order", includeSupporting: true }));
  const ship = await labelsOf(levelRequest("SYSTEM_JSON", "CONTEXT_DETAIL", { contextId: "src_ship" }));
  for (const [id, label] of [...order, ...ship]) {
    if (whole.has(id)) assert.equal(label, whole.get(id), String(id));
  }
  assert.equal(whole.get("n5"), "ポリシー: 締めたら出荷する");
  assert.equal(order.get("n5"), "ポリシー: 締めたら出荷する");
  assert.equal(ship.get("n5"), "ポリシー: 締めたら出荷する");
});

test("俯瞰図: 階層の指定が正しくないときは UNSUPPORTED_FORMAT、地図 2 の Bounded Context が無いときは UNKNOWN_CONTEXT", async () => {
  const reason = (expected: string) => (error: unknown) => error instanceof ProjectionContractError && error.reason === expected;
  const glossary = await glossaryOf(MAP2, LABELS2);
  await assert.rejects(
    projectSystemMap(MAP2, glossary, null, { format: "SYSTEM_JSON", viewRole: "BUSINESS", level: "CONTEXT_ALL" } as unknown as SystemProjectionRequest),
    reason("UNSUPPORTED_FORMAT"),
  );
  await assert.rejects(
    projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_JSON", "CONTEXT_MAP", { includeSupporting: true })),
    reason("UNSUPPORTED_FORMAT"),
  );
  await assert.rejects(
    projectSystemMap(MAP2, glossary, null, { format: "SYSTEM_JSON", viewRole: "BUSINESS", includeSupporting: true }),
    reason("UNSUPPORTED_FORMAT"),
  );
  await assert.rejects(projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_JSON", "CONTEXT_DETAIL")), reason("UNKNOWN_CONTEXT"));
  await assert.rejects(
    projectSystemMap(MAP2, glossary, null, levelRequest("SYSTEM_MERMAID", "CONTEXT_DETAIL", { contextId: "src_none" })),
    reason("UNKNOWN_CONTEXT"),
  );
});