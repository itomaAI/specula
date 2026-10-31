// GlossaryBuilder のテスト（GlossaryBuilder の設計 2〜4）。
// 全体マップは ScenarioExtractor で小さな偽のリポジトリから作り、資料と偽の LLM を渡す。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGlossary } from "../src/core/glossary_builder.js";
import { contextsOf, readSchema } from "../src/core/glossary/entries.js";
import { inlineNamesOf, recordGaps } from "../src/core/glossary/gaps.js";
import { MEANING_CHARS, containsWord, meaningOf } from "../src/core/glossary/match.js";
import type { GlossaryEntry } from "../src/types/glossary.js";
import { splitSections } from "../src/core/glossary/sections.js";
import { discoverSystemContext } from "../src/core/scenario_extractor.js";
import type { LanguageModelPort, OutputCheck } from "../src/ports/LanguageModelPort.js";
import type { JsonValue, LlmRequest, LlmText } from "../src/types/index.js";
import type { EventStormingMap, RepositoryArtifacts, RepositoryDocument } from "../src/types/scenario.js";

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

const symbolOf = (request: LlmRequest): string => {
  const input = request.input as { [key: string]: JsonValue };
  const handler = input["handler"] as { symbol?: string } | undefined;
  return handler?.symbol ?? "";
};

const termLlm = (): FakeLlm =>
  new FakeLlm((request) => {
    switch (request.task) {
      case "glossary.term-context":
        return '{"term": "Users", "label": "利用者"}';
      case "glossary.term-command":
        return symbolOf(request) === "register"
          ? '{"term": "RegisterUser", "label": "利用者を登録する"}'
          : '{"term": "SendWelcomeMail", "label": "歓迎メールを送る"}';
      case "glossary.term-event":
        return '{"term": "WelcomeMailSent", "label": "歓迎メールを送った"}';
      case "glossary.term-policy":
        return '{"term": "SendWelcomeOnRegistration", "label": "登録したら歓迎メールを送る"}';
      default:
        return null;
    }
  });

const FILES: Record<string, string> = {
  "src/users.ts": 'import { bus } from "./bus.js";\nexport function register(name: string) {\n  bus.emit("user.registered", { name });\n}\n',
  "src/mail.ts": 'import { prisma } from "./db.js";\nexport async function sendWelcome(payload: unknown) {\n  await prisma.mail.create({ data: { payload } });\n}\n',
  "src/wire.ts": 'import { bus } from "./bus.js";\nimport { sendWelcome } from "./mail.js";\nbus.on("user.registered", sendWelcome);\n',
};

const DOCUMENTS: RepositoryDocument[] = [
  {
    path: "README.md",
    kind: "README",
    text: "# Users\n\nWhen a user registers (`register`), we send a welcome mail via `sendWelcome`.\n\n## Unknown\n\nThe `archiveUser()` job is planned.\n```ts\nnotInDict()\n```\n",
    truncated: false,
  },
  { path: "docs/mail.md", kind: "DOC", text: "# Mail\n\nsendWelcome sends the welcome mail on user.registered.\n", truncated: true },
  { path: "prisma/schema.prisma", kind: "SCHEMA", text: "model Mail {\n  id String @id\n  payload Json\n  @@index([id])\n}\n", truncated: false },
];

function repoOf(documents: RepositoryDocument[], omittedDocuments: string[] = []): RepositoryArtifacts {
  return { files: Object.entries(FILES).map(([path, text]) => ({ path, text })), documents, omittedDocuments };
}

async function mapOf(): Promise<EventStormingMap> {
  return discoverSystemContext(repoOf([]));
}

