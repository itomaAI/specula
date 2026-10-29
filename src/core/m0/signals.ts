// Stage 2 の検出（M0 の設計 3.2 の 1）。LLM を使わない。
// 状態変化のシグナルを AST から見つけ、それを含む最上位の関数（ハンドラ）ごとに記録する。
//
// 決めたこと（初回）:
// - DB の書き込み:
//   - firebase の modular API: addDoc・setDoc・updateDoc・deleteDoc を "firebase" で始まるモジュールから import して呼ぶもの
//   - 受け手の鎖に collection() か doc() がある add・set・update・delete（firestore の旧 API）
//   - 受け手の鎖に from() がある insert・update・upsert・delete（supabase、knex など）
//   - 受け手の鎖が prisma で始まる create・createMany・update・updateMany・upsert・delete・deleteMany
// - イベントの発行: emit・dispatch・publish の呼び出し（受け手は問わない）と、関数 dispatch の呼び出し。
// - 画面も DB の書き込みも無いとき（ライブラリ、コマンドラインツール）だけ、パッケージの入口から公開されている関数を
//   シグナルにする（PUBLIC_FUNCTION）。公開されている関数は、入口から export される関数の宣言と、関数を値に持つ const。
// - 最上位の名前付き関数の外（モジュールの最上位、クラスのメソッド）にあるシグナルは数えず、unattributed に残す。

import type { SourceLocation } from "../../types/scenario.js";
import {
  type AstNode,
  type ParsedFile,
  type TopLevelFunction,
  describeCallee,
  enclosingTopLevelFunction,
  exportsOf,
  identifierName,
  importsOf,
  isAstNode,
  lineOf,
  stringValue,
  topLevelFunctions,
  walk,
} from "./ast.js";

export type SignalKind = "DB_MUTATION" | "EVENT_EMIT" | "PUBLIC_FUNCTION";

export interface Signal {
  kind: SignalKind;
  handler: SourceLocation;
  /** 呼んでいる関数の名前（PUBLIC_FUNCTION では公開名）。 */
  callee: string;
  /** 最初の文字列リテラルの引数（コレクション名、イベント名など）。無ければ null。 */
  label: string | null;
  line: number;
}

export interface Listener {
  eventName: string;
  /** リスナーとして渡された関数（ハンドラ）の所在。解決できたものだけ。 */
  target: SourceLocation;
  /** 登録している場所。 */
  location: SourceLocation;
}

export interface UnattributedSignal {
  kind: SignalKind;
  file: string;
  line: number;
  callee: string;
}

const FIRESTORE_MODULAR = new Set(["addDoc", "setDoc", "updateDoc", "deleteDoc"]);
const FIRESTORE_CHAINED = new Set(["add", "set", "update", "delete"]);
const QUERY_BUILDER = new Set(["insert", "update", "upsert", "delete"]);
const PRISMA = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const EMITTERS = new Set(["emit", "dispatch", "publish"]);
const LISTENER_METHODS = new Set(["on", "once", "addListener", "addEventListener", "subscribe"]);

/** DB の書き込みとイベントの発行を探す。 */
export function detectStateSignals(files: readonly ParsedFile[]): {
  signals: Signal[];
  unattributed: UnattributedSignal[];
} {
  const signals: Signal[] = [];
  const unattributed: UnattributedSignal[] = [];
  for (const file of files) {
    const functions = topLevelFunctions(file.program);
    const firebaseNames = new Set(
      importsOf(file.program)
        .filter((entry) => entry.from.startsWith("firebase") && FIRESTORE_MODULAR.has(entry.imported))
        .map((entry) => entry.local),
    );
    walk(file.program, (node, ancestors) => {
      if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") return;
      const kind = classifyCall(node, firebaseNames);
      if (kind === null) return;
      const callee = describeCallee(node)?.name ?? "?";
      const owner = enclosingTopLevelFunction(ancestors, functions);
      if (owner === null) {
        unattributed.push({ kind, file: file.path, line: lineOf(node), callee });
        return;
      }
      signals.push({
        kind,
        handler: { file: file.path, symbol: owner.name, line: owner.line },
        callee,
        label: kind === "EVENT_EMIT" ? eventLabel(node) : collectionLabel(node),
        line: lineOf(node),
      });
    });
  }
  return { signals, unattributed };
}

