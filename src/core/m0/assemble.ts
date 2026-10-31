// Stage 2 の後半と Stage 3: EventStormingAssembler（M0 の設計 3.2 の 2・3、3.3）。
// 検出したシグナルからイベント・コマンド・ポリシー・リードモデル・アクターを組む。LLM を使わない
// （名前は GlossaryBuilder、意図の候補は IntentSynthesizer が作る）。
//
// 決めたこと（初回）:
// - イベント: 1 つのハンドラの中のシグナルを (種類, 呼んでいる関数, 最初の文字列の引数) で分け、分けた 1 組が 1 イベント。
//   識別子は EVT-<ファイル>#<関数>。1 つのハンドラに 2 組以上あるときは、最初に現れた行の順に -1, -2 … を付ける。
// - コマンド: シグナルを含むハンドラ 1 つが 1 コマンド。識別子は CMD-<ファイル>#<関数>。
// - アクター: ハンドラの中の role の比較（x.role === "admin" など）の文字列。複数あれば最初に現れたもの。
//   見つからなければ Caller。
// - リードモデル: Next.js の app/**/page.* と pages/**.*（_app・_document・api/ を除く）。ルートはパスから決める。
//   画面のファイルがハンドラのファイルそのものか、画面のファイルがハンドラを import しているときだけ、コマンドに付ける。
//   画面が複数あれば識別子の辞書順で最初のもの。
// - ポリシー: リスナーの登録で、名前が EVENT_EMIT の最初の文字列と一致し、渡された関数がコマンドのハンドラであるもの。
//   ポリシーが起動するコマンドのイベントの after に、きっかけのイベントを入れる。それ以外の after は空。
// - アグリゲートは初回は付けない。

import type {
  Actor,
  BoundedContext,
  Command,
  DomainEvent,
  EventStormingMap,
  Policy,
  ReadModel,
  SourceLocation,
} from "../../types/command.js";
import {
  type ParsedFile,
  identifierName,
  importsOf,
  isAstNode,
  stringValue,
  topLevelFunctions,
  walk,
} from "./ast.js";
import type { BoundaryResult } from "./boundary.js";
import { compareIds } from "./boundary.js";
import { type Listener, type ModuleResolver, type Signal, findExportedFunction } from "./signals.js";

export const CALLER_ACTOR_ID = "ACT-Caller";

export interface AssembleInput {
  files: readonly ParsedFile[];
  /** コードのファイルのパス（リードモデルを探すのに使う）。 */
  codePaths: readonly string[];
  boundaries: BoundaryResult;
  signals: readonly Signal[];
  listeners: readonly Listener[];
  screenshots: readonly string[];
  resolver: ModuleResolver;
}

const locationKey = (location: { file: string; symbol: string }): string => `${location.file}#${location.symbol}`;

interface EventDraft {
  id: string;
  handler: SourceLocation;
  signal: Signal;
}