test("項目: 地図の要素は提示し、アクター・発行の名前・スキーマは記録だけにする（id の辞書順）", async () => {
  const glossary = await buildGlossary(await mapOf(), repoOf(DOCUMENTS), { llm: termLlm() });

  assert.deepEqual(
    glossary.entries.filter((e) => e.kind !== "ACTOR").map((e) => [e.id, e.kind, e.scope]),
    [
      ["CMD-src/mail.ts#sendWelcome", "COMMAND", "PRESENTED"],
      ["CMD-src/users.ts#register", "COMMAND", "PRESENTED"],
      ["DEFAULT_CONTEXT", "BOUNDED_CONTEXT", "PRESENTED"],
      ["EMITTED_EVENT_NAME:user.registered", "EMITTED_EVENT_NAME", "RECORDED"],
      ["EVT-src/mail.ts#sendWelcome", "EVENT", "PRESENTED"],
      ["EVT-src/users.ts#register", "EVENT", "PRESENTED"],
      ["POL-src/wire.ts#<module>@3", "POLICY", "PRESENTED"],
      ["SCHEMA_ENTITY:Mail", "SCHEMA_ENTITY", "RECORDED"],
      ["SCHEMA_FIELD:Mail.id", "SCHEMA_FIELD", "RECORDED"],
      ["SCHEMA_FIELD:Mail.payload", "SCHEMA_FIELD", "RECORDED"],
    ],
  );
  for (const entry of glossary.entries.filter((e) => e.scope === "RECORDED")) {
    assert.equal(entry.term, undefined, entry.id);
    assert.deepEqual(entry.sources, [], entry.id);
  }
  const ids = glossary.entries.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));

  const event = glossary.entries.find((e) => e.id === "EVT-src/users.ts#register");
  assert.deepEqual(event?.implementation, {
    names: ["register", "user.registered"],
    locations: [{ file: "src/users.ts", symbol: "register", line: 2 }, { file: "src/users.ts", line: 3 }],
  });
  const emitted = glossary.entries.find((e) => e.id === "EMITTED_EVENT_NAME:user.registered");
  assert.deepEqual(emitted?.implementation.locations, [{ file: "src/users.ts", symbol: "register", line: 3 }]);
  const field = glossary.entries.find((e) => e.id === "SCHEMA_FIELD:Mail.payload");
  assert.deepEqual(field?.implementation, { names: ["Mail.payload"], locations: [{ file: "prisma/schema.prisma", line: 3 }] });
});

test("節の選択: 一致した手がかりの種類の数が多い順、同じなら節の識別子の順に上位 3 節", async () => {
  const glossary = await buildGlossary(await mapOf(), repoOf(DOCUMENTS), { llm: termLlm() });
  const sourcesOf = (id: string): string[] | undefined => glossary.entries.find((e) => e.id === id)?.sources;

  assert.deepEqual(sourcesOf("CMD-src/mail.ts#sendWelcome"), ["README.md#Users", "docs/mail.md#Mail", "prisma/schema.prisma#"]);
  assert.deepEqual(sourcesOf("CMD-src/users.ts#register"), ["README.md#Users"]);
  assert.deepEqual(sourcesOf("EVT-src/users.ts#register"), ["README.md#Users", "docs/mail.md#Mail"]);
  assert.deepEqual(sourcesOf("POL-src/wire.ts#<module>@3"), ["docs/mail.md#Mail", "README.md#Users"]);
  assert.deepEqual(sourcesOf("DEFAULT_CONTEXT"), [], "DEFAULT_CONTEXT は手がかりを持たない");
});

test("用語: 提示する項目ごとに 1 回、識別子の順に頼み、入力に抜粋を入れる", async () => {
  const llm = termLlm();
  const glossary = await buildGlossary(await mapOf(), repoOf(DOCUMENTS), { llm });

  assert.deepEqual(
    llm.calls.map((c) => c.task),
    [
      "glossary.term-command",
      "glossary.term-command",
      "glossary.term-context",
      "glossary.term-event",
      "glossary.term-event",
      "glossary.term-policy",
    ],
  );
  assert.ok(llm.calls.every((c) => c.promptVersion === "1"));
  const register = glossary.entries.find((e) => e.id === "CMD-src/users.ts#register");
  assert.equal(register?.term?.status, "GENERATED");
  if (register?.term?.status === "GENERATED") {
    assert.equal(register.term.term, "RegisterUser");
    assert.equal(register.term.label, "利用者を登録する");
  }
  const input = llm.calls[1]?.input as { excerpts?: Array<{ section: string; truncated: boolean }> };
  assert.deepEqual(input.excerpts?.map((e) => [e.section, e.truncated]), [["README.md#Users", false]]);
});

