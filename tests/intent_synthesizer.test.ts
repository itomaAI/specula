// IntentSynthesizer のテスト（IntentSynthesizer の設計 1.2・2・3、仕様 3）。
// 全体マップとコマンドは CommandExtractor、辞書は GlossaryBuilder で小さな偽のリポジトリから作り、偽の LLM を渡す。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGlossary } from "../src/core/glossary_builder.js";
import { EXCERPT_CHARS } from "../src/core/glossary/match.js";
import { MAX_INTENT_CHARS, synthesizeIntents } from "../src/core/intent_synthesizer.js";
import { discoverSystemContext, sliceCommands } from "../src/core/command_extractor.js";
import type { LanguageModelPort, OutputCheck } from "../src/ports/LanguageModelPort.js";
import type { JsonValue, LlmRequest, LlmText } from "../src/types/index.js";
import type { Glossary } from "../src/types/glossary.js";
import { IntentContractError } from "../src/types/intent.js";
import type { RepositoryArtifacts, RepositoryDocument, CommandSelection } from "../src/types/command.js";

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

const LABELS = ["利用者", "利用者を登録する", "歓迎メールを送る", "歓迎メールを送った", "登録したら歓迎メールを送る"];

/** 辞書の用語を付ける偽の LLM（意図の入力に用語が入らないことを確かめるため、用語を必ず作る）。 */
const termLlm = (): FakeLlm =>
  new FakeLlm((request) => {
    switch (request.task) {
      case "glossary.term-context":
        return '{"term": "Users", "label": "利用者"}';
      case "glossary.term-command": {
        const handler = (request.input as { [key: string]: JsonValue })["handler"] as { symbol?: string };
        return handler.symbol === "register"
          ? '{"term": "RegisterUser", "label": "利用者を登録する"}'
          : '{"term": "SendWelcomeMail", "label": "歓迎メールを送る"}';
      }
      case "glossary.term-event":
        return '{"term": "WelcomeMailSent", "label": "歓迎メールを送った"}';
      case "glossary.term-policy":
        return '{"term": "SendWelcomeOnRegistration", "label": "登録したら歓迎メールを送る"}';
      default:
        return null;
    }
  });

const intentLlm = (answer: (request: LlmRequest) => string | null = (r) => (r.task === "intent.context" ? "利用者の登録を受け持つ。" : "利用者を登録したい。")): FakeLlm =>
  new FakeLlm(answer);

const FILES: Record<string, string> = {
  "src/users.ts": 'import { bus } from "./bus.js";\nexport function register(name: string) {\n  bus.emit("user.registered", { name });\n}\n',
  "src/mail.ts": 'import { prisma } from "./db.js";\nexport async function sendWelcome(payload: unknown) {\n  await prisma.mail.create({ data: { payload } });\n}\n',
  "src/wire.ts": 'import { bus } from "./bus.js";\nimport { sendWelcome } from "./mail.js";\nbus.on("user.registered", sendWelcome);\n',
};

const DOCUMENTS: RepositoryDocument[] = [
  { path: "README.md", kind: "README", text: "# Users\n\nWhen a user registers (`register`), we send a welcome mail.\n", truncated: false },
  { path: "docs/mail.md", kind: "DOC", text: "# Mail\n\nsendWelcome sends the welcome mail on user.registered.\n", truncated: false },
  { path: "docs/register.md", kind: "DOC", text: "# Register\n\nregister: " + "あ".repeat(2000) + "\n", truncated: false },
];

function repoOf(documents: RepositoryDocument[] = DOCUMENTS, files: Record<string, string> = FILES): RepositoryArtifacts {
  return { files: Object.entries(files).map(([path, text]) => ({ path, text })), documents, omittedDocuments: [] };
}

async function inputsOf(selection?: CommandSelection, llm: LanguageModelPort | undefined = undefined) {
  const repo = repoOf();
  const map = discoverSystemContext(repo);
  const slice = sliceCommands(map, selection);
  const glossary = await buildGlossary(map, repo, { llm: termLlm() });
  return { repo, map, slice, glossary, llm };
}

const inputOf = (request: LlmRequest): { [key: string]: JsonValue } => request.input as { [key: string]: JsonValue };
const sectionsOf = (request: LlmRequest): string[] =>
  (inputOf(request)["excerpts"] as Array<{ section: string }>).map((excerpt) => excerpt.section);
const sourcesOf = (glossary: Glossary, id: string): string[] => glossary.entries.find((entry) => entry.id === id)?.sources ?? [];

