// FileSystemPort の Itera 版（全体設計 4.1）。
// MetaOS の全域変数は参照しない。起動用のアプリが MetaOS.fs を引数で渡す（コアとテストが Itera を知らずに済むため）。

import type { FileSystemPort } from "../ports/FileSystemPort.js";

/** この版が使う MetaOS.fs の部分。 */
export interface IteraFs {
  read(path: string): Promise<string>;
  write(path: string, content: string, opts: { overwrite: boolean }): Promise<unknown>;
  exists(path: string): Promise<boolean>;
  /** 返す要素が名前かパスかは保証されていないので、こちらで名前にそろえる。 */
  list(path: string): Promise<string[]>;
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
}

export class IteraVfsAdapter implements FileSystemPort {
  constructor(private readonly fs: IteraFs) {}

  read(path: string): Promise<string> {
    return this.fs.read(path);
  }

  async write(path: string, content: string): Promise<void> {
    const parent = parentOf(path);
    if (parent !== "" && !(await this.fs.exists(parent))) {
      await this.fs.mkdir(parent, { recursive: true });
    }
    await this.fs.write(path, content, { overwrite: true });
  }

  exists(path: string): Promise<boolean> {
    return this.fs.exists(path);
  }

  async list(dir: string): Promise<string[]> {
    const entries = await this.fs.list(dir);
    return entries.map(nameOf);
  }
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? "" : trimmed.slice(0, at);
}

function nameOf(entry: string): string {
  const trimmed = entry.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}