// SpecProjector の Markdown をブロックに分ける関数のテスト（SpecViewer 基本設計 6.6）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown, tableCells } from "../src/viewer/markdown.js";

test("SpecProjector が出す記法を、それぞれの種類のブロックに分ける", () => {
  const text = [
    "# 仕様書: C-01（名前は未生成）",
    "",
    "この文書の表示名と用語は、人が確かめていない候補である。",
    "",
    "> 注意: この論点カタログは、いまの形式仕様正本とは別の版から作った。",
    "",
    "## 検証の状態",
    "",
    "- 一つ目",
    "- 二つ目",
    "",
    "1. 条件: a",
    "2. 書き込み: b",
    "",
    "| 状態変数 | 値の種類 |",
    "| :-- | :-- |",
    "| open | 真偽値 |",
    "",
    "```alloy",
    "sig A {}",
    "```",
    "",
  ].join("\n");
  assert.deepEqual(parseMarkdown(text), [
    { kind: "heading", level: 1, text: "仕様書: C-01（名前は未生成）" },
    { kind: "paragraph", text: "この文書の表示名と用語は、人が確かめていない候補である。" },
    { kind: "quote", text: "注意: この論点カタログは、いまの形式仕様正本とは別の版から作った。" },
    { kind: "heading", level: 2, text: "検証の状態" },
    { kind: "list", ordered: false, items: ["一つ目", "二つ目"] },
    { kind: "list", ordered: true, items: ["条件: a", "書き込み: b"] },
    { kind: "table", header: ["状態変数", "値の種類"], rows: [["open", "真偽値"]] },
    { kind: "code", info: "alloy", text: "sig A {}" },
  ]);
});

test("行の中の書式は解釈せず、前置きの後ろの LLM の文の記号もそのまま残す", () => {
  const text = ["- 主張: **強調** と `コード`", "- 判断質問: # 見出しではない | 表でもない", "#### C-01-L-001"].join("\n");
  assert.deepEqual(parseMarkdown(text), [
    { kind: "list", ordered: false, items: ["主張: **強調** と `コード`", "判断質問: # 見出しではない | 表でもない"] },
    { kind: "heading", level: 4, text: "C-01-L-001" },
  ]);
});

test("表のセルの \\| を | に戻す（mdCell の逆）", () => {
  assert.deepEqual(tableCells("| a \\| b | c |"), ["a | b", "c"]);
  const text = ["| 表示名 | 結果 |", "| :-- | :-- |", "| x \\| y | なし |"].join("\n");
  assert.deepEqual(parseMarkdown(text), [{ kind: "table", header: ["表示名", "結果"], rows: [["x | y", "なし"]] }]);
});

test("区切りの行が無い | の行は段落として扱う", () => {
  assert.deepEqual(parseMarkdown("| ただの行 |\n続き"), [{ kind: "paragraph", text: "| ただの行 |\n続き" }]);
});

test("囲みは同じ長さの行で閉じ、短い囲みはコードの中身として残す（fenceFor）", () => {
  const text = ["````alloy", "```", "x", "```", "````", "後ろの段落"].join("\n");
  assert.deepEqual(parseMarkdown(text), [
    { kind: "code", info: "alloy", text: "```\nx\n```" },
    { kind: "paragraph", text: "後ろの段落" },
  ]);
});

test("閉じていない囲みは最後までをコードとする", () => {
  assert.deepEqual(parseMarkdown("```alloy\nsig A {}\n"), [{ kind: "code", info: "alloy", text: "sig A {}\n" }]);
});