// 条件の式を GuardExpr と命題に訳す（M2 の設計 2.3・3.2）。
//
// - 条件のユニットは、ユニットの並び順に 1 度だけ訳して使い回す（命題の番号を入力だけで決めるため）。
// - 命題は出現ごと。識別子の元は「条件のユニットの識別子」と「式の中の開始位置」。同じ条件のユニットを
//   複数のスライスや書き込みの guardTerms が指しても、同じ命題になる。
// - 必ず命題にするもの: for…of・for…in の条件（繰り返す対象の式で、真偽ではない）、catch の条件（式 "catch"）、
//   構文木にできない式。どれも式全体を 1 つの命題にする。
// - 状態変数とリテラルの比較は、真偽値と列挙では値ごとに JavaScript の意味で評価し、成り立つ値の OR にする。
//   列挙で初期値が決まらない値（v<n>_unknown）は、その値のとき成り立つかを命題にする（推測しない）。
// - AND の引数が空なら真、OR の引数が空なら偽（AlloyPrinter がそう書く）。

import type { ExtractionUnit } from "../../types/context.js";
import type { GuardExpr, Proposition } from "../../types/formal.js";
import { type AstNode, isAstNode } from "../m0/ast.js";
import type { CheckedFacts } from "./contract.js";
import { type BuiltState, type Literal, type StateModel, literalOf, memberPath, parseExpr, unwrap } from "./states.js";

type Cmp = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

const EQUALITY = new Set(["===", "==", "!==", "!="]);
const RELATIONAL = new Set(["<", "<=", ">", ">="]);
const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

export interface GuardTranslation {
  /** 条件のユニットの識別子 → 訳した式（holds は含まない）。 */
  byUnit: ReadonlyMap<string, GuardExpr>;
  /** 命題（作った順。c1, c2, …）。 */
  propositions: Proposition[];
}

export function translateGuards(checked: CheckedFacts, states: StateModel): GuardTranslation {
  const byUnit = new Map<string, GuardExpr>();
  const propositions: Proposition[] = [];
  for (const unit of checked.facts.units) {
    if (unit.kind !== "BRANCH_CONDITION") continue;
    byUnit.set(unit.id, new ConditionTranslator(unit, states, propositions).translate());
  }
  return { byUnit, propositions };
}

class ConditionTranslator {
  private readonly text: string;

  constructor(
    private readonly unit: ExtractionUnit,
    private readonly states: StateModel,
    private readonly propositions: Proposition[],
  ) {
    const expression = unit.details?.["expression"];
    this.text = typeof expression === "string" ? expression : unit.name;
  }

  translate(): GuardExpr {
    const loop = this.unit.details?.["loop"];
    const branch = this.unit.details?.["branch"];
    if (loop === "FOR_OF" || loop === "FOR_IN" || branch === "CATCH") return this.wholeProp();
    const node = parseExpr(this.text);
    if (node === null) return this.wholeProp();
    return this.expr(node);
  }

  private wholeProp(): GuardExpr {
    return this.prop(this.text);
  }

  /**
   * 命題を 1 つ作る。番号は作った順（条件のユニットの並び → 式の評価の順）なので、
   * 「条件のユニット」と「式の中の位置」で出現を区別したことになる。
   */
  private prop(expression: string): GuardExpr {
    const id = `c${this.propositions.length + 1}`;
    this.propositions.push({ id, unitId: this.unit.id, expression });
    return { op: "PROP", prop: id };
  }

  private propOf(node: AstNode): GuardExpr {
    const start = typeof node["start"] === "number" ? node["start"] : 0;
    const end = typeof node["end"] === "number" ? node["end"] : this.text.length;
    return this.prop(this.text.slice(start, end));
  }

  private expr(input: AstNode): GuardExpr {
    const node = unwrap(input);
    if (node.type === "UnaryExpression" && node["operator"] === "!" && isAstNode(node["argument"])) {
      return { op: "NOT", arg: this.expr(node["argument"]) };
    }
    if (node.type === "LogicalExpression" && (node["operator"] === "&&" || node["operator"] === "||")) {
      const left = node["left"];
      const right = node["right"];
      if (isAstNode(left) && isAstNode(right)) {
        return { op: node["operator"] === "&&" ? "AND" : "OR", args: [this.expr(left), this.expr(right)] };
      }
    }
    if (node.type === "BinaryExpression" && typeof node["operator"] === "string") {
      const translated = this.comparison(node, node["operator"]);
      if (translated !== null) return translated;
      return this.propOf(node);
    }
    const state = this.stateOf(node);
    if (state !== null) return this.truthy(state, node);
    if (node.type === "BooleanLiteral") return node["value"] === true ? { op: "AND", args: [] } : { op: "OR", args: [] };
    return this.propOf(node);
  }

