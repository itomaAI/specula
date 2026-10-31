// 全体地図のビューモデル（SpecViewer 基本設計 3.4・6.10）。
// 純粋な関数。checkRunOutputs を通った RunOutputs を受け取る（通っていない入力では例外を投げる）。
// 元は system_map.json（SpecProjector の俯瞰図の JSON を束ねたもの。全体設計 4.1）。ノードとつながりは型の上では
// Record<string, unknown> なので、使う欄の型を確かめてから読み、形が違えば全体地図だけを理由にする（画面全体は止めない）。
// 要素の文は JSON の label をそのまま使う。ポップアップの用語・意味は用語辞典のビューモデルを表示の id で引く（同じ文を 2 か所で作らない）。
// ビューモデルには地図の識別子（内部の識別子）を入れない（設計 4 節）。辞書の項目の id は、引くためだけに使う。

import { statusMark } from "../core/m5/labels.js";
import { EDGE_TEXT } from "../core/m5/render_system.js";
import { llmText } from "../core/m5/view_model.js";
import type { GlossaryLocation } from "../types/glossary.js";
import type { ViewRole } from "../types/projection.js";
import { buildGlossaryView, displayIdsOf } from "./glossary.js";
import { layoutLayers } from "./graph.js";
import { sourcesOf, valueOf } from "./commands.js";
import type {
  ContextDetailMapView,
  GlossaryEntryView,
  MapEdgeKind,
  MapEdgeView,
  MapGraphView,
  MapNodeKind,
  MapNodeView,
  MapPopupView,
  MapView,
  RunOutputs,
} from "./types.js";

const NO_SYSTEM_MAP = "全体地図を出せない: 俯瞰図が無い";
const BAD_SHAPE = "全体地図を出せない: 俯瞰図の形が違う";
const NO_GLOSSARY = "用語と意味を出せない: 辞書が無い";
const NO_IMPLEMENTATION_MAP = "用語と意味を引けない: 実装との対応表が無い";
const NO_ENTRY = "用語と意味を引けない: 辞書に項目が無い";
const NO_INTENT = "意図の候補が無い";
const CONTEXT_LOOKUP = "意図の候補と属するシナリオの数を引けない";
const COMMAND_LOOKUP = "起点のシナリオを引けない";
const NO_MAP_TABLE = "実装との対応表が無い";
const NO_MAP_ROW = "実装との対応表に行が無い";

const NODE_KINDS: ReadonlySet<string> = new Set<MapNodeKind>([
  "BOUNDED_CONTEXT",
  "EVENT",
  "COMMAND",
  "POLICY",
  "ACTOR",
  "READ_MODEL",
  "AGGREGATE",
]);
/** 辞書の項目を持つ種類（用語辞典に出る種類）。 */
const GLOSSARY_KINDS: ReadonlySet<MapNodeKind> = new Set<MapNodeKind>(["BOUNDED_CONTEXT", "EVENT", "COMMAND", "POLICY"]);
const CONTEXT_ID = /^c[1-9][0-9]*$/;
const ELEMENT_ID = /^n[1-9][0-9]*$/;

/** 俯瞰図の形が違う。message は場所と欄（表示の id と並びの位置だけで書く）。 */
class ShapeError extends Error {}