/** 経過（diagnostics）は呼び出し元（command_extractor.ts）が足す。 */
export function assembleMap(input: AssembleInput): Omit<EventStormingMap, "diagnostics"> {
  const byPath = new Map(input.files.map((file) => [file.path, file] as const));

  // ---- イベント（ハンドラごとに、シグナルの組を分ける）----
  const signalsByHandler = new Map<string, Signal[]>();
  for (const signal of input.signals) {
    const key = locationKey(signal.handler);
    const list = signalsByHandler.get(key) ?? [];
    list.push(signal);
    signalsByHandler.set(key, list);
  }
  const eventDrafts: EventDraft[] = [];
  const eventIdsByHandler = new Map<string, string[]>();
  for (const handlerKey of [...signalsByHandler.keys()].sort(compareIds)) {
    const signals = [...(signalsByHandler.get(handlerKey) ?? [])].sort((a, b) => a.line - b.line);
    const groups: Signal[] = [];
    const seen = new Set<string>();
    for (const signal of signals) {
      const groupKey = JSON.stringify([signal.kind, signal.callee, signal.label]);
      if (seen.has(groupKey)) continue;
      seen.add(groupKey);
      groups.push(signal);
    }
    const ids = groups.map((_, index) => (groups.length === 1 ? `EVT-${handlerKey}` : `EVT-${handlerKey}-${index + 1}`));
    groups.forEach((signal, index) => {
      eventDrafts.push({ id: ids[index] ?? `EVT-${handlerKey}`, handler: signal.handler, signal });
    });
    eventIdsByHandler.set(handlerKey, ids);
  }

  // ---- リードモデル ----
  const readModels = findReadModels(input.codePaths, input.screenshots);

  // ---- アクターとコマンドの骨組み ----
  const actors = new Map<string, Actor>();
  const commandDrafts: Array<{ id: string; handler: SourceLocation; actorId: string; readModelId?: string; eventIds: string[] }> = [];
  for (const handlerKey of [...eventIdsByHandler.keys()].sort(compareIds)) {
    const first = signalsByHandler.get(handlerKey)?.[0];
    if (first === undefined) continue;
    const handler = first.handler;
    const role = roleOf(byPath.get(handler.file), handler.symbol);
    const actor: Actor = role === null ? { id: CALLER_ACTOR_ID, name: "Caller" } : { id: `ACT-${role}`, name: role };
    actors.set(actor.id, actor);
    const readModel = readModels.find((model) => screenUsesHandler(model, handler, byPath, input.resolver));
    commandDrafts.push({
      id: `CMD-${handlerKey}`,
      handler,
      actorId: actor.id,
      ...(readModel === undefined ? {} : { readModelId: readModel.id }),
      eventIds: eventIdsByHandler.get(handlerKey) ?? [],
    });
  }

  // ---- ポリシー ----
  const commandByHandler = new Map(commandDrafts.map((command) => [locationKey(command.handler), command] as const));
  const policyDrafts: Array<{ id: string; triggerEventId: string; actionCommandId: string; listener: Listener }> = [];
  const afterByEvent = new Map<string, Set<string>>();
  for (const listener of input.listeners) {
    const command = commandByHandler.get(locationKey(listener.target));
    if (command === undefined) continue;
    const triggers = eventDrafts.filter(
      (event) => event.signal.kind === "EVENT_EMIT" && event.signal.label === listener.eventName,
    );
    const base = `POL-${listener.location.file}#${listener.location.symbol}@${listener.location.line}`;
    for (const trigger of triggers) {
      policyDrafts.push({
        id: triggers.length === 1 ? base : `${base}-${trigger.id}`,
        triggerEventId: trigger.id,
        actionCommandId: command.id,
        listener,
      });
      for (const eventId of command.eventIds) {
        const after = afterByEvent.get(eventId) ?? new Set<string>();
        after.add(trigger.id);
        afterByEvent.set(eventId, after);
      }
    }
  }

  // ---- 組み立て ----
  const contexts: BoundedContext[] = input.boundaries.contexts.map((boundary) => ({ ...boundary }));

  const events: DomainEvent[] = [];
  for (const draft of eventDrafts) {
    events.push({
      id: draft.id,
      contextId: input.boundaries.contextOf(draft.handler.file),
      handler: draft.handler,
      signal: {
        kind: draft.signal.kind,
        callee: draft.signal.callee,
        label: draft.signal.label,
        line: draft.signal.line,
      },
      after: [...(afterByEvent.get(draft.id) ?? [])].sort(compareIds),
    });
  }

  const commands: Command[] = [];
  for (const draft of commandDrafts) {
    commands.push({
      id: draft.id,
      contextId: input.boundaries.contextOf(draft.handler.file),
      actorId: draft.actorId,
      ...(draft.readModelId === undefined ? {} : { readModelId: draft.readModelId }),
      eventIds: draft.eventIds,
      handler: draft.handler,
    });
  }

  const policies: Policy[] = [];
  for (const draft of policyDrafts.sort((a, b) => compareIds(a.id, b.id))) {
    policies.push({
      id: draft.id,
      triggerEventId: draft.triggerEventId,
      actionCommandId: draft.actionCommandId,
      listener: draft.listener.location,
    });
  }

  return {
    boundedContexts: contexts.sort((a, b) => compareIds(a.id, b.id)),
    events: events.sort((a, b) => compareIds(a.id, b.id)),
    commands: commands.sort((a, b) => compareIds(a.id, b.id)),
    policies,
    readModels,
    actors: [...actors.values()].sort((a, b) => compareIds(a.id, b.id)),
  };
}