test("用語: LLM が無ければ UNREACHABLE、形が合わなければ INVALID_OUTPUT。記録だけの項目は変わらない", async () => {
  const map = await mapOf();
  const withoutLlm = await buildGlossary(map, repoOf(DOCUMENTS), {});
  const invalid = await buildGlossary(map, repoOf(DOCUMENTS), {
    llm: new FakeLlm(() => '{"term": "not pascal", "label": "x"}'),
  });

  for (const entry of withoutLlm.entries.filter((e) => e.scope === "PRESENTED")) {
    assert.equal(entry.term?.status === "NOT_GENERATED" && entry.term.reason, "UNREACHABLE", entry.id);
  }
  for (const entry of invalid.entries.filter((e) => e.scope === "PRESENTED")) {
    assert.equal(entry.term?.status === "NOT_GENERATED" && entry.term.reason, "INVALID_OUTPUT", entry.id);
  }
  const recorded = (g: typeof withoutLlm): unknown => g.entries.filter((e) => e.scope === "RECORDED");
  assert.deepEqual(recorded(invalid), recorded(withoutLlm));
  assert.deepEqual(invalid.gaps.undocumentedEntries, withoutLlm.gaps.undocumentedEntries);
});

test("用語の形: label の改行・40 字超え・JSON でない答えは INVALID_OUTPUT", async () => {
  const map = await mapOf();
  for (const answer of [
    '{"term": "Ok", "label": "1行目\\n2行目"}',
    `{"term": "Ok", "label": "${"あ".repeat(41)}"}`,
    "Ok",
    '```json\n{"term": "Ok", "label": "x"}\n```',
  ]) {
    const glossary = await buildGlossary(map, repoOf(DOCUMENTS), { llm: new FakeLlm(() => answer) });
    const term = glossary.entries.find((e) => e.id === "CMD-src/users.ts#register")?.term;
    assert.equal(term?.status === "NOT_GENERATED" && term.reason, "INVALID_OUTPUT", answer);
  }
});

test("記録のキー: 資料が変わると抜粋が変わって別のキーになり、資料が同じなら同じキーになる", async () => {
  const map = await mapOf();
  const keyOf = async (documents: RepositoryDocument[]): Promise<string | undefined> => {
    const term = (await buildGlossary(map, repoOf(documents), { llm: termLlm() })).entries.find(
      (e) => e.id === "CMD-src/users.ts#register",
    )?.term;
    return term?.status === "GENERATED" ? term.recordKey : undefined;
  };
  const base = await keyOf(DOCUMENTS);
  assert.equal(await keyOf(DOCUMENTS), base);
  assert.notEqual(await keyOf([]), base);
});

test("ずれ: 資料に記述が無い要素、項目に対応しない資料の名前、同義・多義の候補を記録する", async () => {
  const glossary = await buildGlossary(await mapOf(), repoOf(DOCUMENTS), { llm: termLlm() });

  assert.deepEqual(glossary.gaps.undocumentedEntries, ["DEFAULT_CONTEXT"]);
  assert.deepEqual(glossary.gaps.unmatchedDocumentNames, [{ name: "archiveUser", sections: ["README.md#Users > Unknown"] }]);
  assert.deepEqual(glossary.gaps.sharedTerms, [
    {
      term: "WelcomeMailSent",
      contextId: "DEFAULT_CONTEXT",
      entryIds: ["EVT-src/mail.ts#sendWelcome", "EVT-src/users.ts#register"],
    },
  ]);
  assert.deepEqual(glossary.gaps.contextHomonyms, [], "Bounded Context が 1 つだけなら常に空");
  assert.deepEqual(glossary.gaps.multiSourceEntries, [
    { entryId: "CMD-src/mail.ts#sendWelcome", documents: ["README.md", "docs/mail.md", "prisma/schema.prisma"] },
    { entryId: "EVT-src/mail.ts#sendWelcome", documents: ["README.md", "docs/mail.md", "prisma/schema.prisma"] },
    { entryId: "EVT-src/users.ts#register", documents: ["README.md", "docs/mail.md"] },
    { entryId: "POL-src/wire.ts#<module>@3", documents: ["README.md", "docs/mail.md"] },
  ]);
});

