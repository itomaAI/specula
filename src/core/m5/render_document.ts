// 仕様書（DOCUMENT）を描く（M5 の設計 4.1）。中間表現を文字列にするだけで、判定はしない。

import { fenceFor, joinLines, mdCell, mdLine, stripSourceComments } from "./escape.js";
import type { IssueView, ViewModel } from "./view_model.js";

function renderIssue(issue: IssueView): string[] {
  const lines: string[] = [];
  lines.push(`#### ${issue.id}`, "");
  lines.push(`- 状態: ${issue.status}`);
  lines.push(`- 主張: ${mdLine(issue.claim)}`);
  lines.push(`- 観測事実: ${mdLine(issue.observation)}`);
  lines.push(`- 判断質問: ${mdLine(issue.question)}`);
  lines.push(`- 関わる操作: ${issue.operations.map(mdLine).join("、")}`);
  if (issue.dependentCount > 0) {
    lines.push(`- 従属する反例: ${issue.dependentCount} 件（同じ状態で見つかった反例を、この論点にまとめた）`);
  }
  lines.push("");

  if (issue.trace === null) {
    lines.push("実行列: なし（到達しない操作には実行列が無い）。", "");
  } else {
    lines.push("実行列:", "");
    lines.push("| 時点 | 状態変数の値 | 直前の操作の結果 | 成り立つ条件 |");
    lines.push("| :-- | :-- | :-- | :-- |");
    for (const row of issue.trace) {
      const values = row.values.length === 0 ? "なし" : row.values.join("、");
      lines.push(`| ${row.index} | ${mdCell(values)} | ${mdCell(row.outcome)} | ${mdCell(row.holds)} |`);
    }
    lines.push("");
  }

  lines.push("選択肢（候補。どれも採択していない）:", "");
  for (const option of issue.options) lines.push(`- ${option.id}: ${mdLine(option.meaning)}`);
  lines.push("");
  return lines;
}

export function renderDocument(model: ViewModel): string {
  const lines: string[] = [];

  lines.push(`# 仕様書: ${mdLine(model.title)}${model.titleNote}`, "");
  if (model.ledgerIsStale === true) {
    lines.push("> 注意: この論点カタログは、いまの形式仕様正本とは別の版から作った。論点は古い版について見つかったものである。", "");
  }

  lines.push("## 検証の状態", "");
  if (model.verification === null) {
    lines.push("論点カタログが無いので、検証の状態は分からない（M4 を実行していない）。", "");
  } else {
    lines.push(model.verification.headline, "");
    for (const line of model.verification.lines) lines.push(`- ${mdLine(line)}`);
    lines.push("");
  }

  // 意図の候補（設計 4.1 の 3）。LLM が作った推測で、人が確かめていないので「候補」と明記する。
  lines.push("## 意図の候補", "");
  if (model.intent === null) {
    lines.push("意図の候補が無い。", "");
  } else {
    lines.push("次の文は、コードと資料から LLM が推測した候補である。まだ人が確かめていない。", "");
    lines.push(`- 候補: ${mdLine(model.intent.text)}`);
    if (model.intent.userIntent !== null) lines.push(`- 利用者が書いた目的: ${mdLine(model.intent.userIntent)}`);
    lines.push("");
  }

  lines.push("## 状態", "");
  lines.push("状態は、次の状態変数の値と、直前の操作の結果からなる。", "");
  if (model.stateVariables.length === 0) {
    lines.push("状態変数は無い。", "");
  } else {
    lines.push("| 状態変数 | 値の種類 | とりうる値 | 初期値 |");
    lines.push("| :-- | :-- | :-- | :-- |");
    for (const variable of model.stateVariables) {
      lines.push(`| ${mdCell(variable.label)} | ${variable.domain} | ${mdCell(variable.values)} | ${mdCell(variable.initial)} |`);
    }
    lines.push("");
  }

  lines.push("## 環境が決める条件", "");
  lines.push("次の条件は、各時点で環境が自由に決める。どの時点でも、成り立つことも成り立たないこともある。", "");
  if (model.propositions.length === 0) {
    lines.push("環境が決める条件は無い。", "");
  } else {
    for (const prop of model.propositions) lines.push(`- ${mdLine(prop)}`);
    lines.push("");
  }

  lines.push("## 操作", "");
  for (const operation of model.operations) {
    lines.push(`### ${mdLine(operation.label)}`, "");
    if (operation.steps.length === 0) {
      lines.push("条件も書き込みも無い。", "");
    } else {
      lines.push("経路の順の条件と書き込み（条件は、それより前の書き込みを反映した値についての文）:", "");
      operation.steps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step.kind === "CONDITION" ? "条件" : "書き込み"}: ${mdLine(step.text)}`);
      });
      lines.push("");
    }
    lines.push(`- 結果: ${mdLine(operation.outcome)}`);
    if (operation.dataMutationCount > 0) {
      lines.push(`- 状態として検証していない変更: ${operation.dataMutationCount} 件（データベースなどへの変更で、検査の対象に入っていない）`);
    }
    if (operation.issueIds.length > 0) lines.push(`- 関わる論点: ${operation.issueIds.join("、")}`);
    lines.push("");
  }

  lines.push("## 不変条件", "");
  lines.push("初回は不変条件を作らない。不変条件が無いことは、不変条件を満たしていることを意味しない。", "");

  lines.push("## 論点", "");
  if (model.issueGroups === null) {
    lines.push("論点カタログが無い（M4 を実行していない）。", "");
  } else if (model.issueGroups.length === 0) {
    lines.push("論点は無い。どの範囲で調べたかは「検証の状態」の節に書いた。", "");
  } else {
    lines.push("論点はすべて未決である。選択肢は候補で、まだ人が判断していない。", "");
    for (const group of model.issueGroups) {
      lines.push(`### ${group.heading}`, "");
      for (const issue of group.issues) lines.push(...renderIssue(issue));
    }
  }

  // 付録は Eng のときだけ（設計 2 節・4.1・8.3）。正本のソースは識別子を含むため、PdM には出さない。
  if (model.viewRole === "Eng") {
    lines.push("## 付録: 形式仕様のソース", "");
    const source = stripSourceComments(model.source).replace(/\n+$/, "");
    const fence = fenceFor(source);
    lines.push(`${fence}alloy`, source, fence);
  }

  return joinLines(lines);
}