// 仕様の資料（RepositoryArtifacts.documents）を選んで読む規則（ScenarioExtractor の設計 4.0）。
// NodeRepositoryReader と IteraRepositoryReader が同じ規則で集めるために、ここにまとめる。ファイルは読まず、読む関数を受け取る。
//
// - README: 名前が README・README.md・README.mdx（大文字小文字を区別しない）。リポジトリの直下か、
//   コンテキストの根（packages/・apps/・features/・modules/・domains/ の直下のディレクトリ。どの深さでもよい）の直下。
//   根の決め方は ScenarioExtractor の境界と同じ関数を使う（根が 1 つしか無くても README は入れる）。
// - DOC: パスのどこかに docs/ か doc/ のディレクトリがある .md・.mdx。
// - SCHEMA: .sql・.prisma・.graphql・.gql。
// - 除くもの: node_modules/・tests/・__tests__/ の下、tsconfig.json の outDir の下。名前が CHANGELOG・LICENSE で始まるもの。
//   （.git/ と dist/ はリーダーが歩かない。）
// - 上限は UTF-8 のバイト数で数える。1 ファイル 64 KB（超えたら先頭だけを入れて truncated）、合計 2 MB
//   （パスの辞書順に入れ、入れると超える資料に来たら、それと以降をすべて omittedDocuments にする）。

import type { RepositoryArtifacts, RepositoryDocument } from "../types/scenario.js";
import { boundaryRootOf, compareIds } from "../core/m0/boundary.js";

export const DOCUMENT_FILE_LIMIT_BYTES = 64 * 1024;
export const DOCUMENT_TOTAL_LIMIT_BYTES = 2 * 1024 * 1024;

const README_NAMES: ReadonlySet<string> = new Set(["readme", "readme.md", "readme.mdx"]);
const DOC_DIRS: ReadonlySet<string> = new Set(["docs", "doc"]);
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(["node_modules", "tests", "__tests__"]);

/** 資料なら種類を、資料でなければ null を返す。path はリポジトリのルートからの相対パス（"/" 区切り）。 */
export function documentKindOf(path: string, outDir: string | null): RepositoryDocument["kind"] | null {
  const segments = path.split("/");
  const name = segments[segments.length - 1] ?? "";
  const dirs = segments.slice(0, -1);
  if (dirs.some((dir) => EXCLUDED_DIRS.has(dir))) return null;
  if (outDir !== null && (path === outDir || path.startsWith(`${outDir}/`))) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith("changelog") || lower.startsWith("license")) return null;

  if (README_NAMES.has(lower)) {
    const dir = dirs.join("/");
    if (dir === "" || boundaryRootOf(path) === dir) return "README";
  }
  if ((lower.endsWith(".md") || lower.endsWith(".mdx")) && dirs.some((dir) => DOC_DIRS.has(dir))) return "DOC";
  if ([".sql", ".prisma", ".graphql", ".gql"].some((ext) => lower.endsWith(ext))) return "SCHEMA";
  return null;
}

/**
 * 資料の候補を辞書順に読み、上限を当てて documents と omittedDocuments を作る。
 * 合計の上限で止めたあとの資料は読まない。
 */
export async function collectDocuments(
  candidates: ReadonlyArray<{ path: string; kind: RepositoryDocument["kind"] }>,
  read: (path: string) => Promise<string>,
): Promise<Pick<RepositoryArtifacts, "documents" | "omittedDocuments">> {
  const sorted = [...candidates].sort((a, b) => compareIds(a.path, b.path));
  const documents: RepositoryDocument[] = [];
  const omittedDocuments: string[] = [];
  let total = 0;
  for (const candidate of sorted) {
    if (omittedDocuments.length > 0) {
      omittedDocuments.push(candidate.path);
      continue;
    }
    const { text, truncated, bytes } = limitUtf8(await read(candidate.path), DOCUMENT_FILE_LIMIT_BYTES);
    if (total + bytes > DOCUMENT_TOTAL_LIMIT_BYTES) {
      omittedDocuments.push(candidate.path);
      continue;
    }
    total += bytes;
    documents.push({ path: candidate.path, kind: candidate.kind, text, truncated });
  }
  return { documents, omittedDocuments };
}

/** 先頭から maxBytes バイトまでを、文字の途中で切らずに返す。 */
export function limitUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return { text, truncated: false, bytes: encoded.length };
  let end = maxBytes;
  // UTF-8 の継続バイト（10xxxxxx）の手前まで戻り、文字の頭で切る。
  while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const head = encoded.subarray(0, end);
  return { text: new TextDecoder().decode(head), truncated: true, bytes: head.length };
}