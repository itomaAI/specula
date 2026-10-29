// 状態変数を作る（M2 の設計 2.1）。ドメイン・値の識別子・初期値・書き込みの訳と、名前の照合の表。
//
// 決めたこと（設計 02 に書く）:
// - 値の並び（ENUM）は、初期値 → 書き込み（ユニットの並び順）の順で、初めて出た順。同じ値は 1 つにまとめる。
// - 最上位の let・var で初期値が無いものは、初期値を undefined のリテラルとする（JavaScript の意味どおり）。
// - BOOL で初期値が決まらないときは、Bool に値を足さず、初期値を制約しない（Bool は 2 値なので、すべての場合を含む）。
//   ENUM で初期値が決まらないときは、値 "v<n>_unknown" を足して初期値にする（設計 2.1）。
// - 名前の照合の区切りは、M1 の STATE の details.scope と owner で決める（componentScope は使わない）。

import { parseExpression } from "@babel/parser";
import type { ExtractionUnit, UnitLocation } from "../../types/context.js";
import type { StateDomain, StateVariable, WriteChange } from "../../types/formal.js";
import { type AstNode, identifierName, isAstNode } from "../m0/ast.js";
import type { CheckedFacts } from "./contract.js";

/** リテラルの値（ENUM の値と、条件の評価に使う）。 */
export interface Literal {
  /** 同じ値を 1 つにまとめるための正準の文字列（"true"・"0"・"\"a\""・"null"・"undefined"）。 */
  text: string;
  value: boolean | number | string | null | undefined;
}

export interface BuiltState {
  variable: StateVariable;
  unit: ExtractionUnit;
  /** STATE の区切り（M1 の details.scope）。 */
  scope: "MODULE" | "CLASS" | "PARAMETER";
  owner: string | null;
  /** ENUM の値（識別子とリテラル）。"v<n>_unknown" は含まない。 */
  literals: Array<{ id: string; literal: Literal }>;
  /** 初期値が決まらない ENUM の値の識別子。無ければ null。 */
  unknownId: string | null;
  /** 書き込みの式のどれかがドメインを決められなかった。 */
  undetermined: boolean;
}

export interface UndeterminedWrite {
  unitIds: string[];
  location: UnitLocation;
  detail: string;
}

export interface StateModel {
  states: BuiltState[];
  byUnit: ReadonlyMap<string, BuiltState>;
  /** STATE_WRITE の識別子 → 訳した書き込み（ドメインが決まった書き込みだけ）。 */
  writes: ReadonlyMap<string, { state: BuiltState; change: WriteChange }>;
  undeterminedWrites: UndeterminedWrite[];
  /**
   * 条件の式の中の名前（"x"・"this.x"・"p.x"）を、その条件のユニットの所在と関数から状態変数に結び付ける。
   * 区切りが違う同じ名前には結び付けない。
   */
  lookup(file: string, componentScope: string | undefined, path: string): BuiltState | null;
}

/** 式の原文を構文木にする（TypeScript の構文を含む）。読めなければ null。 */
export function parseExpr(text: string): AstNode | null {
  try {
    const node = parseExpression(text, { plugins: ["typescript"] }) as unknown;
    return isAstNode(node) ? unwrap(node) : null;
  } catch {
    return null;
  }
}

/** かっこ・型の注釈（as・!・<T>・satisfies）を外す。 */
export function unwrap(node: AstNode): AstNode {
  let current = node;
  for (;;) {
    if (
      current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSTypeAssertion" ||
      current.type === "TSSatisfiesExpression"
    ) {
      const inner = current["expression"];
      if (!isAstNode(inner)) return current;
      current = inner;
      continue;
    }
    return current;
  }
}

/** リテラルなら値を返す（真偽値・数値・文字列・null・undefined・-数値・式の無いテンプレート）。 */
export function literalOf(input: unknown): Literal | null {
  if (!isAstNode(input)) return null;
  const node = unwrap(input);
  switch (node.type) {
    case "BooleanLiteral":
      return node["value"] === true ? { text: "true", value: true } : { text: "false", value: false };
    case "NumericLiteral": {
      const value = node["value"];
      return typeof value === "number" ? { text: String(value), value } : null;
    }
    case "StringLiteral": {
      const value = node["value"];
      return typeof value === "string" ? { text: JSON.stringify(value), value } : null;
    }
    case "NullLiteral":
      return { text: "null", value: null };
    case "Identifier":
      return node["name"] === "undefined" ? { text: "undefined", value: undefined } : null;
    case "UnaryExpression": {
      if (node["operator"] !== "-") return null;
      const inner = literalOf(node["argument"]);
      return inner !== null && typeof inner.value === "number" ? { text: String(-inner.value), value: -inner.value } : null;
    }
    case "TemplateLiteral": {
      const expressions = node["expressions"];
      const quasis = node["quasis"];
      if (!Array.isArray(expressions) || expressions.length !== 0 || !Array.isArray(quasis) || quasis.length !== 1) return null;
      const quasi = quasis[0];
      const cooked = isAstNode(quasi) && typeof quasi["value"] === "object" && quasi["value"] !== null
        ? (quasi["value"] as { cooked?: unknown }).cooked
        : undefined;
      return typeof cooked === "string" ? { text: JSON.stringify(cooked), value: cooked } : null;
    }
    default:
      return null;
  }
}