test("網羅: すべての Bounded Context とコマンドに 1 つずつ、id の辞書順。初回はすべて CANDIDATE。basis は辞書のもの", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  const catalog = await synthesizeIntents(map, slice, glossary, repo, { llm: intentLlm() });

  assert.deepEqual(catalog.contexts.map((item) => item.contextId), map.boundedContexts.map((context) => context.id).sort());
  assert.deepEqual(catalog.commands.map((item) => item.commandId), slice.commands.map((commandTarget) => commandTarget.id).sort());
  assert.ok(slice.commands.length >= 2, JSON.stringify(slice.commands.map((commandTarget) => commandTarget.id)));
  for (const item of [...catalog.contexts, ...catalog.commands]) {
    assert.equal(item.intentStatus, "CANDIDATE");
    assert.equal(item.intent.status, "GENERATED");
  }
  assert.deepEqual(catalog.basis, glossary.basis);
});

test("LLM が無ければ、すべて NOT_GENERATED（UNREACHABLE）。文で埋めない。確定の状態も NOT_GENERATED", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  const catalog = await synthesizeIntents(map, slice, glossary, repo, {});
  for (const item of [...catalog.contexts, ...catalog.commands]) {
    assert.deepEqual(item.intent, { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "LLM が渡されていない" });
    assert.equal(item.intentStatus, "NOT_GENERATED");
  }
});

test("確定の状態は欄ごとに決まる: 書けた欄は CANDIDATE、届かなかった欄は NOT_GENERATED", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  const llm = intentLlm((request) => (request.task === "intent.context" ? "利用者の登録を受け持つ。" : null));
  const catalog = await synthesizeIntents(map, slice, glossary, repo, { llm });
  assert.ok(catalog.contexts.length > 0 && catalog.commands.length > 0);
  for (const item of catalog.contexts) {
    assert.equal(item.intent.status, "GENERATED");
    assert.equal(item.intentStatus, "CANDIDATE");
  }
  for (const item of catalog.commands) {
    assert.ok(item.intent.status === "NOT_GENERATED" && item.intent.reason === "UNREACHABLE");
    assert.equal(item.intentStatus, "NOT_GENERATED");
  }
});

test("呼ぶ順と処理の名前: Bounded Context、続いてコマンド、それぞれ id の辞書順。promptVersion は 1", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  const llm = intentLlm();
  await synthesizeIntents(map, slice, glossary, repo, { llm });
  const contextCalls = map.boundedContexts.length;
  assert.deepEqual(
    llm.calls.map((call) => call.task),
    [...Array(contextCalls).fill("intent.context"), ...Array(slice.commands.length).fill("intent.scenario")],
  );
  assert.ok(llm.calls.every((call) => call.promptVersion === "1"));
  const commandInlets = llm.calls.slice(contextCalls).map((call) => inputOf(call)["inlet"]);
  const expected = [...slice.commands]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((commandTarget) => ({ file: commandTarget.inletTrigger.handler.file, symbol: commandTarget.inletTrigger.handler.symbol }));
  assert.deepEqual(commandInlets, expected);
});

test("手がかり: 単位の抜粋は起点の項目の節を先に、期待イベントの項目の節を続け、重複を除いて最大 3 節", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  const llm = intentLlm();
  await synthesizeIntents(map, slice, glossary, repo, { llm });
  const commandCalls = llm.calls.filter((call) => call.task === "intent.scenario");
  const sorted = [...slice.commands].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const [index, commandTarget] of sorted.entries()) {
    const call = commandCalls[index];
    assert.ok(call !== undefined);
    const expected = [
      ...new Set([
        ...sourcesOf(glossary, commandTarget.inletTrigger.id),
        ...commandTarget.expectedEvents.flatMap((eventId) => sourcesOf(glossary, eventId)),
      ]),
    ].slice(0, 3);
    assert.deepEqual(sectionsOf(call), expected, commandTarget.id);
    const input = inputOf(call);
    assert.equal(input["inletType"], undefined, "起点はコマンドだけなので種類を渡さない");
    assert.equal(input["actor"], commandTarget.actor.name);
    assert.equal(input["route"], null);
    const expectedEvents = input["expectedEvents"] as Array<{ signal: { kind: string } }>;
    assert.equal(expectedEvents.length, commandTarget.expectedEvents.length);
    for (const event of expectedEvents) assert.ok(["DB_MUTATION", "EVENT_EMIT", "PUBLIC_FUNCTION"].includes(event.signal.kind));
    assert.equal((input["invokedBy"] as unknown[]).length, commandTarget.invokedBy.length);
  }
  // register の起点は README と docs/register.md の節を選んでいる（抜粋がある場合を通す）。
  assert.ok(commandCalls.some((call) => sectionsOf(call).includes("docs/register.md#Register")));

  const contextCall = llm.calls.find((call) => call.task === "intent.context");
  assert.ok(contextCall !== undefined);
  assert.deepEqual(sectionsOf(contextCall), sourcesOf(glossary, "DEFAULT_CONTEXT"));
  assert.deepEqual(inputOf(contextCall)["filePaths"], ["src/mail.ts", "src/users.ts"]);
});

