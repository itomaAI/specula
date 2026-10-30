// M0（ScenarioExtractor）の公開する 2 つの関数（M0 の設計 2）。
// discoverSystemContext = Stage 1〜3、sliceScenarios = Stage 4。コアはファイルを読まず、渡された中身だけを使う。
//
// 決めたこと（初回）:
// - 読むファイル: コードのファイル（.d.ts を除く）のうち、node_modules/・tests/・__tests__/ の下、*.test.*・*.spec.*、
//   tsconfig.json の outDir の下を除いたもの。構文の解析に失敗したファイルは diagnostics.parseFailures に記録して先へ進む。
// - モード: DB の書き込みも画面も無いときだけ PUBLIC_FUNCTIONS（入口から公開されている関数を起点にする）。
//   そのときも、イベントの発行（EVENT_EMIT）はシグナルとして残す。
// - 入口: package.json の exports・main・module・bin。指す先が tsconfig の outDir の下なら、rootDir の下の元のファイルに戻す
//   （例: dist/src/index.js → src/index.ts）。見つからなければ src/index.* か index.*。
// - tsconfig.json と package.json は、コメントと末尾のカンマを許して読む。読めなければ無いものとして扱う。

import type {
  EventStormingMap,
  ExtractionDiagnostics,
  RepositoryArtifacts,
  ScenarioSelection,
  SliceResult,
} from "../types/scenario.js";
import { type ParsedFile, isCodeFile, parseSource } from "./m0/ast.js";
import { assembleMap, findReadModels } from "./m0/assemble.js";
import { analyzeBoundaries, compareIds } from "./m0/boundary.js";
import {
  ModuleResolver,
  candidatesOf,
  detectListeners,
  detectStateSignals,
  normalizePath,
  publicFunctionSignals,
} from "./m0/signals.js";
import { slice } from "./m0/slice.js";

/** Stage 1〜3: リポジトリの中身から全体マップを作る。 */
export function discoverSystemContext(repo: RepositoryArtifacts): EventStormingMap {
  const texts = new Map<string, string>();
  for (const file of repo.files) texts.set(file.path, file.text);
  const screenshots = [...(repo.screenshots ?? [])].sort(compareIds);

  const tsconfig = readTsconfig(texts.get("tsconfig.json"));
  const codePaths = [...texts.keys()]
    .filter((path) => isCodeFile(path) && !isExcluded(path, tsconfig.outDir))
    .sort(compareIds);

  const parsed: ParsedFile[] = [];
  const parseFailures: ExtractionDiagnostics["parseFailures"] = [];
  for (const path of codePaths) {
    const outcome = parseSource(path, texts.get(path) ?? "");
    if (outcome.ok) parsed.push(outcome.file);
    else parseFailures.push({ path: outcome.path, message: outcome.message });
  }
  const parsedPaths = parsed.map((file) => file.path);
  const fileSet = new Set(parsedPaths);
  const resolver = new ModuleResolver(fileSet);
  const byPath = new Map(parsed.map((file) => [file.path, file] as const));

  const boundaries = analyzeBoundaries(parsedPaths);
  const state = detectStateSignals(parsed);
  const readModels = findReadModels(parsedPaths, screenshots);
  const hasDbWrite = state.signals.some((signal) => signal.kind === "DB_MUTATION");
  const mode: ExtractionDiagnostics["mode"] =
    !hasDbWrite && readModels.length === 0 ? "PUBLIC_FUNCTIONS" : "STATE_SIGNALS";

  let entryFiles: string[] = [];
  let signals = state.signals;
  if (mode === "PUBLIC_FUNCTIONS") {
    entryFiles = resolveEntryFiles(texts.get("package.json"), tsconfig, fileSet);
    signals = [...publicFunctionSignals(entryFiles, byPath, resolver), ...state.signals];
  }

  const listeners = detectListeners(parsed, resolver);
  const core = assembleMap({
    files: parsed,
    codePaths: parsedPaths,
    boundaries,
    signals,
    listeners,
    screenshots,
    resolver,
  });

  const unattributedSignals = [...state.unattributed].sort(
    (a, b) => compareIds(a.file, b.file) || a.line - b.line || compareIds(a.callee, b.callee),
  );
  return {
    ...core,
    diagnostics: { mode, entryFiles, parsedFileCount: parsed.length, parseFailures, unattributedSignals },
  };
}

/** Stage 4: 全体マップからシナリオを切り出す。 */
export function sliceScenarios(map: EventStormingMap, selection?: ScenarioSelection): SliceResult {
  return slice(map, selection);
}

