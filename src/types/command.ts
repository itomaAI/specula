// M0（CommandExtractor）の入出力の型（M0 の設計 4.1・4.2）。

/**
 * M0 に渡すリポジトリの中身。読み込みは呼び出し元（アダプターの側）が行い、コアはファイルを読まない。
 * - files: テキストのファイルだけ。path はリポジトリのルートからの相対パス（"/" 区切り、先頭に "./" を付けない）。
 *   package.json と tsconfig.json も、ここに入っていれば読む。
 * - documents: 仕様の資料（README・docs/ の Markdown・スキーマ定義）。CommandExtractor は読まない。GlossaryBuilder の入力。
 *   集める規則と上限は CommandExtractor の設計 4.0（リーダーが同じ規則で集める）。
 * - omittedDocuments: 合計の上限を超えたので入れなかった資料のパス（辞書順）。
 * - screenshots: 画面画像のパス（任意）。画面のルートと結び付けられるものだけをリードモデルに付ける。
 */
export interface RepositoryArtifacts {
  files: Array<{ path: string; text: string }>;
  documents: RepositoryDocument[];
  omittedDocuments: string[];
  screenshots?: string[];
}

/** 仕様の資料 1 つ。truncated は 1 ファイルの上限を超えたので先頭だけを入れたとき true。 */
export interface RepositoryDocument {
  path: string;
  kind: "README" | "DOC" | "SCHEMA";
  text: string;
  truncated: boolean;
}

/** コードの中の位置。symbol は関数の名前、line は 1 から数える。 */
export interface SourceLocation {
  file: string;
  symbol: string;
  line: number;
}

// 2026-10-30: 地図の LLM の欄（Bounded Context の intent・intentStatus、イベント・コマンド・ポリシーの name、
// シナリオの intent・intentStatus・inletTrigger.name）を外した。名前は GlossaryBuilder の辞書、
// 意図の候補は IntentSynthesizer の出力に持つ（CommandExtractor の設計 4.1・4.2）。

export interface BoundedContext {
  /** ルートパスから作る。単一コンテキストは "DEFAULT_CONTEXT"。 */
  id: string;
  /** 根のディレクトリから機械的に決まる実装の名前。利用者向けの表示には使わない。 */
  name: string;
  rootPaths: string[];
  isDefaultFallback: boolean;
}

export interface DomainEvent {
  /** ハンドラの所在から作る。 */
  id: string;
  contextId: string;
  aggregate?: string;
  /** このイベントを起こすシグナルを含む関数。 */
  handler: SourceLocation;
  /**
   * イベントのもとになったシグナル（コードから機械的に決まる値）。後段の LLM の入力に、LLM の名前の代わりに使う。
   * kind は "DB_MUTATION"・"EVENT_EMIT"・"PUBLIC_FUNCTION"。label は最初の文字列の引数（無ければ null）。
   */
  signal: { kind: "DB_MUTATION" | "EVENT_EMIT" | "PUBLIC_FUNCTION"; callee: string; label: string | null; line: number };
  /** 先に起きるイベントの識別子。コードから決められないときは空。 */
  after: string[];
}

export interface Command {
  id: string;
  contextId: string;
  actorId: string;
  readModelId?: string;
  /** このコマンドが発生させるイベント（1 つ以上）。 */
  eventIds: string[];
  handler: SourceLocation;
}

export interface Policy {
  id: string;
  triggerEventId: string;
  actionCommandId: string;
  listener: SourceLocation;
}

export interface ReadModel {
  id: string;
  name: string;
  route: string;
  componentFile: string;
  screenshotPath?: string;
}

export interface Actor {
  id: string;
  name: string;
}

/** 全体マップ。配列はすべて id の辞書順。 */
export interface EventStormingMap {
  boundedContexts: BoundedContext[];
  events: DomainEvent[];
  commands: Command[];
  policies: Policy[];
  readModels: ReadModel[];
  /** 認可のコードから見つけた役割と、必要なときだけ "Caller"。 */
  actors: Actor[];
  /** 抽出の経過（報告に出す）。配列はパスと行の順。 */
  diagnostics: ExtractionDiagnostics;
}

export interface ExtractionDiagnostics {
  /**
   * STATE_SIGNALS: DB の書き込み・イベントの発行・画面からマップを作った。
   * PUBLIC_FUNCTIONS: DB の書き込みも画面も無いので、入口から公開されている関数を起点にした。
   */
  mode: "STATE_SIGNALS" | "PUBLIC_FUNCTIONS";
  /** PUBLIC_FUNCTIONS のときにたどった入口のファイル。 */
  entryFiles: string[];
  /** 読み込んだコードのファイルの数（除外したものは数えない）。 */
  parsedFileCount: number;
  /** 構文の解析に失敗したファイル。マップには入れず、先へ進んだ。 */
  parseFailures: Array<{ path: string; message: string }>;
  /** 最上位の名前付き関数の外にあったため、イベントにしなかったシグナル。 */
  unattributedSignals: Array<{ kind: "DB_MUTATION" | "EVENT_EMIT" | "PUBLIC_FUNCTION"; file: string; line: number; callee: string }>;
}

/** 個別シナリオ（M1 への入力）。 */
export interface CommandTarget {
  /** "CT-<起点の識別子>"。起点が複数のシナリオに分かれるときは "-<イベントの識別子>" を足す。 */
  id: string;
  boundedContext: string;
  origin: "EXTRACTED" | "USER_DEFINED";
  /**
   * 利用者定義のシナリオで、利用者が書いた目的（任意）。LLM の意図の候補（IntentSynthesizer の出力）とは別に持つ。
   * これがあっても意図は確定にならない（確定は SpecProjector の後の合意で行う）。
   */
  userIntent?: string;
  inletType: "COMMAND" | "POLICY";
  inletTrigger: {
    id: string;
    /** 起点の所在。M1 はここから追跡を始める。 */
    handler: SourceLocation;
  };
  actor: Actor;
  /** 画面を持たないシステムでは無い。 */
  readModel?: {
    name: string;
    route: string;
    entryFile: string;
    screenshotPath?: string;
  };
  /** 期待イベントの識別子（1 シナリオに 1 つ）。 */
  expectedEvent: string;
}

/**
 * シナリオの選択。起点は識別子か "ファイル#関数名" で指す（LLM の名前では照合しない）。
 */
export interface CommandSelection {
  filter?: { boundedContext?: string; inlets?: string[] };
  userDefined?: Array<{ inlet: string; intent?: string; route?: string }>;
}

export interface SliceResult {
  commands: CommandTarget[];
  /** 起点が全体マップに無かった利用者定義のシナリオ。 */
  rejected: Array<{ inlet: string; reason: string }>;
}