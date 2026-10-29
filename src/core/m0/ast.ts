// M0 が使う AST の小さな口（M0 の設計 3 の冒頭: @babel/parser で TS と JSX を読む）。
// @babel/types の型には依存せず、自前の最小の型（type と任意のキー）で読む。
// Babel の版で AST の細かい形が変わっても、ここで使う形（関数・export・import・呼び出し）だけに閉じるため。

import { parse } from "@babel/parser";

export interface AstNode {
  type: string;
  [key: string]: unknown;
}

export interface ParsedFile {
  path: string;
  program: AstNode;
}

export type ParseOutcome = { ok: true; file: ParsedFile } | { ok: false; path: string; message: string };

const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** 読むべきコードのファイルか（型宣言 .d.ts は除く）。 */
export function isCodeFile(path: string): boolean {
  if (/\.d\.[cm]?ts$/.test(path)) return false;
  return CODE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** 1 ファイルを読む。失敗は値で返す（呼び出し元はファイルごとに記録して先へ進む）。 */
export function parseSource(path: string, text: string): ParseOutcome {
  const isTs = /\.[cm]?tsx?$/.test(path);
  const allowsJsx = path.endsWith(".tsx") || !isTs;
  const plugins: Array<"typescript" | "jsx"> = [];
  if (isTs) plugins.push("typescript");
  if (allowsJsx) plugins.push("jsx");
  try {
    const file = parse(text, {
      sourceType: path.endsWith(".cjs") || path.endsWith(".cts") ? "script" : "module",
      plugins,
    }) as unknown;
    if (!isAstNode(file) || !isAstNode(file["program"])) {
      return { ok: false, path, message: "parser が program を返さなかった" };
    }
    return { ok: true, file: { path, program: file["program"] } };
  } catch (error) {
    return { ok: false, path, message: error instanceof Error ? error.message : String(error) };
  }
}

export function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** ノードの開始行（1 から）。位置が無ければ 0。 */
export function lineOf(node: AstNode): number {
  const loc = node["loc"];
  if (typeof loc !== "object" || loc === null) return 0;
  const start = (loc as { start?: { line?: unknown } }).start;
  return typeof start?.line === "number" ? start.line : 0;
}

const SKIPPED_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
]);

/** 子のノードを出現順に返す。 */
export function childrenOf(node: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const key of Object.keys(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (isAstNode(item)) out.push(item);
    } else if (isAstNode(value)) {
      out.push(value);
    }
  }
  return out;
}

/** 深さ優先で全ノードをたどる。visit には祖先（根から親まで）も渡す。 */
export function walk(root: AstNode, visit: (node: AstNode, ancestors: readonly AstNode[]) => void): void {
  const ancestors: AstNode[] = [];
  const step = (node: AstNode): void => {
    visit(node, ancestors);
    ancestors.push(node);
    for (const child of childrenOf(node)) step(child);
    ancestors.pop();
  };
  step(root);
}

export function identifierName(node: unknown): string | null {
  return isAstNode(node) && node.type === "Identifier" && typeof node["name"] === "string" ? node["name"] : null;
}

/** 文字列リテラル（式を含まないテンプレートも含む）の値。 */
export function stringValue(node: unknown): string | null {
  if (!isAstNode(node)) return null;
  if (node.type === "StringLiteral" && typeof node["value"] === "string") return node["value"];
  if (node.type === "TemplateLiteral") {
    const expressions = node["expressions"];
    const quasis = node["quasis"];
    if (Array.isArray(expressions) && expressions.length === 0 && Array.isArray(quasis) && quasis.length === 1) {
      const value = (quasis[0] as { value?: { cooked?: unknown } }).value?.cooked;
      return typeof value === "string" ? value : null;
    }
  }
  return null;
}

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

export function isFunctionNode(node: AstNode): boolean {
  return FUNCTION_TYPES.has(node.type);
}

/** モジュールの最上位で名前の付いた関数（宣言と、関数を値に持つ const）。export の内側も含む。 */
export interface TopLevelFunction {
  name: string;
  node: AstNode;
  line: number;
}

export function topLevelFunctions(program: AstNode): Map<string, TopLevelFunction> {
  const found = new Map<string, TopLevelFunction>();
  const body = program["body"];
  if (!Array.isArray(body)) return found;
  for (const statement of body) {
    if (!isAstNode(statement)) continue;
    let target: unknown = statement;
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
      target = statement["declaration"];
    }
    if (!isAstNode(target)) continue;
    if (target.type === "FunctionDeclaration") {
      const name = identifierName(target["id"]);
      if (name !== null) found.set(name, { name, node: target, line: lineOf(target) });
    } else if (target.type === "VariableDeclaration" && target["kind"] === "const") {
      const declarations = target["declarations"];
      if (!Array.isArray(declarations)) continue;
      for (const declarator of declarations) {
        if (!isAstNode(declarator)) continue;
        const name = identifierName(declarator["id"]);
        const init = declarator["init"];
        if (name !== null && isAstNode(init) && isFunctionNode(init)) {
          found.set(name, { name, node: init, line: lineOf(declarator) });
        }
      }
    }
  }
  return found;
}

/** export の 1 項目。 */
export type ExportEntry =
  | { kind: "local"; exported: string; local: string }
  | { kind: "reexport"; exported: string; imported: string; from: string }
  | { kind: "star"; from: string };

