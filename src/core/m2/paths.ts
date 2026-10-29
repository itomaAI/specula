// スライスを操作に訳す（M2 の設計 3.1）。経路の順に条件と書き込みを並べ、EXTERNAL_EFFECT の材料を集める。
//
// - 条件の側（holds）はスライスの conditions から取る。条件のユニットが経路に出てきた位置に CONDITION を置く。
//   同じユニットが同じ側で 2 度出てきたら 1 つにまとめる。経路に出てこなかった条件は出口の前に置く（念のため）。
// - 書き込みの条件（when）は M1 の guardTerms を項ごとに訳したもの。ただし、経路の上でこの書き込みより前に
//   同じ側の CONDITION を置いた項は除く（M1 の guardTerms には経路の条件も入っているが、それは操作の guard が要求している）。
//   残った項が無ければ空。
// - ドメインが決まらなかった書き込みは steps に入れない（AmbiguityReport になるので、ソースは作られない）。
// - 書き込みの合成（同じ変数への 2 回の書き込み）と、条件をその時点の値で評価することは AlloyPrinter が行う。

import type { ExtractionUnit, UseCaseSlice } from "../../types/context.js";
import type { GuardExpr, Operation, OperationStep, WriteCondition } from "../../types/formal.js";
import { type AstNode, isAstNode } from "../m0/ast.js";
import type { CheckedFacts } from "./contract.js";
import type { GuardTranslation } from "./guards.js";
import { type StateModel, parseExpr, unwrap } from "./states.js";

export interface TranslatedPaths {
  operations: Operation[];
  /** 経路にある EXTERNAL_CALL・RECURSION のうち、状態か関数を渡しているもの（ユニットの識別子）。 */
  externalEffects: Set<string>;
}

export function translatePaths(checked: CheckedFacts, states: StateModel, guards: GuardTranslation): TranslatedPaths {
  const operations: Operation[] = [];
  const externalEffects = new Set<string>();
  const effectCache = new Map<string, boolean>();

  checked.facts.slices.forEach((slice, index) => {
    const n = index + 1;
    const steps: OperationStep[] = [];
    const dataMutations: string[] = [];
    // 条件の側を経路の順に並べた待ち行列（同じユニットの同じ側は 1 つ）。M1 の unitIds は重複しないので、
    // 条件のユニットが経路に出てくる位置には最初の側だけを置き、残りの側（ループを抜ける側など）は出口の前に置く。
    const pending = new Map<string, boolean[]>();
    for (const condition of slice.conditions) {
      const list = pending.get(condition.unitId) ?? [];
      if (!list.includes(condition.holds)) list.push(condition.holds);
      pending.set(condition.unitId, list);
    }
    // 経路にすでに置いた条件（側つき）。書き込みの when からこれを除く（操作の guard が要求しているため）。
    const placed = new Set<string>();
    const placeCondition = (unitId: string, all: boolean): void => {
      const sides = pending.get(unitId);
      if (sides === undefined || sides.length === 0) return;
      const taken = all ? sides.splice(0) : sides.splice(0, 1);
      for (const holds of taken) {
        steps.push({ kind: "CONDITION", unitId, expr: guardOf(guards, unitId), holds });
        placed.add(sideKey(unitId, holds));
      }
    };

    for (const unitId of slice.unitIds) {
      if (unitId === slice.outlet.unitId) continue;
      const unit = checked.units.get(unitId) as ExtractionUnit;
      switch (unit.kind) {
        case "BRANCH_CONDITION":
          placeCondition(unitId, false);
          break;
        case "STATE_WRITE": {
          const write = states.writes.get(unitId);
          if (write === undefined) break;
          const terms = checked.guardTerms.get(unitId) ?? [];
          const when: WriteCondition[] = terms
            .filter((term) => !placed.has(sideKey(term.unitId, term.holds)))
            .map((term) => ({ unitId: term.unitId, holds: term.holds, expr: guardOf(guards, term.unitId) }));
          steps.push({ kind: "WRITE", unitId, variable: write.state.variable.id, change: write.change, when });
          break;
        }
        case "DATA_MUTATION":
          if (!dataMutations.includes(unitId)) dataMutations.push(unitId);
          break;
        case "EXTERNAL_CALL":
        case "RECURSION": {
          let touches = effectCache.get(unitId);
          if (touches === undefined) {
            touches = callTouchesState(unit, states);
            effectCache.set(unitId, touches);
          }
          if (touches) externalEffects.add(unitId);
          break;
        }
        default:
          break;
      }
    }
    for (const condition of slice.conditions) placeCondition(condition.unitId, true);

    operations.push({
      id: `op${n}`,
      sliceId: slice.sliceId,
      outcome: `o${n}`,
      outletKind: slice.outlet.kind,
      guardPredicate: `op${n}_guard`,
      steps,
      dataMutations,
    });
  });
  return { operations, externalEffects };
}

