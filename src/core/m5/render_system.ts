// 全体の俯瞰図（SYSTEM_MERMAID・SYSTEM_JSON）を描く（SpecProjector の設計 4.4）。
//
// ノードは全体マップの並び（events → commands → policies。どれも id の辞書順で渡される）に n1・n2 … と振る。
// 全体マップの id はハンドラの所在から作られていて実装の所在を含むので、どちらの形式でも表示しない。
// ノードの文と subgraph の題は、辞書でその要素の項目を引いた term.label とする（設計 8.2）。
// 用語が未生成の要素は「<種類> nN（名前は未生成）」、Bounded Context は「Bounded Context cN（名前は未生成）」と書く（設計 7.6）。
// 辞書が同じ全体マップから作られたこと（GLOSSARY_STALE）は、呼び出し元（spec_projector.ts）が確かめてある。
// つながり: コマンド → 発生させるイベント、先に起きるイベント → イベント（after）、イベント → 反応するポリシー、ポリシー → 起動するコマンド。
// 全体マップに無い id を指すつながりは描かない。

import type { Glossary, GlossaryEntry, PresentedEntryKind } from "../../types/glossary.js";
import type { EventStormingMap } from "../../types/scenario.js";
import { joinLines, mermaidLabel } from "./escape.js";

type NodeKind = "EVENT" | "COMMAND" | "POLICY";
type EdgeKind = "EMITS" | "AFTER" | "TRIGGERS" | "INVOKES";

interface SystemNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Bounded Context の表示名。ポリシーは null。 */
  context: string | null;
  /** 描画の中だけで使う（subgraph の振り分け）。出力には出さない。 */
  contextId: string | null;
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

/** 辞書の提示する項目の表示名。用語が未生成なら null。項目が無いか種類が違えば、辞書と地図の食い違いなので止める。 */
function labelOf(entries: ReadonlyMap<string, GlossaryEntry>, kind: PresentedEntryKind, mapId: string): string | null {
  const entry = entries.get(mapId);
  if (entry === undefined || entry.kind !== kind || entry.term === undefined) {
    throw new Error(`俯瞰図: 辞書に ${kind} の項目 ${mapId} が無い（辞書と全体マップが食い違っている）`);
  }
  return entry.term.status === "GENERATED" ? entry.term.label : null;
}

function contextTitles(map: EventStormingMap, entries: ReadonlyMap<string, GlossaryEntry>): Map<string, string> {
  return new Map(
    map.boundedContexts.map((context, index) => {
      const label = labelOf(entries, "BOUNDED_CONTEXT", context.id);
      return [context.id, label ?? `Bounded Context c${index + 1}（名前は未生成）`] as const;
    }),
  );
}

function buildGraph(map: EventStormingMap, glossary: Glossary): { nodes: SystemNode[]; edges: SystemEdge[]; titles: Map<string, string> } {
  const entries = new Map(glossary.entries.map((entry) => [entry.id, entry] as const));
  const titles = contextTitles(map, entries);
  const nodeOf = new Map<string, string>();
  const nodes: SystemNode[] = [];
  const add = (kind: NodeKind, mapId: string, contextId: string | null): void => {
    const id = `n${nodes.length + 1}`;
    nodeOf.set(`${kind}:${mapId}`, id);
    const context = contextId === null ? null : (titles.get(contextId) ?? null);
    const name = labelOf(entries, kind, mapId) ?? `${KIND_TEXT[kind]} ${id}（名前は未生成）`;
    nodes.push({ id, kind, label: `${KIND_TEXT[kind]}: ${name}`, context, contextId });
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
  return { nodes, edges, titles };
}

export function renderSystemMermaid(map: EventStormingMap, glossary: Glossary): string {
  const { nodes, edges, titles } = buildGraph(map, glossary);
  const lines: string[] = ["flowchart LR"];

  const known = new Set(map.boundedContexts.map((context) => context.id));
  map.boundedContexts.forEach((context, index) => {
    const members = nodes.filter((node) => node.contextId === context.id);
    if (members.length === 0) return;
    lines.push(`  subgraph c${index + 1}${mermaidLabel(titles.get(context.id) ?? "")}`);
    for (const node of members) lines.push(`    ${node.id}${mermaidLabel(node.label)}`);
    lines.push("  end");
  });
  for (const node of nodes.filter((candidate) => candidate.contextId === null || !known.has(candidate.contextId))) {
    lines.push(`  ${node.id}${mermaidLabel(node.label)}`);
  }
  for (const edge of edges) lines.push(`  ${edge.from} -->|${EDGE_TEXT[edge.kind]}| ${edge.to}`);
  return joinLines(lines);
}

export function renderSystemJson(map: EventStormingMap, glossary: Glossary): string {
  const { nodes, edges } = buildGraph(map, glossary);
  const value = {
    nodes: nodes.map((node) => ({ id: node.id, kind: node.kind, label: node.label, context: node.context })),
    edges: edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
  };
  return joinLines([JSON.stringify(value, null, 2)]);
}