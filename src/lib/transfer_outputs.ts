// 出力一式の書き出しと読み込み（standalone 版の C）。GitHub で管理できるように、zip にまとめずディレクトリのまま扱う。
// Node.js のサーバーと Itera OS の両方から使えるように、FileSystemPort だけを通し、node:path を使わない。
//
// 書き出し（exportRun）:
// - 出力先が同じ 1 回の実行の出力としてそろっているかを、SpecViewer と同じ検査（checkRunOutputs）で両方の役割について確かめる。
//   そろっていなければ書き出さない。
// - 対象は writeOutputs が書くファイル（run_report.json の行から決まる）と、LLM の記録（llm_records/<キー>.json）。
//   出力先にあるほかのファイルは書き出さない。
// - JSON のファイルは、キーの順を固定し、インデントして書く（コミットしたときの差分を、実行ごとの変化だけにするため）。
//   それ以外のファイル（.md・.mmd・.als）は中身をそのまま書く。
// - 最後に目録（specula_export.json）を書く。目録には basis と、各ファイルの相対パスと SHA-256 を入れる。
// - 書き出し先が空でなく、目録も無いときは書かない（specula の書き出しでないディレクトリを上書きしないため）。
// - 前の書き出しの目録にあって今回は無いファイルは消さない（FileSystemPort に消す口が無いため）。stale として返す。
//
// 読み込み（importRun）:
// - 目録を読み、各ファイルの SHA-256 が目録と合うか、パスが書き出し先の外を指していないかを確かめる。
// - 書き出し先に対しても checkRunOutputs を両方の役割で回し、目録の basis が run_report.json の basis と同じかを確かめる。
// - 検査に使ったファイルがすべて目録に入っているかを確かめる（目録の外のファイルを読んで通してしまわないため）。
// - 問題が 1 つでもあれば、何も書かない。出力先に run_report.json があるときは、replace を渡したときだけ書く。

import type { FileSystemPort } from "../ports/FileSystemPort.js";
import { VIEW_ROLES, viewsDirOf } from "../types/projection.js";
import { checkRunOutputs } from "../viewer/check.js";
import { readRunOutputs } from "./read_outputs.js";
import { sha256Hex } from "./sha256.js";
import { safeName } from "./write_outputs.js";

export const MANIFEST_NAME = "specula_export.json";
export const EXPORT_FORMAT = "specula-export";
export const EXPORT_VERSION = 1;
/** 書き出し先での LLM の記録の置き場所（出力先の既定の置き場所と同じ名前）。 */
export const RECORDS_DIR = "llm_records";
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export interface ExportBasis {
  mapHash: string;
  documentsHash: string;
}

export interface ExportManifest {
  format: string;
  version: number;
  basis: ExportBasis;
  files: Array<{ path: string; sha256: string }>;
}

export type TransferResult =
  | { ok: true; basis: ExportBasis; files: string[]; stale: string[] }
  | { ok: false; problems: string[] };

export interface TransferOptions {
  /** LLM の記録の置き場所。無ければ <出力先>/llm_records。 */
  recordsDir?: string;
}

/** キーを辞書順に並べ、2 文字でインデントした JSON（末尾に改行）。配列の順は変えない。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortKeys(item));
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
    return sorted;
  }
  return value;
}

const trimDir = (dir: string): string => dir.replace(/\/+$/, "");
const joinPath = (root: string, rel: string): string => (root === "" ? rel : `${root}/${rel}`);

function basisOf(value: unknown): ExportBasis | null {
  if (typeof value !== "object" || value === null) return null;
  const basis = (value as { basis?: unknown }).basis;
  if (typeof basis !== "object" || basis === null) return null;
  const { mapHash, documentsHash } = basis as Record<string, unknown>;
  return typeof mapHash === "string" && typeof documentsHash === "string" ? { mapHash, documentsHash } : null;
}

interface Collected {
  basis: ExportBasis | null;
  /** 出力先からの相対パス（記録は llm_records/<キー>.json）。辞書順。 */
  files: string[];
  problems: string[];
}

