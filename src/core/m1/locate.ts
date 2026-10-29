// 起点の関数と、呼び出し先の関数の定義を見つける（M1 の設計 2.1、M1 の計画「起点」「ユニットの種類」）。
// 呼び出し先を AST から決められないものは、推測せずに理由を返す（EXTERNAL_CALL として記録される）。

import { InletNotFoundError } from "../../types/context.js";
import type { ScenarioTarget } from "../../types/scenario.js";
import { type AstNode, describeCallee, exportsOf, identifierName, isAstNode, lineOf, stringValue, walk } from "../m0/ast.js";
import type { LoadedFile, SourceLoader } from "./source_loader.js";

/** たどる関数 1 つ。className はクラスのメソッドのときだけ。 */
export interface FunctionRef {
  file: LoadedFile;
  /** 関数の名前（"default"、"クラス名.メソッド名" を含む）。 */
  symbol: string;
  /** 関数のノード（FunctionDeclaration・FunctionExpression・ArrowFunctionExpression・ClassMethod）。 */
  node: AstNode;
  line: number;
  className?: string;
}

export type ExternalReason = "PACKAGE" | "UNRESOLVED" | "METHOD" | "DYNAMIC" | "CONSTRUCTOR";

export type CalleeResolution = { kind: "TRACE"; ref: FunctionRef } | { kind: "EXTERNAL"; reason: ExternalReason };

const LISTENER_METHODS = new Set(["on", "once", "addListener", "addEventListener", "subscribe"]);

/** 関数として扱うノードか（クラスのメソッドを含む）。 */
export function isCallableNode(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "ClassMethod" ||
    node.type === "ClassPrivateMethod" ||
    node.type === "ObjectMethod"
  );
}

/** 関数の識別子（再帰と使い回しのキー）。 */
export function refKey(ref: FunctionRef): string {
  return `${ref.file.path}#${ref.symbol}`;
}

/** 起点の関数を見つける。見つからなければ InletNotFoundError（別の関数を起点にしない）。 */
export async function locateInlet(loader: SourceLoader, target: ScenarioTarget): Promise<FunctionRef> {
  const { file: path, symbol, line } = target.inletTrigger.handler;
  if (!(await loader.exists(path))) throw new InletNotFoundError(path, symbol, "ファイルが無い");
  const file = await loader.load(path);
  if (target.inletType === "COMMAND") {
    const ref = findFunction(file, symbol);
    if (ref === null) throw new InletNotFoundError(path, symbol, "その名前の関数が無い");
    return ref;
  }
  // POLICY: 所在はリスナーの登録の場所。その行の登録の 2 番目の引数を解決する。
  let listenerCall: AstNode | null = null;
  walk(file.program, (node) => {
    if (listenerCall !== null || node.type !== "CallExpression" || lineOf(node) !== line) return;
    const callee = describeCallee(node);
    if (callee === null || callee.chain.length === 0 || !LISTENER_METHODS.has(callee.name)) return;
    const args = node["arguments"];
    if (Array.isArray(args) && stringValue(args[0]) !== null) listenerCall = node;
  });
  if (listenerCall === null) throw new InletNotFoundError(path, symbol, `${line} 行目にリスナーの登録が無い`);
  const args = (listenerCall as AstNode)["arguments"] as unknown[];
  const handlerName = identifierName(args[1]);
  if (handlerName === null) throw new InletNotFoundError(path, symbol, "リスナーに渡された関数を名前で決められない");
  const resolved = await resolveName(loader, file, handlerName);
  if (resolved.kind !== "TRACE") throw new InletNotFoundError(path, symbol, `リスナーに渡された関数をたどれない（${resolved.reason}）`);
  return resolved.ref;
}

/** ファイルの中の関数を名前で探す（最上位の関数、"default"、"クラス名.メソッド名"）。 */
export function findFunction(file: LoadedFile, symbol: string): FunctionRef | null {
  const dot = symbol.indexOf(".");
  if (dot > 0) return findClassMethod(file, symbol.slice(0, dot), symbol.slice(dot + 1));
  const top = file.functions.get(symbol);
  if (top !== undefined) return { file, symbol, node: top.node, line: top.line };
  if (symbol === "default") return findDefaultFunction(file);
  return null;
}

function findDefaultFunction(file: LoadedFile): FunctionRef | null {
  const body = file.program["body"];
  if (!Array.isArray(body)) return null;
  for (const statement of body) {
    if (!isAstNode(statement) || statement.type !== "ExportDefaultDeclaration") continue;
    const declaration = statement["declaration"];
    if (!isAstNode(declaration)) return null;
    if (isCallableNode(declaration)) return { file, symbol: "default", node: declaration, line: lineOf(declaration) };
    const name = identifierName(declaration);
    if (name !== null) {
      const top = file.functions.get(name);
      if (top !== undefined) return { file, symbol: name, node: top.node, line: top.line };
    }
    return null;
  }
  return null;
}