test("資料の記録と元にした入力のハッシュ。資料が無いときは全部が「記述が無い」になる", async () => {
  const map = await mapOf();
  const glossary = await buildGlossary(map, repoOf(DOCUMENTS, ["docs/z.md"]), { llm: termLlm() });
  assert.deepEqual(glossary.documents, {
    read: ["README.md", "docs/mail.md", "prisma/schema.prisma"],
    truncated: ["docs/mail.md"],
    omitted: ["docs/z.md"],
  });
  assert.match(glossary.basis.mapHash, /^[0-9a-f]{64}$/);
  assert.match(glossary.basis.documentsHash, /^[0-9a-f]{64}$/);

  const empty = await buildGlossary(map, repoOf([]), { llm: termLlm() });
  assert.equal(empty.basis.mapHash, glossary.basis.mapHash);
  assert.notEqual(empty.basis.documentsHash, glossary.basis.documentsHash);
  assert.deepEqual(
    empty.gaps.undocumentedEntries,
    empty.entries.filter((e) => e.scope === "PRESENTED").map((e) => e.id),
  );
});

test("節の分割: 見出しの並びで識別子を作り、コードの囲みの中の # を見出しにせず、同じ識別子に番号を足す", () => {
  const sections = splitSections([
    {
      path: "docs/a.md",
      kind: "DOC",
      text: "intro\n# A\none\n```sh\n# not a heading\n```\n## B\ntwo\n# A\nthree\n### C ###\nfour",
      truncated: false,
    },
  ]);
  assert.deepEqual(
    sections.map((s) => s.id),
    ["docs/a.md#", "docs/a.md#A", "docs/a.md#A > B", "docs/a.md#A (2)", "docs/a.md#A > C"],
  );
  assert.equal(sections[1]?.text, "# A\none\n```sh\n# not a heading\n```");
  assert.deepEqual(
    splitSections([{ path: "README.md", kind: "README", text: "# T\nx", truncated: false }]).map((s) => s.id),
    ["README.md#T"],
    "見出しより前に本文が無ければ、見出しの無い節は作らない",
  );
});

test("スキーマ: SQL・GraphQL の定義から名前と項目を読み、制約の行とコメントを読まない", () => {
  assert.deepEqual(
    readSchema(
      "db/init.sql",
      "-- users\nCREATE TABLE IF NOT EXISTS public.\"orders\" (\n  id INT PRIMARY KEY,\n  -- note\n  total NUMERIC(10, 2),\n  PRIMARY KEY (id)\n);\nCREATE TABLE broken (\n  x INT,\n",
    ),
    [{ name: "orders", line: 2, fields: [{ name: "id", line: 3 }, { name: "total", line: 5 }] }],
  );
  assert.deepEqual(
    readSchema("api/schema.graphql", "# comment\ntype Order {\n  id: ID!\n  items(first: Int): [Item]\n}\n"),
    [{ name: "Order", line: 2, fields: [{ name: "id", line: 3 }, { name: "items", line: 4 }] }],
  );
});

test("照合とインラインコード: 語の境目は英字・数字・_・- 以外。コードの囲みの中の名前は拾わない", () => {
  assert.equal(containsWord("call `register` here", "register"), true);
  assert.equal(containsWord("registers", "register"), false);
  assert.equal(containsWord("pre-register", "register"), false);
  assert.equal(containsWord("on user.registered.", "user.registered"), true);
  assert.deepEqual(inlineNamesOf("see `a.b`, `run()` and `not a name`\n```\n`hidden`\n```\n`after`"), ["a.b", "run", "after"]);
});

// ---- 画面の仕様に合わせて足した欄（GlossaryBuilder の設計 5）----

test("所属と確定の状態: 地図の要素は所属の Bounded Context と CANDIDATE を持ち、記録だけの項目は null", async () => {
  const map = await mapOf();
  const glossary = await buildGlossary(map, repoOf(DOCUMENTS), { llm: termLlm() });
  for (const entry of glossary.entries) {
    if (entry.scope === "RECORDED") {
      assert.deepEqual([entry.contextId, entry.crossesTo, entry.termStatus, entry.excerpt], [null, null, null, null], entry.id);
      continue;
    }
    assert.equal(entry.contextId, "DEFAULT_CONTEXT", entry.id);
    assert.equal(entry.crossesTo, null, entry.id);
    assert.equal(entry.termStatus, "CANDIDATE", entry.id);
  }

  const withoutLlm = await buildGlossary(map, repoOf(DOCUMENTS), {});
  for (const entry of withoutLlm.entries.filter((e) => e.scope === "PRESENTED")) {
    assert.equal(entry.termStatus, "NOT_GENERATED", entry.id);
  }
});

