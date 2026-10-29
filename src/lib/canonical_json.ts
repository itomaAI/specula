// 正準化した JSON（全体設計 1.3: 記録のキーを作るため）。
// オブジェクトのキーを辞書順（UTF-16 のコード単位の順）に並べ、空白を入れない。配列の順は変えない。

import type { JsonValue } from "../types/index.js";

export function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // NaN と Infinity は JSON.stringify で null になり、別の入力と同じキーになるので受け付けない。
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: 有限でない数は JSON にできない（${String(value)}）`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
      }
      const keys = Object.keys(value).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const item = value[key];
        // 型の上では起きないが、実行時に undefined が入っていたら JSON にできないので止める。
        if (item === undefined) {
          throw new TypeError(`canonicalJson: キー "${key}" の値が undefined`);
        }
        parts.push(JSON.stringify(key) + ":" + canonicalJson(item));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new TypeError(`canonicalJson: JSON にできない値（${typeof value}）`);
  }
}