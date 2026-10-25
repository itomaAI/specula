# Specula

> **The specification layer for software engineering. Extract, formally verify, and manage specifications as the single source of truth.**

---

## 1. Vision & Core Philosophy

In modern software development, **Code** is version-controlled on **GitHub**, and **Design** is version-controlled on **Figma**. However, **Specifications** have lacked an executable, diff-aware, mathematically verifiable platform.

Specula provides the missing vertex of software engineering:

```
        【GitHub】
       Code (Engineers)
         ／        ＼
        ／          ＼
       ／            ＼
【Figma】 ─────────── 【Specula】
Design (Designers)   Specification (PdM)
```

### The Three-Actor Division of Labor
Specula operates on the fundamental principle that **LLMs must not perform logical proofs or calculations**. LLMs are probabilistic, while verification must be deterministic.

| Actor | Role | Responsibilities | Anti-patterns to Avoid |
| :--- | :--- | :--- | :--- |
| **Human (PdM / Decision Maker)** | Definition of Intent & Value | • Write scenarios & requirements in natural language / BDD.<br>• Commit & approve Domain Questions. | Exhaustive state enumeration, mathematical formalization. |
| **LLM (Agent)** | Translation & Orchestration | • Parse requirements/code into decision tables.<br>• Synthesize counterexamples into human Domain Questions. | Guessing specification gaps, autonomous mathematical proofs. |
| **Deterministic Solver** | Formal Proof & State Space Exploration | • Compile formal specifications (Alloy 6).<br>• $N \times M$ exhaustive state space search for deadlocks, unreachable states, and unhandled transitions. | Natural language parsing, business judgment. |

---

## 2. Architecture: Ports & Adapters

Specula is architected with a strict separation between the **Controller/Pipeline** and the **FileSystem/Runtime environment**:

- **Core Engine (`src/core/`)**:
  - `ContextExtractor`: Extracts AST syntax facts and visual facts without domain guessing.
  - `FormalTranspiler`: Compiles facts into formal logic (Alloy 6), detecting ambiguities for human clarification.
  - `FormalSolver`: Exhaustive state space exploration and counterexample trace extraction.
  - `LedgerSynthesizer`: Translates machine counterexamples into actionable Domain Questions.
  - `SpecProjector`: Pure-function deterministic projection to Markdown, DAGs, and sequence views.
- **Ports & Adapters (`src/ports/`, `src/adapters/`)**:
  - `FileSystemPort`: Decouples file I/O. Runs seamlessly inside **Itera OS** (Virtual VFS) and **Standalone Node.js / CI** (`node:fs`).

---

## 3. License

MIT License © 2026 itomaAI