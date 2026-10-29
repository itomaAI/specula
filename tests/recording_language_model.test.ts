// RecordingLanguageModel のテスト（全体設計 1.3: LLM の出力の記録と再利用）。
// メモリ上の FileSystemPort と、呼ばれた回数を数える偽の LLM を使う。

import { test } from "node:test";
import assert from "node:assert/strict";

import { RecordingLanguageModel, recordKeyOf } from "../src/adapters/RecordingLanguageModel.js";
import type { FileSystemPort } from "../src/ports/FileSystemPort.js";
import type { LanguageModelClient, LlmCompletion, OutputCheck } from "../src/ports/LanguageModelPort.js";
import type { LlmRequest } from "../src/types/index.js";

class MemoryFs implements FileSystemPort {
  readonly files = new Map<string, string>();
  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async list(dir: string): Promise<string[]> {
    const prefix = dir.replace(/\/+$/, "") + "/";
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  }
}

class FakeClient implements LanguageModelClient {
  calls = 0;
  constructor(private readonly answer: (request: LlmRequest) => LlmCompletion) {}
  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.calls += 1;
    return this.answer(request);
  }
}

const DIR = "llm-records";
const FIXED_NOW = () => new Date("2026-10-30T00:00:00.000Z");
const anyText: OutputCheck = () => ({ ok: true });
const nonEmpty: OutputCheck = (text) => (text.trim().length > 0 ? { ok: true } : { ok: false, detail: "空" });

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    task: "m0.name-event",
    promptVersion: "1",
    instructions: "イベントに名前を付ける",
    input: { handler: "onSubmit", file: "src/a.ts" },
    ...overrides,
  };
}

test("初回は LLM を呼んで記録し、2 回目は記録を使う", async () => {
  const fs = new MemoryFs();
  const client = new FakeClient(() => ({ kind: "TEXT", text: "送信する", model: "fake-1" }));
  const llm = new RecordingLanguageModel(client, fs, DIR, FIXED_NOW);

  const first = await llm.generate(request(), anyText);
  const second = await llm.generate(request(), anyText);

  assert.equal(client.calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.status, "GENERATED");
  const key = await recordKeyOf(request());
  assert.equal(first.status === "GENERATED" ? first.recordKey : null, key);

  const stored = JSON.parse(await fs.read(`${DIR}/${key}.json`)) as Record<string, unknown>;
  assert.equal(stored["text"], "送信する");
  assert.equal(stored["model"], "fake-1");
  assert.equal(stored["instructions"], "イベントに名前を付ける");
  assert.equal(stored["recordedAt"], "2026-10-30T00:00:00.000Z");
});

test("input のキーの順が違っても同じ記録を使う", async () => {
  const fs = new MemoryFs();
  const client = new FakeClient(() => ({ kind: "TEXT", text: "送信する", model: "fake-1" }));
  const llm = new RecordingLanguageModel(client, fs, DIR, FIXED_NOW);

  await llm.generate(request({ input: { handler: "onSubmit", file: "src/a.ts" } }), anyText);
  await llm.generate(request({ input: { file: "src/a.ts", handler: "onSubmit" } }), anyText);

  assert.equal(client.calls, 1);
});

test("instructions はキーに入らない（変えたら promptVersion を上げる約束）", async () => {
  const fs = new MemoryFs();
  const client = new FakeClient(() => ({ kind: "TEXT", text: "送信する", model: "fake-1" }));
  const llm = new RecordingLanguageModel(client, fs, DIR, FIXED_NOW);

  await llm.generate(request(), anyText);
  await llm.generate(request({ instructions: "別の言い方" }), anyText);
  assert.equal(client.calls, 1);

  await llm.generate(request({ promptVersion: "2" }), anyText);
  assert.equal(client.calls, 2);
});

test("届かなかったときは未生成を返し、記録しない", async () => {
  const fs = new MemoryFs();
  const client = new FakeClient(() => ({ kind: "UNREACHABLE", detail: "つながらない" }));
  const llm = new RecordingLanguageModel(client, fs, DIR, FIXED_NOW);

  const result = await llm.generate(request(), anyText);
  assert.deepEqual(result, { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "つながらない" });
  assert.equal(fs.files.size, 0);

  await llm.generate(request(), anyText);
  assert.equal(client.calls, 2);
});

