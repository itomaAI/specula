// SHA-256 を 16 進の文字列で返す（全体設計 1.3）。
// Web Crypto（globalThis.crypto.subtle）を使う。Node.js 22 とブラウザの両方にあるので、依存を足さない。

export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("sha256Hex: Web Crypto（crypto.subtle）がこの環境に無い");
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}