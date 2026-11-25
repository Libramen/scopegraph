/**
 * Payments configuration from the environment + `business.payments`.
 *
 *   undefined          STRIPE_SECRET_KEY unset → payments disabled (the default)
 *   { error }          enabled but misconfigured → the server must refuse to boot
 *   PaymentsConfig     enabled and valid
 *
 * Warnings (non-fatal) go to `warn` (default stderr).
 */
import * as path from 'node:path';
import type { Business } from '../graph/types.js';
import { isTwoDecimalCurrency, unsupportedCurrencyMessage } from '../pricing/currency.js';
import type { PaymentsConfig } from './types.js';

/**
 * Stripe's minimum charge per (two-decimal) currency, in minor units.
 * Source: https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts
 * (minimums apply in the settlement currency; a charge converted to another
 * settlement currency must meet that currency's minimum after conversion, which
 * Stripe enforces with a definitive refusal). Unlisted currencies: 50.
 */
const MIN_CHARGE_MINOR_UNITS: Record<string, number> = {
  USD: 50, AED: 200, ARS: 50, AUD: 50, BRL: 50, CAD: 50, CHF: 50, COP: 50, CZK: 1500, DKK: 250,
  EUR: 50, GBP: 30, HKD: 400, HUF: 17500, IDR: 50, ILS: 50, INR: 50, MXN: 1000, MYR: 200, NOK: 300,
  NZD: 50, PHP: 50, PLN: 200, RON: 200, RUB: 50, SEK: 300, SGD: 50, THB: 1000, ZAR: 50,
};
const DEFAULT_MIN_CHARGE_MINOR_UNITS = 50;

export function minimumChargeMinorUnits(currency: string): number {
  return MIN_CHARGE_MINOR_UNITS[currency.toUpperCase()] ?? DEFAULT_MIN_CHARGE_MINOR_UNITS;
}

/**
 * `--watch` guard: the payments config (currency checks, confirmation mode,
 * windows, URLs) is validated and frozen at boot, so a reload that changes the
 * currency or the `payments` block must not take effect. Returns a reason to
 * refuse the reload, or undefined when it is safe.
 */
export function paymentsReloadConflict(boot: Business, next: Business): string | undefined {
  const changed: string[] = [];
  if (boot.currency.toUpperCase() !== next.currency.toUpperCase()) changed.push(`currency ${boot.currency} → ${next.currency}`);
  const keys = ['confirmation', 'approvalWindowHours', 'quoteTtlMinutes', 'successUrl', 'cancelUrl'] as const;
  for (const key of keys) {
    if (boot.payments[key] !== next.payments[key]) changed.push(`payments.${key} ${String(boot.payments[key])} → ${String(next.payments[key])}`);
  }
  if (changed.length === 0) return undefined;
  return `business.yaml payment settings changed (${changed.join(', ')}); payments only pick these up on restart`;
}

const MIN_SECRET_LENGTH = 32;
/** Characters a Stripe webhook signing secret must carry after `whsec_`. */
const MIN_WEBHOOK_SECRET_BODY = 16;
const LOCAL_HOSTS: Record<string, true> = { localhost: true, '127.0.0.1': true, '[::1]': true };

