// M1 の読み込み（M1 の設計 2.1、M1 の計画「読み込み」）。
// 追跡でたどり着いたファイルだけを FileSystemPort から読み、パースした結果をその実行の中で使い回す。
// パスはリポジトリのルートからの相対パス（ルートの付け足しは呼び出し元が withRoot で行う）。

import { parse } from "@babel/parser";
import type { FileSystemPort } from "../../ports/FileSystemPort.js";
import { SyntaxExtractionError } from "../../types/context.js";
import {
  type AstNode,
  type ImportEntry,
  type TopLevelFunction,
  importsOf,
  isAstNode,
  topLevelFunctions,
} from "../m0/ast.js";
import { candidatesOf, normalizePath } from "../m0/signals.js";

export interface LoadedFile {
  path: string;
  text: string;
  program: AstNode;
  functions: Map<string, TopLevelFunction>;
  imports: ImportEntry[];
}

export class SourceLoader {
  private readonly files = new Map<string, Promise<LoadedFile>>();
  private readonly resolved = new Map<string, Promise<string | null>>();

  constructor(private readonly fs: FileSystemPort) {}

  /** ファイルを読んでパースする。失敗は SyntaxExtractionError（推測で続けない）。 */
  load(path: string): Promise<LoadedFile> {
    let pending = this.files.get(path);
    if (pending === undefined) {
      pending = this.readAndParse(path);
      this.files.set(path, pending);
    }
    return pending;
  }

  /** ファイルがあるか（起点の確認に使う）。 */
  exists(path: string): Promise<boolean> {
    return this.fs.exists(path);
  }

  /**
   * 相対の指定子（"./x.js" など）をリポジトリの中のファイルのパスにする。
   * 候補の順は M0 と同じ（candidatesOf）。パッケージの指定子と、見つからないものは null。
   */
  resolve(fromFile: string, specifier: string): Promise<string | null> {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return Promise.resolve(null);
    const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
    const joined = normalizePath(dir.length > 0 ? `${dir}/${specifier}` : specifier);
    if (joined === null) return Promise.resolve(null);
    let pending = this.resolved.get(joined);
    if (pending === undefined) {
      pending = this.firstExisting(candidatesOf(joined));
      this.resolved.set(joined, pending);
    }
    return pending;
  }

  private async firstExisting(candidates: readonly string[]): Promise<string | null> {
    for (const candidate of candidates) {
      if (await this.fs.exists(candidate)) return candidate;
    }
    return null;
  }

  private async readAndParse(path: string): Promise<LoadedFile> {
    const text = await this.fs.read(path);
    const isTs = /\.[cm]?tsx?$/.test(path);
    const allowsJsx = path.endsWith(".tsx") || !isTs;
    // プラグインの選び方は M0 の parseSource と同じ。M1 はエラーの行と列が要るので、ここで直接呼ぶ。
    const plugins: Array<"typescript" | "jsx"> = [];
    if (isTs) plugins.push("typescript");
    if (allowsJsx) plugins.push("jsx");
    let file: unknown;
    try {
      file = parse(text, {
        sourceType: path.endsWith(".cjs") || path.endsWith(".cts") ? "script" : "module",
        plugins,
      }) as unknown;
    } catch (error) {
      const loc = (error as { loc?: { line?: unknown; column?: unknown } }).loc;
      const line = typeof loc?.line === "number" ? loc.line : 0;
      const column = typeof loc?.column === "number" ? loc.column + 1 : 0;
      throw new SyntaxExtractionError(path, line, column, error instanceof Error ? error.message : String(error));
    }
    if (!isAstNode(file) || !isAstNode(file["program"])) {
      throw new SyntaxExtractionError(path, 0, 0, "parser が program を返さなかった");
    }
    const program = file["program"];
    return { path, text, program, functions: topLevelFunctions(program), imports: importsOf(program) };
  }
}

/** ノードの原文。位置が無ければ空文字。 */
export function sourceText(file: LoadedFile, node: unknown): string {
  if (!isAstNode(node)) return "";
  const start = node["start"];
  const end = node["end"];
  if (typeof start !== "number" || typeof end !== "number") return "";
  return file.text.slice(start, end);
}

/** ノードの開始位置（行・列は 1 から）。位置が無ければ 0。 */
export function startOf(node: AstNode): { line: number; column: number } {
  const loc = node["loc"] as { start?: { line?: unknown; column?: unknown } } | undefined;
  const line = typeof loc?.start?.line === "number" ? loc.start.line : 0;
  const column = typeof loc?.start?.column === "number" ? loc.start.column + 1 : 0;
  return { line, column };
}

/** ノードの終了位置（暗黙の RETURN の所在に使う。閉じかっこの位置）。 */
export function endOf(node: AstNode): { line: number; column: number } {
  const loc = node["loc"] as { end?: { line?: unknown; column?: unknown } } | undefined;
  const line = typeof loc?.end?.line === "number" ? loc.end.line : 0;
  // end.column は閉じかっこの次の位置（0 から）なので、閉じかっこの列（1 から）はそのまま同じ数になる。
  const column = typeof loc?.end?.column === "number" ? loc.end.column : 0;
  return { line, column };
}