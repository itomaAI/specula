// M0（ScenarioExtractor）のテスト（M0 の設計 2〜4、仕様 00 の 2.2）。
// 小さな偽のリポジトリと、決まった答えを返す偽の LLM を使う。

import { test } from "node:test";
import assert from "node:assert/strict";

import { discoverSystemContext, sliceScenarios, stripJsonc } from "../src/core/scenario_extractor.js";
import type { LanguageModelPort, OutputCheck } from "../src/ports/LanguageModelPort.js";
import type { LlmRequest, LlmText } from "../src/types/index.js";
import type { EventStormingMap, RepositoryArtifacts } from "../src/types/scenario.js";

/** 答えを関数で決める偽の LLM。null を返すと「届かない」。形の確認は本物と同じく check で行う。 */
class FakeLlm implements LanguageModelPort {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly answer: (request: LlmRequest) => string | null) {}
  async generate(request: LlmRequest, check: OutputCheck): Promise<LlmText> {
    this.calls.push(request);
    const text = this.answer(request);
    if (text === null) return { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "fake" };
    const result = check(text);
    if (!result.ok) return { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: result.detail };
    return { status: "GENERATED", text: text.trim(), recordKey: `${request.task}:${JSON.stringify(request.input)}` };
  }
}

const fixedLlm = (): FakeLlm => new FakeLlm((r) => (r.task.startsWith("m0.name") ? "Alpha" : "意図の候補"));
const otherLlm = (): FakeLlm => new FakeLlm((r) => (r.task.startsWith("m0.name") ? "Omega" : "別の意図"));
const invalidLlm = (): FakeLlm => new FakeLlm((r) => (r.task.startsWith("m0.name") ? "not pascal case" : "1行目\n2行目"));
const unreachableLlm = (): FakeLlm => new FakeLlm(() => null);

function repo(files: Record<string, string>, screenshots?: string[]): RepositoryArtifacts {
  return {
    files: Object.entries(files).map(([path, text]) => ({ path, text })),
    documents: [],
    omittedDocuments: [],
    ...(screenshots === undefined ? {} : { screenshots }),
  };
}

