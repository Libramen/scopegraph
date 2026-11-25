import { describe, expect, it } from 'vitest';
import type { Quote, ScopeResult, Trace } from '../engine/types.js';
import {
  colorEnabled,
  createStyle,
  formatDescription,
  formatQuestion,
  formatQuote,
  formatResult,
  formatTrace,
  formatValue,
  summarizeResult,
} from './format.js';

const plain = createStyle(false);
const money = (cents: number, currency: string): string =>
  `${cents < 0 ? '-' : ''}${currency}$${Math.abs(cents / 100).toFixed(2)}`;

describe('style', () => {
  it('is identity when disabled and ANSI when enabled', () => {
    expect(plain.bold('x')).toBe('x');
    const styled = createStyle(true);
    expect(styled.red('x')).toBe('\x1b[31mx\x1b[0m');
    expect(styled.bold('x')).toBe('\x1b[1mx\x1b[0m');
  });

  it('colors only for a TTY with NO_COLOR unset', () => {
    const original = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      expect(colorEnabled({ isTTY: true })).toBe(true);
      expect(colorEnabled({ isTTY: false })).toBe(false);
      expect(colorEnabled(undefined)).toBe(false);
      process.env.NO_COLOR = '1';
      expect(colorEnabled({ isTTY: true })).toBe(false);
    } finally {
      if (original === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = original;
    }
  });
});

describe('formatQuote', () => {
  const quote: Quote = {
    currency: 'USD',
    lines: [
      {
        id: 'tour.base',
        label: 'Guided tour',
        kind: 'base',
        amountCents: 85000,
        quantity: 10,
        unitAmountCents: 8500,
        taxable: true,
        source: { offering: 'tour' },
      },
      {
        id: 'tour.extras.linen.price',
        label: 'Linen service',
        kind: 'addon',
        amountCents: 1500,
        taxable: true,
        source: { offering: 'tour', option: 'extras.linen' },
      },
      {
        id: 'tour.discount',
        label: 'Group discount',
        kind: 'discount',
        amountCents: -1500,
        taxable: true,
        reason: '10+ guests',
        source: { offering: 'tour', adjustment: 'tour.discount' },
      },
    ],
    subtotalCents: 85000,
    taxCents: 7225,
    totalCents: 92225,
  };

  it('renders lines with unit detail, discounts and totals', () => {
    const text = formatQuote(quote, money, plain);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Quote (USD)');
    expect(lines[1]).toContain('Guided tour');
    expect(lines[1]).toContain('$850.00');
    expect(lines[2]).toContain('10 × USD$85.00');
    expect(lines[3]).toContain('Linen service');
    expect(lines[3]).toContain('$15.00');
    expect(lines[4]).toContain('Group discount');
    expect(lines[4]).toContain('-USD$15.00');
    expect(lines[5]).toContain('10+ guests');
    expect(text).toContain('Subtotal');
    expect(text).toContain('$850.00');
    expect(text).toContain('Tax');
    expect(text).toContain('$72.25');
    expect(text).toContain('Total');
    expect(text).toContain('$922.25');
  });

  it('amounts align in a column', () => {
    const lines = formatQuote(quote, money, plain).split('\n');
    const lineAmount = lines[1]!.indexOf('$850.00');
    const totalAmount = lines.at(-1)!.indexOf('$922.25');
    expect(lineAmount).toBe(totalAmount);
  });
});

describe('formatQuestion', () => {
  it('renders parameter questions with spec and options', () => {
    const text = formatQuestion(
      {
        kind: 'parameter',
        key: 'participants',
        label: 'How many participants?',
        type: 'number',
        required: true,
        min: 1,
        max: 20,
      },
      plain,
    );
    expect(text).toContain('? How many participants?');
    expect(text).toContain('participants · number · required · min 1 · max 20');
  });

  it('renders choice questions with options, price hints and rule requirement', () => {
    const text = formatQuestion(
      {
        kind: 'choice',
        key: 'extras',
        label: 'Extras?',
        mode: 'multi',
        minSelections: 0,
        maxSelections: 3,
        options: [
          { key: 'linen', label: 'Linen service', priceHint: '+$15.00' },
          { key: 'towels', label: 'Towels' },
        ],
        requiredOption: 'linen',
        message: 'Groups over 10 need linen',
      },
      plain,
    );
    expect(text).toContain('extras · multi · pick 0–3');
    expect(text).toContain('- linen — Linen service (+$15.00)');
    expect(text).toContain('a rule requires: linen');
    expect(text).toContain('Groups over 10 need linen');
  });

  it('renders date questions with notice', () => {
    const text = formatQuestion(
      { kind: 'date', key: 'date', label: 'When?', required: true, minNoticeHours: 48 },
      plain,
    );
    expect(text).toContain('? When?');
    expect(text).toContain('date · required');
    expect(text).toContain('at least 48h notice');
  });
});

