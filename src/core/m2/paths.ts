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
import { isPureCallee, isPureCalleeNode } from "./pure_calls.js";
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
 * 呼び先が状態を変えない組み込みのメソッドのときは pureCallTouchesState で判定する。
 */
function callTouchesState(unit: ExtractionUnit, states: StateModel): boolean {
  const argTexts: string[] = [];
  const args = unit.details?.["args"];
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args);
      if (Array.isArray(parsed)) for (const item of parsed) if (typeof item === "string") argTexts.push(item);
    } catch {
      // 引数が読めないときは、引数を見ない（受け手だけを見る）
    }
  }
  const receiver = unit.details?.["receiver"];
  const receiverText = typeof receiver === "string" ? receiver : null;
  const callee = unit.details?.["callee"];
  if (typeof callee === "string" && isPureCallee(callee)) {
    return pureCallTouchesState(argTexts, receiverText, unit, states);
  }
  const texts = receiverText === null ? argTexts : [...argTexts, receiverText];
  return texts.some((text) => expressionTouchesState(text, unit, states));
}

/**
 * 状態を変えない組み込みのメソッドの呼び出し（設計 5 の表の下の規則）。
 * - 受け手は参照だけを見る（状態変数・それを持つオブジェクト・this）。受け手の中の関数は、それを受け取った呼び出しのユニットが判定する。
 * - 引数そのものがその場で書いた関数なら、本体を見る（functionBodyTouchesState）。
 * - それ以外の引数は、これまでと同じ規則で見る（引数の奥にある関数は、本体を見ずに当たりとする）。
 */
function pureCallTouchesState(argTexts: string[], receiver: string | null, unit: ExtractionUnit, states: StateModel): boolean {
  if (receiver !== null) {
    const node = parseExpr(receiver);
    if (node !== null) {
      let found = false;
      visitReferences(node, (kind, name) => {
        if (found || kind === "FUNCTION") return;
        if (kind === "THIS" || nameIsState(name, unit, states)) found = true;
      });
      if (found) return true;
    }
  }
  return argTexts.some((text) => {
    const node = parseExpr(text);
    if (node === null) return false;
    if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
      return functionBodyTouchesState(node, unit, states);
    }
    return expressionTouchesState(text, unit, states);
  });
}

/**
 * その場で書いた関数の本体（と引数の既定値）が、状態に触れうるか。
 * 状態変数か this を参照する、または状態を変えない組み込みのメソッドではない呼び出し（new を含む）があれば true。
 * M1 はコールバックの中に入らないので、本体の中の呼び出しは経路に出てこない。そのため慎重側に倒す。
 */
function functionBodyTouchesState(fn: AstNode, unit: ExtractionUnit, states: StateModel): boolean {
  let found = false;
  const check = (input: AstNode): void => {
    if (found) return;
    const node = unwrap(input);
    switch (node.type) {
      case "ThisExpression":
      case "NewExpression":
        found = true;
        return;
      case "Identifier":
        if (typeof node["name"] === "string" && nameIsState(node["name"], unit, states)) found = true;
        return;
      case "CallExpression":
      case "OptionalCallExpression": {
        const callee = node["callee"];
        if (!isAstNode(callee) || !isPureCalleeNode(callee)) {
          found = true;
          return;
        }
        break;
      }
      case "MemberExpression":
      case "OptionalMemberExpression":
        if (isAstNode(node["object"])) check(node["object"]);
        if (node["computed"] === true && isAstNode(node["property"])) check(node["property"]);
        return;
      case "ObjectProperty":
        if (node["computed"] === true && isAstNode(node["key"])) check(node["key"]);
        if (isAstNode(node["value"])) check(node["value"]);
        return;
      default:
        break;
    }
    forEachChild(node, check);
  };
  forEachChild(fn, check);
  return found;
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
    found = nameIsState(name, unit, states);
  });
  return found;
}

/** 名前そのものが状態変数（最上位の let・var）か、その名前のプロパティが状態変数（引数のプロパティ）か。 */
function nameIsState(name: string, unit: ExtractionUnit, states: StateModel): boolean {
  if (states.lookup(unit.location.file, unit.componentScope, name) !== null) return true;
  return states.states.some(
    (state) =>
      state.scope === "PARAMETER" &&
      state.owner === unit.componentScope &&
      state.unit.location.file === unit.location.file &&
      state.unit.name.startsWith(`${name}.`),
  );
}

/** 構文木の子をたどる（位置・コメントの項目は除く）。 */
function forEachChild(node: AstNode, visit: (child: AstNode) => void): void {
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra" || key.endsWith("Comments")) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isAstNode(item)) visit(item);
    } else if (isAstNode(value)) {
      visit(value);
    }
  }
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