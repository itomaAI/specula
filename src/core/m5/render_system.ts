// 全体の俯瞰図（SYSTEM_MERMAID・SYSTEM_JSON）を描く（SpecProjector の設計 4.4）。
//
// ノードは全体マップの並び（events → commands → policies。どれも id の辞書順で渡される）に n1・n2 … と振る。
// Bounded Context は並び順に c1・c2 … と振る（Mermaid では subgraph、JSON では BOUNDED_CONTEXT のノード）。
// 全体マップの id はハンドラの所在から作られていて実装の所在を含むので、どちらの形式でも表示しない。
// ノードの文と subgraph の題は、辞書でその要素の項目を引いた term.label とする（設計 8.2）。
// 用語が未生成の要素は「<種類> nN（名前は未生成）」、Bounded Context は「Bounded Context cN（名前は未生成）」と書く（設計 7.6）。
// 辞書が同じ全体マップから作られたこと（GLOSSARY_STALE）は、呼び出し元（spec_projector.ts）が確かめてある。
// つながり: コマンド → 発生させるイベント、先に起きるイベント → イベント（after）、イベント → 反応するポリシー、ポリシー → 起動するコマンド。
// 全体マップに無い id を指すつながりは描かない。
//
// 表示の役割（設計 8.3）:
// - PdM: 実装の名前と所在を出さない。JSON に implementation のキーを置かない。
// - Eng: Mermaid のノードの文の後ろに「 / ファイル#関数」を足し、JSON の各ノードに implementation を置く。
// 意図の候補（設計 4.4）: JSON の Bounded Context のノードだけに intent を置く（候補が無いか未生成なら null）。

import type { Glossary, GlossaryEntry, GlossaryLocation, PresentedEntryKind } from "../../types/glossary.js";
import type { IntentCatalog } from "../../types/intent.js";
import type { ViewRole } from "../../types/projection.js";
import type { EventStormingMap } from "../../types/scenario.js";
import { joinLines, mermaidLabel } from "./escape.js";
import { mermaidImplementationNote } from "./implementation.js";

type NodeKind = "EVENT" | "COMMAND" | "POLICY";
type EdgeKind = "EMITS" | "AFTER" | "TRIGGERS" | "INVOKES";

interface Implementation {
  names: string[];
  locations: GlossaryLocation[];
}

interface ContextNode {
  /** "c1" … */
  id: string;
  /** 全体マップの id。描画の中だけで使う。出力には出さない。 */
  mapId: string;
  label: string;
  intent: string | null;
  implementation: Implementation;
}

interface SystemNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Bounded Context の表示名。ポリシーは null。 */
  context: string | null;
  /** 描画の中だけで使う（subgraph の振り分け）。出力には出さない。 */
  contextId: string | null;
  implementation: Implementation;
}

interface SystemEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

const KIND_TEXT: Readonly<Record<NodeKind, string>> = { EVENT: "イベント", COMMAND: "コマンド", POLICY: "ポリシー" };
const EDGE_TEXT: Readonly<Record<EdgeKind, string>> = {
  EMITS: "発生させる",
  AFTER: "このあとに起きる",
  TRIGGERS: "反応する",
  INVOKES: "起動する",
};

/** 辞書の提示する項目。項目が無いか種類が違えば、辞書と地図の食い違いなので止める。 */
function entryOf(entries: ReadonlyMap<string, GlossaryEntry>, kind: PresentedEntryKind, mapId: string): GlossaryEntry {
  const entry = entries.get(mapId);
  if (entry === undefined || entry.kind !== kind || entry.term === undefined) {
    throw new Error(`俯瞰図: 辞書に ${kind} の項目 ${mapId} が無い（辞書と全体マップが食い違っている）`);
  }
  return entry;
}

/** 用語の表示名。未生成なら null。 */
function labelOf(entry: GlossaryEntry): string | null {
  return entry.term !== undefined && entry.term.status === "GENERATED" ? entry.term.label : null;
}

/** 辞書の implementation を写す（呼び出し元の配列を共有しない）。 */
function implementationOf(entry: GlossaryEntry): Implementation {
  return {
    names: [...entry.implementation.names],
    locations: entry.implementation.locations.map((location) => ({ ...location })),
  };
}

function contextNodes(
  map: EventStormingMap,
  entries: ReadonlyMap<string, GlossaryEntry>,
  intents: IntentCatalog | null,
): ContextNode[] {
  return map.boundedContexts.map((context, index) => {
    const entry = entryOf(entries, "BOUNDED_CONTEXT", context.id);
    const id = `c${index + 1}`;
    const candidate = intents?.contexts.find((item) => item.contextId === context.id);
    const intent = candidate !== undefined && candidate.intent.status === "GENERATED" ? candidate.intent.text : null;
    return {
      id,
      mapId: context.id,
      label: labelOf(entry) ?? `Bounded Context ${id}（名前は未生成）`,
      intent,
      implementation: implementationOf(entry),
    };
  });
}

