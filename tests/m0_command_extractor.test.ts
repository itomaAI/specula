// CommandExtractor のテスト（CommandExtractor の設計 2〜4、仕様の 2.2）。
// 小さな偽のリポジトリを使う。CommandExtractor は LLM を使わない（2026-10-30 に外した）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverSystemContext, sliceCommands, stripJsonc } from "../src/core/command_extractor.js";
import type { RepositoryArtifacts } from "../src/types/command.js";

function repo(files: Record<string, string>, screenshots?: string[]): RepositoryArtifacts {
  return {
    files: Object.entries(files).map(([path, text]) => ({ path, text })),
    documents: [],
    omittedDocuments: [],
    ...(screenshots === undefined ? {} : { screenshots }),
  };
}

// ---------------------------------------------------------------------------
// 1. ライブラリの形（specula 自身と同じ: 画面も DB も無い。入口は package.json の main → dist → src）

const LIBRARY = repo({
  "package.json": JSON.stringify({ name: "lib", type: "module", main: "./dist/src/index.js", types: "./dist/src/index.d.ts" }),
  "tsconfig.json": [
    "{",
    "  // ビルドの設定",
    '  "compilerOptions": {',
    '    "rootDir": ".", /* 元のファイルの根 */',
    '    "outDir": "dist",',
    "  },",
    "}",
  ].join("\n"),
  "src/index.ts": [
    'export { alpha } from "./core/a.js";',
    'export { beta, gamma, NotAFunction } from "./core/b.js";',
    'import { delta } from "./core/d.js";',
    "export { delta };",
    'export * from "./core/star.js";',
    'export { default as eta } from "./core/e.js";',
    'export type { T } from "./t.js";',
    'export const VERSION = "1";',
  ].join("\n"),
  "src/core/a.ts": "export function alpha(x: number): number {\n  return x + 1;\n}\n",
  "src/core/b.ts": "export function beta() {\n  return 1;\n}\nexport const gamma = (s: string) => s.length;\nexport class NotAFunction {}\n",
  "src/core/d.ts": "export function delta() {}\nexport function hidden() {}\n",
  "src/core/star.ts": "export function epsilon() {}\nexport function zeta() {}\n",
  "src/core/e.ts": "function etaImpl() {}\nexport default etaImpl;\n",
  "src/t.ts": "export type T = number;\n",
  "src/broken.ts": "export function (\n",
  "dist/src/index.js": "export function compiled() {}\n",
  "tests/a.test.ts": "export function testOnly() {}\n",
});

const LIBRARY_COMMANDS = [
  "CMD-src/core/a.ts#alpha",
  "CMD-src/core/b.ts#beta",
  "CMD-src/core/b.ts#gamma",
  "CMD-src/core/d.ts#delta",
  "CMD-src/core/e.ts#etaImpl",
  "CMD-src/core/star.ts#epsilon",
  "CMD-src/core/star.ts#zeta",
];

test("ライブラリ: 入口から公開されている関数 7 本が、それぞれ別のコマンドとシナリオの起点になる", () => {
  const map = discoverSystemContext(LIBRARY);
  assert.equal(map.diagnostics.mode, "PUBLIC_FUNCTIONS");
  assert.deepEqual(map.diagnostics.entryFiles, ["src/index.ts"]);
  assert.deepEqual(map.commands.map((c) => c.id), LIBRARY_COMMANDS);
  assert.deepEqual(
    map.events.map((e) => e.id),
    LIBRARY_COMMANDS.map((id) => id.replace(/^CMD-/, "EVT-")),
  );
  for (const event of map.events) {
    assert.equal(event.signal.kind, "PUBLIC_FUNCTION");
    assert.deepEqual(event.after, []);
  }
  assert.deepEqual(map.boundedContexts.map((c) => c.id), ["DEFAULT_CONTEXT"]);
  assert.deepEqual(map.readModels, []);
  assert.deepEqual(map.policies, []);

  const result = sliceCommands(map);
  assert.equal(result.commands.length, 7);
  assert.deepEqual(result.rejected, []);
  const handlers = new Set(result.commands.map((s) => `${s.inletTrigger.handler.file}#${s.inletTrigger.handler.symbol}`));
  assert.equal(handlers.size, 7, "起点の所在がシナリオごとに違う");
  const expected = new Set(result.commands.map((s) => s.expectedEvent));
  assert.equal(expected.size, 7, "期待イベントがシナリオごとに違う");
  for (const commandTarget of result.commands) {
    assert.deepEqual(commandTarget.actor, { id: "ACT-Caller", name: "Caller" });
    assert.equal(commandTarget.readModel, undefined, "画面が無いシステムでは画面を付けない");
    assert.equal(commandTarget.origin, "EXTRACTED");
    assert.equal(commandTarget.inletType, "COMMAND");
  }
});

