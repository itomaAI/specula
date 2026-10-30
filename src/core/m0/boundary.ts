// Stage 1: ContextBoundaryAnalyzer（M0 の設計 3.1）。
// ディレクトリの形だけから Bounded Context の候補を出す。意図の候補（LLM）は naming.ts が付ける。
//
// 決めたこと（初回）:
// - packages/・apps/・features/・modules/・domains/ の直下のディレクトリを、それぞれ 1 つのコンテキストの根とする
//   （リポジトリのどの深さにあってもよい。例: src/features/billing）。
// - 根が 2 つ以上あるときだけ分ける。1 つ以下なら、全体を DEFAULT_CONTEXT 1 つにする。
// - 分けたとき、どの根にも入らないファイルは DEFAULT_CONTEXT に入れる（共通部分）。
// - DB スキーマの凝集度による分割は、初回は行わない。

export const DEFAULT_CONTEXT_ID = "DEFAULT_CONTEXT";

const BOUNDARY_DIRS = new Set(["packages", "apps", "features", "modules", "domains"]);

export interface ContextBoundary {
  id: string;
  name: string;
  rootPaths: string[];
  isDefaultFallback: boolean;
}

export interface BoundaryResult {
  contexts: ContextBoundary[];
  /** ファイルのパスから、そのファイルが属するコンテキストの id を返す。 */
  contextOf: (path: string) => string;
}

/** ファイルの一覧（リポジトリのルートからの相対パス）からコンテキストを決める。 */
export function analyzeBoundaries(paths: readonly string[]): BoundaryResult {
  const roots = new Set<string>();
  for (const path of paths) {
    const root = boundaryRootOf(path);
    if (root !== null) roots.add(root);
  }

  if (roots.size < 2) {
    const fallback: ContextBoundary = {
      id: DEFAULT_CONTEXT_ID,
      name: DEFAULT_CONTEXT_ID,
      rootPaths: ["."],
      isDefaultFallback: true,
    };
    return { contexts: [fallback], contextOf: () => DEFAULT_CONTEXT_ID };
  }

  const sortedRoots = [...roots].sort();
  const contexts: ContextBoundary[] = sortedRoots.map((root) => ({
    id: `CTX-${root}`,
    name: root.slice(root.lastIndexOf("/") + 1),
    rootPaths: [root],
    isDefaultFallback: false,
  }));

  const contextOf = (path: string): string => {
    const root = boundaryRootOf(path);
    return root !== null && roots.has(root) ? `CTX-${root}` : DEFAULT_CONTEXT_ID;
  };

  // どの根にも入らないファイルがあれば、共通部分として DEFAULT_CONTEXT を足す。
  if (paths.some((path) => boundaryRootOf(path) === null)) {
    contexts.push({ id: DEFAULT_CONTEXT_ID, name: DEFAULT_CONTEXT_ID, rootPaths: ["."], isDefaultFallback: true });
  }
  contexts.sort((a, b) => compareIds(a.id, b.id));
  return { contexts, contextOf };
}

/**
 * パスの中で最初に現れる境界のディレクトリ（packages など）と、その直下のディレクトリまでを返す。
 * 直下がファイル（packages/index.ts など）のときは根にしない。
 */
export function boundaryRootOf(path: string): string | null {
  const segments = path.split("/");
  for (let i = 0; i < segments.length - 2; i += 1) {
    const segment = segments[i];
    const child = segments[i + 1];
    if (segment !== undefined && child !== undefined && BOUNDARY_DIRS.has(segment) && child.length > 0) {
      return segments.slice(0, i + 2).join("/");
    }
  }
  return null;
}

/** 識別子の並びはすべてこれで決める（ロケールによらない、コード単位の辞書順）。 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}