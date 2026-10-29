// FileSystemPort の Node.js 版（全体設計 4.1）。
// node: のモジュールは、使うときに import する。Itera 向けの bundle（build:itera）は node:* を外に出すので、
// ここで静的に import すると、ブラウザで読み込んだ時点で失敗するため。

import type { FileSystemPort } from "../ports/FileSystemPort.js";

export class NodeFsAdapter implements FileSystemPort {
  async read(path: string): Promise<string> {
    const fs = await import("node:fs/promises");
    return fs.readFile(path, "utf8");
  }

  async write(path: string, content: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    await fs.mkdir(nodePath.dirname(path), { recursive: true });
    await fs.writeFile(path, content, "utf8");
  }

  async exists(path: string): Promise<boolean> {
    const fs = await import("node:fs/promises");
    try {
      await fs.stat(path);
      return true;
    } catch (error) {
      // 無いことだけを false にする。権限などほかの失敗は、環境の故障として上げる。
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async list(dir: string): Promise<string[]> {
    const fs = await import("node:fs/promises");
    return fs.readdir(dir);
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}