/**
 * Shared printers for the CLI: quote tables, questions, results, traces,
 * offering descriptions. All functions are pure string builders — the entry
 * point injects the money formatter (pricing's `formatMoney`) and the style
 * (ANSI only when stdout is a TTY and NO_COLOR is unset).
 */
import type {
  ChoiceQuestion,
  OfferingDescription,
  ParameterQuestion,
  Quote,
  ScopeResult,
  Trace,
} from '../engine/types.js';
import type { Value } from '../graph/types.js';

/** `(cents, currency) → "$64.00"`; injected from src/pricing. */
export type Money = (cents: number, currency: string) => string;

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

const wrap =
  (code: string) =>
  (text: string): string =>
    `\x1b[${code}m${text}\x1b[0m`;

const identity = (text: string): string => text;

/** ANSI styling when `enabled`; plain identity otherwise. */
export function createStyle(enabled: boolean): Style {
  if (!enabled) {
    return { bold: identity, dim: identity, red: identity, green: identity, yellow: identity, cyan: identity };
  }
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}

/** Colors only for a TTY with NO_COLOR unset. */
export function colorEnabled(stream: { isTTY?: boolean } | undefined = process.stdout): boolean {
  return Boolean(stream?.isTTY) && !process.env.NO_COLOR;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function formatValue(value: Value): string {
  return Array.isArray(value) ? `[${value.join(', ')}]` : String(value);
}

// ─── Quote table ─────────────────────────────────────────────────────────────

export function formatQuote(quote: Quote, money: Money, style: Style): string {
  interface Row {
    label: string;
    amount: string;
    detail?: string;
  }
  const lineRows: Row[] = quote.lines.map((line) => ({
    label: line.label,
    amount: money(line.amountCents, quote.currency),
    detail:
      line.unitAmountCents !== undefined
        ? `${line.quantity ?? 1} × ${money(line.unitAmountCents, quote.currency)}`
        : line.quantity !== undefined && line.quantity !== 1
          ? `${line.quantity} ×`
          : line.reason,
  }));
  const totalRows: Array<Row & { strong?: boolean }> = [
    { label: 'Subtotal', amount: money(quote.subtotalCents, quote.currency) },
    { label: 'Tax', amount: money(quote.taxCents, quote.currency) },
    { label: 'Total', amount: money(quote.totalCents, quote.currency), strong: true },
  ];
  const allRows: Array<Row & { strong?: boolean }> = [...lineRows, ...totalRows];
  const labelWidth = Math.min(
    48,
    Math.max(12, ...allRows.map((row) => row.label.length)),
  );
  const amountWidth = Math.max(...allRows.map((row) => row.amount.length));
  const render = (row: Row & { strong?: boolean }): string => {
    const label = truncate(row.label, labelWidth).padEnd(labelWidth);
    const amount = row.amount.padStart(amountWidth);
    return `  ${label}  ${row.strong ? style.bold(amount) : amount}`;
  };
  const lines = [
    `${style.cyan('Quote')} ${style.dim(`(${quote.currency})`)}`,
    ...lineRows.flatMap((row) =>
      row.detail ? [render(row), `      ${style.dim(row.detail)}`] : [render(row)],
    ),
    style.dim(`  ${'─'.repeat(labelWidth + amountWidth + 2)}`),
    ...totalRows.slice(0, 2).map((row) => style.dim(render(row))),
    render(totalRows[2]!),
  ];
  return lines.join('\n');
}

// ─── Questions ───────────────────────────────────────────────────────────────

function parameterSpec(question: ParameterQuestion): string {
  const bits = [
    question.key,
    question.type,
    question.required ? 'required' : 'optional',
  ];
  if (question.min !== undefined) bits.push(`min ${question.min}`);
  if (question.max !== undefined) bits.push(`max ${question.max}`);
  if (question.pattern !== undefined) bits.push(`pattern ${question.pattern}`);
  if (question.default !== undefined) bits.push(`default ${formatValue(question.default)}`);
  if (question.options?.length) {
    const options = question.options
      .map((option) => (option.label === option.value ? option.value : `${option.value} — ${option.label}`))
      .join(', ');
    bits.push(question.type === 'multiselect' ? `any of: ${options}` : `one of: ${options}`);
  }
  return bits.join(' · ');
}

function choiceSpec(question: ChoiceQuestion): string {
  const range =
    question.maxSelections !== undefined
      ? `pick ${question.minSelections}–${question.maxSelections}`
      : `pick at least ${question.minSelections}`;
  return `${question.key} · ${question.mode} · ${range}`;
}

export function formatQuestion(
  question: ParameterQuestion | ChoiceQuestion | { kind: 'date'; key: 'date'; label: string; required: boolean; minNoticeHours?: number },
  style: Style,
): string {
  const lines = [`  ${style.bold(`? ${question.label}`)}`];
  if (question.kind === 'parameter') {
    lines.push(`    ${style.dim(parameterSpec(question))}`);
    if (question.description) lines.push(`    ${style.dim(question.description)}`);
  } else if (question.kind === 'choice') {
    lines.push(`    ${style.dim(choiceSpec(question))}`);
    if (question.description) lines.push(`    ${style.dim(question.description)}`);
    for (const option of question.options) {
      const hint = option.priceHint ? ` ${style.dim(`(${option.priceHint})`)}` : '';
      const label = option.label === option.key ? option.key : `${option.key} — ${option.label}`;
      lines.push(`      - ${label}${hint}`);
      if (option.description) lines.push(`        ${style.dim(option.description)}`);
    }
    if (question.requiredOption) {
      lines.push(`      ${style.yellow(`a rule requires: ${question.requiredOption}`)}`);
      if (question.message) lines.push(`        ${style.dim(question.message)}`);
    }
  } else {
    lines.push(`    ${style.dim('date · ' + (question.required ? 'required' : 'optional'))}`);
    if (question.minNoticeHours !== undefined) {
      lines.push(`    ${style.dim(`at least ${question.minNoticeHours}h notice`)}`);
    }
  }
  return lines.join('\n');
}

// ─── Results ─────────────────────────────────────────────────────────────────

const STATUS_COLOR: Partial<Record<ScopeResult['status'], keyof Omit<Style, 'dim' | 'cyan'>>> = {
  qualified: 'green',
  needs_input: 'yellow',
  blocked: 'red',
  invalid: 'red',
  unavailable: 'red',
};

function formatSummary(summary: {
  answers: Record<string, Value>;
  selections: Record<string, string[]>;
  date?: string;
}): string {
  const parts = Object.entries(summary.answers).map(([key, value]) => `${key}=${formatValue(value)}`);
  for (const [key, value] of Object.entries(summary.selections)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  if (summary.date !== undefined) parts.push(`date=${summary.date}`);
  return parts.join(', ');
}

export function formatResult(result: ScopeResult, money: Money, style: Style): string {
  const color = STATUS_COLOR[result.status] ?? 'cyan';
  const lines = [`status: ${style[color](style.bold(result.status))}`];
  switch (result.status) {
    case 'qualified': {
      const request = formatSummary(result.summary);
      if (request) lines.push(`  ${style.dim(`request: ${request}`)}`);
      lines.push(formatQuote(result.quote, money, style));
      for (const group of result.addOns ?? []) {
        const options = group.options.map((option) => (option.priceHint !== undefined ? `${option.key} (${option.priceHint})` : option.key));
        lines.push(`  ${style.dim(`add-on ${group.key} [${group.mode}]: ${options.join(', ')}`)}`);
      }
      break;
    }
    case 'needs_input':
      lines.push(formatQuestion(result.question, style));
      break;
    case 'blocked':
      for (const reason of result.reasons) {
        const rule = reason.ruleId ? ` [${reason.ruleId}]` : '';
        lines.push(`  ${style.red(`${reason.code}${rule}`)}: ${reason.message}`);
      }
      break;
    case 'invalid':
      for (const error of result.errors) {
        lines.push(`  ${style.red(`${error.field}: ${error.code}`)} — ${error.message}`);
      }
      break;
    case 'unavailable':
      lines.push(`  ${style.red(result.code)} — ${result.message}`);
      break;
  }
  return lines.join('\n');
}

/** One compact line describing the outcome — used under failed scenarios. */
export function summarizeResult(result: ScopeResult, money: Money): string {
  switch (result.status) {
    case 'qualified':
      return `result: qualified — total ${money(result.quote.totalCents, result.quote.currency)}`;
    case 'needs_input':
      return `result: needs_input — asks '${result.question.key}' (${result.reason})`;
    case 'blocked':
      return `result: blocked — ${result.reasons.map((r) => `${r.code}: ${truncate(r.message, 60)}`).join('; ')}`;
    case 'invalid':
      return `result: invalid — ${result.errors.map((e) => `${e.field}: ${e.code}`).join('; ')}`;
    case 'unavailable':
      return `result: unavailable — ${result.code}: ${truncate(result.message, 60)}`;
  }
}

// ─── Trace (why) ─────────────────────────────────────────────────────────────

export function formatTrace(trace: Trace, money: Money, currency: string, style: Style): string {
  const lines: string[] = [style.cyan('why:')];
  const valueEntries = Object.entries(trace.values);
  if (valueEntries.length) {
    lines.push('  values used:');
    for (const [name, value] of valueEntries) {
      lines.push(`    ${name} = ${formatValue(value)}`);
    }
  }
  if (trace.rules.length) {
    lines.push('  rules:');
    for (const rule of trace.rules) {
      const bits = [
        `${rule.id} —`,
        `when=${rule.when}`,
        rule.fired ? 'fired' : 'not fired',
        `(${rule.effect})`,
      ];
      if (rule.unknownRefs.length) bits.push(`unknown: ${rule.unknownRefs.join(', ')}`);
      lines.push(`    ${bits.join(' ')}`);
    }
  }
  if (trace.pricing.length) {
    lines.push('  pricing:');
    for (const entry of trace.pricing) {
      const bits = [`${entry.id} (${entry.label}) —`, entry.applied ? 'applied' : 'skipped'];
      if (entry.amountCents !== undefined) bits.push(money(entry.amountCents, currency));
      if (entry.note) bits.push(style.dim(entry.note));
      lines.push(`    ${bits.join(' ')}`);
    }
  }
  if (trace.questionReason) lines.push(`  question reason: ${trace.questionReason}`);
  if (trace.pendingQuestions.length) {
    lines.push(`  still pending: ${trace.pendingQuestions.join(', ')}`);
  }
  if (trace.warnings.length) {
    lines.push('  warnings:');
    for (const warning of trace.warnings) lines.push(`    - ${warning}`);
  }
  return lines.join('\n');
}

// ─── Offering description ────────────────────────────────────────────────────

export function formatDescription(
  description: OfferingDescription,
  style: Style,
): string {
  const lines = [`${style.bold(description.name)} ${style.dim(`(${description.id} · ${description.kind})`)}`];
  if (description.category) lines.push(`  category: ${description.category}`);
  if (description.description) lines.push(`  ${description.description}`);
  if (description.priceFrom) lines.push(`  ${style.dim('price from:')} ${description.priceFrom}`);
  const dateBits = [`date: ${description.date}`];
  if (description.minNoticeHours !== undefined) dateBits.push(`min notice ${description.minNoticeHours}h`);
  lines.push(`  ${style.dim(dateBits.join(' · '))}`);
  if (description.contains?.length) {
    lines.push('  contains:');
    for (const item of description.contains) {
      lines.push(`    ${item.quantity} × ${item.offering} — ${item.name}`);
    }
  }
  if (description.questions.length) {
    lines.push('  questions (ask order):');
    description.questions.forEach((question, index) => {
      lines.push(`    ${index + 1}. ${question.label}`);
      lines.push(`       ${style.dim(parameterSpec(question))}`);
    });
  }
  if (description.choices.length) {
    lines.push('  choices:');
    for (const choice of description.choices) {
      lines.push(`    ${style.bold(choice.label)}`);
      lines.push(`       ${style.dim(choiceSpec(choice))}`);
      if (choice.description) lines.push(`       ${style.dim(choice.description)}`);
      for (const option of choice.options) {
        const hint = option.priceHint ? ` ${style.dim(`(${option.priceHint})`)}` : '';
        const label = option.label === option.key ? option.key : `${option.key} — ${option.label}`;
        lines.push(`       - ${label}${hint}`);
      }
    }
  }
  return lines.join('\n');
}
