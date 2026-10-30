// 全体の俯瞰図（SYSTEM_MERMAID・SYSTEM_JSON）を描く（SpecProjector の設計 4.4・8.9）。
//
// 形は 3 つある（設計 8.9）。
// - level を省いたとき: 今の 1 枚の図。Bounded Context ごとの subgraph に、イベント・コマンド・ポリシーとそのつながり。
// - CONTEXT_MAP（地図 1）: Bounded Context と、Bounded Context をまたぐポリシーのつながりだけ。
// - CONTEXT_DETAIL（地図 2）: 1 つの Bounded Context の中のイベント・コマンド・ポリシー。includeSupporting で
//   アクター・リードモデル・アグリゲートを足す。
//
// 番号は形と includeSupporting によらず全体マップの並びで振る（設計 8.8・8.9）。
// ノードは events → commands → policies → actors → readModels → アグリゲート（どれも id の辞書順。アグリゲートは
// Bounded Context の id と aggregate の組の順）に n1・n2 … と振る。Bounded Context は並び順に c1・c2 … と振る。
// 全体マップの id はハンドラの所在から作られていて実装の所在を含むので、どの形でも表示しない。
// ノードの文と subgraph の題は、辞書でその要素の項目を引いた term.label とする（設計 8.2）。
// 用語が未生成の要素は「<種類> nN（名前は未生成）」、Bounded Context は「Bounded Context cN（名前は未生成）」と書く（設計 7.6）。
// アクター・リードモデル・アグリゲートは辞書の用語を持たないので「<種類> nN」と書く（設計 8.9）。
// 辞書が同じ全体マップから作られたこと（GLOSSARY_STALE）と、地図 2 の Bounded Context があることは、
// 呼び出し元（spec_projector.ts）が確かめてある。
// つながり: コマンド → 発生させるイベント、先に起きるイベント → イベント（after）、イベント → 反応するポリシー、
// ポリシー → 起動するコマンド、アクター → 実行するコマンド、リードモデル → その画面から操作するコマンド、
// アグリゲート → 起こすイベント。全体マップに無い id を指すつながりは描かない。
// ポリシーの所属（設計 8.9。GlossaryBuilder の設計 5.1 と同じ規則）: 反応するイベントの Bounded Context。
// 起動するコマンドの Bounded Context が違えば「またいでいる」。
//
// 表示の役割（設計 8.3）:
// - PdM: 実装の名前と所在を出さない。JSON に implementation のキーを置かない。
// - Eng: Mermaid のノードの文の後ろに「 / ファイル#関数」を足し、JSON の各ノードに implementation を置く。
// 意図の候補（設計 4.4）: JSON の Bounded Context のノードだけに intent を置く（候補が無いか未生成なら null）。
// 壊れた印（設計 8.9）: JSON のノードとつながりに broken: null を置く。Mermaid には何も足さない。

import type { Glossary, GlossaryEntry, GlossaryLocation, PresentedEntryKind } from "../../types/glossary.js";
import type { IntentCatalog } from "../../types/intent.js";
import type { SystemMapLevel, ViewRole } from "../../types/projection.js";
import type { EventStormingMap } from "../../types/scenario.js";
import { joinLines, mermaidLabel } from "./escape.js";
import { mermaidImplementationNote } from "./implementation.js";

/** 描画の指定。spec_projector.ts が request を確かめてから作る。 */
export interface SystemRenderOptions {
  viewRole: ViewRole;
  /** null は今の 1 枚の図。 */
  level: SystemMapLevel | null;
  /** CONTEXT_DETAIL のときの Bounded Context（全体マップの id）。ほかの形では null。 */
  contextId: string | null;
  /** CONTEXT_DETAIL のときだけ true になりうる。 */
  includeSupporting: boolean;
}