// ---------------------------------------------------------------------------

export interface TsconfigSummary {
  /** "dist" のような正規化した相対パス。指定が無ければ null。 */
  outDir: string | null;
  /** 正規化した相対パス。"." は ""。 */
  rootDir: string;
}

/** tsconfig.json の outDir と rootDir を読む。リーダー（資料の除外）からも使う。 */
export function readTsconfig(text: string | undefined): TsconfigSummary {
  const fallback: TsconfigSummary = { outDir: null, rootDir: "" };
  if (text === undefined) return fallback;
  const value = tryParseJsonc(text);
  if (!isRecord(value) || !isRecord(value["compilerOptions"])) return fallback;
  const options = value["compilerOptions"];
  const outDir = typeof options["outDir"] === "string" ? normalizePath(options["outDir"]) : null;
  const rootDir = typeof options["rootDir"] === "string" ? normalizePath(options["rootDir"]) : "";
  return { outDir: outDir === null || outDir === "" ? null : outDir, rootDir: rootDir ?? "" };
}

function isExcluded(path: string, outDir: string | null): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => segment === "node_modules" || segment === "tests" || segment === "__tests__")) {
    return true;
  }
  const name = segments[segments.length - 1] ?? "";
  if (/\.(test|spec)\.[^.]+$/.test(name)) return true;
  if (outDir !== null && (path === outDir || path.startsWith(`${outDir}/`))) return true;
  return false;
}

/** package.json と tsconfig から、入口の元のファイルを決める（パスの辞書順）。 */
export function resolveEntryFiles(
  packageText: string | undefined,
  tsconfig: TsconfigSummary,
  files: ReadonlySet<string>,
): string[] {
  const targets: string[] = [];
  const pkg = packageText === undefined ? undefined : tryParseJsonc(packageText);
  if (isRecord(pkg)) {
    collectExportTargets(pkg["exports"], null, targets);
    for (const key of ["main", "module"]) {
      const value = pkg[key];
      if (typeof value === "string") targets.push(value);
    }
    const bin = pkg["bin"];
    if (typeof bin === "string") targets.push(bin);
    else if (isRecord(bin)) for (const value of Object.values(bin)) if (typeof value === "string") targets.push(value);
  }

  const found = new Set<string>();
  for (const target of targets) {
    if (target.includes("*") || /\.d\.[cm]?ts$/.test(target)) continue;
    const normalized = normalizePath(target);
    if (normalized === null || normalized === "") continue;
    let sourcePath = normalized;
    if (tsconfig.outDir !== null && normalized.startsWith(`${tsconfig.outDir}/`)) {
      const rest = normalized.slice(tsconfig.outDir.length + 1);
      sourcePath = tsconfig.rootDir === "" ? rest : `${tsconfig.rootDir}/${rest}`;
    }
    const hit = candidatesOf(sourcePath).find((candidate) => files.has(candidate));
    if (hit !== undefined) found.add(hit);
  }

  if (found.size === 0) {
    const fallback = ["src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js"].find((path) =>
      files.has(path),
    );
    if (fallback !== undefined) found.add(fallback);
  }
  return [...found].sort(compareIds);
}

/** exports の値（文字列・配列・条件のオブジェクト）から、型宣言以外の指す先を集める。 */
function collectExportTargets(value: unknown, key: string | null, out: string[]): void {
  if (key === "types") return;
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, key, out);
  } else if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) collectExportTargets(child, childKey, out);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
}

/** コメント（// と /* *\/）と、閉じ括弧の直前のカンマを取り除く。文字列の中は触らない。 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') j += text.charAt(j) === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "/" && (text.charAt(i + 1) === "/" || text.charAt(i + 1) === "*")) {
      i = skipComment(text, i);
      continue;
    }
    if (c === ",") {
      const next = text.charAt(skipTrivia(text, i + 1));
      if (next === "}" || next === "]") {
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

function skipComment(text: string, start: number): number {
  if (text.charAt(start + 1) === "/") {
    const end = text.indexOf("\n", start + 2);
    return end < 0 ? text.length : end;
  }
  const end = text.indexOf("*/", start + 2);
  return end < 0 ? text.length : end + 2;
}

/** 空白とコメントを飛ばした次の位置。 */
function skipTrivia(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
    } else if (c === "/" && (text.charAt(i + 1) === "/" || text.charAt(i + 1) === "*")) {
      i = skipComment(text, i);
    } else {
      break;
    }
  }
  return i;
}