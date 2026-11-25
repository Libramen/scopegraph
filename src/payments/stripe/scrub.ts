/**
 * Removes Stripe credentials (shared payment tokens, payment methods, card
 * tokens, API and ephemeral keys, webhook secrets, PaymentIntent client
 * secrets) and account-identifying ids (accounts, customers, profiles) from
 * text before it is stored, logged or returned. Run any external error text
 * through it first.
 * PaymentIntent ids (`pi_…`) are not sensitive and are left as they are; a
 * client secret (`pi_…_secret_…`) keeps its id and loses the secret.
 */
const STRIPE_SECRETS =
  /(pi_[A-Za-z0-9]+)_secret_[A-Za-z0-9]+|(spt|pm|seti|src|whsec|we|acct|tok|cus)_[A-Za-z0-9_]+|(sk|rk|ek)_(?:test|live)_[A-Za-z0-9_]+|(profile)_[A-Za-z0-9_]{16,}/g;

export function redactStripeSecrets(input: string | undefined | null): string | undefined {
  if (!input) return input ?? undefined;
  return input.replace(
    STRIPE_SECRETS,
    (_match, intent: string | undefined, token: string | undefined, key: string | undefined, profile: string | undefined) =>
      intent !== undefined ? `${intent}_secret_[REDACTED]` : `${token ?? key ?? profile}_[REDACTED]`,
  );
}
