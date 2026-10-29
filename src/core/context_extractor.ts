import type {
  ScenarioTarget,
  RepositoryArtifacts,
  RawContextModel,
  ExtractionUnit,
  UseCaseSlice
} from '../types/index.js';

/**
 * M1: ContextExtractor
 * Zero-I/O Core: Pure ESM, strictly deterministic.
 * Slices the vertical causal chain within strict Inlet, Outlet, and Asynchronous boundaries.
 */
export function extractContext(
  target: ScenarioTarget,
  repo: RepositoryArtifacts
): RawContextModel {
  if (!target || !target.id) {
    throw new Error('Precondition failed: ScenarioTarget must have a valid id');
  }

  const files = repo?.files || [];
  const entryFile = files.find(f => f.path === target.readModel.entryFile) ||
                    files.find(f => f.path.includes(target.readModel.entryFile)) ||
                    files[0];

  const units: ExtractionUnit[] = [];
  const slices: UseCaseSlice[] = [];
  let isAsyncCutEnforced = false;

  // 1. UI Layer Extraction (Entry point screen)
  if (entryFile) {
    const uiUnits = extractUIUnits(entryFile.content, entryFile.path, target.inletTrigger.name);
    units.push(...uiUnits);
  }

  // 2. API & Backend Layer Extraction (Tracing operations to handlers)
  const apiFiles = files.filter(f => f.path.includes('/api/') || f.path.includes('/server/') || f.path.includes('/services/'));
  for (const af of apiFiles) {
    const backendUnits = extractBackendUnits(af.content, af.path);
    units.push(...backendUnits);
  }

  // 3. Schema & Database Layer Extraction
  const schemaFiles = files.filter(f => f.path.includes('/schema') || f.path.includes('/models') || f.path.includes('/entities') || f.path.endsWith('.prisma') || f.path.endsWith('.sql'));
  for (const sf of schemaFiles) {
    const schemaUnits = extractSchemaUnits(sf.content, sf.path);
    units.push(...schemaUnits);
  }

  // 4. Asynchronous Boundary Detection & Cut
  for (const f of files) {
    if (/(?:emit|publish|dispatch|enqueue|addDoc|publishMessage)\s*\(/g.test(f.content)) {
      isAsyncCutEnforced = true;
      units.push({
        id: `CUT-ASYNC-${f.path.split('/').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'EVENT'}`,
        kind: 'ASYNC_CUT',
        name: 'AsynchronousBoundarySevered',
        layer: 'ASYNC_TRIGGER',
        details: {
          file: f.path,
          rule: 'Subsequent asynchronous executions severed into separate scenario'
        }
      });
      break;
    }
  }

  // 5. Use Case Slicing (Branching: Guard success vs Guard failure)
  slices.push({
    sliceId: `${target.id}-NORMAL`,
    precondition: 'Input valid and authorized',
    outcome: 'State mutation committed and success response returned',
    units: units.filter(u => u.kind !== 'ASYNC_CUT')
  });

  slices.push({
    sliceId: `${target.id}-REJECTED`,
    precondition: 'Validation failed or unauthorized',
    outcome: 'Early return with rejection error without state mutation',
    units: units.filter(u => u.kind === 'BRANCH_CONDITION' || u.kind === 'OPERATION')
  });

  // 完全決定論的ソート
  units.sort((a, b) => a.id.localeCompare(b.id));
  slices.sort((a, b) => a.sliceId.localeCompare(b.sliceId));

  return {
    scenarioId: target.id,
    intent: target.intent,
    entryPoint: {
      route: target.readModel.route,
      file: target.readModel.entryFile,
      inletTrigger: target.inletTrigger.name
    },
    units,
    slices,
    isAsyncCutEnforced
  };
}

// -------------------------------------------------------------
// UI層解析 (UIAnalyzer)
// -------------------------------------------------------------
function extractUIUnits(content: string, filePath: string, triggerName: string): ExtractionUnit[] {
  const units: ExtractionUnit[] = [];
  const compName = filePath.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'Component';

  // 1. STATE (useState, state hooks)
  const stateMatches = content.matchAll(/const\s+\[([a-zA-Z0-9_]+),\s*([a-zA-Z0-9_]+)\]\s*=\s*useState/g);
  for (const m of stateMatches) {
    units.push({
      id: `STATE-${compName}-${m[1]}`,
      kind: 'STATE',
      name: m[1],
      componentScope: compName,
      layer: 'UI'
    });
  }

  // 2. OPERATION (handlers)
  const fnMatches = content.matchAll(/(?:const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|function\s+([a-zA-Z0-9_]+)\s*\()/g);
  for (const m of fnMatches) {
    const fnName = m[1] || m[2];
    if (fnName && /^(?:handle|on|submit|update|change|create|delete)/i.test(fnName)) {
      units.push({
        id: `OP-${compName}-${fnName}`,
        kind: 'OPERATION',
        name: fnName,
        componentScope: compName,
        layer: 'UI'
      });
    }
  }

  // 3. INTERFACE_TEXT (labels, button texts)
  const textMatches = content.matchAll(/<(?:button|label|span|p)[^>]*>([^<]+)<\//g);
  for (const m of textMatches) {
    const text = m[1].trim();
    if (text && text.length < 50) {
      units.push({
        id: `TEXT-${compName}-${text.replace(/[^a-zA-Z0-9_]/g, '_')}`,
        kind: 'INTERFACE_TEXT',
        name: text,
        componentScope: compName,
        layer: 'UI'
      });
    }
  }

  // 4. BRANCH_CONDITION (if / guards)
  const ifMatches = content.matchAll(/if\s*\(([^)]+)\)/g);
  for (const m of ifMatches) {
    const cond = m[1].trim();
    units.push({
      id: `BRANCH-${compName}-${cond.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30)}`,
      kind: 'BRANCH_CONDITION',
      name: cond,
      componentScope: compName,
      layer: 'UI'
    });
  }

  return units;
}

// -------------------------------------------------------------
// バックエンド層解析 (BackendAnalyzer)
// -------------------------------------------------------------
function extractBackendUnits(content: string, filePath: string): ExtractionUnit[] {
  const units: ExtractionUnit[] = [];
  const fileName = filePath.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'Backend';

  // APIルート
  const routeMatches = content.matchAll(/(?:app|router)\.(get|post|put|delete)\s*\(\s*['"]([^'"]+)['"]/g);
  for (const m of routeMatches) {
    units.push({
      id: `API-${m[1].toUpperCase()}-${m[2].replace(/[^a-zA-Z0-9_]/g, '_')}`,
      kind: 'API_ENDPOINT',
      name: `${m[1].toUpperCase()} ${m[2]}`,
      componentScope: fileName,
      layer: 'API'
    });
  }

  // データミューテーション (DB updates/inserts)
  const mutMatches = content.matchAll(/(?:insert|update|delete|save)\s*\(/g);
  for (const m of mutMatches) {
    units.push({
      id: `MUT-${fileName}-${m[0]}`,
      kind: 'DATA_MUTATION',
      name: m[0],
      componentScope: fileName,
      layer: 'DATABASE'
    });
  }

  return units;
}

// -------------------------------------------------------------
// スキーマ層解析 (SchemaAnalyzer)
// -------------------------------------------------------------
function extractSchemaUnits(content: string, filePath: string): ExtractionUnit[] {
  const units: ExtractionUnit[] = [];
  const fileName = filePath.split('/').pop()?.replace(/\.[^/.]+$/, '') || 'Schema';

  // テーブル / モデル定義 (model User, TABLE user)
  const modelMatches = content.matchAll(/(?:model|TABLE|interface)\s+([a-zA-Z0-9_]+)/g);
  for (const m of modelMatches) {
    units.push({
      id: `SCHEMA-${m[1]}`,
      kind: 'SCHEMA_ENTITY',
      name: m[1],
      componentScope: fileName,
      layer: 'DATABASE'
    });
  }

  return units;
}