/** 呼び出しが DB の書き込みかイベントの発行か（M1 も同じ規則で使う）。firebaseNames は firebase から import した addDoc などの局所名。 */
export function classifyCall(call: AstNode, firebaseNames: ReadonlySet<string>): SignalKind | null {
  const callee = describeCallee(call);
  if (callee === null) return null;
  const { name, chain } = callee;
  if (chain.length === 0) {
    if (firebaseNames.has(name)) return "DB_MUTATION";
    if (name === "dispatch") return "EVENT_EMIT";
    return null;
  }
  if (EMITTERS.has(name)) return "EVENT_EMIT";
  if (FIRESTORE_CHAINED.has(name) && (chain.includes("collection()") || chain.includes("doc()"))) return "DB_MUTATION";
  if (QUERY_BUILDER.has(name) && chain.includes("from()")) return "DB_MUTATION";
  if (PRISMA.has(name) && chain[0] === "prisma") return "DB_MUTATION";
  return null;
}

function argumentsOf(call: AstNode): unknown[] {
  const args = call["arguments"];
  return Array.isArray(args) ? args : [];
}

function firstStringArgument(call: AstNode): string | null {
  for (const arg of argumentsOf(call)) {
    const value = stringValue(arg);
    if (value !== null) return value;
  }
  return null;
}

/** emit("名前") の名前。dispatch({ type: "名前" }) なら type の値。 */
function eventLabel(call: AstNode): string | null {
  const direct = firstStringArgument(call);
  if (direct !== null) return direct;
  const first = argumentsOf(call)[0];
  if (isAstNode(first) && first.type === "ObjectExpression" && Array.isArray(first["properties"])) {
    for (const property of first["properties"]) {
      if (!isAstNode(property) || property.type !== "ObjectProperty") continue;
      if (identifierName(property["key"]) === "type" || stringValue(property["key"]) === "type") {
        return stringValue(property["value"]);
      }
    }
  }
  return null;
}

/** 受け手の鎖にある collection()・from()・doc() の最初の文字列の引数。無ければ呼び出し自身の最初の文字列。 */
function collectionLabel(call: AstNode): string | null {
  let node: unknown = call["callee"];
  let found: string | null = null;
  while (isAstNode(node)) {
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const inner = describeCallee(node);
      if (inner !== null && ["collection", "from", "doc"].includes(inner.name)) {
        const value = firstStringArgument(node);
        if (value !== null) found = value; // 外側から内側へ進むので、最後に見つかったもの（いちばん内側）を使う
      }
      node = node["callee"];
    } else if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      node = node["object"];
    } else if (node.type === "AwaitExpression") {
      node = node["argument"];
    } else {
      break;
    }
  }
  if (found !== null) return found;
  // modular API: updateDoc(doc(db, "users", id), ...) のように、最初の引数の中に doc()/collection() がある
  const first = argumentsOf(call)[0];
  if (isAstNode(first) && first.type === "CallExpression") {
    const inner = describeCallee(first);
    if (inner !== null && ["collection", "doc"].includes(inner.name)) return firstStringArgument(first);
  }
  return firstStringArgument(call);
}

/** リスナーの登録（on("名前", 関数) など）を探す。渡された関数が最上位の関数に解決できるものだけ。 */
export function detectListeners(files: readonly ParsedFile[], resolver: ModuleResolver): Listener[] {
  const listeners: Listener[] = [];
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  for (const file of files) {
    const functions = topLevelFunctions(file.program);
    const imports = importsOf(file.program);
    walk(file.program, (node, ancestors) => {
      if (node.type !== "CallExpression") return;
      const callee = describeCallee(node);
      if (callee === null || callee.chain.length === 0 || !LISTENER_METHODS.has(callee.name)) return;
      const [first, second] = argumentsOf(node);
      const eventName = stringValue(first);
      const handlerName = identifierName(second);
      if (eventName === null || handlerName === null) return;
      const target = resolveFunction(file.path, handlerName, functions, imports, byPath, resolver);
      if (target === null) return;
      const owner = enclosingTopLevelFunction(ancestors, functions);
      listeners.push({
        eventName,
        target,
        location: { file: file.path, symbol: owner?.name ?? "<module>", line: lineOf(node) },
      });
    });
  }
  return listeners;
}

function resolveFunction(
  path: string,
  name: string,
  functions: Map<string, TopLevelFunction>,
  imports: ReturnType<typeof importsOf>,
  byPath: ReadonlyMap<string, ParsedFile>,
  resolver: ModuleResolver,
): SourceLocation | null {
  const local = functions.get(name);
  if (local !== undefined) return { file: path, symbol: local.name, line: local.line };
  const imported = imports.find((entry) => entry.local === name);
  if (imported === undefined || imported.imported === "*") return null;
  const target = resolver.resolve(path, imported.from);
  if (target === null) return null;
  const targetFile = byPath.get(target);
  if (targetFile === undefined) return null;
  return findExportedFunction(targetFile, imported.imported, byPath, resolver, new Set());
}