/** 名前の道筋（"x"・"this.x"・"a.b.c"）。計算されたプロパティなどは null。 */
export function memberPath(input: unknown): string | null {
  if (!isAstNode(input)) return null;
  const node = unwrap(input);
  if (node.type === "ThisExpression") return "this";
  const name = identifierName(node);
  if (name !== null && node.type === "Identifier") return name;
  if ((node.type === "MemberExpression" || node.type === "OptionalMemberExpression") && node["computed"] !== true) {
    const object = memberPath(node["object"]);
    const property = identifierName(node["property"]);
    return object === null || property === null ? null : `${object}.${property}`;
  }
  return null;
}

/** 書き込みの式を分類した結果。 */
type WriteShape =
  | { kind: "LITERAL"; literal: Literal }
  | { kind: "ADD"; amount: number }
  | { kind: "OTHER" };

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** 書き込みの式（"x = 1"・"x++"・"x += 2"・"x = x - 1"）を分類する（設計 2.1 の表）。 */
export function shapeOfWrite(expression: string): WriteShape {
  const node = parseExpr(expression);
  if (node === null) return { kind: "OTHER" };
  if (node.type === "UpdateExpression") {
    return { kind: "ADD", amount: node["operator"] === "--" ? -1 : 1 };
  }
  if (node.type !== "AssignmentExpression") return { kind: "OTHER" };
  const operator = node["operator"];
  const right = node["right"];
  if (operator === "+=" || operator === "-=") {
    const literal = literalOf(right);
    if (literal === null || !isInteger(literal.value)) return { kind: "OTHER" };
    return { kind: "ADD", amount: operator === "-=" ? -literal.value : literal.value };
  }
  if (operator !== "=") return { kind: "OTHER" };
  const literal = literalOf(right);
  if (literal !== null) return { kind: "LITERAL", literal };
  // x = x + N・x = x - N
  if (isAstNode(right)) {
    const inner = unwrap(right);
    if (inner.type === "BinaryExpression" && (inner["operator"] === "+" || inner["operator"] === "-")) {
      const self = memberPath(node["left"]);
      const amount = literalOf(inner["right"]);
      if (self !== null && memberPath(inner["left"]) === self && amount !== null && isInteger(amount.value)) {
        return { kind: "ADD", amount: inner["operator"] === "-" ? -amount.value : amount.value };
      }
    }
  }
  return { kind: "OTHER" };
}

function stringDetail(unit: ExtractionUnit, key: string): string | null {
  const value = unit.details?.[key];
  return typeof value === "string" ? value : null;
}

