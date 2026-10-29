import type {
  RawContextModel,
  FormalSpecification,
  FormalSignature,
  FormalPredicate,
  TranspilerResult
} from '../types/index.js';

/**
 * M2: FormalTranspiler
 * Zero-I/O Core: Pure ESM, strictly deterministic.
 * Compiles RawContextModel into formal mathematical specification (Alloy 6 / Temporal logic).
 * Hides implementation details and exposes only domain vocabulary.
 */
export function transpileFormal(
  context: RawContextModel,
  previousSpec?: FormalSpecification
): TranspilerResult {
  if (!context || !context.scenarioId) {
    throw new Error('Precondition failed: RawContextModel must have scenarioId');
  }

  // 1. 曖昧性検知 (Ambiguity Detection)
  // 入力事実モデルに操作ハンドラが存在しない場合、勝手な推測を拒否して AmbiguityReport を返す
  const ops = context.units.filter(u => u.kind === 'OPERATION');
  if (ops.length === 0) {
    return {
      kind: 'AMBIGUITY',
      report: {
        scenarioId: context.scenarioId,
        hasAmbiguity: true,
        issues: [
          {
            target: context.scenarioId,
            description: 'シナリオ内に実行可能な操作ハンドラ (OPERATION) が特定されていません',
            domainQuestion: 'このシナリオを開始するユーザー操作またはトリガーハンドラは何ですか？'
          }
        ]
      }
    };
  }

  // 2. ドメイン語彙への昇華とシグネチャ生成 (Signatures)
  const signatures: FormalSignature[] = [];

  // 状態空間の抽象シグネチャ (ScreenState)
  signatures.push({
    name: 'ScreenState',
    isVar: false,
    isAbstract: true,
    fields: []
  });

  // 離散状態
  signatures.push({
    name: 'InitialReady',
    isVar: false,
    isAbstract: false,
    extendsName: 'ScreenState',
    fields: []
  });

  signatures.push({
    name: 'Processing',
    isVar: false,
    isAbstract: false,
    extendsName: 'ScreenState',
    fields: []
  });

  signatures.push({
    name: 'SuccessCompleted',
    isVar: false,
    isAbstract: false,
    extendsName: 'ScreenState',
    fields: []
  });

  signatures.push({
    name: 'RejectedError',
    isVar: false,
    isAbstract: false,
    extendsName: 'ScreenState',
    fields: []
  });

  // 時相状態変数
  signatures.push({
    name: 'CurrentState',
    isVar: true,
    isAbstract: false,
    extendsName: 'ScreenState',
    fields: []
  });

  // スキーマエンティティのシグネチャ化
  const schemaEntities = context.units.filter(u => u.kind === 'SCHEMA_ENTITY');
  for (const se of schemaEntities) {
    const domainName = sanitizeDomainIdentifier(se.name);
    if (!signatures.some(s => s.name === domainName)) {
      signatures.push({
        name: domainName,
        isVar: false,
        isAbstract: false,
        fields: [{ name: 'id', type: 'String', multiplicity: 'one' }],
        sourceAnnotation: se.name
      });
    }
  }

  // 3. 操作述語の合成 (Predicates)
  const predicates: FormalPredicate[] = [];
  for (const op of ops) {
    const predName = toDomainPredicateName(op.name);

    predicates.push({
      name: predName,
      params: [{ name: 'actor', type: 'User' }],
      preconditions: [
        'CurrentState in InitialReady',
        'some actor'
      ],
      postconditions: [
        'CurrentState\' in Processing or CurrentState\' in SuccessCompleted'
      ],
      invariants: [
        '-- 不変条件: アクターの識別子は遷移を通じて不変',
        'actor.id\' = actor.id'
      ],
      sourceAnnotation: op.name
    });
  }

  // 4. 安全性・健全性アサーション (Assertions)
  const assertions: string[] = [
    'assert NoDeadlock { always (some s: ScreenState | CurrentState in s) }',
    'assert SoundTermination { CurrentState in SuccessCompleted implies once (CurrentState in InitialReady) }'
  ];

  // 5. Alloy 6 ソースコードの正規生成
  const sourceCode = generateAlloySource(context.scenarioId, signatures, predicates, assertions);

  return {
    kind: 'SUCCESS',
    spec: {
      scenarioId: context.scenarioId,
      sourceCode,
      signatures: signatures.sort((a, b) => a.name.localeCompare(b.name)),
      predicates: predicates.sort((a, b) => a.name.localeCompare(b.name)),
      assertions,
      isSound: true
    }
  };
}

// -------------------------------------------------------------
// Alloy 6 ソースコードジェネレータ
// -------------------------------------------------------------
function generateAlloySource(
  scenarioId: string,
  signatures: FormalSignature[],
  predicates: FormalPredicate[],
  assertions: string[]
): string {
  const lines: string[] = [];

  lines.push(`module ${sanitizeDomainIdentifier(scenarioId)}`);
  lines.push(`-- Generated deterministically by Specula FormalTranspiler (M2)\n`);

  // Signatures
  lines.push(`abstract sig ScreenState {}\n`);
  lines.push(`one sig InitialReady, Processing, SuccessCompleted, RejectedError extends ScreenState {}\n`);
  lines.push(`var one sig CurrentState in ScreenState {}\n`);

  for (const sig of signatures) {
    if (['ScreenState', 'InitialReady', 'Processing', 'SuccessCompleted', 'RejectedError', 'CurrentState'].includes(sig.name)) continue;
    lines.push(`-- @source: "${sig.sourceAnnotation || sig.name}"`);
    lines.push(`sig ${sig.name} {`);
    for (const f of sig.fields) {
      lines.push(`  ${f.name}: ${f.multiplicity} ${f.type}`);
    }
    lines.push(`}\n`);
  }

  // Predicates
  for (const pred of predicates) {
    lines.push(`-- @source: "${pred.sourceAnnotation || pred.name}"`);
    lines.push(`pred ${pred.name} [] {`);
    lines.push(`  -- Preconditions`);
    for (const pre of pred.preconditions) lines.push(`  ${pre}`);
    lines.push(`  -- Postconditions`);
    for (const post of pred.postconditions) lines.push(`  ${post}`);
    lines.push(`  -- Invariants`);
    for (const inv of pred.invariants) lines.push(`  ${inv}`);
    lines.push(`}\n`);
  }

  // Assertions
  for (const a of assertions) {
    lines.push(a);
  }

  return lines.join('\n');
}

// -------------------------------------------------------------
// 識別子サニタイズ（実装語彙の隠蔽）
// -------------------------------------------------------------
function sanitizeDomainIdentifier(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function toDomainPredicateName(handlerName: string): string {
  const clean = handlerName.replace(/^(?:handle|on)/i, '');
  return `Execute${clean.charAt(0).toUpperCase() + clean.slice(1)}`;
}