/** 最上位（export の内側を含む）のクラスのメソッド。 */
export function findClassMethod(file: LoadedFile, className: string, methodName: string): FunctionRef | null {
  const body = file.program["body"];
  if (!Array.isArray(body)) return null;
  for (const statement of body) {
    if (!isAstNode(statement)) continue;
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement["declaration"]
        : statement;
    if (!isAstNode(declaration) || declaration.type !== "ClassDeclaration") continue;
    if (identifierName(declaration["id"]) !== className) continue;
    const classBody = declaration["body"];
    const members = isAstNode(classBody) ? classBody["body"] : null;
    if (!Array.isArray(members)) return null;
    for (const member of members) {
      if (!isAstNode(member) || member.type !== "ClassMethod" || member["computed"] === true) continue;
      if (identifierName(member["key"]) === methodName) {
        return { file, symbol: `${className}.${methodName}`, node: member, line: lineOf(member), className };
      }
    }
    return null;
  }
  return null;
}

/** 呼び出し（CallExpression・OptionalCallExpression）の呼び出し先を決める。 */
export async function resolveCall(
  loader: SourceLoader,
  file: LoadedFile,
  call: AstNode,
  className: string | undefined,
): Promise<CalleeResolution> {
  const callee = call["callee"];
  if (!isAstNode(callee)) return { kind: "EXTERNAL", reason: "UNRESOLVED" };
  if (callee.type === "Import") return { kind: "EXTERNAL", reason: "DYNAMIC" };
  const direct = identifierName(callee);
  if (direct !== null) return resolveName(loader, file, direct);
  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression") {
    return { kind: "EXTERNAL", reason: "UNRESOLVED" };
  }
  if (callee["computed"] === true) return { kind: "EXTERNAL", reason: "DYNAMIC" };
  const property = identifierName(callee["property"]);
  if (property === null) return { kind: "EXTERNAL", reason: "DYNAMIC" };
  const object = callee["object"];
  if (isAstNode(object) && object.type === "ThisExpression") {
    if (className === undefined) return { kind: "EXTERNAL", reason: "METHOD" };
    const method = findClassMethod(file, className, property);
    return method === null ? { kind: "EXTERNAL", reason: "METHOD" } : { kind: "TRACE", ref: method };
  }
  const objectName = identifierName(object);
  if (objectName !== null) {
    const imported = file.imports.find((entry) => entry.local === objectName);
    if (imported !== undefined) {
      const target = await loader.resolve(file.path, imported.from);
      if (target === null) {
        return isRelative(imported.from) ? { kind: "EXTERNAL", reason: "UNRESOLVED" } : { kind: "EXTERNAL", reason: "PACKAGE" };
      }
      if (imported.imported === "*") {
        const ref = await findExported(loader, await loader.load(target), property, new Set());
        return ref === null ? { kind: "EXTERNAL", reason: "UNRESOLVED" } : { kind: "TRACE", ref };
      }
    }
  }
  return { kind: "EXTERNAL", reason: "METHOD" };
}

/** 名前で呼ばれた関数を決める（同じファイルの最上位の関数か、import した関数）。 */
export async function resolveName(loader: SourceLoader, file: LoadedFile, name: string): Promise<CalleeResolution> {
  const top = file.functions.get(name);
  if (top !== undefined) return { kind: "TRACE", ref: { file, symbol: name, node: top.node, line: top.line } };
  const imported = file.imports.find((entry) => entry.local === name);
  if (imported === undefined) return { kind: "EXTERNAL", reason: "UNRESOLVED" }; // 引数、入れ子の関数、グローバルなど
  const target = await loader.resolve(file.path, imported.from);
  if (target === null) {
    return isRelative(imported.from) ? { kind: "EXTERNAL", reason: "UNRESOLVED" } : { kind: "EXTERNAL", reason: "PACKAGE" };
  }
  if (imported.imported === "*") return { kind: "EXTERNAL", reason: "UNRESOLVED" };
  const ref = await findExported(loader, await loader.load(target), imported.imported, new Set());
  return ref === null ? { kind: "EXTERNAL", reason: "UNRESOLVED" } : { kind: "TRACE", ref };
}

/** あるファイルから export されている名前を、定義している関数までたどる（M0 の findExportedFunction と同じ道筋）。 */
async function findExported(
  loader: SourceLoader,
  file: LoadedFile,
  exportedName: string,
  visited: Set<string>,
): Promise<FunctionRef | null> {
  const visitKey = `${file.path}#${exportedName}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);
  if (exportedName === "default") {
    const fn = findDefaultFunction(file);
    if (fn !== null) return fn;
  }
  const entries = exportsOf(file.program);
  for (const entry of entries) {
    if (entry.kind === "local" && entry.exported === exportedName) {
      const top = file.functions.get(entry.local);
      if (top !== undefined) return { file, symbol: entry.local, node: top.node, line: top.line };
      const imported = file.imports.find((item) => item.local === entry.local);
      if (imported === undefined || imported.imported === "*") return null;
      const next = await loader.resolve(file.path, imported.from);
      return next === null ? null : findExported(loader, await loader.load(next), imported.imported, visited);
    }
    if (entry.kind === "reexport" && entry.exported === exportedName) {
      const next = await loader.resolve(file.path, entry.from);
      return next === null ? null : findExported(loader, await loader.load(next), entry.imported, visited);
    }
  }
  for (const entry of entries) {
    if (entry.kind !== "star") continue;
    const next = await loader.resolve(file.path, entry.from);
    if (next === null) continue;
    const found = await findExported(loader, await loader.load(next), exportedName, visited);
    if (found !== null) return found;
  }
  return null;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}