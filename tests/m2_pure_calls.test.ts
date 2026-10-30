// 状態を変えない組み込みのメソッドとの照合のテスト（M2 の設計 5 の表の下の規則）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { isPureCallee } from "../src/core/m2/pure_calls.js";

test("状態を変えない組み込み: メソッドは最後のプロパティの名前で照合する", () => {
  for (const callee of ["xs.map", "a.b.filter", "name.trim", "a?.join", "(xs as string[]).slice", "m.get", "s.has"]) {
    assert.equal(isPureCallee(callee), true, callee);
  }
  for (const callee of ["xs.push", "xs.sort", "xs.reverse", "xs.splice", "m.set", "s.add", "m.delete", "xs[k]", "xs['map']"]) {
    assert.equal(isPureCallee(callee), false, callee);
  }
});

test("状態を変えない組み込み: 静的なメソッドと大域の関数は原文全体で照合する", () => {
  for (const callee of ["Object.keys", "Object.entries", "Array.isArray", "JSON.stringify", "Math.max", "Math.random", "Number.isFinite", "String", "parseInt"]) {
    assert.equal(isPureCallee(callee), true, callee);
  }
  // Object・Array などが受け手のときは、メソッドの一覧（keys・values など）を使わない
  for (const callee of ["Object.assign", "Object.freeze", "Object.defineProperty", "Array.prototype", "Reflect.set", "Promise.all", "save", "compute", "new Date", ""]) {
    assert.equal(isPureCallee(callee), false, callee);
  }
});