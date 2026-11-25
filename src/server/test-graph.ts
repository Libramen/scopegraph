/**
 * Minimal fixture graphs for server tests, written out inline and shaped
 * exactly per `src/graph/types.ts`.
 *
 * `surf-lesson`: one required integer parameter (`participants`, 1–6), one
 * optional single-choice group (`board`), base price 7300¢ per participant,
 * epoxy board +1500¢. Drives needs_input → qualified through the whole
 * pipeline including the hand-off URL template.
 *
 * `dawn-patrol`: no questions, but the business declares a required fact —
 * with the default `getFacts` (returns {}) it must fail closed as
 * FACTS_UNAVAILABLE, proving caller-supplied facts never get through.
 */
import type { Business, Graph, Offering } from '../graph/types.js';

const surfBusiness: Business = {
  name: 'Kelp Point Surf School',
  description: 'Surf lessons on a quiet point break.',
  website: 'https://kelppoint.example',
  currency: 'USD',
  timezone: 'America/Halifax',
  facts: {},
  seasons: [],
  disclosure: 'progressive',
  payments: { confirmation: 'owner_approves', approvalWindowHours: 24, quoteTtlMinutes: 30 },
  handoff: {
    url: 'https://bookings.kelppoint.example/{offering}?amount={total_cents}&{params}',
    message: 'Reserve your lesson',
  },
};

const surfLesson: Offering = {
  id: 'surf-lesson',
  kind: 'product',
  name: 'Surf Lesson',
  description: 'Ninety minutes in the white water with a coach.',
  keywords: ['surf', 'lesson'],
  status: 'active',
  bookable: true,
  contains: [],
  date: 'none',
  scope: {
    parameters: [
      {
        name: 'participants',
        label: 'Participants',
        type: 'integer',
        required: true,
        min: 1,
        max: 6,
        internal: false,
        ownerOfferingId: 'surf-lesson',
      },
    ],
    optionGroups: [
      {
        key: 'board',
        label: 'Board',
        mode: 'single',
        required: false,
        minSelections: 0,
        options: [
          {
            id: 'board.softtop',
            key: 'softtop',
            groupKey: 'board',
            label: 'Soft-top board',
            adjustments: [],
          },
          {
            id: 'board.epoxy',
            key: 'epoxy',
            groupKey: 'board',
            label: 'Epoxy board',
            adjustments: [
              {
                id: 'surf-lesson.board.epoxy.price',
                label: 'Epoxy board upgrade',
                kind: 'addon',
                method: { type: 'fixed', amountCents: 1500 },
                taxable: true,
                order: 100,
                ownerOfferingId: 'surf-lesson',
                ownerOptionId: 'board.epoxy',
              },
            ],
          },
        ],
      },
    ],
    rules: [],
    adjustments: [],
    baseLines: [
      {
        offeringId: 'surf-lesson',
        label: 'Surf lesson',
        amountCents: 7300,
        per: 'participants',
        quantity: 1,
        taxable: true,
      },
    ],
    inactiveContents: [],
  },
};

export function buildTestGraph(): Graph {
  return { business: surfBusiness, offerings: { 'surf-lesson': surfLesson } };
}

export function buildFactsGraph(): Graph {
  const business: Business = {
    ...surfBusiness,
    name: 'Dawn Patrol Co',
    facts: {
      vip_open: { name: 'vip_open', type: 'boolean', required: true },
    },
    handoff: undefined,
  };
  const dawnPatrol: Offering = {
    id: 'dawn-patrol',
    kind: 'product',
    name: 'Dawn Patrol Session',
    description: 'First-light session, members only.',
    keywords: [],
    status: 'active',
    bookable: true,
    contains: [],
    date: 'none',
    scope: {
      parameters: [],
      optionGroups: [],
      rules: [],
      adjustments: [],
      baseLines: [
        {
          offeringId: 'dawn-patrol',
          label: 'Dawn patrol session',
          amountCents: 10_000,
          quantity: 1,
          taxable: true,
        },
      ],
      inactiveContents: [],
    },
  };
  return { business, offerings: { 'dawn-patrol': dawnPatrol } };
}
