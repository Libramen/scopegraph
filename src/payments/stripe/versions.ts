/**
 * Stripe API version sent on every Shared Payment Token call (PaymentIntent
 * create with `payment_method_data[shared_payment_granted_token]`). SPTs are a
 * preview feature: this pins the preview version Stripe's seller SPT docs use.
 * Source: https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens.md?agent-seller=seller
 * (examples send `Stripe-Version: 2026-09-30.preview`). Verify against a
 * Stripe test-mode account before changing.
 *
 * Every other call uses the stripe SDK's pinned default version.
 */
export const STRIPE_SPT_API_VERSION = '2026-09-30.preview';
