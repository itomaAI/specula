import type {
  FormalSpecification,
  DomainLedgerCatalog,
  ProjectionRequest,
  SpecificationViews
} from '../types/index.js';

/**
 * M5: SpecProjector
 * Zero-I/O Core: Pure ESM, strictly deterministic.
 * Projects mathematical formal models into multi-view specifications (Markdown, DAG, Mermaid, Matrix).
 * Guarantees 100% deterministic reproducibility (diff=0 invariant).
 */
export function projectSpecification(
  spec: FormalSpecification,
  ledger?: DomainLedgerCatalog,
  req?: ProjectionRequest
): SpecificationViews {
  if (!spec || !spec.scenarioId) {
    throw new Error('Precondition failed: FormalSpecification must have a scenarioId');
  }

  const formats = req?.formats || ['MARKDOWN', 'DAG_JSON', 'MERMAID_FLOW', 'STATE_MATRIX'];
  const views: SpecificationViews = {
    scenarioId: spec.scenarioId
  };

  // 1. Markdown Specification Projection
  if (formats.includes('MARKDOWN')) {
    views.markdownDoc = renderMarkdownDoc(spec, ledger);
  }

  // 2. DAG JSON Projection (for DAG Viewer)
  if (formats.includes('DAG_JSON')) {
    views.dagJson = renderDagJson(spec);
  }

  // 3. Mermaid Sequence / Flow Diagram
  if (formats.includes('MERMAID_FLOW')) {
    views.mermaidDiagram = renderMermaidFlow(spec);
  }

  // 4. State Matrix Markdown Table
  if (formats.includes('STATE_MATRIX')) {
    views.stateMatrixMd = renderStateMatrix(spec);
  }

  return views;
}

// -------------------------------------------------------------
// Markdown 仕様書プロジェクター
// -------------------------------------------------------------
function renderMarkdownDoc(spec: FormalSpecification, ledger?: DomainLedgerCatalog): string {
  const lines: string[] = [];

  lines.push(`# 仕様書: ${spec.scenarioId}\n`);
  lines.push(`> 本仕様書は、形式仕様正本より決定論的にオンデマンド射影されたブラックボックス契約仕様書です。\n`);

  lines.push(`## 1. ドメイン概念と構造 (Signatures)\n`);
  lines.push(`| 概念名 | 種別 | 説明 |`);
  lines.push(`| :--- | :--- | :--- |`);
  for (const sig of spec.signatures) {
    lines.push(`| **${sig.name}** | ${sig.isVar ? '時相状態' : 'エンティティ'} | ${sig.sourceAnnotation ? `出どころ: ${sig.sourceAnnotation}` : 'ドメイン状態'} |`);
  }
  lines.push('');

  lines.push(`## 2. 操作仕様と事前・事後条件 (Predicates)\n`);
  for (const pred of spec.predicates) {
    lines.push(`### 操作: \`${pred.name}\`\n`);
    lines.push(`- **事前条件 (Preconditions)**:`);
    for (const pre of pred.preconditions) lines.push(`  - \`${pre}\``);
    lines.push(`- **事後条件 (Postconditions)**:`);
    for (const post of pred.postconditions) lines.push(`  - \`${post}\``);
    lines.push(`- **不変条件 (Invariants)**:`);
    for (const inv of pred.invariants) lines.push(`  - \`${inv}\``);
    lines.push('');
  }

  lines.push(`## 3. 安全性・健全性表明 (Assertions)\n`);
  for (const a of spec.assertions) {
    lines.push(`- \`${a}\``);
  }
  lines.push('');

  if (ledger && ledger.ledgers.length > 0) {
    lines.push(`## 4. 合意済み意思決定論点 (Domain Decision Ledgers)\n`);
    for (const l of ledger.ledgers) {
      lines.push(`### [${l.id}] ${l.claim}\n`);
      lines.push(`- **観測事実**: ${l.observation}`);
      lines.push(`- **判断の問い**: ${l.domainQuestion}`);
      lines.push(`- **採択選択肢**: ${l.options[0]?.label || '未定'}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// -------------------------------------------------------------
// DAG JSON プロジェクター (因果グラフ)
// -------------------------------------------------------------
function renderDagJson(spec: FormalSpecification): Record<string, unknown> {
  const nodes = [];
  const edges = [];

  // 状態ノード
  nodes.push({ id: 'InitialReady', label: '初期準備状態', kind: 'STATE' });
  nodes.push({ id: 'Processing', label: '処理中', kind: 'STATE' });
  nodes.push({ id: 'SuccessCompleted', label: '成功完了', kind: 'STATE' });

  // 操作ノード
  for (const pred of spec.predicates) {
    nodes.push({ id: pred.name, label: pred.name, kind: 'OPERATION' });
    edges.push({ from: 'InitialReady', to: pred.name });
    edges.push({ from: pred.name, to: 'Processing' });
    edges.push({ from: 'Processing', to: 'SuccessCompleted' });
  }

  return {
    scenarioId: spec.scenarioId,
    nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges
  };
}

// -------------------------------------------------------------
// Mermaid シーケンス・フロープロジェクター
// -------------------------------------------------------------
function renderMermaidFlow(spec: FormalSpecification): string {
  const lines: string[] = ['sequenceDiagram', '  autonumber'];
  lines.push('  actor User as 一般ユーザー');
  lines.push('  participant UI as 画面UI (ReadModel)');
  lines.push('  participant Core as システム (Domain)');

  for (const pred of spec.predicates) {
    lines.push(`  User->>UI: ${pred.name} 操作を実行`);
    lines.push(`  UI->>Core: 状態遷移リクエスト`);
    lines.push(`  Core-->>UI: 状態確定 (SuccessCompleted)`);
    lines.push(`  UI-->>User: 画面応答返却`);
  }

  return lines.join('\n');
}

// -------------------------------------------------------------
// 状態決定表マトリクスプロジェクター
// -------------------------------------------------------------
function renderStateMatrix(spec: FormalSpecification): string {
  const states = ['InitialReady', 'Processing', 'SuccessCompleted', 'RejectedError'];
  const commands = spec.predicates.map(p => p.name);

  const lines: string[] = [];
  lines.push(`| 現在状態 \\ 操作 | ${commands.join(' | ')} |`);
  lines.push(`| :--- | ${commands.map(() => ':---').join(' | ')} |`);

  for (const s of states) {
    const row = commands.map(c => {
      if (s === 'InitialReady') return `➔ Processing`;
      if (s === 'Processing') return `➔ SuccessCompleted`;
      return `🛑 非活性 (Disabled)`;
    });
    lines.push(`| **${s}** | ${row.join(' | ')} |`);
  }

  return lines.join('\n');
}