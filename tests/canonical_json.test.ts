// canonicalJson と sha256Hex のテスト（記録のキーの土台）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson } from "../src/lib/canonical_json.js";
import { sha256Hex } from "../src/lib/sha256.js";

test("キーの順が違っても同じ文字列になる", () => {
  const a = canonicalJson({ b: 1, a: { d: true, c: null } });
  const b = canonicalJson({ a: { c: null, d: true }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":null,"d":true},"b":1}');
});

test("配列の順は変えない", () => {
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("文字列は JSON の規則でエスケープする", () => {
  assert.equal(canonicalJson('a"b\n'), '"a\\"b\\n"');
  assert.equal(canonicalJson({ "キー": "値" }), '{"キー":"値"}');
});

test("空のオブジェクトと空の配列", () => {
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson([]), "[]");
});

test("有限でない数は受け付けない", () => {
  assert.throws(() => canonicalJson(Number.NaN), TypeError);
  assert.throws(() => canonicalJson({ x: Number.POSITIVE_INFINITY }), TypeError);
});

test("undefined が混ざっていたら止める", () => {
  const broken = { x: undefined } as unknown as { [key: string]: null };
  assert.throws(() => canonicalJson(broken), TypeError);
});

test("sha256Hex は既知の値と一致する", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});