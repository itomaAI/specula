import type {
  RepositoryArtifacts,
  ScenarioExtractorResult,
  BoundedContextDefinition,
  DomainEvent,
  DomainCommand,
  DomainPolicy,
  ReadModel,
  Actor,
  Aggregate,
  EventStormingMap,
  ScenarioTarget
} from '../types/index.js';

/**
 * M0: ScenarioExtractor
 * Zero-I/O Core: Pure ESM, strictly deterministic.
 * Implements Loom Dual-Container model & 4-Stage Stepwise Refinement.
 */
export function extractScenarios(
  repo: RepositoryArtifacts,
  humanPrompt?: string
): ScenarioExtractorResult {
  const files = repo?.files || [];

  // Stage 1: ContextBoundaryAnalyzer (境界同定)
  const boundedContexts = analyzeContextBoundaries(files);

  // Stage 2: EventStreamDiscoverer (事実骨格抽出)
  const events = discoverDomainEvents(files, boundedContexts);

  // Stage 3: EventStormingAssembler (関係性統合)
  const { commands, policies, readModels, actors, aggregates } = assembleEventStorming(
    files,
    boundedContexts,
    events
  );

  const map: EventStormingMap = {
    boundedContexts,
    events,
    commands,
    policies,
    readModels,
    actors,
    aggregates
  };

  // Stage 4: ScenarioSlicerResolver (具象シナリオ生成: 置く)
  const scenarios = sliceScenarios(map, humanPrompt);

  return { map, scenarios };
}

// -------------------------------------------------------------
// Stage 1: ContextBoundaryAnalyzer
// -------------------------------------------------------------
function analyzeContextBoundaries(files: Array<{ path: string; content: string }>): BoundedContextDefinition[] {
  const candidateMap = new Map<string, { rootPath: string }>();

  // ディレクトリヒューリスティクス: features/*, modules/*, apps/*, domains/*
  const prefixRegex = /^(?:src\/)?(?:features|modules|apps|domains)\/([^/]+)/;

  for (const f of files) {
    const match = f.path.match(prefixRegex);
    if (match && match[1]) {
      const name = match[1];
      if (!candidateMap.has(name)) {
        candidateMap.set(name, { rootPath: match[0] });
      }
    }
  }

  // 区分不能または単一のみの場合は単一コンテキスト（DEFAULT_CONTEXT）へ安全にフォールバック
  if (candidateMap.size === 0) {
    return [
      {
        id: "CTX-DEFAULT",
        name: "DefaultContext",
        rootPath: "",
        isDefaultFallback: true
      }
    ];
  }

  const contexts: BoundedContextDefinition[] = [];
  for (const [name, info] of candidateMap.entries()) {
    contexts.push({
      id: `CTX-${name.toUpperCase()}`,
      name: name,
      rootPath: info.rootPath,
      isDefaultFallback: false
    });
  }

  return contexts.sort((a, b) => a.id.localeCompare(b.id));
}

