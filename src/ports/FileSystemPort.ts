// ファイルの読み書きの口（全体設計 4.1）。
// コアはこの口だけを通してファイルに触れ、環境（node:fs、MetaOS.fs）を知らない。

export interface FileSystemPort {
  /** テキストとして読む。無ければ例外を投げる（呼ぶ側が exists で確かめる）。 */
  read(path: string): Promise<string>;
  /** テキストを書く。あれば上書きし、親のディレクトリが無ければ作る。 */
  write(path: string, content: string): Promise<void>;
  /** ファイルかディレクトリがあるか。 */
  exists(path: string): Promise<boolean>;
  /** ディレクトリの直下の名前（パスではない）。順序は保証しない。 */
  list(dir: string): Promise<string[]>;
}