test("手がかり: 抜粋は節の先頭の 1500 字まで（GlossaryBuilder と同じ規則）", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  const llm = intentLlm();
  await synthesizeIntents(map, slice, glossary, repo, { llm });
  const excerpts = llm.calls
    .flatMap((call) => inputOf(call)["excerpts"] as Array<{ section: string; text: string; truncated: boolean }>)
    .filter((excerpt) => excerpt.section === "docs/register.md#Register");
  assert.ok(excerpts.length > 0);
  for (const excerpt of excerpts) {
    assert.equal(excerpt.truncated, true);
    assert.equal(Array.from(excerpt.text).length, EXCERPT_CHARS);
  }
});

test("手がかりに辞書の用語（term・label）を入れない", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  assert.ok(glossary.entries.some((entry) => entry.term?.status === "GENERATED"));
  const llm = intentLlm();
  await synthesizeIntents(map, slice, glossary, repo, { llm });
  for (const call of llm.calls) {
    const text = JSON.stringify(call.input);
    for (const label of LABELS) assert.ok(!text.includes(label), `${call.task}: ${label}`);
    for (const term of ["RegisterUser", "SendWelcomeMail", "WelcomeMailSent", "SendWelcomeOnRegistration"]) {
      assert.ok(!text.includes(term), `${call.task}: ${term}`);
    }
  }
});

test("出力の検査: 2 行・空・200 字を超えるものは INVALID_OUTPUT（確定の状態は NOT_GENERATED）。200 字ちょうどは通す（CANDIDATE）", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  const cases: Array<[string, LlmText["status"]]> = [
    ["一行目。\n二行目。", "NOT_GENERATED"],
    ["   ", "NOT_GENERATED"],
    ["あ".repeat(MAX_INTENT_CHARS + 1), "NOT_GENERATED"],
    ["あ".repeat(MAX_INTENT_CHARS), "GENERATED"],
  ];
  for (const [answer, status] of cases) {
    const catalog = await synthesizeIntents(map, slice, glossary, repo, { llm: intentLlm(() => answer) });
    for (const item of [...catalog.contexts, ...catalog.commands]) {
      assert.equal(item.intent.status, status, JSON.stringify(answer).slice(0, 40));
      assert.equal(item.intentStatus, status === "GENERATED" ? "CANDIDATE" : "NOT_GENERATED");
      if (item.intent.status === "NOT_GENERATED") assert.equal(item.intent.reason, "INVALID_OUTPUT");
    }
  }
});

test("利用者が書いた目的は userIntent にそのまま写し、候補の欄に入れない", async () => {
  const { repo, map, slice, glossary } = await inputsOf({ userDefined: [{ inlet: "src/users.ts#register", intent: "利用者を増やす" }] });
  const defined = slice.commands.find((commandTarget) => commandTarget.origin === "USER_DEFINED");
  assert.ok(defined !== undefined);
  const catalog = await synthesizeIntents(map, slice, glossary, repo, { llm: intentLlm() });
  const item = catalog.commands.find((commandTarget) => commandTarget.commandId === defined.id);
  assert.ok(item !== undefined);
  assert.equal(item.userIntent, "利用者を増やす");
  assert.ok(item.intent.status === "GENERATED" && item.intent.text === "利用者を登録したい。");
  for (const other of catalog.commands.filter((commandTarget) => commandTarget.commandId !== defined.id)) {
    assert.equal("userIntent" in other, false);
  }
});

test("辞書が別の全体マップから作られていたら GLOSSARY_STALE", async () => {
  const { repo, map, slice } = await inputsOf();
  const otherRepo = repoOf(DOCUMENTS, { "src/users.ts": FILES["src/users.ts"] ?? "" });
  const stale = await buildGlossary(discoverSystemContext(otherRepo), otherRepo, {});
  await assert.rejects(
    synthesizeIntents(map, slice, stale, repo, {}),
    (error: unknown) => error instanceof IntentContractError && error.reason === "GLOSSARY_STALE" && error.detail.includes("mapHash"),
  );
});

test("辞書が別の資料から作られていたら GLOSSARY_STALE（節を同じ本文から切り出せないため）", async () => {
  const { repo, map, slice } = await inputsOf();
  const otherRepo = repoOf(DOCUMENTS.slice(0, 1));
  const stale = await buildGlossary(map, otherRepo, {});
  await assert.rejects(
    synthesizeIntents(map, slice, stale, repo, {}),
    (error: unknown) => error instanceof IntentContractError && error.reason === "GLOSSARY_STALE" && error.detail.includes("documentsHash"),
  );
});

test("同じ入力から同じ一覧と同じ頼み方になる", async () => {
  const { repo, map, slice, glossary } = await inputsOf();
  const a = intentLlm();
  const b = intentLlm();
  const first = await synthesizeIntents(map, slice, glossary, repo, { llm: a });
  const second = await synthesizeIntents(map, slice, glossary, repo, { llm: b });
  assert.deepEqual(second, first);
  assert.deepEqual(b.calls, a.calls);
});