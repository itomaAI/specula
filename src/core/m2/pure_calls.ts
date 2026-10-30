// 状態を変えない組み込みのメソッドとの照合（M2 の設計 5 の表の下の規則）。
//
// - 名前だけで照合し、型は見ない（限界は設計 5 に書いてある）。
// - メソッドは callee の最後のプロパティの名前で照合する。
// - 静的なメソッドと大域の関数は callee の原文全体で照合する。受け手が Object・Array などの大域のオブジェクトのときは、
//   メソッドの一覧は使わない（Object.assign を配列の keys などと取り違えないため）。

import { type AstNode, isAstNode } from "../m0/ast.js";
import { parseExpr, unwrap } from "./states.js";

/** 受け手を変えない配列・文字列・Map・Set のメソッド。 */
const PURE_METHODS: ReadonlySet<string> = new Set([
  // 配列
  "map",
  "filter",
  "reduce",
  "reduceRight",
  "slice",
  "concat",
  "join",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "indexOf",
  "lastIndexOf",
  "includes",
  "flat",
  "flatMap",
  "at",
  "entries",
  "keys",
  "values",
  "forEach",
  "toSorted",
  "toReversed",
  "toSpliced",
  "with",
  // 文字列
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "split",
  "replace",
  "replaceAll",
  "startsWith",
  "endsWith",
  "padStart",
  "padEnd",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "substring",
  "localeCompare",
  "normalize",
  "repeat",
  "match",
  "matchAll",
  "search",
  "toString",
  // Map・Set
  "get",
  "has",
]);

/** 引数を変えない静的なメソッド（Math は名前によらずすべて）。 */
const PURE_STATIC: ReadonlySet<string> = new Set([
  "Object.keys",
  "Object.values",
  "Object.entries",
  "Array.isArray",
  "Array.from",
  "JSON.stringify",
  "JSON.parse",
  "Number.isInteger",
  "Number.isFinite",
  "Number.isNaN",
]);

/** 引数を変えない大域の関数。 */
const PURE_GLOBALS: ReadonlySet<string> = new Set(["String", "Number", "Boolean", "parseInt", "parseFloat"]);

/** 静的なメソッドを持つ大域のオブジェクト。これが受け手のときは PURE_STATIC だけで照合する。 */
const NAMESPACES: ReadonlySet<string> = new Set([
  "Object",
  "Array",
  "JSON",
  "Math",
  "Number",
  "String",
  "Reflect",
  "Promise",
  "Date",
  "Symbol",
  "BigInt",
  "Atomics",
  "Intl",
]);

/** callee の原文が、状態を変えない組み込みのメソッドか。読めない原文は false（慎重側）。 */
export function isPureCallee(calleeText: string): boolean {
  const node = parseExpr(calleeText);
  return node !== null && isPureCalleeNode(node);
}

/** callee の構文木が、状態を変えない組み込みのメソッドか。 */
export function isPureCalleeNode(input: AstNode): boolean {
  const node = unwrap(input);
  if (node.type === "Identifier") {
    const global: unknown = node["name"];
    return typeof global === "string" && PURE_GLOBALS.has(global);
  }
  if (node.type !== "MemberExpression" && node.type !== "OptionalMemberExpression") return false;
  if (node["computed"] === true) return false;
  const property = node["property"];
  if (!isAstNode(property) || property.type !== "Identifier") return false;
  const name: unknown = property["name"];
  if (typeof name !== "string") return false;
  const objectNode = node["object"];
  const object = isAstNode(objectNode) ? unwrap(objectNode) : null;
  const namespace: unknown = object !== null && object.type === "Identifier" ? object["name"] : null;
  if (typeof namespace === "string" && NAMESPACES.has(namespace)) {
    if (namespace === "Math") return true;
    return PURE_STATIC.has(`${namespace}.${name}`);
  }
  return PURE_METHODS.has(name);
}