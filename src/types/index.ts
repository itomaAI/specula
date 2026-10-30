// モジュールをまたぐ共通の型（全体設計 1.3）。
// 各モジュール（M0〜M5）の入出力の型は、そのモジュールを書き直すときに足す。

/** JSON にそのまま書ける値。LLM への入力と記録の中身に使う。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** LLM に頼む 1 件の処理。 */
export interface LlmRequest {
  /** 処理の種類（例: "glossary.term-event"）。 */
  task: string;
  /** プロンプトの版。プロンプトを変えたら上げる。 */
  promptVersion: string;
  /** LLM に渡す指示の文。記録のキーには入れない（中身を変えたら promptVersion を上げる）。 */
  instructions: string;
  /** JSON にできる値だけ。記録のキーはこの値を正準化して作る。 */
  input: JsonValue;
}

/**
 * LLM の結果。届かなかったことも値で表す（例外にしない）。
 * NOT_GENERATED の項目を、機械的に作った文や名前で埋めない。
 */
export type LlmText =
  | { status: "GENERATED"; text: string; recordKey: string }
  | { status: "NOT_GENERATED"; reason: "UNREACHABLE" | "INVALID_OUTPUT"; detail: string };