/** 値の export を集める（export type と型だけの宣言は除く）。 */
export function exportsOf(program: AstNode): ExportEntry[] {
  const out: ExportEntry[] = [];
  const body = program["body"];
  if (!Array.isArray(body)) return out;
  for (const statement of body) {
    if (!isAstNode(statement)) continue;
    if (statement["exportKind"] === "type") continue;
    if (statement.type === "ExportAllDeclaration") {
      const from = stringValue(statement["source"]);
      if (from !== null) out.push({ kind: "star", from });
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement["declaration"];
      const local = isAstNode(declaration)
        ? identifierName(declaration["id"]) ?? identifierName(declaration)
        : null;
      if (local !== null) out.push({ kind: "local", exported: "default", local });
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement["declaration"];
    if (isAstNode(declaration)) {
      if (declaration.type === "FunctionDeclaration") {
        const name = identifierName(declaration["id"]);
        if (name !== null) out.push({ kind: "local", exported: name, local: name });
      } else if (declaration.type === "VariableDeclaration") {
        const declarations = declaration["declarations"];
        if (Array.isArray(declarations)) {
          for (const declarator of declarations) {
            const name = isAstNode(declarator) ? identifierName(declarator["id"]) : null;
            if (name !== null) out.push({ kind: "local", exported: name, local: name });
          }
        }
      } else if (declaration.type === "ClassDeclaration") {
        const name = identifierName(declaration["id"]);
        if (name !== null) out.push({ kind: "local", exported: name, local: name });
      }
      continue;
    }
    const from = stringValue(statement["source"]);
    const specifiers = statement["specifiers"];
    if (!Array.isArray(specifiers)) continue;
    for (const specifier of specifiers) {
      if (!isAstNode(specifier) || specifier["exportKind"] === "type") continue;
      const exported = moduleExportName(specifier["exported"]);
      const local = moduleExportName(specifier["local"]);
      if (exported === null) continue;
      if (from !== null) {
        if (specifier.type === "ExportNamespaceSpecifier") continue; // export * as ns: 名前空間は関数ではない
        out.push({ kind: "reexport", exported, imported: local ?? exported, from });
      } else if (local !== null) {
        out.push({ kind: "local", exported, local });
      }
    }
  }
  return out;
}

/** import の 1 項目（値の import だけ）。imported は "default" か "*" か名前。 */
export interface ImportEntry {
  local: string;
  imported: string;
  from: string;
}

export function importsOf(program: AstNode): ImportEntry[] {
  const out: ImportEntry[] = [];
  const body = program["body"];
  if (!Array.isArray(body)) return out;
  for (const statement of body) {
    if (!isAstNode(statement) || statement.type !== "ImportDeclaration") continue;
    if (statement["importKind"] === "type") continue;
    const from = stringValue(statement["source"]);
    const specifiers = statement["specifiers"];
    if (from === null || !Array.isArray(specifiers)) continue;
    for (const specifier of specifiers) {
      if (!isAstNode(specifier) || specifier["importKind"] === "type") continue;
      const local = identifierName(specifier["local"]);
      if (local === null) continue;
      if (specifier.type === "ImportDefaultSpecifier") out.push({ local, imported: "default", from });
      else if (specifier.type === "ImportNamespaceSpecifier") out.push({ local, imported: "*", from });
      else {
        const imported = moduleExportName(specifier["imported"]);
        if (imported !== null) out.push({ local, imported, from });
      }
    }
  }
  return out;
}

function moduleExportName(node: unknown): string | null {
  return identifierName(node) ?? stringValue(node);
}

/**
 * 呼び出しの callee を「受け手の鎖」と「最後の名前」に分ける。
 * 例: db.collection("a").doc(x).update(v) → { name: "update", chain: ["db", "collection()", "doc()"] }
 *     addDoc(ref, v) → { name: "addDoc", chain: [] }
 */
export function describeCallee(call: AstNode): { name: string; chain: string[] } | null {
  const callee = call["callee"];
  const direct = identifierName(callee);
  if (direct !== null) return { name: direct, chain: [] };
  if (!isAstNode(callee) || (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression")) {
    return null;
  }
  if (callee["computed"] === true) return null;
  const name = identifierName(callee["property"]);
  if (name === null) return null;
  return { name, chain: receiverChain(callee["object"]) };
}

function receiverChain(node: unknown): string[] {
  if (!isAstNode(node)) return [];
  const id = identifierName(node);
  if (id !== null) return [id];
  if (node.type === "ThisExpression") return ["this"];
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const property = identifierName(node["property"]);
    return [...receiverChain(node["object"]), property ?? "?"];
  }
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
    const inner = describeCallee(node);
    if (inner === null) return ["?()"];
    return [...inner.chain, `${inner.name}()`];
  }
  if (node.type === "AwaitExpression") return receiverChain(node["argument"]);
  return ["?"];
}

/** 祖先の中で一番外側の、最上位の名前付き関数の名前（無ければ null）。 */
export function enclosingTopLevelFunction(
  ancestors: readonly AstNode[],
  functions: Map<string, TopLevelFunction>,
): TopLevelFunction | null {
  for (const ancestor of ancestors) {
    if (!isFunctionNode(ancestor)) continue;
    for (const fn of functions.values()) {
      if (fn.node === ancestor) return fn;
    }
  }
  return null;
}