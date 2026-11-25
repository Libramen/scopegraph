/**
 * Default qualified hook: handoff URL templating (encoded placeholders,
 * `{params}` never repeats a name the template's own query sets).
 */
import { describe, expect, it } from 'vitest';
import type { Business } from '../graph/types.js';
import type { Qualified } from '../engine/types.js';
import { fillHandoffUrl } from './onQualified.js';

const business: Business = {
  name: 'Surf & Turf? #1',
  currency: 'USD',
  timezone: 'UTC',
  facts: {},
  seasons: [],
  disclosure: 'progressive',
  payments: { confirmation: 'owner_approves', approvalWindowHours: 24, quoteTtlMinutes: 60 },
};

const result: Qualified = {
  status: 'qualified',
  offering: 'surf-lesson',
  quote: { currency: 'USD', lines: [], subtotalCents: 14600, taxCents: 0, totalCents: 14600 },
  summary: {
    // Catalog parameters that happen to share the template's query names; the
    // buyer controls their values.
    answers: { total: '0.01', currency: 'XXX', participants: 2 },
    selections: { offering: ['free'], extras: ['wax', 'leash'] },
    date: '2027-01-09',
  },
};

const fill = (template: string): string =>
  fillHandoffUrl(template, result, { business, request: { offering: 'surf-lesson' } });

describe('fillHandoffUrl', () => {
  it('{params} never repeats a query name the template already sets', () => {
    const url = new URL(fill('https://book.example.com/start?offering={offering}&total={total}&currency={currency}&{params}'));
    expect(url.searchParams.getAll('total')).toEqual(['146.00']);
    expect(url.searchParams.getAll('currency')).toEqual(['USD']);
    expect(url.searchParams.getAll('offering')).toEqual(['surf-lesson']);
    expect(url.searchParams.get('participants')).toBe('2');
    expect(url.searchParams.get('extras')).toBe('wax,leash');
    expect(url.searchParams.get('date')).toBe('2027-01-09');
  });

  it('{business} and {offering} are URL-encoded (no query/fragment injection)', () => {
    const url = new URL(fill('https://book.example.com/{offering}?shop={business}&amount={total_cents}'));
    expect(url.pathname).toBe('/surf-lesson');
    expect([...url.searchParams.keys()]).toEqual(['shop', 'amount']);
    expect(url.searchParams.get('shop')).toBe('Surf & Turf? #1');
    expect(url.searchParams.get('amount')).toBe('14600');
    expect(url.hash).toBe('');
  });

  it('without a templated query, {params} carries every answer', () => {
    const url = new URL(fill('https://book.example.com/{offering}/{params}'));
    expect(url.pathname).toBe('/surf-lesson/total=0.01&currency=XXX&participants=2&offering=free&extras=wax%2Cleash&date=2027-01-09');
  });
});