/** ハンドラの中の role の比較（x.role === "admin"、"admin" == user.role）の文字列。最初に現れたもの。 */
function roleOf(file: ParsedFile | undefined, symbol: string): string | null {
  if (file === undefined) return null;
  const fn = topLevelFunctions(file.program).get(symbol);
  if (fn === undefined) return null;
  const hits: Array<{ role: string; position: number }> = [];
  walk(fn.node, (node) => {
    if (node.type !== "BinaryExpression") return;
    const operator = node["operator"];
    if (operator !== "===" && operator !== "==") return;
    const left = node["left"];
    const right = node["right"];
    const role = isRoleAccess(left) ? stringValue(right) : isRoleAccess(right) ? stringValue(left) : null;
    if (role === null || role.length === 0) return;
    const position = typeof node["start"] === "number" ? node["start"] : Number.MAX_SAFE_INTEGER;
    hits.push({ role, position });
  });
  hits.sort((a, b) => a.position - b.position);
  return hits[0]?.role ?? null;
}

function isRoleAccess(node: unknown): boolean {
  return (
    isAstNode(node) &&
    (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
    identifierName(node["property"]) === "role"
  );
}

/** Next.js の画面のファイルからリードモデルを作る（識別子の辞書順）。 */
export function findReadModels(paths: readonly string[], screenshots: readonly string[]): ReadModel[] {
  const models: ReadModel[] = [];
  for (const path of paths) {
    const route = routeOf(path);
    if (route === null) continue;
    const screenshot = screenshotFor(route, screenshots);
    models.push({
      id: `RM-${path}`,
      name: route,
      route,
      componentFile: path,
      ...(screenshot === undefined ? {} : { screenshotPath: screenshot }),
    });
  }
  return models.sort((a, b) => compareIds(a.id, b.id));
}

/** 画面のファイルのルート。画面でなければ null。 */
export function routeOf(path: string): string | null {
  const segments = path.split("/");
  const appIndex = segments.lastIndexOf("app");
  const last = segments[segments.length - 1] ?? "";
  if (appIndex >= 0 && /^page\.(tsx|jsx|ts|js)$/.test(last)) {
    const parts = segments.slice(appIndex + 1, -1).filter((part) => !(part.startsWith("(") && part.endsWith(")")));
    return "/" + parts.join("/");
  }
  const pagesIndex = segments.lastIndexOf("pages");
  if (pagesIndex >= 0 && /\.(tsx|jsx)$/.test(last)) {
    const parts = segments.slice(pagesIndex + 1);
    if (parts[0] === "api") return null;
    const stem = last.replace(/\.(tsx|jsx)$/, "");
    if (stem.startsWith("_")) return null;
    parts[parts.length - 1] = stem;
    if (stem === "index") parts.pop();
    return "/" + parts.join("/");
  }
  return null;
}

/** 画像の名前（拡張子を除く）が、ルートを "_" でつないだもの（"/" は "index"）と一致する画像。 */
function screenshotFor(route: string, screenshots: readonly string[]): string | undefined {
  const slug = route === "/" ? "index" : route.slice(1).split("/").join("_");
  return [...screenshots].sort(compareIds).find((path) => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return name.replace(/\.[^.]+$/, "") === slug;
  });
}

function screenUsesHandler(
  model: ReadModel,
  handler: SourceLocation,
  byPath: ReadonlyMap<string, ParsedFile>,
  resolver: ModuleResolver,
): boolean {
  if (model.componentFile === handler.file) return true;
  const screen = byPath.get(model.componentFile);
  if (screen === undefined) return false;
  for (const entry of importsOf(screen.program)) {
    if (entry.imported === "*") continue;
    const target = resolver.resolve(screen.path, entry.from);
    const targetFile = target === null ? undefined : byPath.get(target);
    if (targetFile === undefined) continue;
    const location = findExportedFunction(targetFile, entry.imported, byPath, resolver, new Set());
    if (location !== null && location.file === handler.file && location.symbol === handler.symbol) return true;
  }
  return false;
}