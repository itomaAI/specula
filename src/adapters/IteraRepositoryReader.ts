// リポジトリのディレクトリを Itera OS の VFS から読み、M0 に渡す RepositoryArtifacts を作る（Itera OS の入口用。全体設計 4.1）。
// NodeRepositoryReader と同じ規則で集める（拡張子・読まないディレクトリ・相対パス・辞書順）。
//
// - FileSystemPort はファイルとディレクトリを区別できないので、読む口は狭い RepositorySource として受ける。
//   起動アプリが MetaOS.fs から作って渡す（isDirectory は `MetaOS.fs.stat(path).kind === "directory"`）。MetaOS は参照しない。
// - list が名前を返すかパスを返すかは保証されていないので、名前にそろえる（IteraVfsAdapter と同じ）。

import type { RepositoryArtifacts } from "../types/scenario.js";
import { REPOSITORY_EXTENSIONS, REPOSITORY_SKIPPED_DIRS } from "./NodeRepositoryReader.js";

/** リポジトリを読むのに使う口。 */
export interface RepositorySource {
  /** ディレクトリの直下。要素は名前でもパスでもよい。 */
  list(dir: string): Promise<string[]>;
  isDirectory(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}

export async function readIteraRepository(source: RepositorySource, rootDir: string): Promise<RepositoryArtifacts> {
  const root = rootDir.replace(/\/+$/, "");
  const absolute = (relative: string): string => (relative === "" ? root : root === "" ? relative : `${root}/${relative}`);

  const paths: string[] = [];
  const walk = async (relativeDir: string): Promise<void> => {
    const names = (await source.list(absolute(relativeDir))).map(nameOf).filter((name) => name !== "");
    for (const name of names) {
      const relative = relativeDir === "" ? name : `${relativeDir}/${name}`;
      if (await source.isDirectory(absolute(relative))) {
        if (!REPOSITORY_SKIPPED_DIRS.has(name)) await walk(relative);
      } else if (REPOSITORY_EXTENSIONS.some((ext) => name.endsWith(ext))) {
        paths.push(relative);
      }
    }
  };
  await walk("");

  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files: RepositoryArtifacts["files"] = [];
  for (const path of paths) {
    files.push({ path, text: await source.read(absolute(path)) });
  }
  return { files };
}

function nameOf(entry: string): string {
  const trimmed = entry.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}