  private stateOf(node: AstNode): BuiltState | null {
    const path = memberPath(node);
    if (path === null || path === "this") return null;
    return this.states.lookup(this.unit.location.file, this.unit.componentScope, path);
  }

  /** 状態変数がそのまま条件になっている（if (flag)）。 */
  private truthy(state: BuiltState, node: AstNode): GuardExpr {
    const variable = state.variable.id;
    if (state.variable.domain === "BOOL") return { op: "IS", variable, value: "True" };
    if (state.variable.domain === "INT") return { op: "CMP", variable, cmp: "neq", value: 0 };
    return this.enumWhere(state, (value) => Boolean(value), node);
  }

  /** 状態変数とリテラルの比較。どちらにも当たらなければ null（命題にする）。 */
  private comparison(node: AstNode, operator: string): GuardExpr | null {
    if (!EQUALITY.has(operator) && !RELATIONAL.has(operator)) return null;
    const left = node["left"];
    const right = node["right"];
    if (!isAstNode(left) || !isAstNode(right)) return null;
    let state = this.stateOf(left);
    let literal = literalOf(right);
    let op = operator;
    if (state === null || literal === null) {
      state = this.stateOf(right);
      literal = literalOf(left);
      op = FLIP[operator] ?? operator;
    }
    if (state === null || literal === null) return null;
    const variable = state.variable.id;
    const value = literal.value;

    if (state.variable.domain === "INT") {
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return { op: "CMP", variable, cmp: cmpOf(op), value };
      }
      if (EQUALITY.has(op)) {
        // 整数とほかの値の比較: === は偽、!== は真。== は JavaScript の型の変換があるので命題にする。
        if (op === "===") return { op: "OR", args: [] };
        if (op === "!==") return { op: "AND", args: [] };
      }
      return null;
    }
    const holds = (current: Literal["value"]): boolean => compare(current, op, value);
    if (state.variable.domain === "BOOL") {
      const args: GuardExpr[] = [];
      if (holds(true)) args.push({ op: "IS", variable, value: "True" });
      if (holds(false)) args.push({ op: "IS", variable, value: "False" });
      return { op: "OR", args };
    }
    return this.enumWhere(state, holds, node);
  }

  /** 列挙の値のうち pred が成り立つものの OR。初期値が決まらない値では、成り立つかを命題にする。 */
  private enumWhere(state: BuiltState, pred: (value: Literal["value"]) => boolean, node: AstNode): GuardExpr {
    const variable = state.variable.id;
    const args: GuardExpr[] = state.literals
      .filter((item) => pred(item.literal.value))
      .map((item) => ({ op: "IS", variable, value: item.id }) as GuardExpr);
    if (state.unknownId !== null) {
      args.push({ op: "AND", args: [{ op: "IS", variable, value: state.unknownId }, this.propOf(node)] });
    }
    return { op: "OR", args };
  }
}

function cmpOf(operator: string): Cmp {
  switch (operator) {
    case "===":
    case "==":
      return "eq";
    case "!==":
    case "!=":
      return "neq";
    case "<":
      return "lt";
    case "<=":
      return "lte";
    case ">":
      return "gt";
    default:
      return "gte";
  }
}

/** JavaScript の意味での比較（左がいまの値、右がリテラル）。 */
function compare(left: Literal["value"], operator: string, right: Literal["value"]): boolean {
  /* eslint-disable eqeqeq */
  switch (operator) {
    case "===":
      return left === right;
    case "!==":
      return left !== right;
    case "==":
      return left == right;
    case "!=":
      return left != right;
    case "<":
      return (left as number) < (right as number);
    case "<=":
      return (left as number) <= (right as number);
    case ">":
      return (left as number) > (right as number);
    case ">=":
      return (left as number) >= (right as number);
    default:
      return false;
  }
  /* eslint-enable eqeqeq */
}