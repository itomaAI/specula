// ユニットを作る（M1 の設計 2.3・4、M1 の計画「ユニットの種類」「状態変数」）。
// 識別子は所在から作る（"<ファイル>:<行>:<列>:<種類>"）。同じ識別子は 1 度だけ登録する。

import type { ExtractionLayer, ExtractionUnit, ExtractionUnitKind } from "../../types/context.js";
import { type AstNode, identifierName, isAstNode } from "../m0/ast.js";
import { type LoadedFile, sourceText, startOf } from "./source_loader.js";

type Details = Record<string, string | number | boolean | null>;

const LAYER_OF: Record<ExtractionUnitKind, ExtractionLayer> = {
  STATE: "LOGIC",
  STATE_WRITE: "LOGIC",
  OPERATION: "UI",
  INTERFACE_TEXT: "UI",
  BRANCH_CONDITION: "LOGIC",
  API_ENDPOINT: "LOGIC",
  DATA_MUTATION: "DATABASE",
  SCHEMA_ENTITY: "DATABASE",
  CALL: "LOGIC",
  RETURN: "LOGIC",
  THROW: "LOGIC",
  ASYNC_CUT: "ASYNC_TRIGGER",
  EXTERNAL_CALL: "LOGIC",
  RECURSION: "LOGIC",
};

export function unitId(file: string, line: number, column: number, kind: ExtractionUnitKind): string {
  return `${file}:${line}:${column}:${kind}`;
}

export class UnitCollector {
  private readonly units = new Map<string, ExtractionUnit>();
  /** 状態変数の名前（ファイルとクラスで区切る）→ STATE の識別子。 */
  private readonly states = new Map<string, string>();

  /** ユニットを登録して識別子を返す。同じ識別子が既にあれば、先のものを残す。 */
  add(
    file: string,
    position: { line: number; column: number },
    kind: ExtractionUnitKind,
    name: string,
    scope: string | undefined,
    details?: Details,
  ): string {
    const id = unitId(file, position.line, position.column, kind);
    if (!this.units.has(id)) {
      const unit: ExtractionUnit = {
        id,
        kind,
        name,
        layer: LAYER_OF[kind],
        location: { file, line: position.line, column: position.column },
      };
      if (scope !== undefined) unit.componentScope = scope;
      if (details !== undefined) unit.details = details;
      this.units.set(id, unit);
    }
    return id;
  }

  has(id: string): boolean {
    return this.units.has(id);
  }

  get(id: string): ExtractionUnit | undefined {
    return this.units.get(id);
  }

  /** ファイル → 行 → 列 → 種類の順。 */
  sorted(): ExtractionUnit[] {
    return [...this.units.values()].sort(compareUnits);
  }

  /**
   * 代入の左辺が状態変数なら、その STATE を（無ければ作って）返す。状態変数でなければ null。
   * - 同じファイルの最上位の let・var（所在は宣言、initial は初期値の式）
   * - this.x（クラスのメソッドの中。所在は最初の書き込み）
   * - 引数のプロパティ p.x（所在は引数）
   */
  stateOf(
    file: LoadedFile,
    target: AstNode,
    fn: { node: AstNode; symbol: string; className?: string },
  ): { id: string; name: string } | null {
    const name = identifierName(target);
    if (name !== null) {
      const declarator = moduleLevelMutable(file, name);
      if (declarator === null) return null;
      const key = `${file.path}#${name}`;
      const initial = sourceTextOrNull(file, declarator["init"]);
      return { id: this.stateUnit(key, file, declarator, name, fn.symbol, { initial, scope: "MODULE", owner: null }), name };
    }
    if ((target.type !== "MemberExpression" && target.type !== "OptionalMemberExpression") || target["computed"] === true) {
      return null;
    }
    const property = identifierName(target["property"]);
    const object = target["object"];
    if (property === null || !isAstNode(object)) return null;
    if (object.type === "ThisExpression") {
      const stateName = `this.${property}`;
      const owner = fn.className ?? fn.symbol;
      const key = `${file.path}#${owner}#${stateName}`;
      return { id: this.stateUnit(key, file, target, stateName, fn.symbol, { initial: null, scope: "CLASS", owner }), name: stateName };
    }
    const objectName = identifierName(object);
    if (objectName === null) return null;
    const param = parameterNamed(fn.node, objectName);
    if (param === null) return null;
    const stateName = `${objectName}.${property}`;
    const key = `${file.path}#${fn.symbol}#${stateName}`;
    return {
      id: this.stateUnit(key, file, param, stateName, fn.symbol, { initial: null, scope: "PARAMETER", owner: fn.symbol }),
      name: stateName,
    };
  }

