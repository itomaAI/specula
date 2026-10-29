import type {
  SolverReport,
  FormalSpecification,
  DomainLedgerCatalog,
  DomainLedger,
  DomainLedgerOption
} from '../types/index.js';

/**
 * M4: LedgerSynthesizer
 * Zero-I/O Core: Pure ESM, strictly deterministic.
 * Translates mechanical counterexamples into stakeholder-facing decision ledgers.
 * Prioritizes root-cause ambiguities and produces actionable 3-way options.
 */
export function synthesizeLedger(
  report: SolverReport,
  spec?: FormalSpecification
): DomainLedgerCatalog {
  if (!report || !report.scenarioId) {
    throw new Error('Precondition failed: SolverReport must have a scenarioId');
  }

  const ledgers: DomainLedger[] = [];

  // 1. 健全時（証明成功時）の仕様ロック推奨 (Proof Success Lock)
  if (report.isSound || (report.unhandledTransitions.length === 0 && report.counterexamples.length === 0)) {
    ledgers.push({
      id: `LEDGER-${report.scenarioId}-LOCK`,
      scenarioId: report.scenarioId,
      isRootCause: true,
      claim: 'モデル検査により指定スコープ内で不変条件が破られないことが数学的に証明された',
      observation: '矛盾・デッドロック・未定義遷移はゼロ件であり、仕様モデルは健全である',
      domainQuestion: 'この形式仕様を正本（Single Source of Truth）として確定（ロック）しますか？',
      options: [
        {
          key: 'SPECIFY',
          label: '仕様をロックして正本化',
          description: 'この仕様を合意正本とし、テストコードおよびドキュメント射影を生成する'
        },
        {
          key: 'ALLOW_EDGE_CASE',
          label: '検証スコープを拡大して再検査',
          description: 'より大きなインスタンス数または時相ステップで再検証を実行する'
        },
        {
          key: 'FIX_BUG',
          label: '要件を見直して再設計',
          description: '追加の制約やシナリオをモデルに導入する'
        }
      ]
    });

    return {
      scenarioId: report.scenarioId,
      ledgers,
      summary: {
        totalIssues: 0,
        rootCausesCount: 1,
        isSound: true
      }
    };
  }

  // 2. 未定義遷移および反例のドメイン論点化
  let ledgerIndex = 1;

  for (const unhandled of report.unhandledTransitions) {
    const isRoot = ledgerIndex === 1; // 最初の未定義が根本原因
    const standardOptions: DomainLedgerOption[] = [
      {
        key: 'SPECIFY',
        label: '仕様として正式追加（活性化制御・エラー画面）',
        description: `状態が『${unhandled.state}』のとき、操作『${unhandled.command}』を非活性（Disabled）にするか、専用のエラー表示を返すよう仕様に明記する`
      },
      {
        key: 'FIX_BUG',
        label: '実装側のバグとして修正',
        description: `この状態での操作呼び出しをコード・UI側のガードで阻止するよう修正する`
      },
      {
        key: 'ALLOW_EDGE_CASE',
        label: '物理的に到達不能な例外として許容',
        description: `画面レイアウトやセッション制御上、実運用では発生し得ないため仕様例外として許容する`
      }
    ];

    ledgers.push({
      id: `LEDGER-${report.scenarioId}-${String(ledgerIndex).padStart(3, '0')}`,
      scenarioId: report.scenarioId,
      isRootCause: isRoot,
      claim: `状態『${unhandled.state}』における操作『${unhandled.command}』の振る舞いが一意に定義されているべきである`,
      observation: unhandled.reason || `状態 ${unhandled.state} において操作 ${unhandled.command} を実行した際の事後状態が定義されていません`,
      domainQuestion: `状態が『${unhandled.state}』のとき、操作『${unhandled.command}』を実行した場合の期待する振る舞いは何ですか？`,
      options: standardOptions
    });

    ledgerIndex++;
  }

  // 根本論点を先頭にソート
  ledgers.sort((a, b) => {
    if (a.isRootCause && !b.isRootCause) return -1;
    if (!a.isRootCause && b.isRootCause) return 1;
    return a.id.localeCompare(b.id);
  });

  return {
    scenarioId: report.scenarioId,
    ledgers,
    summary: {
      totalIssues: ledgers.length,
      rootCausesCount: ledgers.filter(l => l.isRootCause).length,
      isSound: false
    }
  };
}