test("意味の抜粋: 先頭の節の、見出しの直後の最初の段落。節の本文にある文字列そのもの。出どころが無ければ null", async () => {
  const glossary = await buildGlossary(await mapOf(), repoOf(DOCUMENTS), { llm: termLlm() });
  const excerptOf = (id: string): unknown => glossary.entries.find((e) => e.id === id)?.excerpt;

  assert.deepEqual(excerptOf("CMD-src/users.ts#register"), {
    text: "When a user registers (`register`), we send a welcome mail via `sendWelcome`.",
    source: "README.md#Users",
    truncated: false,
    status: "CANDIDATE",
  });
  assert.deepEqual(excerptOf("POL-src/wire.ts#<module>@3"), {
    text: "sendWelcome sends the welcome mail on user.registered.",
    source: "docs/mail.md#Mail",
    truncated: false,
    status: "CANDIDATE",
  });
  assert.equal(excerptOf("DEFAULT_CONTEXT"), null);

  // 抜粋は LLM を使わないので、LLM が無くても同じ。
  const withoutLlm = await buildGlossary(await mapOf(), repoOf(DOCUMENTS), {});
  assert.deepEqual(
    withoutLlm.entries.map((e) => e.excerpt),
    glossary.entries.map((e) => e.excerpt),
  );
  for (const entry of glossary.entries) {
    if (entry.excerpt === null) continue;
    const document = DOCUMENTS.find((d) => entry.excerpt?.source.startsWith(`${d.path}#`));
    assert.ok(document?.text.includes(entry.excerpt.text), entry.id);
  }
});

test("意味の抜粋の切り出し: 見出しの無い節は先頭の行を飛ばさない。400 字で切る。段落が無ければ null", () => {
  const section = (id: string, text: string, truncated = false) => ({ section: id, document: "d.md", text, truncated });

  assert.deepEqual(meaningOf(section("d.md#A", "# A\n\n\nfirst line\nsecond line\n\nnext paragraph")), {
    text: "first line\nsecond line",
    truncated: false,
  });
  assert.deepEqual(meaningOf(section("d.md#", "intro text\n\n# A")), { text: "intro text", truncated: false });
  assert.deepEqual(meaningOf(section("api/schema.graphql#", "# comment\ntype Order {\n  id: ID!\n}\n")), {
    text: "# comment\ntype Order {\n  id: ID!\n}",
    truncated: false,
  });
  assert.equal(meaningOf(section("d.md#A", "# A\n\n")), null);

  const long = meaningOf(section("d.md#A", `# A\n${"あ".repeat(MEANING_CHARS + 1)}`));
  assert.equal(long?.truncated, true);
  assert.equal(Array.from(long?.text ?? "").length, MEANING_CHARS);
  // 段落が LLM の抜粋の末尾まで続き、その抜粋が切られていたら、段落も途中で切れている。
  assert.deepEqual(meaningOf(section("d.md#A", "# A\nbody", true)), { text: "body", truncated: true });
  assert.deepEqual(meaningOf(section("d.md#A", "# A\nbody\n\nmore", true)), { text: "body", truncated: false });
});

test("意味の抜粋の切り出し: ソースコードの囲みは飛ばし、言語の名前が無い囲みと仕様の記法の囲みは残す（Q5）", () => {
  const section = (id: string, text: string, truncated = false) => ({ section: id, document: "d.md", text, truncated });

  // 囲みの中の空行で段落を切らず、囲みの終わりまで飛ばす
  assert.deepEqual(
    meaningOf(section("d.md#A", "# A\n\n```typescript\ninterface X {\n\n  a: string;\n}\n```\n\nthe meaning\nline 2\n\nmore")),
    { text: "the meaning\nline 2", truncated: false },
  );
  // 囲みが続けば続けて飛ばす。言語の名前は大文字小文字を区別しない
  assert.deepEqual(meaningOf(section("d.md#A", "# A\n```TS\nx\n```\n~~~python\ny\n~~~\nafter")), { text: "after", truncated: false });
  // 言語の名前が無い囲みと、仕様の記法の囲みは飛ばさない
  assert.deepEqual(meaningOf(section("d.md#A", "# A\n```\nplain\n```")), { text: "```\nplain\n```", truncated: false });
  assert.deepEqual(meaningOf(section("d.md#A", "# A\n```alloy\nsig A {}\n```")), { text: "```alloy\nsig A {}\n```", truncated: false });
  // 囲みが抜粋の末尾まで続けば null。囲みの後の段落が抜粋の末尾まで続き、抜粋が切られていれば truncated
  assert.equal(meaningOf(section("d.md#A", "# A\n```ts\nconst a = 1;", true)), null);
  assert.deepEqual(meaningOf(section("d.md#A", "# A\n```ts\nx\n```\nbody", true)), { text: "body", truncated: true });
});