test("形が合わない出力は未生成を返し、記録しない", async () => {
  const fs = new MemoryFs();
  const client = new FakeClient(() => ({ kind: "TEXT", text: "   ", model: "fake-1" }));
  const llm = new RecordingLanguageModel(client, fs, DIR, FIXED_NOW);

  const result = await llm.generate(request(), nonEmpty);
  assert.deepEqual(result, { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: "空" });
  assert.equal(fs.files.size, 0);
});

test("LLM のアダプターが無いときは届かなかったものとして返す", async () => {
  const fs = new MemoryFs();
  const llm = new RecordingLanguageModel(null, fs, DIR, FIXED_NOW);

  const result = await llm.generate(request(), anyText);
  assert.equal(result.status, "NOT_GENERATED");
  assert.equal(result.status === "NOT_GENERATED" ? result.reason : null, "UNREACHABLE");
});

test("記録があれば、LLM のアダプターが無くても記録を使う", async () => {
  const fs = new MemoryFs();
  const client = new FakeClient(() => ({ kind: "TEXT", text: "送信する", model: "fake-1" }));
  await new RecordingLanguageModel(client, fs, DIR, FIXED_NOW).generate(request(), anyText);

  const offline = new RecordingLanguageModel(null, fs, DIR, FIXED_NOW);
  const result = await offline.generate(request(), anyText);
  assert.equal(result.status === "GENERATED" ? result.text : null, "送信する");
});

test("アダプターが例外を投げても例外にせず、届かなかったものとして返す", async () => {
  const fs = new MemoryFs();
  const client = new FakeClient(() => {
    throw new Error("boom");
  });
  const llm = new RecordingLanguageModel(client, fs, DIR, FIXED_NOW);

  const result = await llm.generate(request(), anyText);
  assert.equal(result.status === "NOT_GENERATED" ? result.reason : null, "UNREACHABLE");
  assert.equal(fs.files.size, 0);
});

test("いまの check を通らない記録は使わず、呼び直して上書きする", async () => {
  const fs = new MemoryFs();
  let answer = "   ";
  const client = new FakeClient(() => ({ kind: "TEXT", text: answer, model: "fake-1" }));
  const llm = new RecordingLanguageModel(client, fs, DIR, FIXED_NOW);

  await llm.generate(request(), anyText); // 空白だけの出力を記録する
  answer = "送信する";
  const result = await llm.generate(request(), nonEmpty);

  assert.equal(client.calls, 2);
  assert.equal(result.status === "GENERATED" ? result.text : null, "送信する");
  const key = await recordKeyOf(request());
  const stored = JSON.parse(await fs.read(`${DIR}/${key}.json`)) as Record<string, unknown>;
  assert.equal(stored["text"], "送信する");
});

test("壊れた記録や、request が一致しない記録は使わない", async () => {
  const fs = new MemoryFs();
  const client = new FakeClient(() => ({ kind: "TEXT", text: "送信する", model: "fake-1" }));
  const llm = new RecordingLanguageModel(client, fs, DIR, FIXED_NOW);
  const key = await recordKeyOf(request());
  const path = `${DIR}/${key}.json`;

  await fs.write(path, "{ 壊れている");
  await llm.generate(request(), anyText);
  assert.equal(client.calls, 1);

  const other = {
    request: { task: "別の処理", promptVersion: "1", input: null },
    instructions: "",
    text: "別の答え",
    model: "fake-1",
    recordedAt: "2026-10-30T00:00:00.000Z",
  };
  await fs.write(path, JSON.stringify(other));
  const result = await llm.generate(request(), anyText);
  assert.equal(client.calls, 2);
  assert.equal(result.status === "GENERATED" ? result.text : null, "送信する");
});

test("recordsDir が空なら作れない", () => {
  assert.throws(() => new RecordingLanguageModel(null, new MemoryFs(), ""));
});