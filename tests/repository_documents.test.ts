// 仕様の資料の選び方と上限のテスト（CommandExtractor の設計 4.0。repository_documents.ts）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOCUMENT_FILE_LIMIT_BYTES,
  DOCUMENT_TOTAL_LIMIT_BYTES,
  collectDocuments,
  documentKindOf,
  limitUtf8,
} from "../src/adapters/repository_documents.js";

test("README はリポジトリの直下とコンテキストの根の直下だけを入れ、名前の大文字小文字を区別しない", () => {
  assert.equal(documentKindOf("README.md", null), "README");
  assert.equal(documentKindOf("readme", null), "README");
  assert.equal(documentKindOf("Readme.MDX", null), "README");
  assert.equal(documentKindOf("packages/billing/README.md", null), "README");
  assert.equal(documentKindOf("src/features/cart/README.md", null), "README");
  assert.equal(documentKindOf("src/README.md", null), null);
  assert.equal(documentKindOf("packages/README.md", null), null);
  assert.equal(documentKindOf("packages/billing/src/README.md", null), null);
});

test("docs/・doc/ の下の .md・.mdx を DOC、スキーマ定義を SCHEMA にする", () => {
  assert.equal(documentKindOf("docs/specs/a.spec.md", null), "DOC");
  assert.equal(documentKindOf("packages/billing/doc/flow.mdx", null), "DOC");
  assert.equal(documentKindOf("docs/README.md", null), "DOC");
  assert.equal(documentKindOf("docs/pipeline_flow.json", null), null);
  assert.equal(documentKindOf("notes/a.md", null), null);
  assert.equal(documentKindOf("prisma/schema.prisma", null), "SCHEMA");
  assert.equal(documentKindOf("db/001_init.sql", null), "SCHEMA");
  assert.equal(documentKindOf("api/schema.graphql", null), "SCHEMA");
  assert.equal(documentKindOf("api/query.gql", null), "SCHEMA");
});

test("node_modules・tests・__tests__・outDir の下と、CHANGELOG・LICENSE を除く", () => {
  assert.equal(documentKindOf("node_modules/x/README.md", null), null);
  assert.equal(documentKindOf("tests/docs/a.md", null), null);
  assert.equal(documentKindOf("src/__tests__/schema.sql", null), null);
  assert.equal(documentKindOf("build/docs/a.md", "build"), null);
  assert.equal(documentKindOf("docs/a.md", "build"), "DOC");
  assert.equal(documentKindOf("docs/CHANGELOG.md", null), null);
  assert.equal(documentKindOf("LICENSE.md", null), null);
});

test("1 ファイルの上限を超えた資料は、文字の途中で切らずに先頭だけを入れて truncated にする", async () => {
  const big = "あ".repeat(DOCUMENT_FILE_LIMIT_BYTES); // 1 文字 3 バイトなので上限の 3 倍
  const result = await collectDocuments([{ path: "docs/big.md", kind: "DOC" }], async () => big);

  const doc = result.documents[0];
  assert.ok(doc !== undefined);
  assert.equal(doc.truncated, true);
  assert.ok(new TextEncoder().encode(doc.text).length <= DOCUMENT_FILE_LIMIT_BYTES);
  assert.ok(/^あ+$/.test(doc.text));
  assert.deepEqual(result.omittedDocuments, []);
});

test("合計の上限を超える資料とそれ以降は読まずに omittedDocuments へ入れる（辞書順）", async () => {
  const reads: string[] = [];
  const chunk = "a".repeat(DOCUMENT_FILE_LIMIT_BYTES);
  const count = DOCUMENT_TOTAL_LIMIT_BYTES / DOCUMENT_FILE_LIMIT_BYTES; // ちょうど上限まで入る数
  const candidates = Array.from({ length: count + 2 }, (_, i) => ({
    path: `docs/${String(i).padStart(3, "0")}.md`,
    kind: "DOC" as const,
  })).reverse();

  const result = await collectDocuments(candidates, async (path) => {
    reads.push(path);
    return chunk;
  });

  assert.equal(result.documents.length, count);
  assert.equal(result.documents[0]?.path, "docs/000.md");
  assert.deepEqual(result.omittedDocuments, [
    `docs/${String(count).padStart(3, "0")}.md`,
    `docs/${String(count + 1).padStart(3, "0")}.md`,
  ]);
  assert.equal(reads.length, count + 1); // 超えた 1 つは大きさを知るために読むが、その後は読まない
});

test("上限より小さい文字列はそのまま返す", () => {
  assert.deepEqual(limitUtf8("abc", 10), { text: "abc", truncated: false, bytes: 3 });
  assert.deepEqual(limitUtf8("aあ", 3), { text: "a", truncated: true, bytes: 1 });
});