/** あるファイルから export されている名前を、定義している関数までたどる（再公開もたどる）。 */
export function findExportedFunction(
  file: ParsedFile,
  exportedName: string,
  byPath: ReadonlyMap<string, ParsedFile>,
  resolver: ModuleResolver,
  visited: Set<string>,
): SourceLocation | null {
  const visitKey = `${file.path}#${exportedName}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);
  const functions = topLevelFunctions(file.program);
  for (const entry of exportsOf(file.program)) {
    if (entry.kind === "local" && entry.exported === exportedName) {
      const fn = functions.get(entry.local);
      if (fn !== undefined) return { file: file.path, symbol: fn.name, line: fn.line };
      // import した名前をそのまま公開している（import { a } from "./b.js"; export { a }; や export default a;）
      const imported = importsOf(file.program).find((item) => item.local === entry.local);
      if (imported === undefined || imported.imported === "*") return null;
      const next = resolveFile(file.path, imported.from, byPath, resolver);
      return next === null ? null : findExportedFunction(next, imported.imported, byPath, resolver, visited);
    }
    if (entry.kind === "reexport" && entry.exported === exportedName) {
      const next = resolveFile(file.path, entry.from, byPath, resolver);
      return next === null ? null : findExportedFunction(next, entry.imported, byPath, resolver, visited);
    }
  }
  for (const entry of exportsOf(file.program)) {
    if (entry.kind !== "star") continue;
    const next = resolveFile(file.path, entry.from, byPath, resolver);
    if (next === null) continue;
    const found = findExportedFunction(next, exportedName, byPath, resolver, visited);
    if (found !== null) return found;
  }
  return null;
}

function resolveFile(
  from: string,
  specifier: string,
  byPath: ReadonlyMap<string, ParsedFile>,
  resolver: ModuleResolver,
): ParsedFile | null {
  const path = resolver.resolve(from, specifier);
  return path === null ? null : byPath.get(path) ?? null;
}

/** 入口のファイルから公開されている関数をすべて集める（公開名の辞書順）。 */
export function publicFunctionSignals(
  entryFiles: readonly string[],
  byPath: ReadonlyMap<string, ParsedFile>,
  resolver: ModuleResolver,
): Signal[] {
  const seen = new Set<string>();
  const signals: Signal[] = [];
  for (const entryPath of entryFiles) {
    const entry = byPath.get(entryPath);
    if (entry === undefined) continue;
    for (const name of exportedNames(entry, byPath, resolver, new Set()).sort()) {
      const location = findExportedFunction(entry, name, byPath, resolver, new Set());
      if (location === null) continue; // 関数でない（クラス・定数）か、たどれない
      const key = `${location.file}#${location.symbol}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({ kind: "PUBLIC_FUNCTION", handler: location, callee: name, label: null, line: location.line });
    }
  }
  return signals;
}

function exportedNames(
  file: ParsedFile,
  byPath: ReadonlyMap<string, ParsedFile>,
  resolver: ModuleResolver,
  visited: Set<string>,
): string[] {
  if (visited.has(file.path)) return [];
  visited.add(file.path);
  const names = new Set<string>();
  for (const entry of exportsOf(file.program)) {
    if (entry.kind === "star") {
      const next = resolveFile(file.path, entry.from, byPath, resolver);
      if (next !== null) {
        for (const name of exportedNames(next, byPath, resolver, visited)) if (name !== "default") names.add(name);
      }
    } else {
      names.add(entry.exported);
    }
  }
  return [...names];
}

/** 相対の指定子（"./x.js" など）をリポジトリの中のファイルのパスにする。パッケージの指定子は解決しない。 */
export class ModuleResolver {
  constructor(private readonly files: ReadonlySet<string>) {}

  resolve(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
    const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
    const joined = normalizePath(dir.length > 0 ? `${dir}/${specifier}` : specifier);
    if (joined === null) return null;
    for (const candidate of candidatesOf(joined)) {
      if (this.files.has(candidate)) return candidate;
    }
    return null;
  }
}

const SOURCE_FOR_OUTPUT: Array<[string, string[]]> = [
  [".js", [".ts", ".tsx", ".js", ".jsx"]],
  [".jsx", [".tsx", ".jsx"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
];

/** ビルド後の拡張子で書かれた指定子から、元のファイルの候補を順に返す。 */
export function candidatesOf(path: string): string[] {
  for (const [ext, sources] of SOURCE_FOR_OUTPUT) {
    if (path.endsWith(ext)) {
      const stem = path.slice(0, -ext.length);
      return sources.map((source) => stem + source);
    }
  }
  if (/\.[cm]?tsx?$/.test(path)) return [path];
  return [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"].map((suffix) => path + suffix);
}

/** "a/./b/../c" を "a/c" にする。ルートより上に出るときは null。先頭の "./" と "/" は外す。 */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out.join("/");
}