test("ライブラリ: dist・tests を読まず、構文の誤りはファイルごとに記録して先へ進む", () => {
  const map = discoverSystemContext(LIBRARY);
  assert.equal(map.diagnostics.parsedFileCount, 7);
  assert.deepEqual(map.diagnostics.parseFailures.map((f) => f.path), ["src/broken.ts"]);
  assert.ok(map.commands.every((c) => !c.handler.file.startsWith("dist/") && !c.handler.file.startsWith("tests/")));
});

test("全体マップとシナリオは LLM の欄（name・intent・intentStatus）を持たない", () => {
  const map = discoverSystemContext(LIBRARY);
  for (const context of map.boundedContexts) {
    assert.deepEqual(Object.keys(context).sort(), ["id", "isDefaultFallback", "name", "rootPaths"]);
  }
  for (const item of [...map.events, ...map.commands, ...map.policies]) assert.equal("name" in item, false);
  for (const commandTarget of sliceCommands(map).commands) {
    assert.equal("intent" in commandTarget, false);
    assert.equal("intentStatus" in commandTarget, false);
    assert.deepEqual(Object.keys(commandTarget.inletTrigger).sort(), ["handler", "id"]);
  }
});

test("並びは辞書順で、2 回実行して同じ結果になる", () => {
  const first = discoverSystemContext(LIBRARY);
  const second = discoverSystemContext(LIBRARY);
  assert.deepEqual(first, second);
  const sorted = (ids: string[]): string[] => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(first.commands.map((c) => c.id), sorted(first.commands.map((c) => c.id)));
  assert.deepEqual(first.events.map((e) => e.id), sorted(first.events.map((e) => e.id)));
  const a = sliceCommands(first);
  const b = sliceCommands(second);
  assert.deepEqual(a, b);
  assert.deepEqual(a.commands.map((s) => s.id), sorted(a.commands.map((s) => s.id)));
});

// ---------------------------------------------------------------------------
// 2. Next.js と Firestore の形

const WEB_APP = repo(
  {
    "app/profile/page.tsx": [
      'import { saveProfile } from "../../lib/profile";',
      "export default function Page() {",
      '  return <button onClick={() => saveProfile("x")}>save</button>;',
      "}",
    ].join("\n"),
    "app/admin/page.tsx": "export default function Admin() {\n  return <div>admin</div>;\n}\n",
    "lib/profile.ts": [
      'import { doc, updateDoc } from "firebase/firestore";',
      'import { db } from "./db";',
      "export async function saveProfile(name: string) {",
      '  await updateDoc(doc(db, "users", "u1"), { name });',
      "}",
      "export async function removeUser(user: { role: string }) {",
      '  if (user.role === "admin") {',
      '    await db.collection("users").doc("u1").delete();',
      "  }",
      "}",
    ].join("\n"),
  },
  ["shots/profile.png", "shots/other.png"],
);

test("Next.js と Firestore: DB の書き込みがコマンドになり、使っている画面とアクターが付く", () => {
  const map = discoverSystemContext(WEB_APP);
  assert.equal(map.diagnostics.mode, "STATE_SIGNALS");
  assert.deepEqual(map.readModels.map((m) => [m.id, m.route, m.screenshotPath ?? null]), [
    ["RM-app/admin/page.tsx", "/admin", null],
    ["RM-app/profile/page.tsx", "/profile", "shots/profile.png"],
  ]);
  assert.deepEqual(map.commands.map((c) => [c.id, c.actorId, c.readModelId ?? null]), [
    ["CMD-lib/profile.ts#removeUser", "ACT-admin", null],
    ["CMD-lib/profile.ts#saveProfile", "ACT-Caller", "RM-app/profile/page.tsx"],
  ]);
  assert.deepEqual(map.events.map((e) => [e.id, e.signal.kind, e.signal.callee, e.signal.label]), [
    ["EVT-lib/profile.ts#removeUser", "DB_MUTATION", "delete", "users"],
    ["EVT-lib/profile.ts#saveProfile", "DB_MUTATION", "updateDoc", "users"],
  ]);
  assert.deepEqual(map.actors.map((a) => a.id), ["ACT-Caller", "ACT-admin"]);

  const result = sliceCommands(map);
  const save = result.commands.find((s) => s.id === "CT-CMD-lib/profile.ts#saveProfile");
  assert.ok(save !== undefined);
  assert.deepEqual(save.readModel, {
    name: "/profile",
    route: "/profile",
    entryFile: "app/profile/page.tsx",
    screenshotPath: "shots/profile.png",
  });
  const remove = result.commands.find((s) => s.id === "CT-CMD-lib/profile.ts#removeUser");
  assert.ok(remove !== undefined);
  assert.deepEqual(remove.actor, { id: "ACT-admin", name: "admin" });
  assert.equal(remove.readModel, undefined, "画面がハンドラを使っていなければ画面を付けない");
});