describe('formatResult', () => {
  it('renders blocked reasons with codes and rule ids', () => {
    const result: ScopeResult = {
      status: 'blocked',
      offering: 'tour',
      reasons: [
        { code: 'RULE', message: 'Not available with linen', ruleId: 'tour.rule1' },
        { code: 'DATE_TOO_SOON', message: 'Not enough notice' },
      ],
    };
    const text = formatResult(result, money, plain);
    expect(text).toContain('status: blocked');
    expect(text).toContain('RULE [tour.rule1]: Not available with linen');
    expect(text).toContain('DATE_TOO_SOON: Not enough notice');
  });

  it('renders invalid errors with field and code', () => {
    const result: ScopeResult = {
      status: 'invalid',
      offering: 'tour',
      errors: [{ field: 'answers.participants', code: 'INVALID_VALUE', message: 'must be ≤ 20' }],
    };
    expect(formatResult(result, money, plain)).toContain(
      'answers.participants: INVALID_VALUE — must be ≤ 20',
    );
  });

  it('renders unavailable with code and message', () => {
    const result: ScopeResult = {
      status: 'unavailable',
      offering: 'ghost',
      code: 'NOT_ACTIVE',
      message: 'this offering is paused',
    };
    const text = formatResult(result, money, plain);
    expect(text).toContain('status: unavailable');
    expect(text).toContain('NOT_ACTIVE — this offering is paused');
  });

  it('renders qualified with the request summary and quote', () => {
    const result: ScopeResult = {
      status: 'qualified',
      offering: 'tour',
      quote: {
        currency: 'USD',
        lines: [
          {
            id: 'tour.base',
            label: 'Guided tour',
            kind: 'base',
            amountCents: 85000,
            taxable: true,
            source: { offering: 'tour' },
          },
        ],
        subtotalCents: 85000,
        taxCents: 0,
        totalCents: 85000,
      },
      summary: {
        answers: { participants: 10, vip: true },
        selections: { extras: ['linen', 'towels'] },
        date: '2026-07-04',
      },
    };
    const text = formatResult(result, money, plain);
    expect(text).toContain('status: qualified');
    expect(text).toContain('request: participants=10, vip=true, extras=[linen, towels], date=2026-07-04');
    expect(text).toContain('$850.00');
  });
});

describe('formatTrace', () => {
  it('renders values, rules, pricing, question reason, pending and warnings', () => {
    const trace: Trace = {
      values: { participants: 10, isPeak: true, extras: ['linen'] },
      questionReason: 'required',
      pendingQuestions: ['date', 'extras'],
      rules: [
        {
          id: 'tour.rule1',
          offering: 'tour',
          effect: 'block',
          when: 'TRUE',
          fired: true,
          unknownRefs: [],
        },
        {
          id: 'tour.rule2',
          offering: 'tour',
          effect: 'require',
          when: 'UNKNOWN',
          fired: false,
          unknownRefs: ['participants'],
        },
      ],
      pricing: [
        { id: 'tour.base', label: 'Guided tour', when: 'TRUE', applied: true, amountCents: 85000 },
        { id: 'tour.discount', label: 'Discount', when: 'FALSE', applied: false, note: 'not peak' },
      ],
      warnings: ['undeclared fact'],
    };
    const text = formatTrace(trace, money, 'USD', plain);
    expect(text).toContain('why:');
    expect(text).toContain('participants = 10');
    expect(text).toContain('isPeak = true');
    expect(text).toContain('extras = [linen]');
    expect(text).toContain('tour.rule1 — when=TRUE fired (block)');
    expect(text).toContain('tour.rule2 — when=UNKNOWN not fired (require) unknown: participants');
    expect(text).toContain('tour.base (Guided tour) — applied USD$850.00');
    expect(text).toContain('tour.discount (Discount) — skipped not peak');
    expect(text).toContain('question reason: required');
    expect(text).toContain('still pending: date, extras');
    expect(text).toContain('- undeclared fact');
  });
});

describe('summarizeResult', () => {
  it('compresses each status to one line', () => {
    expect(
      summarizeResult(
        {
          status: 'needs_input',
          offering: 'tour',
          question: {
            kind: 'parameter',
            key: 'participants',
            label: 'Participants?',
            type: 'number',
            required: true,
          },
          reason: 'required',
        },
        money,
      ),
    ).toBe("result: needs_input — asks 'participants' (required)");
    expect(
      summarizeResult(
        {
          status: 'blocked',
          offering: 'tour',
          reasons: [{ code: 'RULE', message: 'no linen', ruleId: 'tour.r1' }],
        },
        money,
      ),
    ).toBe('result: blocked — RULE: no linen');
  });
});

describe('formatDescription', () => {
  it('renders name, date policy, questions and choices', () => {
    const text = formatDescription(
      {
        id: 'city-tour',
        kind: 'product',
        name: 'City Walking Tour',
        category: 'experiences',
        keywords: ['tour'],
        priceFrom: 'USD$85.00 per participant',
        currency: 'USD',
        timezone: 'America/Los_Angeles',
        date: 'required',
        minNoticeHours: 48,
        questions: [
          {
            kind: 'parameter',
            key: 'participants',
            label: 'How many participants?',
            type: 'number',
            required: true,
            min: 1,
            max: 20,
          },
        ],
        choices: [
          {
            kind: 'choice',
            key: 'extras',
            label: 'Extras?',
            mode: 'multi',
            minSelections: 0,
            maxSelections: 2,
            options: [{ key: 'linen', label: 'Linen service', priceHint: '+$15.00' }],
          },
        ],
      },
      plain,
    );
    expect(text).toContain('City Walking Tour (city-tour · product)');
    expect(text).toContain('category: experiences');
    expect(text).toContain('price from: USD$85.00 per participant');
    expect(text).toContain('date: required · min notice 48h');
    expect(text).toContain('questions (ask order):');
    expect(text).toContain('1. How many participants?');
    expect(text).toContain('participants · number · required · min 1 · max 20');
    expect(text).toContain('- linen — Linen service (+$15.00)');
  });
});

describe('formatValue', () => {
  it('formats scalars and lists', () => {
    expect(formatValue(10)).toBe('10');
    expect(formatValue(true)).toBe('true');
    expect(formatValue('a')).toBe('a');
    expect(formatValue(['a', 'b'])).toBe('[a, b]');
  });
});
