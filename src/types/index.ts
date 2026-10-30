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
 * 確定の状態（SpecViewer の仕様 2.4）。LLM や機械が作った項目に共通で持たせる。
 * - NOT_GENERATED: 作れなかった（LLM に届かなかったなど）
 * - CANDIDATE: 作ったが、人が確かめていない
 * - CONFIRMED: 人が確かめて確定にした
 * - NEEDS_RECHECK: 確定したあとで、元にした資料やコードが変わった
 * 確定の操作は現在の範囲に無いので、各モジュールが書くのは NOT_GENERATED と CANDIDATE だけである。
 */
export type ConfirmationStatus = "NOT_GENERATED" | "CANDIDATE" | "CONFIRMED" | "NEEDS_RECHECK";

/**
 * LLM の結果。届かなかったことも値で表す（例外にしない）。
 * NOT_GENERATED の項目を、機械的に作った文や名前で埋めない。
 */
export type LlmText =
  | { status: "GENERATED"; text: string; recordKey: string }
  | { status: "NOT_GENERATED"; reason: "UNREACHABLE" | "INVALID_OUTPUT"; detail: string };