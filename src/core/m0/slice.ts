// Stage 4: CommandSlicerResolver（CommandExtractor の設計 3.4）。
// 全体マップから、コマンドノード 1 つにつき 1 つのコマンドの単位を切り出す。LLM を使わない（意図の候補は IntentSynthesizer が作る）。
//
// 決めたこと（2026-10-31 T-0070 で改めた）:
// - 起点はコマンドだけ。単位 1 つにコマンド 1 つ。期待イベントは、そのコマンドが発生させるイベントのすべて。
// - ポリシーは起点にしない。コマンドを起動するポリシーは、そのコマンドの単位の invokedBy に入れる。
// - filter は抽出した単位にだけ効く。利用者定義の単位は filter によらず出す。
// - 利用者定義: inlet が全体マップのコマンド（識別子か "ファイル#関数名"）に無ければ rejected。ポリシーを指したときも rejected
//   にし、起動するコマンドを理由に書く（起動するコマンドに読み替えると、同じコマンドを 2 通りで指せるため）。
//   同じコマンドを 2 度指したら、2 度目を rejected。route があり、そのルートのリードモデルが全体マップに無ければ rejected。
//   あれば、そのリードモデルを付ける。同じコマンドの単位が抽出側にもあれば、抽出側を出さない。
// - filter.inlets でポリシーを指したときも、同じ理由で rejected に書く（そのポリシーでは何も選ばれない）。

import type {
  Actor,
  Command,
  EventStormingMap,
  CommandSelection,
  CommandTarget,
  SliceResult,
  SourceLocation,
} from "../../types/command.js";
import { compareIds } from "./boundary.js";

interface Draft {
  command: Command;
  origin: "EXTRACTED" | "USER_DEFINED";
  userIntent?: string;
  readModelId?: string;
}

export function slice(map: EventStormingMap, selection: CommandSelection | undefined): SliceResult {
  const commandsInOrder = [...map.commands].sort((a, b) => compareIds(a.id, b.id));
  const refers = (ref: string, id: string, location: SourceLocation): boolean =>
    id === ref || `${location.file}#${location.symbol}` === ref;
  const findCommand = (ref: string): Command | undefined =>
    commandsInOrder.find((command) => refers(ref, command.id, command.handler));
  const policyReasonOf = (ref: string): string | undefined => {
    const policy = map.policies.find((candidate) => refers(ref, candidate.id, candidate.listener));
    return policy === undefined ? undefined : `ポリシーは起点にしない。起動するコマンド ${policy.actionCommandId} を指す`;
  };

  // ---- 利用者定義 ----
  const rejected: SliceResult["rejected"] = [];
  const userDrafts: Draft[] = [];
  for (const defined of selection?.userDefined ?? []) {
    const command = findCommand(defined.inlet);
    if (command === undefined) {
      rejected.push({ inlet: defined.inlet, reason: policyReasonOf(defined.inlet) ?? "起点が全体マップに無い" });
      continue;
    }
    if (userDrafts.some((draft) => draft.command.id === command.id)) {
      rejected.push({ inlet: defined.inlet, reason: `コマンド ${command.id} は利用者定義ですでに指されている` });
      continue;
    }
    let readModelId = command.readModelId;
    if (defined.route !== undefined) {
      const model = map.readModels.find((candidate) => candidate.route === defined.route);
      if (model === undefined) {
        rejected.push({ inlet: defined.inlet, reason: `ルート ${defined.route} のリードモデルが全体マップに無い` });
        continue;
      }
      readModelId = model.id;
    }
    userDrafts.push({
      command,
      origin: "USER_DEFINED",
      ...(defined.intent === undefined ? {} : { userIntent: defined.intent }),
      ...(readModelId === undefined ? {} : { readModelId }),
    });
  }
  const userCommandIds = new Set(userDrafts.map((draft) => draft.command.id));

  // ---- 抽出 ----
  const filter = selection?.filter;
  let filteredIds: Set<string> | undefined;
  if (filter?.inlets !== undefined) {
    filteredIds = new Set();
    for (const ref of filter.inlets) {
      const command = findCommand(ref);
      if (command !== undefined) {
        filteredIds.add(command.id);
        continue;
      }
      const reason = policyReasonOf(ref);
      if (reason !== undefined) rejected.push({ inlet: ref, reason });
    }
  }
  const extractedDrafts: Draft[] = [];
  for (const command of commandsInOrder) {
    if (userCommandIds.has(command.id)) continue;
    if (filter?.boundedContext !== undefined && command.contextId !== filter.boundedContext) continue;
    if (filteredIds !== undefined && !filteredIds.has(command.id)) continue;
    extractedDrafts.push({
      command,
      origin: "EXTRACTED",
      ...(command.readModelId === undefined ? {} : { readModelId: command.readModelId }),
    });
  }

  // ---- 組み立て（コマンドの識別子の辞書順）----
  const drafts = [...userDrafts, ...extractedDrafts].sort((a, b) => compareIds(a.command.id, b.command.id));

  const commands: CommandTarget[] = [];
  for (const draft of drafts) {
    const command = draft.command;
    const actor = actorOf(map, command.actorId);
    const model = draft.readModelId === undefined ? undefined : map.readModels.find((m) => m.id === draft.readModelId);
    const invokedBy = map.policies
      .filter((policy) => policy.actionCommandId === command.id)
      .sort((a, b) => compareIds(a.id, b.id))
      .map((policy) => ({ policyId: policy.id, triggerEventId: policy.triggerEventId, listener: { ...policy.listener } }));
    commands.push({
      id: `CT-${command.id}`,
      boundedContext: command.contextId,
      origin: draft.origin,
      ...(draft.userIntent === undefined ? {} : { userIntent: draft.userIntent }),
      inletTrigger: { id: command.id, handler: command.handler },
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
      expectedEvents: [...command.eventIds],
      invokedBy,
    });
  }

  return { commands, rejected };
}

function actorOf(map: EventStormingMap, actorId: string): Actor {
  const actor = map.actors.find((candidate) => candidate.id === actorId);
  if (actor === undefined) throw new Error(`全体マップにアクター ${actorId} が無い（コマンドが指している）`);
  return { id: actor.id, name: actor.name };
}