// -------------------------------------------------------------
// Stage 2: EventStreamDiscoverer
// -------------------------------------------------------------
function discoverDomainEvents(
  files: Array<{ path: string; content: string }>,
  contexts: BoundedContextDefinition[]
): DomainEvent[] {
  const events: DomainEvent[] = [];
  const eventNamesSeen = new Set<string>();

  // ミューテーションおよび状態変化シグナルを走査
  for (const f of files) {
    const ctx = findContextForPath(f.path, contexts);

    // 1. DB更新やAPIリクエスト・ハンドラからの完了形イベント検出
    // 例: updatePassword, changePassword, submitOrder, handlePasswordChange
    const fnMatches = f.content.matchAll(/(?:async\s+function\s+([a-zA-Z0-9_]+)|const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(|await\s+([a-zA-Z0-9_]+)\s*\()/g);
    for (const m of fnMatches) {
      const fnName = m[1] || m[2] || m[3];
      if (!fnName) continue;
      const cleanName = fnName.replace(/^handle/i, '');
      if (/^(?:update|change|create|submit|register|delete|remove|reset|cancel|order|password|subscription)/i.test(cleanName)) {
        const pastTense = toPastTense(cleanName);
        if (!eventNamesSeen.has(pastTense)) {
          eventNamesSeen.add(pastTense);
          events.push({
            id: `EVT-${pastTense.toUpperCase()}`,
            name: pastTense,
            label: `${pastTense} 完了`,
            contextId: ctx.id,
            aggregate: extractAggregateName(cleanName)
          });
        }
      }
    }

    // 2. イベント発行コード (emit, dispatch)
    const emitMatches = f.content.matchAll(/(?:emit|dispatch)\s*\(\s*['"]([a-zA-Z0-9_:-]+)['"]/g);
    for (const m of emitMatches) {
      const rawEvt = m[1].replace(/[:_-]/g, '');
      const pastTense = toPastTense(rawEvt);
      if (!eventNamesSeen.has(pastTense)) {
        eventNamesSeen.add(pastTense);
        events.push({
          id: `EVT-${pastTense.toUpperCase()}`,
          name: pastTense,
          label: `${pastTense} 発行`,
          contextId: ctx.id
        });
      }
    }
  }

  // 既定のイベントがゼロの場合は基本イベントを生成
  if (events.length === 0) {
    events.push({
      id: "EVT-OPERATIONCOMPLETED",
      name: "OperationCompleted",
      label: "操作が完了した",
      contextId: contexts[0].id
    });
  }

  return events.sort((a, b) => a.id.localeCompare(b.id));
}

// -------------------------------------------------------------
// Stage 3: EventStormingAssembler
// -------------------------------------------------------------
function assembleEventStorming(
  files: Array<{ path: string; content: string }>,
  contexts: BoundedContextDefinition[],
  events: DomainEvent[]
) {
  const readModels: ReadModel[] = [];
  const commands: DomainCommand[] = [];
  const policies: DomainPolicy[] = [];
  const actors: Actor[] = [
    { id: "ACT-USER", name: "一般ユーザー (User)" },
    { id: "ACT-ADMIN", name: "管理者 (Admin)" },
    { id: "ACT-SYSTEM", name: "システムワーカー (System)" }
  ];
  const aggregates: Aggregate[] = [];

  // Read Model（画面ルート）の同定
  for (const f of files) {
    // Next.js app/pages 画面ルーティングの検出
    if (f.path.includes('/app/') || f.path.includes('/pages/') || f.path.endsWith('page.tsx') || f.path.endsWith('page.jsx')) {
      const route = toRoutePath(f.path);
      const name = route === '/' ? 'Home' : route.split('/').filter(Boolean).pop() || 'Screen';
      const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
      const rmId = `RM-${capitalized.toUpperCase()}`;

      if (!readModels.some(r => r.id === rmId)) {
        readModels.push({
          id: rmId,
          name: `${capitalized}Screen`,
          route: route,
          componentFile: f.path
        });
      }
    }
  }

  if (readModels.length === 0) {
    readModels.push({
      id: "RM-MAIN",
      name: "MainView",
      route: "/",
      componentFile: files[0]?.path || "src/App.tsx"
    });
  }

  // 各イベントに対応するコマンドのバインド
  for (const evt of events) {
    const cmdName = toCommandName(evt.name);
    const rm = readModels[0];
    const cmdId = `CMD-${cmdName.toUpperCase()}`;

    if (!commands.some(c => c.id === cmdId)) {
      commands.push({
        id: cmdId,
        name: cmdName,
        label: `${cmdName}を実行する`,
        contextId: evt.contextId,
        actorId: "ACT-USER",
        readModelId: rm.id,
        handlerName: `handle${cmdName}`
      });
    }

    if (evt.aggregate && !aggregates.some(a => a.name === evt.aggregate)) {
      aggregates.push({
        id: `AGG-${evt.aggregate.toUpperCase()}`,
        name: evt.aggregate,
        contextId: evt.contextId
      });
    }
  }

  // ポリシーの同定（あるイベントを受けて別コマンドを発火するルール）
  if (events.length > 1) {
    policies.push({
      id: "POL-ON-COMPLETION-NOTIFY",
      name: "OnOperationCompletedNotify",
      label: "操作完了時に通知を発行する",
      triggerEventId: events[0].id,
      actionCommandId: commands[0].id
    });
  }

  return { commands, policies, readModels, actors, aggregates };
}

// -------------------------------------------------------------
// Stage 4: ScenarioSlicerResolver (置く)
// -------------------------------------------------------------
function sliceScenarios(map: EventStormingMap, humanPrompt?: string): ScenarioTarget[] {
  const scenarios: ScenarioTarget[] = [];

  for (const cmd of map.commands) {
    const rm = map.readModels.find(r => r.id === cmd.readModelId) || map.readModels[0];
    const actor = map.actors.find(a => a.id === cmd.actorId) || map.actors[0];
    const matchedEvent = map.events.find(e => e.contextId === cmd.contextId) || map.events[0];
    const ctx = map.boundedContexts.find(c => c.id === cmd.contextId) || map.boundedContexts[0];

    scenarios.push({
      id: `SCN-${cmd.name.toUpperCase()}`,
      boundedContext: ctx.name,
      intent: `${actor.name}が${rm.name}から${cmd.label}を行い、${matchedEvent.name}を達成する`,
      inletType: "COMMAND",
      inletTrigger: {
        name: cmd.name,
        handlerName: cmd.handlerName
      },
      actor: {
        id: actor.id,
        name: actor.name
      },
      readModel: {
        name: rm.name,
        route: rm.route,
        entryFile: rm.componentFile,
        screenshotPath: rm.screenshotPath
      },
      expectedEvent: matchedEvent.name
    });
  }

  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}

// -------------------------------------------------------------
// ヘルパーユーティリティ
// -------------------------------------------------------------
function findContextForPath(filePath: string, contexts: BoundedContextDefinition[]): BoundedContextDefinition {
  for (const ctx of contexts) {
    if (ctx.rootPath && filePath.startsWith(ctx.rootPath)) {
      return ctx;
    }
  }
  return contexts[0];
}

function toPastTense(verbOrNoun: string): string {
  if (verbOrNoun.endsWith('ed')) return verbOrNoun;
  if (/e$/i.test(verbOrNoun)) return `${verbOrNoun}d`;
  return `${verbOrNoun}Completed`;
}

function toCommandName(eventName: string): string {
  return eventName.replace(/(?:d|Completed|ed)$/i, '');
}

function extractAggregateName(fnName: string): string {
  const stripped = fnName.replace(/^(?:update|change|create|submit|register|delete|remove|reset|cancel)/i, '');
  return stripped || 'Entity';
}

function toRoutePath(filePath: string): string {
  const match = filePath.match(/(?:app|pages)(.*)\/(?:page|index)\.[a-zA-Z0-9]+$/);
  if (match && match[1]) {
    // Next.js ルートグループ (dashboard) などを正規化
    const cleaned = match[1].replace(/\/\([^)]+\)/g, '');
    return cleaned || '/';
  }
  return '/';
}