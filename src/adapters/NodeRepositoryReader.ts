// リポジトリのディレクトリを読み、M0 に渡す RepositoryArtifacts を作る（Node.js の入口用。全体設計 4.1）。
// どのファイルを解析するかは M0 が決める。ここではテキストのコードと設定のファイルを集めるだけ。
//
// - 集める拡張子: .ts .tsx .mts .cts .js .jsx .mjs .cjs .json
// - 読まないディレクトリ: node_modules・.git・dist（どの深さでも）
// - 通常のファイルだけを読む（シンボリックリンクはたどらない）
// - path はリポジトリのルートからの相対パス（"/" 区切り）。並びはコード単位の辞書順。
// node: のモジュールは使うときに import する（NodeFsAdapter と同じ理由）。

import type { RepositoryArtifacts } from "../types/scenario.js";

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);

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
      } else if (entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        paths.push(relative);
      }
    }
  };
  await walk("");

  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files: RepositoryArtifacts["files"] = [];
  for (const path of paths) {
    files.push({ path, text: await fs.readFile(nodePath.join(rootDir, path), "utf8") });
  }
  return { files };
}