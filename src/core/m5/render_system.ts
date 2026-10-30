// 全体の俯瞰図（SYSTEM_MERMAID・SYSTEM_JSON）を描く（M5 の設計 4.4）。
//
// ノードは全体マップの並び（events → commands → policies。どれも id の辞書順で渡される）に n1・n2 … と振る。
// 全体マップの id はハンドラの所在から作られていて実装の所在を含むので、どちらの形式でも表示しない。
// 名前が未生成の要素は「<種類>（名前は未生成）」と書く（設計 4.4 の「識別子のまま」は、上の理由で種類と番号に置き換えた）。
// つながり: コマンド → 発生させるイベント、先に起きるイベント → イベント（after）、イベント → 反応するポリシー、ポリシー → 起動するコマンド。
// 全体マップに無い id を指すつながりは描かない。

import type { LlmText } from "../../types/index.js";
import type { EventStormingMap } from "../../types/scenario.js";
import { joinLines, mermaidLabel } from "./escape.js";

type NodeKind = "EVENT" | "COMMAND" | "POLICY";
type EdgeKind = "EMITS" | "AFTER" | "TRIGGERS" | "INVOKES";

interface SystemNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Bounded Context の名前。ポリシーは null。 */
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

function nameOf(kind: NodeKind, name: LlmText, n: string): string {
  if (name.status === "GENERATED") return name.text;
  return `${KIND_TEXT[kind]} ${n}（名前は未生成）`;
}

function buildGraph(map: EventStormingMap): { nodes: SystemNode[]; edges: SystemEdge[] } {
  const contextName = new Map(map.boundedContexts.map((context) => [context.id, context.name]));
  const nodeOf = new Map<string, string>();
  const nodes: SystemNode[] = [];
  const add = (kind: NodeKind, mapId: string, name: LlmText, contextId: string | null): void => {
    const id = `n${nodes.length + 1}`;
    nodeOf.set(`${kind}:${mapId}`, id);
    const context = contextId === null ? null : (contextName.get(contextId) ?? null);
    nodes.push({ id, kind, label: `${KIND_TEXT[kind]}: ${nameOf(kind, name, id)}`, context, contextId });
  };
  for (const event of map.events) add("EVENT", event.id, event.name, event.contextId);
  for (const command of map.commands) add("COMMAND", command.id, command.name, command.contextId);
  for (const policy of map.policies) add("POLICY", policy.id, policy.name, null);

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
  return { nodes, edges };
}

export function renderSystemMermaid(map: EventStormingMap): string {
  const { nodes, edges } = buildGraph(map);
  const lines: string[] = ["flowchart LR"];

  const known = new Set(map.boundedContexts.map((context) => context.id));
  map.boundedContexts.forEach((context, index) => {
    const members = nodes.filter((node) => node.contextId === context.id);
    if (members.length === 0) return;
    lines.push(`  subgraph c${index + 1}${mermaidLabel(context.name)}`);
    for (const node of members) lines.push(`    ${node.id}${mermaidLabel(node.label)}`);
    lines.push("  end");
  });
  for (const node of nodes.filter((candidate) => candidate.contextId === null || !known.has(candidate.contextId))) {
    lines.push(`  ${node.id}${mermaidLabel(node.label)}`);
  }
  for (const edge of edges) lines.push(`  ${edge.from} -->|${EDGE_TEXT[edge.kind]}| ${edge.to}`);
  return joinLines(lines);
}

export function renderSystemJson(map: EventStormingMap): string {
  const { nodes, edges } = buildGraph(map);
  const value = {
    nodes: nodes.map((node) => ({ id: node.id, kind: node.kind, label: node.label, context: node.context })),
    edges: edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
  };
  return joinLines([JSON.stringify(value, null, 2)]);
}