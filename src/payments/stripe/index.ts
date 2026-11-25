/**
 * The Stripe gateway: the real SDK-backed implementation, the scriptable
 * fake for tests, error classification, and secret redaction for logs.
 */
export { StripeGateway, classifyStripeError } from './gateway.js';
export { FakeGateway } from './fake.js';
export type { FailMode, GatewayCall, GatewayMethod } from './fake.js';
export { redactStripeSecrets } from './scrub.js';
export { STRIPE_SPT_API_VERSION } from './versions.js';