/** 出力先を両方の役割で検査し、書き出す対象の相対パスを集める。 */
async function collect(fs: FileSystemPort, root: string, recordsDir: string): Promise<Collected> {
  const problems: string[] = [];
  const files = new Set<string>();
  let basis: ExportBasis | null = null;

  for (const viewRole of VIEW_ROLES) {
    const outputs = await readRunOutputs(fs, root, viewRole);
    const check = checkRunOutputs(outputs);
    for (const problem of check.problems) {
      const where = problem.commandTarget === null ? problem.file : `${problem.commandTarget} の ${problem.file}`;
      const line = `${where}: ${problem.detail}`;
      if (!problems.includes(line)) problems.push(line);
    }
    if (outputs.report.kind !== "OK") continue;
    basis = basisOf(outputs.report.value);

    files.add("run_report.json");
    for (const name of ["glossary.json", "intents.json", "implementation_map.json"]) {
      if (await fs.exists(joinPath(root, name))) files.add(name);
    }
    const views = viewsDirOf(viewRole);
    for (const name of ["system_map.json", "system_map.mmd"]) {
      if (await fs.exists(joinPath(root, `${views}/${name}`))) files.add(`${views}/${name}`);
    }
    for (const commandTarget of outputs.commands) {
      const dir = `commands/${safeName(commandTarget.commandId)}`;
      const viewDir = `${views}/commands/${safeName(commandTarget.commandId)}`;
      if (commandTarget.kind === "COMPLETED") {
        for (const name of ["spec.json", "spec.als", "solver_report.json", "ledger.json"]) {
          if (await fs.exists(joinPath(root, `${dir}/${name}`))) files.add(`${dir}/${name}`);
        }
        for (const name of ["spec.md", "matrix.md", "flow.mmd"]) files.add(`${viewDir}/${name}`);
      } else if (commandTarget.kind === "AMBIGUOUS") {
        files.add(`${dir}/ambiguity.json`);
        if (await fs.exists(joinPath(root, `${viewDir}/ambiguity.md`))) files.add(`${viewDir}/ambiguity.md`);
      }
    }
  }

  if (await fs.exists(recordsDir)) {
    for (const name of await fs.list(recordsDir)) {
      if (RECORD_FILE.test(name)) files.add(`${RECORDS_DIR}/${name}`);
    }
  }
  return { basis, files: [...files].sort(), problems };
}