export function loadPaymentsConfig(
  env: Record<string, string | undefined>,
  business: Business,
  warn: (message: string) => void = (message) => console.error(`scopegraph: ${message}`),
): PaymentsConfig | undefined | { error: string } {
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  };

  const secretKey = read('STRIPE_SECRET_KEY');
  if (secretKey === undefined) return undefined;

  const problems: string[] = [];
  const keyMode = /^(?:sk|rk)_(test|live)_/.exec(secretKey)?.[1];
  if (keyMode === undefined) {
    problems.push('STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_test_…, sk_live_…, rk_test_…, rk_live_…).');
  }

  const webhookSecret = read('STRIPE_WEBHOOK_SECRET');
  if (webhookSecret === undefined) {
    problems.push('STRIPE_WEBHOOK_SECRET is required (whsec_… from your Stripe webhook endpoint for PUBLIC_URL/webhooks/stripe).');
  } else if (!webhookSecret.startsWith('whsec_') || webhookSecret.length < 'whsec_'.length + MIN_WEBHOOK_SECRET_BODY) {
    problems.push(`STRIPE_WEBHOOK_SECRET must be whsec_ followed by at least ${String(MIN_WEBHOOK_SECRET_BODY)} characters (copy it from your Stripe webhook endpoint).`);
  }

  let publicUrl: string | undefined;
  const rawPublicUrl = read('PUBLIC_URL');
  if (rawPublicUrl === undefined) {
    problems.push('PUBLIC_URL is required (the https base URL buyers and Stripe reach this server at, e.g. https://book.example.com).');
  } else {
    let url: URL | undefined;
    try {
      url = new URL(rawPublicUrl);
    } catch {
      problems.push(`PUBLIC_URL is not a valid URL: ${rawPublicUrl}`);
    }
    if (url !== undefined) {
      if (url.search !== '' || url.hash !== '') {
        problems.push('PUBLIC_URL must not contain a query string or fragment.');
      } else if (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS[url.hostname] === true)) {
        publicUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, '');
        if (keyMode === 'live' && (LOCAL_HOSTS[url.hostname] === true || /^127\./.test(url.hostname))) {
          problems.push('PUBLIC_URL must not be a loopback address with a live Stripe key: buyers, Stripe and approval links could never reach it.');
        }
      } else {
        problems.push('PUBLIC_URL must use https (plain http is only allowed for localhost).');
      }
    }
  }

  const adminToken = read('ADMIN_TOKEN');
  if (adminToken === undefined || adminToken.length < MIN_SECRET_LENGTH) {
    problems.push(`ADMIN_TOKEN is required and must be at least ${String(MIN_SECRET_LENGTH)} characters (e.g. \`openssl rand -hex 32\`).`);
  }

  const signingSecret = read('ORDER_SIGNING_SECRET');
  if (signingSecret === undefined || Buffer.byteLength(signingSecret, 'utf8') < MIN_SECRET_LENGTH) {
    problems.push(`ORDER_SIGNING_SECRET is required and must be at least ${String(MIN_SECRET_LENGTH)} bytes (e.g. \`openssl rand -hex 32\`).`);
  } else if (signingSecret === adminToken) {
    problems.push('ORDER_SIGNING_SECRET must differ from ADMIN_TOKEN (generate each with `openssl rand -hex 32`).');
  }

  const currency = business.currency.toUpperCase();
  if (!isTwoDecimalCurrency(currency)) {
    problems.push(`${unsupportedCurrencyMessage(currency)}.`);
  }

  const settings = business.payments;
  if (!Number.isInteger(settings.approvalWindowHours) || settings.approvalWindowHours < 1 || settings.approvalWindowHours > 96) {
    problems.push('business.yaml payments.approvalWindowHours must be an integer from 1 to 96.');
  }
  if (!Number.isInteger(settings.quoteTtlMinutes) || settings.quoteTtlMinutes < 30 || settings.quoteTtlMinutes > 240) {
    problems.push('business.yaml payments.quoteTtlMinutes must be an integer from 30 to 240.');
  }

  const profileId = read('STRIPE_PROFILE_ID');

  let acp: PaymentsConfig['acp'];
  const bearer = read('ACP_BEARER_TOKENS');
  if (bearer !== undefined) {
    const bearerTokens = bearer.split(',').map((t) => t.trim()).filter((t) => t !== '');
    const webhookUrl = read('ACP_WEBHOOK_URL');
    const acpWebhookSecret = read('ACP_WEBHOOK_SECRET');
    if (bearerTokens.length === 0) problems.push('ACP_BEARER_TOKENS is set but contains no tokens.');
    if (bearerTokens.some((token) => token.length < MIN_SECRET_LENGTH)) {
      problems.push(`Each ACP_BEARER_TOKENS token must be at least ${String(MIN_SECRET_LENGTH)} characters (e.g. \`openssl rand -hex 32\`).`);
    }
    if (adminToken !== undefined && bearerTokens.includes(adminToken)) {
      problems.push('ACP_BEARER_TOKENS must not contain ADMIN_TOKEN: an ACP platform would hold the owner credential.');
    }
    if ((webhookUrl === undefined) !== (acpWebhookSecret === undefined)) {
      problems.push('ACP_WEBHOOK_URL and ACP_WEBHOOK_SECRET must be set together.');
    }
    if (acpWebhookSecret !== undefined && acpWebhookSecret.length < MIN_SECRET_LENGTH) {
      problems.push(`ACP_WEBHOOK_SECRET must be at least ${String(MIN_SECRET_LENGTH)} characters.`);
    }
    acp = {
      bearerTokens,
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
      ...(acpWebhookSecret !== undefined ? { webhookSecret: acpWebhookSecret } : {}),
    };
  }

  let mppEnabled = false;
  if (read('MPP_ENABLED') === 'true') {
    if (settings.confirmation !== 'instant') {
      warn('MPP_ENABLED ignored — MPP settles immediately, so it needs business.yaml payments.confirmation: instant (currently owner_approves). The MPP door is not mounted.');
    } else if (profileId === undefined) {
      problems.push('MPP_ENABLED=true requires STRIPE_PROFILE_ID (the Stripe profile id agents mint shared payment tokens for).');
    } else {
      mppEnabled = true;
    }
  }
  if (profileId === undefined) {
    warn('STRIPE_PROFILE_ID is not set — agents cannot mint Stripe shared payment tokens for UCP/ACP checkouts until it is (payment links still work).');
  }

  if (problems.length > 0 || keyMode === undefined || webhookSecret === undefined || publicUrl === undefined
    || adminToken === undefined || signingSecret === undefined) {
    return { error: `payments are enabled (STRIPE_SECRET_KEY is set) but misconfigured:\n  - ${problems.join('\n  - ')}` };
  }

  return {
    confirmation: settings.confirmation,
    approvalWindowHours: settings.approvalWindowHours,
    quoteTtlMinutes: settings.quoteTtlMinutes,
    ...(settings.successUrl !== undefined ? { successUrl: settings.successUrl } : {}),
    ...(settings.cancelUrl !== undefined ? { cancelUrl: settings.cancelUrl } : {}),
    publicUrl,
    stripe: { secretKey, webhookSecret, ...(profileId !== undefined ? { profileId } : {}), livemode: keyMode === 'live' },
    adminToken,
    signingSecret,
    dataDir: path.resolve(read('DATA_DIR') ?? './data'),
    ...(acp !== undefined ? { acp } : {}),
    mppEnabled,
  };
}
