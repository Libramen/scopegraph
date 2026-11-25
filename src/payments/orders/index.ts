/**
 * OrderService public surface: the facade class, its factory, and the hook
 * contract forkers implement (src/extend/orders.ts). Internals live in the
 * sibling modules — import those directly.
 */
export { DefaultOrderService, createOrderService } from './service.js';
export type { OrderHooks } from './service.js';

