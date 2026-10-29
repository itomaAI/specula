// FileSystemPort にルートのディレクトリを付ける包み（M1 の計画）。
// コアはリポジトリのルートからの相対パス（"src/a.ts"）で読み、ルートの付け足しは呼び出し元がこれで行う。
// ポートの型だけに依存する（node:fs も MetaOS.fs も知らない）。

import type { FileSystemPort } from "../ports/FileSystemPort.js";

/** root が "" か "." なら、そのまま返す。末尾の "/" は 1 つにそろえる。 */
export function withRoot(fs: FileSystemPort, root: string): FileSystemPort {
  if (root === "" || root === "." || root === "./") return fs;
  const trimmed = root.replace(/\/+$/, "");
  const join = (path: string): string => {
    const relative = path.replace(/^\.\//, "").replace(/^\/+/, "");
    if (trimmed === "") return `/${relative}`; // root が "/" のとき
    return relative === "" ? trimmed : `${trimmed}/${relative}`;
  };
  return {
    read: (path) => fs.read(join(path)),
    write: (path, content) => fs.write(join(path), content),
    exists: (path) => fs.exists(join(path)),
    list: (dir) => fs.list(join(dir)),
  };
}