function fail(where: string, what: string): never {
  throw new ShapeError(`${where}: ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type Implementation = { names: string[]; locations: GlossaryLocation[] };

interface RawNode {
  id: string;
  kind: MapNodeKind;
  label: string;
  crossing: { from: string; to: string } | null;
  broken: boolean;
  implementation: Implementation | null;
}

interface RawEdge {
  from: string;
  to: string;
  kind: MapEdgeKind;
  text: string;
  policy: string | null;
  broken: boolean;
}

function readLocation(value: unknown, where: string): GlossaryLocation {
  if (!isRecord(value)) fail(where, "implementation の所在");
  const file = value["file"];
  const symbol = value["symbol"];
  const line = value["line"];
  if (typeof file !== "string") fail(where, "implementation の所在の file");
  if (symbol !== undefined && typeof symbol !== "string") fail(where, "implementation の所在の symbol");
  if (line !== undefined && typeof line !== "number") fail(where, "implementation の所在の line");
  const location: GlossaryLocation = { file };
  if (symbol !== undefined) location.symbol = symbol;
  if (line !== undefined) location.line = line;
  return location;
}

function readImplementation(value: unknown, where: string): Implementation {
  if (!isRecord(value)) fail(where, "implementation");
  const names = value["names"];
  const locations = value["locations"];
  if (!Array.isArray(names) || !names.every((name): name is string => typeof name === "string")) fail(where, "implementation の names");
  if (!Array.isArray(locations)) fail(where, "implementation の locations");
  return { names: [...names], locations: locations.map((location) => readLocation(location, where)) };
}

function readNode(value: unknown, where: string): RawNode {
  if (!isRecord(value)) fail(where, "ノードの形");
  const id = value["id"];
  const kind = value["kind"];
  const label = value["label"];
  const crossing = value["crossing"];
  if (typeof id !== "string" || !(CONTEXT_ID.test(id) || ELEMENT_ID.test(id))) fail(where, "id");
  if (typeof kind !== "string" || !NODE_KINDS.has(kind)) fail(where, "kind");
  // Bounded Context は c、ほかの要素は n で番号を振る（render_system.ts）。
  if ((kind === "BOUNDED_CONTEXT") !== CONTEXT_ID.test(id)) fail(where, "id と kind の組");
  if (typeof label !== "string") fail(where, "label");
  if (!("broken" in value)) fail(where, "broken");
  let crossingValue: { from: string; to: string } | null = null;
  if (crossing !== undefined && crossing !== null) {
    if (!isRecord(crossing)) fail(where, "crossing");
    const from = crossing["from"];
    const to = crossing["to"];
    if (typeof from !== "string" || !CONTEXT_ID.test(from) || typeof to !== "string" || !CONTEXT_ID.test(to)) fail(where, "crossing");
    crossingValue = { from, to };
  }
  return {
    id,
    kind: kind as MapNodeKind,
    label,
    crossing: crossingValue,
    broken: value["broken"] !== null,
    implementation: "implementation" in value ? readImplementation(value["implementation"], where) : null,
  };
}

/** level: 地図 1 は「またぐポリシー」のつながりだけ、地図 2 は俯瞰図のつながりの種類（EDGE_TEXT）だけ。 */
function readEdge(value: unknown, where: string, level: "CONTEXT_MAP" | "CONTEXT_DETAIL"): RawEdge {
  if (!isRecord(value)) fail(where, "つながりの形");
  const from = value["from"];
  const to = value["to"];
  const kind = value["kind"];
  if (typeof from !== "string" || typeof to !== "string") fail(where, "from・to");
  if (!("broken" in value)) fail(where, "broken");
  const broken = value["broken"] !== null;
  if (level === "CONTEXT_MAP") {
    const policy = value["policy"];
    const label = value["label"];
    if (kind !== "POLICY") fail(where, "kind");
    if (typeof policy !== "string" || !ELEMENT_ID.test(policy)) fail(where, "policy");
    if (typeof label !== "string") fail(where, "label");
    return { from, to, kind: "POLICY", text: label, policy, broken };
  }
  if (typeof kind !== "string" || !Object.hasOwn(EDGE_TEXT, kind)) fail(where, "kind");
  const edgeKind = kind as keyof typeof EDGE_TEXT;
  return { from, to, kind: edgeKind, text: EDGE_TEXT[edgeKind], policy: null, broken };
}

/** 「〈地図〉の N 番目の〈もの〉」。地図の名前が英数字で終わるとき（「地図 1」）は、「の」の前に空白を入れる。 */
function nth(where: string, position: number, what: string): string {
  return `${where}${/[0-9A-Za-z]$/.test(where) ? " " : ""}の ${position + 1} 番目の${what}`;
}

function readGraph(value: unknown, where: string, level: "CONTEXT_MAP" | "CONTEXT_DETAIL"): { nodes: RawNode[]; edges: RawEdge[] } {
  const nodes = isRecord(value) ? value["nodes"] : undefined;
  const edges = isRecord(value) ? value["edges"] : undefined;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) fail(where, "nodes・edges");
  return {
    nodes: nodes.map((node, index) => readNode(node, nth(where, index, "ノード"))),
    edges: edges.map((edge, index) => readEdge(edge, nth(where, index, "つながり"), level)),
  };
}

type PopupOf = (node: RawNode) => MapPopupView;

/** ノードとつながりを並びの位置に直し、layoutLayers で層に並べる（設計 6.9・6.10）。 */
function graphOf(nodes: readonly RawNode[], edges: readonly RawEdge[], where: string, viewRole: ViewRole, popupOf: PopupOf): MapGraphView {
  const index = new Map(nodes.map((node, position) => [node.id, position] as const));
  if (index.size !== nodes.length) fail(where, "ノードの id の重複");
  const edgeViews: MapEdgeView[] = edges.map((edge, position) => {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined) fail(nth(where, position, "つながり"), "地図に無いノードを指している");
    return { from, to, kind: edge.kind, text: edge.text, policy: edge.policy, broken: edge.broken };
  });
  const nodeViews: MapNodeView[] = nodes.map((node) => nodeView(node, viewRole, popupOf));
  return { nodes: nodeViews, edges: edgeViews, layout: layoutLayers(nodeViews.length, edgeViews) };
}

function nodeView(node: RawNode, viewRole: ViewRole, popupOf: PopupOf): MapNodeView {
  return {
    displayId: node.id,
    kind: node.kind,
    label: node.label,
    crossing: node.crossing,
    broken: node.broken,
    // JSON は出力を作ったときの役割で書かれているので、画面の役割が BUSINESS なら JSON にあっても持たない（設計 6.10）。
    implementation: viewRole === "IMPLEMENTATION" ? node.implementation : null,
    popup: popupOf(node),
  };
}

/** ポップアップを作る関数。用語辞典のビューモデルと、実装との対応表から引く表を 1 回だけ作る。 */
function popupFactory(outputs: RunOutputs, viewRole: ViewRole): PopupOf {
  const sources = sourcesOf(outputs);
  const glossaryView = buildGlossaryView(outputs, viewRole);
  // またぐポリシーは用語辞典の 2 つの区切りに出る。またぎは要素の crossing で持つので、ポップアップでは crossing を null にする。
  const entries = new Map<string, GlossaryEntryView>();
  for (const section of glossaryView.sections) {
    for (const entry of section.entries) {
      if (entry.displayId !== null && !entries.has(entry.displayId)) entries.set(entry.displayId, { ...entry, crossing: null });
    }
  }
  const displayIds = displayIdsOf(sources.implementationMap);
  const entryIdOf = new Map<string, string>();
  for (const [entryId, displayId] of displayIds ?? []) entryIdOf.set(displayId, entryId);
  // 起点の辞書の項目 → シナリオの表示の id（対応表の COMMAND_TARGET の行。設計 6.5）。
  const commandsOf = new Map<string, string[]>();
  for (const row of sources.implementationMap?.entries ?? []) {
    if (row.kind !== "COMMAND_TARGET" || row.glossaryEntryId === null) continue;
    commandsOf.set(row.glossaryEntryId, [...(commandsOf.get(row.glossaryEntryId) ?? []), row.displayId]);
  }

  return (node) => {
    const empty: MapPopupView = { entry: null, entryNote: null, intent: null, commandTargetCount: null, commands: null, lookupNote: null };
    // アクター・リードモデル・アグリゲートは辞書の項目を持たないので、JSON の文だけを出す（設計 6.10）。
    if (!GLOSSARY_KINDS.has(node.kind)) return empty;
    const entry = entries.get(node.id) ?? null;
    const entryNote = entry !== null ? null : sources.glossary === null ? NO_GLOSSARY : displayIds === null ? NO_IMPLEMENTATION_MAP : NO_ENTRY;
    const entryId = entryIdOf.get(node.id) ?? null;
    const missing = displayIds === null ? NO_MAP_TABLE : NO_MAP_ROW;
    if (node.kind === "BOUNDED_CONTEXT") {
      if (entryId === null) return { ...empty, entry, entryNote, lookupNote: `${CONTEXT_LOOKUP}: ${missing}` };
      const candidate = sources.intents?.contexts.find((item) => item.contextId === entryId);
      return {
        ...empty,
        entry,
        entryNote,
        intent: candidate === undefined ? NO_INTENT : `${llmText(candidate.intent)}${statusMark(candidate.intentStatus)}`,
        // 実行の報告の行の boundedContext は全体マップの識別子で、Bounded Context の辞書の項目の id と同じ（render_system.ts の entryOf）。
        commandTargetCount: sources.report.commands.filter((row) => row.boundedContext === entryId).length,
      };
    }
    if (node.kind === "COMMAND" || node.kind === "POLICY") {
      if (entryId === null) return { ...empty, entry, entryNote, lookupNote: `${COMMAND_LOOKUP}: ${missing}` };
      return { ...empty, entry, entryNote, commands: [...(commandsOf.get(entryId) ?? [])] };
    }
    return { ...empty, entry, entryNote };
  };
}

function readBundle(bundle: unknown, viewRole: ViewRole, popupOf: PopupOf): MapView {
  if (!isRecord(bundle)) fail("system_map.json", "形");
  const contextMap = readGraph(bundle["contextMap"], "地図 1", "CONTEXT_MAP");
  if (contextMap.nodes.some((node) => node.kind !== "BOUNDED_CONTEXT")) fail("地図 1", "Bounded Context でないノード");
  const detailsValue = bundle["details"];
  if (!Array.isArray(detailsValue)) fail("system_map.json", "details");

  const details: ContextDetailMapView[] = detailsValue.map((detail, index) => {
    const where = `地図 2 の ${index + 1} 番目`;
    if (!isRecord(detail)) fail(where, "形");
    const context = detail["context"];
    if (typeof context !== "string" || !CONTEXT_ID.test(context)) fail(where, "context");
    const graphs = {
      core: readGraph(detail["core"], `地図 2（${context}）`, "CONTEXT_DETAIL"),
      supporting: readGraph(detail["supporting"], `地図 2（${context}、足す要素あり）`, "CONTEXT_DETAIL"),
    };
    // 先頭のノードは箱の題にする Bounded Context。層には入れない（設計 6.10）。
    for (const [name, graph] of Object.entries(graphs)) {
      const title = graph.nodes[0];
      if (title === undefined || title.kind !== "BOUNDED_CONTEXT" || title.id !== context) fail(`${where}の ${name}`, "先頭のノード");
      if (graph.nodes.slice(1).some((node) => node.kind === "BOUNDED_CONTEXT")) fail(`${where}の ${name}`, "2 つ目の Bounded Context");
    }
    const title = graphs.core.nodes[0] as RawNode;
    return {
      context: nodeView(title, viewRole, popupOf),
      core: graphOf(graphs.core.nodes.slice(1), graphs.core.edges, `地図 2（${context}）`, viewRole, popupOf),
      supporting: graphOf(graphs.supporting.nodes.slice(1), graphs.supporting.edges, `地図 2（${context}、足す要素あり）`, viewRole, popupOf),
    };
  });
  // 地図 2 は全体マップの Bounded Context ごとに 1 つずつある（全体設計 4.1）。
  // 並びが地図 1 と違っても形の違いにはせず、地図 1 の並びに並べ替えて読む（Q12 で緩めた）。
  const byContext = new Map<string, ContextDetailMapView>();
  for (const detail of details) {
    const id = detail.context.displayId;
    if (byContext.has(id)) fail("地図 2", `${id} が 2 つある`);
    byContext.set(id, detail);
  }
  const ordered = contextMap.nodes.map((node) => {
    const detail = byContext.get(node.id);
    if (detail === undefined) fail("地図 2", `${node.id} が無い`);
    return detail;
  });
  if (byContext.size !== ordered.length) fail("地図 2", "地図 1 に無い Bounded Context");

  return {
    kind: "OK",
    startWithDetail: contextMap.nodes.length === 1,
    contextMap: graphOf(contextMap.nodes, contextMap.edges, "地図 1", viewRole, popupOf),
    details: ordered,
  };
}

/** 全体地図（設計 3.4・6.10）。俯瞰図が無いか形が違えば、理由だけを持つ。 */
export function buildMapView(outputs: RunOutputs, viewRole: ViewRole): MapView {
  // 事前条件を通っていない入力は、ここで例外になる（sourcesOf。設計 6.5 と同じ）。
  const popupOf = popupFactory(outputs, viewRole);
  const bundle = valueOf(outputs.systemMap);
  if (bundle === null) return { kind: "UNAVAILABLE", reason: NO_SYSTEM_MAP };
  try {
    return readBundle(bundle, viewRole, popupOf);
  } catch (error) {
    if (error instanceof ShapeError) return { kind: "UNAVAILABLE", reason: `${BAD_SHAPE}（${error.message}）` };
    throw error;
  }
}