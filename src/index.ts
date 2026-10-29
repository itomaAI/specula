// Specula の入口。Node.js と Itera（build:itera の bundle）の両方から読む。
// M0〜M5 の公開コマンドは、各モジュールを書き直すときに足す。

export type { JsonValue, LlmRequest, LlmText } from "./types/index.js";

export type { FileSystemPort } from "./ports/FileSystemPort.js";
export type {
  LanguageModelClient,
  LanguageModelPort,
  LlmCompletion,
  OutputCheck,
} from "./ports/LanguageModelPort.js";
export type {
  EngineInfo,
  RawInstance,
  SolverPort,
  SolverRequest,
  SolverResponse,
} from "./ports/SolverPort.js";

export { NodeFsAdapter } from "./adapters/NodeFsAdapter.js";
export { IteraVfsAdapter } from "./adapters/IteraVfsAdapter.js";
export type { IteraFs } from "./adapters/IteraVfsAdapter.js";
export { RecordingLanguageModel, recordKeyOf } from "./adapters/RecordingLanguageModel.js";
export type { LlmRecord } from "./adapters/RecordingLanguageModel.js";

export { canonicalJson } from "./lib/canonical_json.js";
export { sha256Hex } from "./lib/sha256.js";

export const VERSION = "0.1.0";