function sideKey(unitId: string, holds: boolean): string {
  return `${holds ? "+" : "-"}${unitId}`;
}

function guardOf(guards: GuardTranslation, unitId: string): GuardExpr {
  const expr = guards.byUnit.get(unitId);
  // 契約で BRANCH_CONDITION であることは確かめてある。訳が無いことは無い。
  if (expr === undefined) throw new Error(`条件 ${unitId} の訳が無い`);
  return expr;
}

/** 条件の組（ユニットと側）。CONFLICTING_SLICES の比較に使う。 */
export function conditionKey(slice: UseCaseSlice): string {
  const keys = new Set(slice.conditions.map((c) => `${c.holds ? "+" : "-"}${c.unitId}`));
  return [...keys].sort().join("|");
}

/**
 * 呼び出しが状態を変えうるか（M2 の設計 5 の EXTERNAL_EFFECT）。
 * 引数か受け手（receiver）に、状態変数・それを持つオブジェクト・this・関数のどれかがあれば true。
 */
function callTouchesState(unit: ExtractionUnit, states: StateModel): boolean {
  const texts: string[] = [];
  const args = unit.details?.["args"];
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (Array.isArray(parsed)) for (const item of parsed) if (typeof item === "string") texts.push(item);
    } catch {
      // 引数が読めないときは、引数を見ない（受け手だけを見る）
    }
  }
  const receiver = unit.details?.["receiver"];
  if (typeof receiver === "string") texts.push(receiver);
  return texts.some((text) => expressionTouchesState(text, unit, states));
}

function expressionTouchesState(text: string, unit: ExtractionUnit, states: StateModel): boolean {
  const node = parseExpr(text);
  if (node === null) return false;
  let found = false;
  visitReferences(node, (kind, name) => {
    if (found) return;
    if (kind === "FUNCTION" || kind === "THIS") {
      found = true;
      return;
    }
    // 名前そのものが状態変数（最上位の let・var）か、その名前のプロパティが状態変数（引数のプロパティ）
    if (states.lookup(unit.location.file, unit.componentScope, name) !== null) {
      found = true;
      return;
    }
    found = states.states.some(
      (state) =>
        state.scope === "PARAMETER" &&
        state.owner === unit.componentScope &&
        state.unit.location.file === unit.location.file &&
        state.unit.name.startsWith(`${name}.`),
    );
  });
  return found;
}

/**
 * 式の中の参照をたどる。関数は FUNCTION、this は THIS、識別子は名前で知らせる。
 * プロパティの名前（a.b の b、{ b: 1 } の b）は参照ではないので知らせない。関数の中には入らない。
 */
function visitReferences(input: AstNode, visit: (kind: "FUNCTION" | "THIS" | "NAME", name: string) => void): void {
  const node = unwrap(input);
  switch (node.type) {
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      visit("FUNCTION", "");
      return;
    case "ThisExpression":
      visit("THIS", "this");
      return;
    case "Identifier":
      if (typeof node["name"] === "string" && node["name"] !== "undefined") visit("NAME", node["name"]);
      return;
    case "MemberExpression":
    case "OptionalMemberExpression":
      if (isAstNode(node["object"])) visitReferences(node["object"], visit);
      if (node["computed"] === true && isAstNode(node["property"])) visitReferences(node["property"], visit);
      return;
    case "ObjectProperty":
      if (node["computed"] === true && isAstNode(node["key"])) visitReferences(node["key"], visit);
      if (isAstNode(node["value"])) visitReferences(node["value"], visit);
      return;
    case "ObjectMethod":
      visit("FUNCTION", "");
      return;
    default:
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments")) continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) if (isAstNode(item)) visitReferences(item, visit);
        } else if (isAstNode(value)) {
          visitReferences(value, visit);
        }
      }
  }
}