  /**
   * STATE を（無ければ）作る。componentScope は最初に書き込んだ関数で、区切りとは一致しない。
   * 区切りは details の scope（MODULE・CLASS・PARAMETER）と owner（クラス名か関数の symbol。MODULE は null）で渡す。
   */
  private stateUnit(
    key: string,
    file: LoadedFile,
    at: AstNode,
    name: string,
    scope: string,
    details: { initial: string | null; scope: "MODULE" | "CLASS" | "PARAMETER"; owner: string | null },
  ): string {
    const existing = this.states.get(key);
    if (existing !== undefined) return existing;
    const id = this.add(file.path, startOf(at), "STATE", name, scope, details);
    this.states.set(key, id);
    return id;
  }
}

function compareUnits(a: ExtractionUnit, b: ExtractionUnit): number {
  if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
  if (a.location.line !== b.location.line) return a.location.line - b.location.line;
  if (a.location.column !== b.location.column) return a.location.column - b.location.column;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/** 最上位（export の内側を含む）の let・var の宣言子。 */
function moduleLevelMutable(file: LoadedFile, name: string): AstNode | null {
  const body = file.program["body"];
  if (!Array.isArray(body)) return null;
  for (const statement of body) {
    if (!isAstNode(statement)) continue;
    const declaration = statement.type === "ExportNamedDeclaration" ? statement["declaration"] : statement;
    if (!isAstNode(declaration) || declaration.type !== "VariableDeclaration") continue;
    if (declaration["kind"] !== "let" && declaration["kind"] !== "var") continue;
    const declarators = declaration["declarations"];
    if (!Array.isArray(declarators)) continue;
    for (const declarator of declarators) {
      if (isAstNode(declarator) && identifierName(declarator["id"]) === name) return declarator;
    }
  }
  return null;
}

/** 関数の引数のうち、その名前の識別子（既定値つき・型注釈つきを含む）。 */
function parameterNamed(fn: AstNode, name: string): AstNode | null {
  const params = fn["params"];
  if (!Array.isArray(params)) return null;
  for (const param of params) {
    if (!isAstNode(param)) continue;
    const inner = param.type === "AssignmentPattern" ? param["left"] : param.type === "TSParameterProperty" ? param["parameter"] : param;
    if (identifierName(inner) === name && isAstNode(inner)) return inner;
  }
  return null;
}

function sourceTextOrNull(file: LoadedFile, node: unknown): string | null {
  const text = sourceText(file, node);
  return text === "" ? null : text;
}

/** 呼び出しの details（callee・args・receiver）。args は引数の原文を JSON の配列にした文字列。 */
export function callDetails(file: LoadedFile, call: AstNode): { callee: string; args: string; receiver: string | null } {
  const callee = call["callee"];
  const args = call["arguments"];
  const argTexts = Array.isArray(args) ? args.map((arg) => sourceText(file, arg)) : [];
  let receiver: string | null = null;
  if (isAstNode(callee) && (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression")) {
    receiver = sourceText(file, callee["object"]);
  }
  return { callee: sourceText(file, callee), args: JSON.stringify(argTexts), receiver };
}