/** 出力先の一式を、目録つきのディレクトリとして書き出す。 */
export async function exportRun(
  fs: FileSystemPort,
  outDir: string,
  exportDir: string,
  options: TransferOptions = {},
): Promise<TransferResult> {
  const root = trimDir(outDir);
  const target = trimDir(exportDir);
  if (target === "" || target === root) return { ok: false, problems: ["書き出し先を出力先と別のディレクトリにしてください。"] };
  const recordsDir = trimDir(options.recordsDir ?? joinPath(root, RECORDS_DIR));

  const collected = await collect(fs, root, recordsDir);
  if (collected.problems.length > 0) return { ok: false, problems: collected.problems };
  if (collected.basis === null) return { ok: false, problems: ["run_report.json: basis が無い。"] };

  // 前の書き出し。目録が無いのに中身があるディレクトリには書かない。
  const manifestPath = joinPath(target, MANIFEST_NAME);
  let previous: string[] = [];
  if (await fs.exists(manifestPath)) {
    const old = parseManifest(await fs.read(manifestPath));
    if (typeof old === "string") return { ok: false, problems: [`${MANIFEST_NAME}: ${old}`] };
    previous = old.files.map((file) => file.path);
  } else if ((await fs.exists(target)) && (await fs.list(target)).length > 0) {
    return { ok: false, problems: [`書き出し先が空ではなく、${MANIFEST_NAME} もありません。空のディレクトリか、前に書き出したディレクトリを選んでください。`] };
  }

  // 先に全部を読んで整形し、読めないものがあれば何も書かない。
  const prepared: Array<{ path: string; content: string }> = [];
  const problems: string[] = [];
  for (const rel of collected.files) {
    const source = rel.startsWith(`${RECORDS_DIR}/`) ? joinPath(recordsDir, rel.slice(RECORDS_DIR.length + 1)) : joinPath(root, rel);
    const text = await fs.read(source);
    if (rel.endsWith(".json")) {
      try {
        prepared.push({ path: rel, content: stableJson(JSON.parse(text)) });
      } catch (error) {
        problems.push(`${rel}: JSON として読めない（${error instanceof Error ? error.message : String(error)}）`);
      }
    } else {
      prepared.push({ path: rel, content: text });
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const entries: ExportManifest["files"] = [];
  for (const file of prepared) {
    await fs.write(joinPath(target, file.path), file.content);
    entries.push({ path: file.path, sha256: await sha256Hex(file.content) });
  }
  const manifest: ExportManifest = { format: EXPORT_FORMAT, version: EXPORT_VERSION, basis: collected.basis, files: entries };
  // 目録は最後に書く（途中で止まったとき、目録が中身と食い違わないように）。
  await fs.write(manifestPath, stableJson(manifest));

  const current = new Set(collected.files);
  return { ok: true, basis: collected.basis, files: collected.files, stale: previous.filter((path) => !current.has(path)).sort() };
}

/** 書き出したディレクトリを確かめ、出力先へ読み込む。 */
export async function importRun(
  fs: FileSystemPort,
  exportDir: string,
  outDir: string,
  options: TransferOptions & { replace?: boolean } = {},
): Promise<TransferResult> {
  const source = trimDir(exportDir);
  const root = trimDir(outDir);
  if (root === "" || root === source) return { ok: false, problems: ["出力先を書き出し先と別のディレクトリにしてください。"] };
  const recordsDir = trimDir(options.recordsDir ?? joinPath(root, RECORDS_DIR));

  const manifestPath = joinPath(source, MANIFEST_NAME);
  if (!(await fs.exists(manifestPath))) return { ok: false, problems: [`${MANIFEST_NAME} が無い。specula で書き出したディレクトリを選んでください。`] };
  const manifest = parseManifest(await fs.read(manifestPath));
  if (typeof manifest === "string") return { ok: false, problems: [`${MANIFEST_NAME}: ${manifest}`] };

  const problems: string[] = [];
  const contents = new Map<string, string>();
  for (const file of manifest.files) {
    const path = joinPath(source, file.path);
    if (!(await fs.exists(path))) {
      problems.push(`${file.path}: 目録にあるファイルが無い。`);
      continue;
    }
    const text = await fs.read(path);
    if ((await sha256Hex(text)) !== file.sha256) {
      problems.push(`${file.path}: 中身が目録の SHA-256 と違う（書き出しの後に変わった）。`);
      continue;
    }
    contents.set(file.path, text);
  }

  // 書き出し先そのものを、出力先と同じ並びとして検査する。
  const collected = await collect(fs, source, joinPath(source, RECORDS_DIR));
  problems.push(...collected.problems);
  if (collected.basis !== null && (collected.basis.mapHash !== manifest.basis.mapHash || collected.basis.documentsHash !== manifest.basis.documentsHash)) {
    problems.push("run_report.json: basis が目録の basis と違う。");
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const rel of collected.files) {
    if (!listed.has(rel)) problems.push(`${rel}: 目録に無いファイル。`);
  }
  if (problems.length > 0) return { ok: false, problems };

  if ((await fs.exists(joinPath(root, "run_report.json"))) && options.replace !== true) {
    return { ok: false, problems: ["出力先に別の実行の出力がある。置き換えるときは replace を指定してください。"] };
  }

  const written: string[] = [];
  for (const file of manifest.files) {
    const text = contents.get(file.path) ?? "";
    const target = file.path.startsWith(`${RECORDS_DIR}/`) ? joinPath(recordsDir, file.path.slice(RECORDS_DIR.length + 1)) : joinPath(root, file.path);
    await fs.write(target, text);
    written.push(file.path);
  }
  return { ok: true, basis: manifest.basis, files: written.sort(), stale: [] };
}

/** 目録を読む。誤りなら理由の文を返す。 */
export function parseManifest(text: string): ExportManifest | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `JSON として読めない（${error instanceof Error ? error.message : String(error)}）`;
  }
  if (typeof value !== "object" || value === null) return "オブジェクトではない";
  const record = value as Record<string, unknown>;
  if (record.format !== EXPORT_FORMAT) return `format が ${EXPORT_FORMAT} ではない`;
  if (record.version !== EXPORT_VERSION) return `version ${String(record.version)} は読めない（読めるのは ${EXPORT_VERSION}）`;
  const basis = basisOf(record);
  if (basis === null) return "basis が無い";
  if (!Array.isArray(record.files)) return "files が配列ではない";
  const files: ExportManifest["files"] = [];
  const seen = new Set<string>();
  for (const item of record.files as unknown[]) {
    if (typeof item !== "object" || item === null) return "files の項目がオブジェクトではない";
    const { path, sha256 } = item as Record<string, unknown>;
    if (typeof path !== "string" || typeof sha256 !== "string") return "files の項目に path か sha256 が無い";
    if (!SAFE_PATH.test(path) || path.split("/").some((part) => part === "." || part === "..") || path === MANIFEST_NAME) {
      return `使えないパス: ${path}`;
    }
    if (seen.has(path)) return `同じパスが 2 回ある: ${path}`;
    seen.add(path);
    files.push({ path, sha256 });
  }
  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, basis, files };
}