function buildGraph(
  map: EventStormingMap,
  glossary: Glossary,
  intents: IntentCatalog | null,
): { contexts: ContextNode[]; nodes: SystemNode[]; edges: SystemEdge[] } {
  const entries = new Map(glossary.entries.map((entry) => [entry.id, entry] as const));
  const contexts = contextNodes(map, entries, intents);
  const titles = new Map(contexts.map((context) => [context.mapId, context.label] as const));
  const nodeOf = new Map<string, string>();
  const nodes: SystemNode[] = [];
  const add = (kind: NodeKind, mapId: string, contextId: string | null): void => {
    const id = `n${nodes.length + 1}`;
    nodeOf.set(`${kind}:${mapId}`, id);
    const entry = entryOf(entries, kind, mapId);
    const context = contextId === null ? null : (titles.get(contextId) ?? null);
    const name = labelOf(entry) ?? `${KIND_TEXT[kind]} ${id}（名前は未生成）`;
    nodes.push({ id, kind, label: `${KIND_TEXT[kind]}: ${name}`, context, contextId, implementation: implementationOf(entry) });
  };
  for (const event of map.events) add("EVENT", event.id, event.contextId);
  for (const command of map.commands) add("COMMAND", command.id, command.contextId);
  for (const policy of map.policies) add("POLICY", policy.id, null);

  const edges: SystemEdge[] = [];
  const link = (fromKey: string, toKey: string, kind: EdgeKind): void => {
    const from = nodeOf.get(fromKey);
    const to = nodeOf.get(toKey);
    if (from !== undefined && to !== undefined) edges.push({ from, to, kind });
  };
  for (const command of map.commands) {
    for (const eventId of command.eventIds) link(`COMMAND:${command.id}`, `EVENT:${eventId}`, "EMITS");
  }
  for (const event of map.events) {
    for (const before of event.after) link(`EVENT:${before}`, `EVENT:${event.id}`, "AFTER");
  }
  for (const policy of map.policies) {
    link(`EVENT:${policy.triggerEventId}`, `POLICY:${policy.id}`, "TRIGGERS");
    link(`POLICY:${policy.id}`, `COMMAND:${policy.actionCommandId}`, "INVOKES");
  }
  return { contexts, nodes, edges };
}

export function renderSystemMermaid(
  map: EventStormingMap,
  glossary: Glossary,
  intents: IntentCatalog | null,
  viewRole: ViewRole,
): string {
  const { contexts, nodes, edges } = buildGraph(map, glossary, intents);
  const text = (node: SystemNode): string =>
    viewRole === "Eng" ? `${node.label}${mermaidImplementationNote(node.implementation.locations)}` : node.label;
  const lines: string[] = ["flowchart LR"];

  for (const context of contexts) {
    const members = nodes.filter((node) => node.contextId === context.mapId);
    if (members.length === 0) continue;
    lines.push(`  subgraph ${context.id}${mermaidLabel(context.label)}`);
    for (const node of members) lines.push(`    ${node.id}${mermaidLabel(text(node))}`);
    lines.push("  end");
  }
  const known = new Set(contexts.map((context) => context.mapId));
  for (const node of nodes.filter((candidate) => candidate.contextId === null || !known.has(candidate.contextId))) {
    lines.push(`  ${node.id}${mermaidLabel(text(node))}`);
  }
  for (const edge of edges) lines.push(`  ${edge.from} -->|${EDGE_TEXT[edge.kind]}| ${edge.to}`);
  return joinLines(lines);
}

export function renderSystemJson(
  map: EventStormingMap,
  glossary: Glossary,
  intents: IntentCatalog | null,
  viewRole: ViewRole,
): string {
  const { contexts, nodes, edges } = buildGraph(map, glossary, intents);
  // キーの並びは id・kind・label・context・intent・implementation に固定する（設計 4.4）。
  // intent は Bounded Context のノードだけ、implementation は Eng のときだけ置く。
  const withImplementation = <T extends object>(value: T, implementation: Implementation): T | (T & { implementation: Implementation }) =>
    viewRole === "Eng" ? { ...value, implementation } : value;
  const value = {
    nodes: [
      ...contexts.map((context) =>
        withImplementation(
          { id: context.id, kind: "BOUNDED_CONTEXT", label: context.label, context: null, intent: context.intent },
          context.implementation,
        ),
      ),
      ...nodes.map((node) =>
        withImplementation({ id: node.id, kind: node.kind, label: node.label, context: node.context }, node.implementation),
      ),
    ],
    edges: edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
  };
  return joinLines([JSON.stringify(value, null, 2)]);
}