// Stage 4: ScenarioSlicerResolver（ScenarioExtractor の設計 3.4）。
// 全体マップから、コマンドかポリシーを起点にしたシナリオを切り出す。LLM を使わない（意図の候補は IntentSynthesizer が作る）。
//
// 決めたこと（初回）:
// - コマンドが起点: 期待イベントはそのコマンドのイベント。1 イベントにつき 1 シナリオ。
// - ポリシーが起点: 期待イベントは、ポリシーが起動するコマンドのイベント。起点の所在はリスナーの登録の場所
//   （コマンドのハンドラにすると、コマンドが起点のシナリオと所在と期待イベントが同じになるため）。
//   アクター・コンテキストは、起動されるコマンドのものを使う。リードモデルは付けない。
// - filter は抽出したシナリオにだけ効く。利用者定義のシナリオは filter によらず出す。
// - 利用者定義: inlet が全体マップの起点（識別子か "ファイル#関数名"）に無ければ rejected。route があり、
//   そのルートのリードモデルが全体マップに無ければ rejected。あれば、そのリードモデルを付ける。
//   同じ起点のシナリオが抽出側にもあれば、抽出側を出さない。

import type {
  Actor,
  Command,
  EventStormingMap,
  ScenarioSelection,
  ScenarioTarget,
  SliceResult,
  SourceLocation,
} from "../../types/scenario.js";
import { compareIds } from "./boundary.js";

interface Inlet {
  type: "COMMAND" | "POLICY";
  id: string;
  handler: SourceLocation;
  /** 期待イベントの候補（起点が起動するコマンドのイベント）。 */
  command: Command;
}

interface Draft {
  inlet: Inlet;
  eventId: string;
  origin: "EXTRACTED" | "USER_DEFINED";
  userIntent?: string;
  readModelId?: string;
}

export function slice(map: EventStormingMap, selection: ScenarioSelection | undefined): SliceResult {
  const inlets = inletsOf(map);
  const findInlet = (ref: string): Inlet | undefined =>
    inlets.find((inlet) => inlet.id === ref || `${inlet.handler.file}#${inlet.handler.symbol}` === ref);

  // ---- 利用者定義 ----
  const rejected: SliceResult["rejected"] = [];
  const userDrafts: Draft[] = [];
  for (const defined of selection?.userDefined ?? []) {
    const inlet = findInlet(defined.inlet);
    if (inlet === undefined) {
      rejected.push({ inlet: defined.inlet, reason: "起点が全体マップに無い" });
      continue;
    }
    let readModelId: string | undefined;
    if (defined.route !== undefined) {
      const model = map.readModels.find((candidate) => candidate.route === defined.route);
      if (model === undefined) {
        rejected.push({ inlet: defined.inlet, reason: `ルート ${defined.route} のリードモデルが全体マップに無い` });
        continue;
      }
      readModelId = model.id;
    } else if (inlet.type === "COMMAND" && inlet.command.readModelId !== undefined) {
      readModelId = inlet.command.readModelId;
    }
    for (const eventId of inlet.command.eventIds) {
      userDrafts.push({
        inlet,
        eventId,
        origin: "USER_DEFINED",
        ...(defined.intent === undefined ? {} : { userIntent: defined.intent }),
        ...(readModelId === undefined ? {} : { readModelId }),
      });
    }
  }
  const userInletIds = new Set(userDrafts.map((draft) => draft.inlet.id));

  // ---- 抽出 ----
  const filter = selection?.filter;
  const extractedDrafts: Draft[] = [];
  for (const inlet of inlets) {
    if (userInletIds.has(inlet.id)) continue;
    if (filter?.boundedContext !== undefined && inlet.command.contextId !== filter.boundedContext) continue;
    if (filter?.inlets !== undefined && !filter.inlets.some((ref) => findInlet(ref)?.id === inlet.id)) continue;
    for (const eventId of inlet.command.eventIds) {
      const readModelId = inlet.type === "COMMAND" ? inlet.command.readModelId : undefined;
      extractedDrafts.push({
        inlet,
        eventId,
        origin: "EXTRACTED",
        ...(readModelId === undefined ? {} : { readModelId }),
      });
    }
  }

  // ---- 組み立て（識別子の辞書順）----
  const drafts = [...userDrafts, ...extractedDrafts]
    .map((draft) => ({ draft, id: scenarioIdOf(draft.inlet, draft.eventId) }))
    .sort((a, b) => compareIds(a.id, b.id));

  const scenarios: ScenarioTarget[] = [];
  for (const { draft, id } of drafts) {
    const actor = actorOf(map, draft.inlet.command.actorId);
    const model = draft.readModelId === undefined ? undefined : map.readModels.find((m) => m.id === draft.readModelId);
    scenarios.push({
      id,
      boundedContext: draft.inlet.command.contextId,
      origin: draft.origin,
      ...(draft.userIntent === undefined ? {} : { userIntent: draft.userIntent }),
      inletType: draft.inlet.type,
      inletTrigger: { id: draft.inlet.id, handler: draft.inlet.handler },
      actor,
      ...(model === undefined
        ? {}
        : {
            readModel: {
              name: model.name,
              route: model.route,
              entryFile: model.componentFile,
              ...(model.screenshotPath === undefined ? {} : { screenshotPath: model.screenshotPath }),
            },
          }),
      expectedEvent: draft.eventId,
    });
  }

  return { scenarios, rejected };
}

function inletsOf(map: EventStormingMap): Inlet[] {
  const inlets: Inlet[] = map.commands.map((command) => ({
    type: "COMMAND" as const,
    id: command.id,
    handler: command.handler,
    command,
  }));
  for (const policy of map.policies) {
    const command = map.commands.find((candidate) => candidate.id === policy.actionCommandId);
    if (command === undefined) continue; // 全体マップの組み立てで起きないはずだが、壊れたマップを渡されたら起点にしない
    inlets.push({ type: "POLICY", id: policy.id, handler: policy.listener, command });
  }
  return inlets.sort((a, b) => compareIds(a.id, b.id));
}

function scenarioIdOf(inlet: Inlet, eventId: string): string {
  return inlet.command.eventIds.length === 1 ? `SCN-${inlet.id}` : `SCN-${inlet.id}-${eventId}`;
}

function actorOf(map: EventStormingMap, actorId: string): Actor {
  const actor = map.actors.find((candidate) => candidate.id === actorId);
  if (actor === undefined) throw new Error(`全体マップにアクター ${actorId} が無い（コマンドが指している）`);
  return { id: actor.id, name: actor.name };
}