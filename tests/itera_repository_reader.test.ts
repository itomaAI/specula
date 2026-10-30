// IteraRepositoryReader のテスト（全体設計 4.1: VFS からリポジトリを読む。NodeRepositoryReader と同じ規則）。
// メモリ上のファイルの木を RepositorySource として渡す。list は Itera のように「パス」を返す版と「名前」を返す版を試す。

import { test } from "node:test";
import assert from "node:assert/strict";

import { readIteraRepository } from "../src/adapters/IteraRepositoryReader.js";
import type { RepositorySource } from "../src/adapters/IteraRepositoryReader.js";

function sourceOf(files: Record<string, string>, listReturns: "paths" | "names"): RepositorySource & { reads: string[] } {
  const reads: string[] = [];
  const isDir = (path: string): boolean => Object.keys(files).some((f) => f.startsWith(path + "/"));
  return {
    reads,
    async list(dir: string): Promise<string[]> {
      const prefix = dir + "/";
      const children = new Set<string>();
      for (const f of Object.keys(files)) {
        if (!f.startsWith(prefix)) continue;
        const name = f.slice(prefix.length).split("/")[0] ?? "";
        children.add(name);
      }
      return [...children].map((name) => (listReturns === "paths" ? `${dir}/${name}${isDir(prefix + name) ? "/" : ""}` : name));
    },
    async isDirectory(path: string): Promise<boolean> {
      return isDir(path);
    },
    async read(path: string): Promise<string> {
      reads.push(path);
      const text = files[path];
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return text;
    },
  };
}

const TREE: Record<string, string> = {
  "user/repo/package.json": "{}",
  "user/repo/src/b.ts": "export const b = 1;",
  "user/repo/src/a.tsx": "export const a = 1;",
  "user/repo/src/sub/c.mjs": "export const c = 1;",
  "user/repo/README.md": "# readme",
  "user/repo/src/logo.png": "binary",
  "user/repo/node_modules/x/index.js": "module.exports = 1;",
  "user/repo/dist/index.js": "built",
  "user/repo/.git/config": "[core]",
  "user/repo/src/dist/d.ts": "export const d = 1;",
};

for (const listReturns of ["paths", "names"] as const) {
  test(`拡張子で集め、node_modules・.git・dist をどの深さでも読まず、辞書順の相対パスにする（list が ${listReturns} を返す）`, async () => {
    const source = sourceOf(TREE, listReturns);

    const artifacts = await readIteraRepository(source, "user/repo/");

    assert.deepEqual(
      artifacts.files.map((f) => f.path),
      ["package.json", "src/a.tsx", "src/b.ts", "src/sub/c.mjs"],
    );
    assert.equal(artifacts.files.find((f) => f.path === "src/b.ts")?.text, "export const b = 1;");
    assert.ok(source.reads.every((p) => p.startsWith("user/repo/") && !p.includes("node_modules") && !p.includes("/dist/")));
  });

  test(`仕様の資料（README・docs の Markdown・スキーマ定義）を documents に入れ、outDir と tests の下を除く（list が ${listReturns} を返す）`, async () => {
    const source = sourceOf(
      {
        ...TREE,
        "user/repo/tsconfig.json": '{ "compilerOptions": { "outDir": "build" } // コメント\n}',
        "user/repo/docs/specs/a.spec.md": "# a",
        "user/repo/docs/CHANGELOG.md": "# changes",
        "user/repo/prisma/schema.prisma": "model A {}",
        "user/repo/packages/billing/README.md": "# billing",
        "user/repo/build/docs/old.md": "# built",
        "user/repo/tests/docs/t.md": "# test",
        "user/repo/node_modules/x/README.md": "# dep",
      },
      listReturns,
    );

    const artifacts = await readIteraRepository(source, "user/repo");

    assert.deepEqual(
      artifacts.documents.map((d) => [d.path, d.kind, d.truncated]),
      [
        ["README.md", "README", false],
        ["docs/specs/a.spec.md", "DOC", false],
        ["packages/billing/README.md", "README", false],
        ["prisma/schema.prisma", "SCHEMA", false],
      ],
    );
    assert.equal(artifacts.documents.find((d) => d.path === "docs/specs/a.spec.md")?.text, "# a");
    assert.deepEqual(artifacts.omittedDocuments, []);
    assert.ok(!artifacts.files.some((f) => f.path.endsWith(".md")));
  });
}