/** 識別子だけを取り出す（名前と意図によらない部分）。 */
function idsOf(map: EventStormingMap): unknown {
  return {
    contexts: map.boundedContexts.map((c) => c.id),
    events: map.events.map((e) => [e.id, e.after]),
    commands: map.commands.map((c) => [c.id, c.actorId, c.readModelId ?? null, c.eventIds]),
    policies: map.policies.map((p) => [p.id, p.triggerEventId, p.actionCommandId]),
    readModels: map.readModels.map((m) => m.id),
    actors: map.actors.map((a) => a.id),
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

test("ライブラリ: 入口から公開されている関数 7 本が、それぞれ別のコマンドとシナリオの起点になる", async () => {
  const map = await discoverSystemContext(LIBRARY, { llm: fixedLlm() });
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

  const result = await sliceScenarios(map, undefined, { llm: fixedLlm() });
  assert.equal(result.scenarios.length, 7);
  assert.deepEqual(result.rejected, []);
  const handlers = new Set(result.scenarios.map((s) => `${s.inletTrigger.handler.file}#${s.inletTrigger.handler.symbol}`));
  assert.equal(handlers.size, 7, "起点の所在がシナリオごとに違う");
  const expected = new Set(result.scenarios.map((s) => s.expectedEvent));
  assert.equal(expected.size, 7, "期待イベントがシナリオごとに違う");
  for (const scenario of result.scenarios) {
    assert.deepEqual(scenario.actor, { id: "ACT-Caller", name: "Caller" });
    assert.equal(scenario.readModel, undefined, "画面が無いシステムでは画面を付けない");
    assert.equal(scenario.origin, "EXTRACTED");
    assert.equal(scenario.inletType, "COMMAND");
    assert.equal(scenario.intentStatus, "CANDIDATE");
  }
});

test("ライブラリ: dist・tests を読まず、構文の誤りはファイルごとに記録して先へ進む", async () => {
  const map = await discoverSystemContext(LIBRARY, { llm: fixedLlm() });
  assert.equal(map.diagnostics.parsedFileCount, 7);
  assert.deepEqual(map.diagnostics.parseFailures.map((f) => f.path), ["src/broken.ts"]);
  assert.ok(map.commands.every((c) => !c.handler.file.startsWith("dist/") && !c.handler.file.startsWith("tests/")));
});

test("識別子は LLM の名前によらない（別の答え・形の合わない答え・届かないとき）", async () => {
  const base = idsOf(await discoverSystemContext(LIBRARY, { llm: fixedLlm() }));
  assert.deepEqual(idsOf(await discoverSystemContext(LIBRARY, { llm: otherLlm() })), base);
  assert.deepEqual(idsOf(await discoverSystemContext(LIBRARY, { llm: invalidLlm() })), base);
  assert.deepEqual(idsOf(await discoverSystemContext(LIBRARY, { llm: unreachableLlm() })), base);
});

test("LLM に届かないとき: 名前と意図は NOT_GENERATED になり、識別子とシナリオの数は変わらない", async () => {
  const map = await discoverSystemContext(LIBRARY, { llm: unreachableLlm() });
  for (const item of [...map.events, ...map.commands]) {
    assert.deepEqual(item.name, { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "fake" });
  }
  for (const context of map.boundedContexts) assert.equal(context.intent.status, "NOT_GENERATED");
  const result = await sliceScenarios(map, undefined, { llm: unreachableLlm() });
  assert.equal(result.scenarios.length, 7);
  for (const scenario of result.scenarios) assert.equal(scenario.intent.status, "NOT_GENERATED");

  const fixed = await sliceScenarios(await discoverSystemContext(LIBRARY, { llm: fixedLlm() }), undefined, { llm: fixedLlm() });
  assert.deepEqual(result.scenarios.map((s) => s.id), fixed.scenarios.map((s) => s.id));
});

test("形の合わない答えは INVALID_OUTPUT になり、文で埋めない", async () => {
  const map = await discoverSystemContext(LIBRARY, { llm: invalidLlm() });
  for (const command of map.commands) {
    assert.equal(command.name.status, "NOT_GENERATED");
    if (command.name.status === "NOT_GENERATED") assert.equal(command.name.reason, "INVALID_OUTPUT");
  }
});

test("LLM のポートを渡さずに切り出すと、意図は NOT_GENERATED（UNREACHABLE）", async () => {
  const map = await discoverSystemContext(LIBRARY, { llm: fixedLlm() });
  const result = await sliceScenarios(map);
  assert.equal(result.scenarios.length, 7);
  for (const scenario of result.scenarios) {
    assert.equal(scenario.intent.status, "NOT_GENERATED");
    if (scenario.intent.status === "NOT_GENERATED") assert.equal(scenario.intent.reason, "UNREACHABLE");
  }
});

test("並びは辞書順で、2 回実行して同じ結果になる", async () => {
  const first = await discoverSystemContext(LIBRARY, { llm: fixedLlm() });
  const second = await discoverSystemContext(LIBRARY, { llm: fixedLlm() });
  assert.deepEqual(first, second);
  const sorted = (ids: string[]): string[] => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(first.commands.map((c) => c.id), sorted(first.commands.map((c) => c.id)));
  assert.deepEqual(first.events.map((e) => e.id), sorted(first.events.map((e) => e.id)));
  const a = await sliceScenarios(first, undefined, { llm: fixedLlm() });
  const b = await sliceScenarios(second, undefined, { llm: fixedLlm() });
  assert.deepEqual(a, b);
  assert.deepEqual(a.scenarios.map((s) => s.id), sorted(a.scenarios.map((s) => s.id)));
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

test("Next.js と Firestore: DB の書き込みがコマンドになり、使っている画面とアクターが付く", async () => {
  const map = await discoverSystemContext(WEB_APP, { llm: fixedLlm() });
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

  const result = await sliceScenarios(map, undefined, { llm: fixedLlm() });
  const save = result.scenarios.find((s) => s.id === "SCN-CMD-lib/profile.ts#saveProfile");
  assert.ok(save !== undefined);
  assert.deepEqual(save.readModel, {
    name: "/profile",
    route: "/profile",
    entryFile: "app/profile/page.tsx",
    screenshotPath: "shots/profile.png",
  });
  const remove = result.scenarios.find((s) => s.id === "SCN-CMD-lib/profile.ts#removeUser");
  assert.ok(remove !== undefined);
  assert.deepEqual(remove.actor, { id: "ACT-admin", name: "admin" });
  assert.equal(remove.readModel, undefined, "画面がハンドラを使っていなければ画面を付けない");
});

test("利用者定義: 画面のルートが全体マップにあれば付け、無ければ rejected に理由を付ける", async () => {
  const map = await discoverSystemContext(WEB_APP, { llm: fixedLlm() });
  const result = await sliceScenarios(
    map,
    {
      userDefined: [
        { inlet: "CMD-lib/profile.ts#removeUser", route: "/admin", intent: "管理者がユーザーを消す" },
        { inlet: "lib/profile.ts#saveProfile", route: "/nowhere" },
      ],
    },
    { llm: fixedLlm() },
  );
  const remove = result.scenarios.find((s) => s.id === "SCN-CMD-lib/profile.ts#removeUser");
  assert.ok(remove !== undefined);
  assert.equal(remove.origin, "USER_DEFINED");
  assert.equal(remove.userIntent, "管理者がユーザーを消す");
  assert.equal(remove.intentStatus, "CANDIDATE");
  assert.equal(remove.readModel?.route, "/admin");
  assert.deepEqual(result.rejected.map((r) => r.inlet), ["lib/profile.ts#saveProfile"]);
  // rejected になった起点は抽出側から出る
  const save = result.scenarios.find((s) => s.id === "SCN-CMD-lib/profile.ts#saveProfile");
  assert.equal(save?.origin, "EXTRACTED");
});

// ---------------------------------------------------------------------------
// 3. リスナーのあるもの（ポリシー）

const LISTENER = repo({
  "src/users.ts": 'import { bus } from "./bus.js";\nexport function register(name: string) {\n  bus.emit("user.registered", { name });\n}\n',
  "src/mail.ts": 'import { prisma } from "./db.js";\nexport async function sendWelcome(payload: unknown) {\n  await prisma.mail.create({ data: { payload } });\n}\n',
  "src/wire.ts": 'import { bus } from "./bus.js";\nimport { sendWelcome } from "./mail.js";\nbus.on("user.registered", sendWelcome);\n',
});

test("リスナー: 発行の名前と一致するリスナーがポリシーになり、起動されるイベントの after にきっかけが入る", async () => {
  const map = await discoverSystemContext(LISTENER, { llm: fixedLlm() });
  assert.equal(map.diagnostics.mode, "STATE_SIGNALS");
  assert.deepEqual(map.policies.map((p) => [p.id, p.triggerEventId, p.actionCommandId, p.listener.line]), [
    ["POL-src/wire.ts#<module>@3", "EVT-src/users.ts#register", "CMD-src/mail.ts#sendWelcome", 3],
  ]);
  const welcome = map.events.find((e) => e.id === "EVT-src/mail.ts#sendWelcome");
  assert.deepEqual(welcome?.after, ["EVT-src/users.ts#register"]);
  const registered = map.events.find((e) => e.id === "EVT-src/users.ts#register");
  assert.deepEqual(registered?.signal, { kind: "EVENT_EMIT", callee: "emit", label: "user.registered", line: 3 });

  const result = await sliceScenarios(map, undefined, { llm: fixedLlm() });
  assert.deepEqual(result.scenarios.map((s) => [s.id, s.inletType, s.expectedEvent]), [
    ["SCN-CMD-src/mail.ts#sendWelcome", "COMMAND", "EVT-src/mail.ts#sendWelcome"],
    ["SCN-CMD-src/users.ts#register", "COMMAND", "EVT-src/users.ts#register"],
    ["SCN-POL-src/wire.ts#<module>@3", "POLICY", "EVT-src/mail.ts#sendWelcome"],
  ]);
  const policy = result.scenarios.find((s) => s.inletType === "POLICY");
  assert.equal(policy?.inletTrigger.handler.file, "src/wire.ts", "ポリシーの起点はリスナーの登録の場所");
});

test("リスナー: ポリシーの識別子と after も LLM の名前によらない", async () => {
  const base = idsOf(await discoverSystemContext(LISTENER, { llm: fixedLlm() }));
  assert.deepEqual(idsOf(await discoverSystemContext(LISTENER, { llm: otherLlm() })), base);
  assert.deepEqual(idsOf(await discoverSystemContext(LISTENER, { llm: unreachableLlm() })), base);
});

test("選択: filter は抽出したシナリオにだけ効き、利用者定義は同じ起点の抽出を置き換える", async () => {
  const map = await discoverSystemContext(LISTENER, { llm: fixedLlm() });
  const result = await sliceScenarios(
    map,
    {
      filter: { inlets: ["CMD-src/users.ts#register"] },
      userDefined: [
        { inlet: "src/mail.ts#sendWelcome", intent: "歓迎メールを送る" },
        { inlet: "src/nope.ts#missing" },
      ],
    },
    { llm: fixedLlm() },
  );
  assert.deepEqual(result.scenarios.map((s) => [s.id, s.origin]), [
    ["SCN-CMD-src/mail.ts#sendWelcome", "USER_DEFINED"],
    ["SCN-CMD-src/users.ts#register", "EXTRACTED"],
  ]);
  assert.deepEqual(result.rejected, [{ inlet: "src/nope.ts#missing", reason: "起点が全体マップに無い" }]);
});

// ---------------------------------------------------------------------------
// 4. 小さな部品

test("stripJsonc: コメントと閉じ括弧の前のカンマを除き、文字列の中は触らない", () => {
  const text = '{\n  // c\n  "a": "x // y /* z */", /* d */\n  "b": [1, 2, /* e */ ],\n}';
  assert.deepEqual(JSON.parse(stripJsonc(text)), { a: "x // y /* z */", b: [1, 2] });
});