type CoreKind = "EVENT" | "COMMAND" | "POLICY";
type SupportingKind = "ACTOR" | "READ_MODEL" | "AGGREGATE";
type NodeKind = CoreKind | SupportingKind;
type EdgeKind = "EMITS" | "AFTER" | "TRIGGERS" | "INVOKES" | "EXECUTES" | "VIEWED_FROM" | "RAISES";

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
  /** Bounded Context の表示名。ポリシー・アクター・リードモデルは null。 */
  context: string | null;
  /** 描画の中だけで使う（subgraph の振り分け）。出力には出さない。ポリシー・アクター・リードモデルは null。 */
  contextId: string | null;
  /** 地図 2 に出す Bounded Context（全体マップの id）。描画の中だけで使う。 */
  memberOf: Set<string>;
  /** ポリシーだけ: 反応するイベントの Bounded Context と、起動するコマンドの Bounded Context（全体マップの id）。 */
  policyFrom: string | null;
  policyTo: string | null;
  implementation: Implementation;
}

interface SystemEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

interface Graph {
  contexts: ContextNode[];
  nodes: SystemNode[];
  edges: SystemEdge[];
}

const CORE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["EVENT", "COMMAND", "POLICY"]);
const KIND_TEXT: Readonly<Record<NodeKind, string>> = {
  EVENT: "イベント",
  COMMAND: "コマンド",
  POLICY: "ポリシー",
  ACTOR: "アクター",
  READ_MODEL: "リードモデル",
  AGGREGATE: "アグリゲート",
};
const EDGE_TEXT: Readonly<Record<EdgeKind, string>> = {
  EMITS: "発生させる",
  AFTER: "このあとに起きる",
  TRIGGERS: "反応する",
  INVOKES: "起動する",
  EXECUTES: "実行する",
  VIEWED_FROM: "この画面から操作する",
  RAISES: "起こす",
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

/**
 * アクター・リードモデルの implementation。辞書に同じ id・同じ種類の項目があればそれを写し、
 * 無ければ全体マップの名前だけにする（所在は無し）。
 */
function supportingImplementation(
  entries: ReadonlyMap<string, GlossaryEntry>,
  kind: "ACTOR" | "READ_MODEL",
  mapId: string,
  name: string,
): Implementation {
  const entry = entries.get(mapId);
  if (entry !== undefined && entry.kind === kind) return implementationOf(entry);
  return { names: [name], locations: [] };
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

/** アグリゲート: Bounded Context と aggregate の組ごとに 1 つ。Bounded Context の id、aggregate の順に並べる。 */
function aggregatesOf(map: EventStormingMap): Array<{ key: string; contextId: string; name: string }> {
  const seen = new Map<string, { key: string; contextId: string; name: string }>();
  for (const event of map.events) {
    if (event.aggregate === undefined) continue;
    const key = JSON.stringify([event.contextId, event.aggregate]);
    if (!seen.has(key)) seen.set(key, { key, contextId: event.contextId, name: event.aggregate });
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...seen.values()].sort((a, b) => compare(a.contextId, b.contextId) || compare(a.name, b.name));
}

function buildGraph(map: EventStormingMap, glossary: Glossary, intents: IntentCatalog | null): Graph {
  const entries = new Map(glossary.entries.map((entry) => [entry.id, entry] as const));
  const contexts = contextNodes(map, entries, intents);
  const titles = new Map(contexts.map((context) => [context.mapId, context.label] as const));
  const nodeOf = new Map<string, SystemNode>();
  const nodes: SystemNode[] = [];
  const push = (key: string, node: Omit<SystemNode, "id" | "label">, name: (id: string) => string): SystemNode => {
    const id = `n${nodes.length + 1}`;
    const created: SystemNode = { ...node, id, label: name(id) };
    nodes.push(created);
    nodeOf.set(key, created);
    return created;
  };
  const addCore = (kind: CoreKind, mapId: string, contextId: string | null, policyFrom: string | null, policyTo: string | null): void => {
    const entry = entryOf(entries, kind, mapId);
    const context = contextId === null ? null : (titles.get(contextId) ?? null);
    const memberOf = new Set<string>();
    if (contextId !== null) memberOf.add(contextId);
    if (policyFrom !== null) memberOf.add(policyFrom);
    if (policyTo !== null) memberOf.add(policyTo);
    push(
      `${kind}:${mapId}`,
      { kind, context, contextId, memberOf, policyFrom, policyTo, implementation: implementationOf(entry) },
      (id) => `${KIND_TEXT[kind]}: ${labelOf(entry) ?? `${KIND_TEXT[kind]} ${id}（名前は未生成）`}`,
    );
  };

  const eventContext = new Map(map.events.map((event) => [event.id, event.contextId] as const));
  const commandContext = new Map(map.commands.map((command) => [command.id, command.contextId] as const));
  for (const event of map.events) addCore("EVENT", event.id, event.contextId, null, null);
  for (const command of map.commands) addCore("COMMAND", command.id, command.contextId, null, null);
  for (const policy of map.policies) {
    addCore(
      "POLICY",
      policy.id,
      null,
      eventContext.get(policy.triggerEventId) ?? null,
      commandContext.get(policy.actionCommandId) ?? null,
    );
  }

  // アクター・リードモデル・アグリゲート（設計 8.9）。includeSupporting によらず番号を振り、既存の番号を動かさない。
  const commandContextsOf = (match: (command: EventStormingMap["commands"][number]) => boolean): Set<string> =>
    new Set(map.commands.filter(match).map((command) => command.contextId));
  const plain = (kind: SupportingKind) => (id: string) => `${KIND_TEXT[kind]} ${id}`;
  for (const actor of map.actors) {
    push(
      `ACTOR:${actor.id}`,
      {
        kind: "ACTOR",
        context: null,
        contextId: null,
        memberOf: commandContextsOf((command) => command.actorId === actor.id),
        policyFrom: null,
        policyTo: null,
        implementation: supportingImplementation(entries, "ACTOR", actor.id, actor.name),
      },
      plain("ACTOR"),
    );
  }
  for (const readModel of map.readModels) {
    push(
      `READ_MODEL:${readModel.id}`,
      {
        kind: "READ_MODEL",
        context: null,
        contextId: null,
        memberOf: commandContextsOf((command) => command.readModelId === readModel.id),
        policyFrom: null,
        policyTo: null,
        implementation: supportingImplementation(entries, "READ_MODEL", readModel.id, readModel.name),
      },
      plain("READ_MODEL"),
    );
  }
  for (const aggregate of aggregatesOf(map)) {
    push(
      `AGGREGATE:${aggregate.key}`,
      {
        kind: "AGGREGATE",
        context: titles.get(aggregate.contextId) ?? null,
        contextId: aggregate.contextId,
        memberOf: new Set([aggregate.contextId]),
        policyFrom: null,
        policyTo: null,
        implementation: { names: [aggregate.name], locations: [] },
      },
      plain("AGGREGATE"),
    );
  }

  const edges: SystemEdge[] = [];
  const link = (fromKey: string, toKey: string, kind: EdgeKind): void => {
    const from = nodeOf.get(fromKey);
    const to = nodeOf.get(toKey);
    if (from !== undefined && to !== undefined) edges.push({ from: from.id, to: to.id, kind });
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
  for (const command of map.commands) link(`ACTOR:${command.actorId}`, `COMMAND:${command.id}`, "EXECUTES");
  for (const command of map.commands) {
    if (command.readModelId !== undefined) link(`READ_MODEL:${command.readModelId}`, `COMMAND:${command.id}`, "VIEWED_FROM");
  }
  for (const event of map.events) {
    if (event.aggregate !== undefined) {
      link(`AGGREGATE:${JSON.stringify([event.contextId, event.aggregate])}`, `EVENT:${event.id}`, "RAISES");
    }
  }
  return { contexts, nodes, edges };
}

/** ポリシーがまたいでいれば、その 2 つの Bounded Context のノード。またいでいなければ null。 */
function crossingOf(node: SystemNode, contexts: readonly ContextNode[]): { from: ContextNode; to: ContextNode } | null {
  if (node.kind !== "POLICY" || node.policyFrom === null || node.policyTo === null || node.policyFrom === node.policyTo) {
    return null;
  }
  const from = contexts.find((context) => context.mapId === node.policyFrom);
  const to = contexts.find((context) => context.mapId === node.policyTo);
  return from === undefined || to === undefined ? null : { from, to };
}

/** 地図 2 に出すノード（設計 8.9）。 */
function detailNodes(graph: Graph, contextId: string, includeSupporting: boolean): SystemNode[] {
  return graph.nodes.filter((node) => {
    if (!CORE_KINDS.has(node.kind) && !includeSupporting) return false;
    if (node.kind === "POLICY") return node.policyFrom === contextId || node.policyTo === contextId;
    return node.memberOf.has(contextId);
  });
}

/** 両端が shown にあるつながりだけ。 */
function edgesAmong(edges: readonly SystemEdge[], shown: readonly SystemNode[]): SystemEdge[] {
  const ids = new Set(shown.map((node) => node.id));
  return edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

/** 地図 2 のノードの文。またぐポリシーには「（cN から cM へまたぐ）」を足す。 */
function detailLabel(node: SystemNode, contexts: readonly ContextNode[]): string {
  const crossing = crossingOf(node, contexts);
  return crossing === null ? node.label : `${node.label}（${crossing.from.id} から ${crossing.to.id} へまたぐ）`;
}

/** Mermaid のつながりの文（`-->|"…"|`）。ノードの文と同じ置き換えをする。 */
function mermaidEdgeText(text: string): string {
  return mermaidLabel(text).slice(1, -1);
}

function contextOf(graph: Graph, contextId: string | null): ContextNode {
  const context = graph.contexts.find((candidate) => candidate.mapId === contextId);
  if (context === undefined) throw new Error(`俯瞰図: Bounded Context ${String(contextId)} が全体マップに無い`);
  return context;
}

export function renderSystemMermaid(
  map: EventStormingMap,
  glossary: Glossary,
  intents: IntentCatalog | null,
  options: SystemRenderOptions,
): string {
  const graph = buildGraph(map, glossary, intents);
  const note = (implementation: Implementation): string =>
    options.viewRole === "Eng" ? mermaidImplementationNote(implementation.locations) : "";
  const lines: string[] = ["flowchart LR"];

  if (options.level === "CONTEXT_MAP") {
    for (const context of graph.contexts) lines.push(`  ${context.id}${mermaidLabel(`${context.label}${note(context.implementation)}`)}`);
    for (const node of graph.nodes) {
      const crossing = crossingOf(node, graph.contexts);
      if (crossing !== null) lines.push(`  ${crossing.from.id} -->|${mermaidEdgeText(node.label)}| ${crossing.to.id}`);
    }
    return joinLines(lines);
  }

  if (options.level === "CONTEXT_DETAIL") {
    const context = contextOf(graph, options.contextId);
    const shown = detailNodes(graph, context.mapId, options.includeSupporting);
    const text = (node: SystemNode): string => `${detailLabel(node, graph.contexts)}${note(node.implementation)}`;
    const inside = shown.filter((node) => node.kind !== "ACTOR" && node.kind !== "READ_MODEL");
    lines.push(`  subgraph ${context.id}${mermaidLabel(context.label)}`);
    for (const node of inside) lines.push(`    ${node.id}${mermaidLabel(text(node))}`);
    lines.push("  end");
    for (const node of shown.filter((candidate) => !inside.includes(candidate))) lines.push(`  ${node.id}${mermaidLabel(text(node))}`);
    for (const edge of edgesAmong(graph.edges, shown)) lines.push(`  ${edge.from} -->|${EDGE_TEXT[edge.kind]}| ${edge.to}`);
    return joinLines(lines);
  }

  // level を省いたとき: 今の 1 枚の図（設計 4.4）。アクター・リードモデル・アグリゲートは出さない。
  const core = graph.nodes.filter((node) => CORE_KINDS.has(node.kind));
  const text = (node: SystemNode): string => `${node.label}${note(node.implementation)}`;
  for (const context of graph.contexts) {
    const members = core.filter((node) => node.contextId === context.mapId);
    if (members.length === 0) continue;
    lines.push(`  subgraph ${context.id}${mermaidLabel(context.label)}`);
    for (const node of members) lines.push(`    ${node.id}${mermaidLabel(text(node))}`);
    lines.push("  end");
  }
  const known = new Set(graph.contexts.map((context) => context.mapId));
  for (const node of core.filter((candidate) => candidate.contextId === null || !known.has(candidate.contextId))) {
    lines.push(`  ${node.id}${mermaidLabel(text(node))}`);
  }
  for (const edge of edgesAmong(graph.edges, core)) lines.push(`  ${edge.from} -->|${EDGE_TEXT[edge.kind]}| ${edge.to}`);
  return joinLines(lines);
}

export function renderSystemJson(
  map: EventStormingMap,
  glossary: Glossary,
  intents: IntentCatalog | null,
  options: SystemRenderOptions,
): string {
  const graph = buildGraph(map, glossary, intents);
  // キーの並びは id・kind・label・context・intent・crossing・broken・implementation に固定する（設計 4.4・8.9）。
  // intent は Bounded Context のノードだけ、crossing は地図 2 のポリシーだけ、implementation は Eng のときだけ置く。
  const withImplementation = <T extends object>(value: T, implementation: Implementation): T | (T & { implementation: Implementation }) =>
    options.viewRole === "Eng" ? { ...value, implementation } : value;
  const contextValue = (context: ContextNode) =>
    withImplementation(
      { id: context.id, kind: "BOUNDED_CONTEXT", label: context.label, context: null, intent: context.intent, broken: null },
      context.implementation,
    );
  const nodeValue = (node: SystemNode) =>
    withImplementation({ id: node.id, kind: node.kind, label: node.label, context: node.context, broken: null }, node.implementation);
  const edgeValue = (edge: SystemEdge) => ({ from: edge.from, to: edge.to, kind: edge.kind, broken: null });

  let value: { nodes: object[]; edges: object[] };
  if (options.level === "CONTEXT_MAP") {
    const edges: object[] = [];
    for (const node of graph.nodes) {
      const crossing = crossingOf(node, graph.contexts);
      if (crossing !== null) {
        edges.push({ from: crossing.from.id, to: crossing.to.id, kind: "POLICY", policy: node.id, label: node.label, broken: null });
      }
    }
    value = { nodes: graph.contexts.map(contextValue), edges };
  } else if (options.level === "CONTEXT_DETAIL") {
    const context = contextOf(graph, options.contextId);
    const shown = detailNodes(graph, context.mapId, options.includeSupporting);
    const detailValue = (node: SystemNode) => {
      if (node.kind !== "POLICY") return nodeValue(node);
      const crossing = crossingOf(node, graph.contexts);
      return withImplementation(
        {
          id: node.id,
          kind: node.kind,
          label: node.label,
          context: node.context,
          crossing: crossing === null ? null : { from: crossing.from.id, to: crossing.to.id },
          broken: null,
        },
        node.implementation,
      );
    };
    value = { nodes: [contextValue(context), ...shown.map(detailValue)], edges: edgesAmong(graph.edges, shown).map(edgeValue) };
  } else {
    // level を省いたとき: 今の 1 枚の図（設計 4.4）。
    const core = graph.nodes.filter((node) => CORE_KINDS.has(node.kind));
    value = { nodes: [...graph.contexts.map(contextValue), ...core.map(nodeValue)], edges: edgesAmong(graph.edges, core).map(edgeValue) };
  }
  return joinLines([JSON.stringify(value, null, 2)]);
}