test("利用者定義: 画面のルートが全体マップにあれば付け、無ければ rejected に理由を付ける", () => {
  const map = discoverSystemContext(WEB_APP);
  const result = sliceCommands(map, {
    userDefined: [
      { inlet: "CMD-lib/profile.ts#removeUser", route: "/admin", intent: "管理者がユーザーを消す" },
      { inlet: "lib/profile.ts#saveProfile", route: "/nowhere" },
    ],
  });
  const remove = result.commands.find((s) => s.id === "CT-CMD-lib/profile.ts#removeUser");
  assert.ok(remove !== undefined);
  assert.equal(remove.origin, "USER_DEFINED");
  assert.equal(remove.userIntent, "管理者がユーザーを消す");
  assert.equal(remove.readModel?.route, "/admin");
  assert.deepEqual(result.rejected.map((r) => r.inlet), ["lib/profile.ts#saveProfile"]);
  // rejected になった起点は抽出側から出る
  const save = result.commands.find((s) => s.id === "CT-CMD-lib/profile.ts#saveProfile");
  assert.equal(save?.origin, "EXTRACTED");
});

// ---------------------------------------------------------------------------
// 3. リスナーのあるもの（ポリシー）

const LISTENER = repo({
  "src/users.ts": 'import { bus } from "./bus.js";\nexport function register(name: string) {\n  bus.emit("user.registered", { name });\n}\n',
  "src/mail.ts": 'import { prisma } from "./db.js";\nexport async function sendWelcome(payload: unknown) {\n  await prisma.mail.create({ data: { payload } });\n}\n',
  "src/wire.ts": 'import { bus } from "./bus.js";\nimport { sendWelcome } from "./mail.js";\nbus.on("user.registered", sendWelcome);\n',
});

test("リスナー: 発行の名前と一致するリスナーがポリシーになり、起動されるイベントの after にきっかけが入る", () => {
  const map = discoverSystemContext(LISTENER);
  assert.equal(map.diagnostics.mode, "STATE_SIGNALS");
  assert.deepEqual(map.policies.map((p) => [p.id, p.triggerEventId, p.actionCommandId, p.listener.line]), [
    ["POL-src/wire.ts#<module>@3", "EVT-src/users.ts#register", "CMD-src/mail.ts#sendWelcome", 3],
  ]);
  const welcome = map.events.find((e) => e.id === "EVT-src/mail.ts#sendWelcome");
  assert.deepEqual(welcome?.after, ["EVT-src/users.ts#register"]);
  const registered = map.events.find((e) => e.id === "EVT-src/users.ts#register");
  assert.deepEqual(registered?.signal, { kind: "EVENT_EMIT", callee: "emit", label: "user.registered", line: 3 });

  const result = sliceCommands(map);
  assert.deepEqual(result.commands.map((s) => [s.id, s.inletType, s.expectedEvent]), [
    ["CT-CMD-src/mail.ts#sendWelcome", "COMMAND", "EVT-src/mail.ts#sendWelcome"],
    ["CT-CMD-src/users.ts#register", "COMMAND", "EVT-src/users.ts#register"],
    ["CT-POL-src/wire.ts#<module>@3", "POLICY", "EVT-src/mail.ts#sendWelcome"],
  ]);
  const policy = result.commands.find((s) => s.inletType === "POLICY");
  assert.equal(policy?.inletTrigger.handler.file, "src/wire.ts", "ポリシーの起点はリスナーの登録の場所");
});

test("選択: filter は抽出したシナリオにだけ効き、利用者定義は同じ起点の抽出を置き換える", () => {
  const map = discoverSystemContext(LISTENER);
  const result = sliceCommands(map, {
    filter: { inlets: ["CMD-src/users.ts#register"] },
    userDefined: [
      { inlet: "src/mail.ts#sendWelcome", intent: "歓迎メールを送る" },
      { inlet: "src/nope.ts#missing" },
    ],
  });
  assert.deepEqual(result.commands.map((s) => [s.id, s.origin]), [
    ["CT-CMD-src/mail.ts#sendWelcome", "USER_DEFINED"],
    ["CT-CMD-src/users.ts#register", "EXTRACTED"],
  ]);
  assert.deepEqual(result.rejected, [{ inlet: "src/nope.ts#missing", reason: "起点が全体マップに無い" }]);
});

// ---------------------------------------------------------------------------
// 4. 小さな部品

test("stripJsonc: コメントと閉じ括弧の前のカンマを除き、文字列の中は触らない", () => {
  const text = '{\n  // c\n  "a": "x // y /* z */", /* d */\n  "b": [1, 2, /* e */ ],\n}';
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: "x // y /* z */", b: [1, 2] });
});