/** 状態変数を作る（STATE のユニットの並び順に v1, v2, …）。 */
export function buildStates(checked: CheckedFacts): StateModel {
  const states: BuiltState[] = [];
  const byUnit = new Map<string, BuiltState>();
  const writes = new Map<string, { state: BuiltState; change: WriteChange }>();
  const undeterminedWrites: UndeterminedWrite[] = [];
  const table = new Map<string, BuiltState>();

  const writesOf = new Map<string, ExtractionUnit[]>();
  for (const unit of checked.facts.units) {
    if (unit.kind !== "STATE_WRITE") continue;
    const target = stringDetail(unit, "target") as string;
    const list = writesOf.get(target) ?? [];
    list.push(unit);
    writesOf.set(target, list);
  }

  let index = 0;
  for (const unit of checked.facts.units) {
    if (unit.kind !== "STATE") continue;
    index += 1;
    const id = `v${index}`;
    const scopeDetail = stringDetail(unit, "scope");
    const scope = scopeDetail === "CLASS" || scopeDetail === "PARAMETER" ? scopeDetail : "MODULE";
    const owner = stringDetail(unit, "owner");
    const initialText = stringDetail(unit, "initial");

    // 初期値: MODULE で式が無ければ undefined。式があればリテラルか。CLASS・PARAMETER は決まらない。
    let initialLiteral: Literal | null = null;
    if (scope === "MODULE") {
      initialLiteral = initialText === null ? { text: "undefined", value: undefined } : literalOf(parseExpr(initialText));
    }

    const shapes = (writesOf.get(unit.id) ?? []).map((write) => ({
      write,
      shape: shapeOfWrite(stringDetail(write, "expression") as string),
    }));
    const hasAdd = shapes.some((item) => item.shape.kind === "ADD");
    const setLiterals = shapes.flatMap((item) => (item.shape.kind === "LITERAL" ? [item.shape.literal] : []));

    let domain: StateDomain;
    if (hasAdd) {
      domain = "INT";
    } else if (
      setLiterals.every((literal) => typeof literal.value === "boolean") &&
      (initialLiteral === null || typeof initialLiteral.value === "boolean") &&
      (setLiterals.length > 0 || initialLiteral !== null)
    ) {
      domain = "BOOL";
    } else {
      domain = "ENUM";
    }

    const built: BuiltState = {
      variable: { id, unitId: unit.id, domain, values: [], valueLiterals: {}, initial: null },
      unit,
      scope,
      owner,
      literals: [],
      unknownId: null,
      undetermined: false,
    };

    const enumId = (literal: Literal): string => {
      const found = built.literals.find((item) => item.literal.text === literal.text);
      if (found !== undefined) return found.id;
      const valueId = `${id}_${built.literals.length + 1}`;
      built.literals.push({ id: valueId, literal });
      return valueId;
    };

    // 初期値
    if (domain === "INT") {
      built.variable.initial = initialLiteral !== null && isInteger(initialLiteral.value) ? String(initialLiteral.value) : null;
    } else if (domain === "BOOL") {
      built.variable.initial = initialLiteral === null ? null : initialLiteral.value === true ? "True" : "False";
    } else if (initialLiteral !== null) {
      built.variable.initial = enumId(initialLiteral);
    }

    // 書き込み
    for (const { write, shape } of shapes) {
      let change: WriteChange | null = null;
      if (shape.kind === "ADD" && domain === "INT") {
        change = { op: "ADD", amount: shape.amount };
      } else if (shape.kind === "LITERAL") {
        if (domain === "INT") {
          change = isInteger(shape.literal.value) ? { op: "SET", value: shape.literal.value } : null;
        } else if (domain === "BOOL") {
          change = { op: "SET", value: shape.literal.value === true ? "True" : "False" };
        } else {
          change = { op: "SET", value: enumId(shape.literal) };
        }
      }
      if (change === null) {
        built.undetermined = true;
        undeterminedWrites.push({
          unitIds: [write.id],
          location: write.location,
          detail: stringDetail(write, "expression") as string,
        });
        continue;
      }
      writes.set(write.id, { state: built, change });
    }

    if (domain === "ENUM") {
      if (built.variable.initial === null) {
        built.unknownId = `${id}_unknown`;
        built.variable.initial = built.unknownId;
      }
      built.variable.values = built.literals.map((item) => item.id);
      if (built.unknownId !== null) built.variable.values.push(built.unknownId);
      for (const item of built.literals) built.variable.valueLiterals[item.id] = item.literal.text;
    }

    states.push(built);
    byUnit.set(unit.id, built);
    table.set(tableKey(unit.location.file, scope, owner, unit.name), built);
  }

  return {
    states,
    byUnit,
    writes,
    undeterminedWrites,
    lookup(file, componentScope, path) {
      if (!path.includes(".")) return table.get(tableKey(file, "MODULE", null, path)) ?? null;
      if (path.startsWith("this.")) {
        if (componentScope === undefined) return null;
        // M1 の owner はクラス名（クラスのメソッド "C.m" なら "C"）か、クラスの外なら関数の symbol そのもの。
        const dot = componentScope.indexOf(".");
        const className = dot > 0 ? componentScope.slice(0, dot) : componentScope;
        return table.get(tableKey(file, "CLASS", className, path)) ?? table.get(tableKey(file, "CLASS", componentScope, path)) ?? null;
      }
      if (componentScope === undefined) return null;
      return table.get(tableKey(file, "PARAMETER", componentScope, path)) ?? null;
    },
  };
}

function tableKey(file: string, scope: string, owner: string | null, name: string): string {
  return `${file}#${scope}#${owner ?? ""}#${name}`;
}