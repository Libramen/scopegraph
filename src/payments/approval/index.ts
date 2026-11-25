/**
 * Owner approval: the signed approve/reject links, the HTML pages behind
 * them, and the express router that serves both (admin API + email links).
 */
export { createApprovalRouter, hasOwnerCredential, isOwnerRoute } from './routes.js';
export type { ApprovalRouterDeps } from './routes.js';
export { escapeHtml } from './html.js';
export { signApprovalToken, verifyApprovalToken } from './tokens.js';
export type { ApprovalAction, ApprovalLinks, TokenCheck } from './tokens.js';
