/**
 * `simulate --interactive`: a readline loop that asks each question the
 * engine asks, accumulates answers/selections/date, and stops at the first
 * terminal status. Parsing helpers are exported (and unit-tested) so the
 * prompt grammar is exact: numbers must look like numbers, options are
 * accepted by key or label, booleans accept the usual yes/no spellings.
 */
import * as readline from 'node:readline/promises';
import type {
  ChoiceQuestion,
  Evaluate,
  ParameterQuestion,
  ScopeRequest,
} from '../engine/types.js';
import type { Graph, Value } from '../graph/types.js';
import { formatResult, formatTrace } from './format.js';
import type { Money, Style } from './format.js';

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

const TRUE_ANSWERS: Record<string, true> = { y: true, yes: true, true: true, t: true, '1': true };
const FALSE_ANSWERS: Record<string, true> = { n: true, no: true, false: true, f: true, '0': true };
const MAX_TURNS = 200;

function splitList(input: string): string[] {
  return input
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Parse one line of terminal input for a parameter question. */
export function parseAnswer(question: ParameterQuestion, raw: string): ParseOutcome<Value> {
  const input = raw.trim();
  switch (question.type) {
    case 'number': {
      if (/^-?\d+(\.\d+)?$/.test(input)) return { ok: true, value: Number(input) };
      return { ok: false, error: `expected a number, got '${input}'` };
    }
    case 'integer': {
      if (/^-?\d+$/.test(input)) return { ok: true, value: Number(input) };
      return { ok: false, error: `expected a whole number, got '${input}'` };
    }
    case 'boolean': {
      const lower = input.toLowerCase();
      if (TRUE_ANSWERS[lower]) return { ok: true, value: true };
      if (FALSE_ANSWERS[lower]) return { ok: true, value: false };
      return { ok: false, error: `expected yes/no, got '${input}'` };
    }
    case 'select':
    case 'multiselect': {
      const options = question.options ?? [];
      const keys = options.map((option) => option.value).join(', ');
      const parts = question.type === 'multiselect' ? splitList(input) : [input];
      if (parts[0] === '') return { ok: true, value: [] };
      const values: string[] = [];
      for (const part of parts) {
        const option =
          options.find((candidate) => candidate.value === part) ??
          options.find((candidate) => candidate.label === part);
        if (!option) return { ok: false, error: `unknown option '${part}' — choose one of: ${keys}` };
        if (!values.includes(option.value)) values.push(option.value);
      }
      return { ok: true, value: question.type === 'multiselect' ? values : values[0]! };
    }
    default:
      return { ok: true, value: input };
  }
}

/** Parse one line of terminal input for a choice (option group) question. */
export function parseSelection(question: ChoiceQuestion, raw: string): ParseOutcome<string[]> {
  const parts = splitList(raw);
  if (parts.length === 0) return { ok: true, value: [] };
  const keys: string[] = [];
  for (const part of parts) {
    const option =
      question.options.find((candidate) => candidate.key === part) ??
      question.options.find((candidate) => candidate.label === part);
    if (!option) {
      const valid = question.options.map((candidate) => candidate.key).join(', ');
      return { ok: false, error: `unknown option '${part}' — choose from: ${valid}` };
    }
    if (!keys.includes(option.key)) keys.push(option.key);
  }
  if (question.mode === 'single' && keys.length > 1) {
    return { ok: false, error: 'pick exactly one option' };
  }
  if (question.maxSelections !== undefined && keys.length > question.maxSelections) {
    return { ok: false, error: `pick at most ${question.maxSelections} options` };
  }
  return { ok: true, value: keys };
}

export interface InteractiveOptions {
  graph: Graph;
  evaluate: Evaluate;
  /** Initial request (from --answers/--selections/--date/--facts flags). */
  request: ScopeRequest;
  now?: Date;
  explain?: boolean;
  money: Money;
  style: Style;
  /** Business currency, for the --explain trace amounts. */
  currency: string;
}

/**
 * Ask questions until a terminal status; returns the process exit code
 * (0 = qualified, 1 = blocked/invalid/unavailable or gave up).
 */
export async function runInteractive(options: InteractiveOptions): Promise<number> {
  const { graph, evaluate, money, style } = options;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const write = (text: string) => process.stdout.write(`${text}\n`);
  let request: ScopeRequest = options.request;
  const skipped = new Set<string>();
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const result = evaluate(graph, request, { now: options.now, trace: true });
      if (result.status !== 'needs_input') {
        write(formatResult(result, money, style));
        if (options.explain && result.trace) {
          write(formatTrace(result.trace, money, options.currency, style));
        }
        return result.status === 'qualified' ? 0 : 1;
      }
      const question = result.question;
      write(formatResult(result, money, style));
      const answer = (await rl.question(style.bold('> '))).trim();
      if (answer === '') {
        const required = question.kind === 'choice' ? question.minSelections > 0 : question.required;
        if (required) {
          write(style.yellow('this one is required — please answer it'));
          continue;
        }
        if (skipped.has(question.key)) {
          write(
            style.yellow(
              `'${question.key}' is still needed to decide; answer it or rerun with flags`,
            ),
          );
          return 1;
        }
        skipped.add(question.key);
        write(style.dim(`('${question.key}' left blank)`) );
        continue;
      }
      if (question.kind === 'parameter') {
        const parsed = parseAnswer(question, answer);
        if (!parsed.ok) {
          write(style.red(parsed.error));
          continue;
        }
        request = {
          ...request,
          answers: { ...request.answers, [question.key]: parsed.value },
        };
      } else if (question.kind === 'choice') {
        const parsed = parseSelection(question, answer);
        if (!parsed.ok) {
          write(style.red(parsed.error));
          continue;
        }
        const selections: Record<string, string | string[]> = {
          ...(request.selections ?? {}),
          [question.key]: question.mode === 'single' ? parsed.value[0]! : parsed.value,
        };
        request = { ...request, selections };
      } else {
        request = { ...request, date: answer };
      }
    }
    write(style.red(`gave up after ${MAX_TURNS} questions — this looks like a loop`));
    return 1;
  } finally {
    rl.close();
  }
}
