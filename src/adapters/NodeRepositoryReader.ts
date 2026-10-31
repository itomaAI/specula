// リポジトリのディレクトリを読み、CommandExtractor に渡す RepositoryArtifacts を作る（Node.js の入口用。全体設計 4.1）。
// どのファイルを解析するかは CommandExtractor が決める。ここではテキストのコードと設定のファイル、仕様の資料を集めるだけ。
//
// - 集める拡張子: .ts .tsx .mts .cts .js .jsx .mjs .cjs .json
// - 仕様の資料: README・docs/ の Markdown・スキーマ定義（規則と上限は repository_documents.ts。CommandExtractor の設計 4.0）
// - 読まないディレクトリ: node_modules・.git・dist（どの深さでも）
// - 通常のファイルだけを読む（シンボリックリンクはたどらない）
// - path はリポジトリのルートからの相対パス（"/" 区切り）。並びはコード単位の辞書順。
// node: のモジュールは使うときに import する（NodeFsAdapter と同じ理由）。

import type { RepositoryArtifacts } from "../types/command.js";
import { readTsconfig } from "../core/command_extractor.js";
import { collectDocuments, documentKindOf } from "./repository_documents.js";

// IteraRepositoryReader も同じ規則で集めるので export する。
export const REPOSITORY_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
export const REPOSITORY_SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist"]);
const EXTENSIONS = REPOSITORY_EXTENSIONS;
const SKIPPED_DIRS = REPOSITORY_SKIPPED_DIRS;

export async function readRepository(rootDir: string): Promise<RepositoryArtifacts> {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");

  const paths: string[] = [];
  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await fs.readdir(nodePath.join(rootDir, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(relative);
      } else if (entry.isFile()) {
        paths.push(relative);
      }
    }
  };
  await walk("");

  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const read = (path: string): Promise<string> => fs.readFile(nodePath.join(rootDir, path), "utf8");
  const files: RepositoryArtifacts["files"] = [];
  for (const path of paths.filter((p) => EXTENSIONS.some((ext) => p.endsWith(ext)))) {
    files.push({ path, text: await read(path) });
  }
  const { outDir } = readTsconfig(files.find((f) => f.path === "tsconfig.json")?.text);
  const candidates = paths.flatMap((path) => {
    const kind = documentKindOf(path, outDir);
    return kind === null ? [] : [{ path, kind }];
  });
  return { files, ...(await collectDocuments(candidates, read)) };
}