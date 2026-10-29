// LLM の出力を記録して再利用する（全体設計 1.3）。
// LanguageModelPort を実装し、内側に実際の LLM（LanguageModelClient）と FileSystemPort を持つ。
//
// - 記録のキー: task・promptVersion・input を正準化した JSON の SHA-256。instructions はキーに入れない。
// - 記録の置き場所: <recordsDir>/<キー>.json
// - 記録を使う条件: 読めて、request の task・promptVersion・input が一致し、いまの check も通ること。
//   条件を満たさない記録は使わず、LLM を呼び直して上書きする。
// - 記録しないもの: UNREACHABLE と INVALID_OUTPUT。次の実行で改めて呼ぶ。
// - FileSystemPort の失敗は、そのまま例外にする（LLM に届かなかったこととは別の、環境の故障なので）。

import type { JsonValue, LlmRequest, LlmText } from "../types/index.js";
import type { FileSystemPort } from "../ports/FileSystemPort.js";
import type {
  LanguageModelClient,
  LanguageModelPort,
  LlmCompletion,
  OutputCheck,
} from "../ports/LanguageModelPort.js";
import { canonicalJson } from "../lib/canonical_json.js";
import { sha256Hex } from "../lib/sha256.js";

/** 記録のファイルの中身。 */
export interface LlmRecord {
  request: { task: string; promptVersion: string; input: JsonValue };
  instructions: string;
  text: string;
  model: string;
  recordedAt: string;
}

export async function recordKeyOf(request: LlmRequest): Promise<string> {
  return sha256Hex(
    canonicalJson({ task: request.task, promptVersion: request.promptVersion, input: request.input }),
  );
}

export class RecordingLanguageModel implements LanguageModelPort {
  constructor(
    private readonly client: LanguageModelClient | null,
    private readonly fs: FileSystemPort,
    private readonly recordsDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (recordsDir.length === 0) {
      throw new Error("RecordingLanguageModel: recordsDir が空");
    }
  }

  recordPathOf(key: string): string {
    return `${this.recordsDir.replace(/\/+$/, "")}/${key}.json`;
  }

  async generate(request: LlmRequest, check: OutputCheck): Promise<LlmText> {
    const key = await recordKeyOf(request);
    const path = this.recordPathOf(key);

    const reused = await this.readUsableRecord(path, request, check);
    if (reused !== null) {
      return { status: "GENERATED", text: reused.text, recordKey: key };
    }

    if (this.client === null) {
      return { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: "LLM のアダプターが無い" };
    }

    let completion: LlmCompletion;
    try {
      completion = await this.client.complete(request);
    } catch (error) {
      // アダプターは例外を投げない約束だが、投げたら届かなかったものとして理由を残す。
      return {
        status: "NOT_GENERATED",
        reason: "UNREACHABLE",
        detail: `LLM のアダプターが例外を投げた: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (completion.kind === "UNREACHABLE") {
      return { status: "NOT_GENERATED", reason: "UNREACHABLE", detail: completion.detail };
    }

    const verdict = check(completion.text);
    if (!verdict.ok) {
      return { status: "NOT_GENERATED", reason: "INVALID_OUTPUT", detail: verdict.detail };
    }

    const record: LlmRecord = {
      request: { task: request.task, promptVersion: request.promptVersion, input: request.input },
      instructions: request.instructions,
      text: completion.text,
      model: completion.model,
      recordedAt: this.now().toISOString(),
    };
    await this.fs.write(path, JSON.stringify(record, null, 2) + "\n");
    return { status: "GENERATED", text: completion.text, recordKey: key };
  }

  private async readUsableRecord(path: string, request: LlmRequest, check: OutputCheck): Promise<LlmRecord | null> {
    if (!(await this.fs.exists(path))) return null;
    const raw = await this.fs.read(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // 壊れた記録は使わない（呼び直して上書きする）
    }
    if (!isLlmRecord(parsed)) return null;
    const stored = canonicalJson(parsed.request);
    const wanted = canonicalJson({ task: request.task, promptVersion: request.promptVersion, input: request.input });
    if (stored !== wanted) return null;
    if (!check(parsed.text).ok) return null;
    return parsed;
  }
}

function isLlmRecord(value: unknown): value is LlmRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const req = v["request"];
  if (typeof req !== "object" || req === null) return false;
  const r = req as Record<string, unknown>;
  return (
    typeof r["task"] === "string" &&
    typeof r["promptVersion"] === "string" &&
    "input" in r &&
    typeof v["instructions"] === "string" &&
    typeof v["text"] === "string" &&
    typeof v["model"] === "string" &&
    typeof v["recordedAt"] === "string"
  );
}