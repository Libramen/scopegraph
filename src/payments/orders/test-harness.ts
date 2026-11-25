/**
 * Test harness for the payments core (store + FakeGateway + OrderService with
 * a controllable clock, recording hooks and scriptable facts). Test-only.
 */
import type { Graph, Value } from '../../graph/types.js';
import type { ScopedRequest, StoredQuote, Order, PaymentsConfig } from '../types.js';
import { evaluate } from '../../engine/index.js';
import { baseLine, f, graph, offering, param, rule } from '../../engine/testing.js';
import { PaymentsStore, MemoryBackend } from '../store/index.js';
import { FakeGateway } from '../stripe/fake.js';
import type { ApprovalLinks } from '../approval/tokens.js';
import { createOrderService } from './service.js';
import type { DefaultOrderService } from './service.js';

export const START = new Date('2026-07-01T12:00:00.000Z');

export function testConfig(overrides: Partial<PaymentsConfig> = {}): PaymentsConfig {
  return {
    confirmation: 'owner_approves',
    approvalWindowHours: 24,
    quoteTtlMinutes: 30,
    publicUrl: 'https://book.example.com',
    stripe: { secretKey: 'sk_test_x', webhookSecret: 'whsec_test', profileId: 'profile_test', livemode: false },
    adminToken: 'a'.repeat(40),
    signingSecret: 's'.repeat(40),
    dataDir: '/nonexistent',
    mppEnabled: false,
    ...overrides,
  };
}

/** `lesson`: 7300¢ × participants, optional date, blocked when the `tide` fact is 'high'. */
export function lessonGraph(overrides: { priceCents?: number; timezone?: string } = {}): Graph {
  return graph(
    [
      offering('lesson', {
        name: 'Surf Lesson',
        date: 'optional',
        scope: {
          parameters: [param('participants', { type: 'integer', role: 'quantity', min: 1, max: 6 })],
          rules: [rule('lesson.tide', { kind: 'block', message: 'Unsafe tide.' }, { when: f('tide', 'eq', 'high') })],
          baseLines: [baseLine(overrides.priceCents ?? 7300, { label: 'Surf lesson', per: 'participants' })],
        },
      }),
      offering('sticker', {
        name: 'Sticker',
        scope: { baseLines: [baseLine(40, { label: 'Sticker' })] },
      }),
    ],
    {
      name: 'Kelp Point Surf School',
      timezone: overrides.timezone ?? 'America/Los_Angeles',
      facts: { tide: { name: 'tide', type: 'string', required: false } },
    },
  );
}

export interface HookCall {
  hook: 'onApprovalNeeded' | 'onPaid' | 'onClosed';
  order: Order;
  links?: ApprovalLinks;
}

export interface Harness {
  store: PaymentsStore;
  backend: MemoryBackend;
  gateway: FakeGateway;
  service: DefaultOrderService;
  config: PaymentsConfig;
  clock: { now: Date; advance(ms: number): Date };
  facts: Record<string, Value>;
  hookCalls: HookCall[];
  /** Hooks throw while > 0 (decremented per failing call). */
  failHooks: { remaining: number };
  /** While true, hook calls never settle (a hung email/CRM API). */
  hangHooks: { on: boolean };
  logs: string[];
  graph: { current: Graph };
  /** Evaluate + store a payable quote for `lesson` (participants default 2 → 14600¢). */
  quote(request?: Partial<ScopedRequest>, offeringId?: string): Promise<StoredQuote>;
  /** Re-open the same backend (process restart): new store, service, same gateway + clock. */
  restart(): Promise<Harness>;
}

export async function makeHarness(options: {
  config?: Partial<PaymentsConfig>;
  graph?: Graph;
  backend?: MemoryBackend;
  gateway?: FakeGateway;
  clock?: Harness['clock'];
  facts?: Record<string, Value>;
  hookCalls?: HookCall[];
  hookTimeoutMs?: number;
} = {}): Promise<Harness> {
  const backend = options.backend ?? new MemoryBackend();
  const store = await PaymentsStore.memory(backend);
  const gateway = options.gateway ?? new FakeGateway();
  const config = testConfig(options.config);
  const clock = options.clock ?? {
    now: new Date(START),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
      return this.now;
    },
  };
  const facts: Record<string, Value> = options.facts ?? {};
  const hookCalls: HookCall[] = options.hookCalls ?? [];
  const failHooks = { remaining: 0 };
  const hangHooks = { on: false };
  const logs: string[] = [];
  const graphRef = { current: options.graph ?? lessonGraph() };
  const record = async (call: HookCall): Promise<void> => {
    if (hangHooks.on) return new Promise<void>(() => undefined);
    if (failHooks.remaining > 0) {
      failHooks.remaining -= 1;
      throw new Error('hook endpoint down');
    }
    hookCalls.push(call);
  };
  const service = createOrderService({
    store,
    gateway,
    config,
    getGraph: () => graphRef.current,
    now: () => new Date(clock.now),
    getFacts: async () => ({ ...facts }),
    log: (line) => logs.push(line),
    ...(options.hookTimeoutMs !== undefined ? { hookTimeoutMs: options.hookTimeoutMs } : {}),
    hooks: {
      onApprovalNeeded: (order, links) => record({ hook: 'onApprovalNeeded', order, links }),
      onPaid: (order) => record({ hook: 'onPaid', order }),
      onClosed: (order) => record({ hook: 'onClosed', order }),
    },
  });
  const harness: Harness = {
    store,
    backend,
    gateway,
    service,
    config,
    clock,
    facts,
    hookCalls,
    failHooks,
    hangHooks,
    logs,
    graph: graphRef,
    async quote(request = {}, offeringId = 'lesson') {
      const answers = request.answers ?? (offeringId === 'lesson' ? { participants: 2 } : {});
      const result = evaluate(
        graphRef.current,
        { offering: offeringId, answers, ...(request.date !== undefined ? { date: request.date } : {}), facts: { ...facts } },
        { now: new Date(clock.now), trace: false },
      );
      if (result.status !== 'qualified') throw new Error(`fixture request did not qualify: ${result.status}`);
      const stored = await service.createQuote(offeringId, result.summary, result.quote);
      if (stored === undefined) throw new Error('fixture quote not payable');
      return stored;
    },
    async restart() {
      return makeHarness({
        config: options.config ?? {},
        graph: graphRef.current,
        backend,
        gateway,
        clock,
        facts,
        hookCalls,
      });
    },
  };
  return harness;
}