test("所属: ポリシーは反応するイベントの Bounded Context に属し、起動するコマンドが別の Bounded Context ならまたいでいる先にする", () => {
  const at = (file: string, symbol: string) => ({ file, symbol, line: 1 });
  const map: EventStormingMap = {
    boundedContexts: [
      { id: "CTX-a", name: "a", rootPaths: ["a"], isDefaultFallback: false },
      { id: "CTX-b", name: "b", rootPaths: ["b"], isDefaultFallback: false },
    ],
    events: [
      {
        id: "EVT-a",
        contextId: "CTX-a",
        handler: at("a/x.ts", "x"),
        signal: { kind: "EVENT_EMIT", callee: "emit", label: "x.done", line: 2 },
        after: [],
      },
    ],
    commands: [
      { id: "CMD-a", contextId: "CTX-a", actorId: "Caller", eventIds: [], handler: at("a/y.ts", "y") },
      { id: "CMD-b", contextId: "CTX-b", actorId: "Caller", eventIds: [], handler: at("b/z.ts", "z") },
    ],
    policies: [
      { id: "POL-cross", triggerEventId: "EVT-a", actionCommandId: "CMD-b", listener: at("b/wire.ts", "<module>") },
      { id: "POL-inside", triggerEventId: "EVT-a", actionCommandId: "CMD-a", listener: at("a/wire.ts", "<module>") },
    ],
    readModels: [],
    actors: [],
    diagnostics: { mode: "STATE_SIGNALS", entryFiles: [], parsedFileCount: 0, parseFailures: [], unattributedSignals: [] },
  };
  const contexts = contextsOf(map);
  assert.deepEqual(contexts.get("CTX-b"), { contextId: "CTX-b", crossesTo: null });
  assert.deepEqual(contexts.get("CMD-b"), { contextId: "CTX-b", crossesTo: null });
  assert.deepEqual(contexts.get("EVT-a"), { contextId: "CTX-a", crossesTo: null });
  assert.deepEqual(contexts.get("POL-cross"), { contextId: "CTX-a", crossesTo: "CTX-b" });
  assert.deepEqual(contexts.get("POL-inside"), { contextId: "CTX-a", crossesTo: null });
});

test("同義の数え方: 同じ Bounded Context の中だけで数え、違う Bounded Context の同じ用語は別の区分に 1 回ずつ載せる", () => {
  const entry = (id: string, term: string, contextId: string | null): GlossaryEntry => ({
    id,
    kind: "COMMAND",
    scope: "PRESENTED",
    term: { status: "GENERATED", term, label: term, recordKey: id },
    implementation: { names: [], locations: [] },
    sources: [],
    contextId,
    crossesTo: null,
    termStatus: "CANDIDATE",
    excerpt: null,
  });
  const gaps = recordGaps(
    [
      entry("A1", "Order", "CTX-a"),
      entry("A2", "Order", "CTX-a"),
      entry("B1", "Order", "CTX-b"),
      entry("C1", "Ship", "CTX-a"),
      entry("D1", "Ship", "CTX-b"),
      entry("E1", "Pay", "CTX-a"),
      entry("N1", "Order", null),
    ],
    [],
    new Map(),
  );
  assert.deepEqual(gaps.sharedTerms, [{ term: "Order", contextId: "CTX-a", entryIds: ["A1", "A2"] }]);
  assert.deepEqual(gaps.contextHomonyms, [
    { term: "Order", entries: [{ entryId: "A1", contextId: "CTX-a" }, { entryId: "B1", contextId: "CTX-b" }] },
    { term: "Ship", entries: [{ entryId: "C1", contextId: "CTX-a" }, { entryId: "D1", contextId: "CTX-b" }] },
  ]);
});