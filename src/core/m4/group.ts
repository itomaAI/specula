// 反例を論点にまとめる（M4 の設計 3）。決定論的で、LLM は使わない。
//
// - 実行列のある反例は、最後の時点の状態変数の値の組（values）が同じものを 1 つの論点にまとめる。
//   holds と outcome は比べない（設計 3.1 は「状態変数の値の組」で決めるため）。
// - 本体は ROOT_PRIORITY の順（DEADLOCK → UNHANDLED_TRANSITION → OVERLAPPING_OPERATIONS）で選ぶ。
//   同じ種類が 2 件以上あれば、findings の中で先のものを本体にする。
// - UNREACHABLE_OPERATION（実行列なし）は 1 件で 1 つの論点にする。
// - 論点は本体の findings の中の順に並べ、"LEDGER-<commandId>-<3 桁の連番>" の識別子を付ける。
// - 状態をまたぐ依存の鎖は作らない（設計 3.1）。

import { canonicalJson } from "../../lib/canonical_json.js";
import { ROOT_PRIORITY } from "../../types/ledger.js";
import type { Finding, TraceStep } from "../../types/solver.js";

export interface FindingGroup {
  id: string;
  root: number;
  /** findings の中の順。 */
  dependents: number[];
  /** 本体の操作のあとに、従属する反例の操作を重ねずに足したもの。 */
  operations: string[];
}

export function groupFindings(commandId: string, findings: Finding[]): FindingGroup[] {
  const buckets: number[][] = [];
  const byState = new Map<string, number[]>();
  findings.forEach((finding, index) => {
    if (finding.trace === null || finding.trace.length === 0) {
      buckets.push([index]);
      return;
    }
    const last = finding.trace[finding.trace.length - 1] as TraceStep;
    const key = canonicalJson(last.values);
    const bucket = byState.get(key);
    if (bucket === undefined) {
      const created = [index];
      byState.set(key, created);
      buckets.push(created);
    } else {
      bucket.push(index);
    }
  });

  const groups = buckets.map((members) => {
    const root = chooseRoot(findings, members);
    const dependents = members.filter((index) => index !== root).sort((a, b) => a - b);
    const operations: string[] = [];
    for (const index of [root, ...dependents]) {
      for (const operation of (findings[index] as Finding).operations) {
        if (!operations.includes(operation)) operations.push(operation);
      }
    }
    return { root, dependents, operations };
  });
  groups.sort((a, b) => a.root - b.root);

  return groups.map((group, position) => ({
    id: `LEDGER-${commandId}-${String(position + 1).padStart(3, "0")}`,
    ...group,
  }));
}

function chooseRoot(findings: Finding[], members: number[]): number {
  let best = members[0] as number;
  for (const index of members) {
    const rank = ROOT_PRIORITY.indexOf((findings[index] as Finding).kind);
    const bestRank = ROOT_PRIORITY.indexOf((findings[best] as Finding).kind);
    if (rank < bestRank || (rank === bestRank && index < best)) best = index;
  }
  return best;
}