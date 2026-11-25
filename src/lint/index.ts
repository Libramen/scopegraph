/**
 * Graph linting: warnings about catalogs that compile but probably do not do
 * what the author intended. `lintGraph` is pure (graph in, warnings out) and
 * never produces errors — every diagnostic has severity 'warning'.
 *
 * Lint diagnostics carry graph paths (`['offerings', id, …]`) instead of
 * file positions: the compiled graph does not keep source locations.
 */
import type { Diagnostic } from '../compile/diagnostics.js';
import type {
  Adjustment,
  Condition,
  ConditionRef,
  Graph,
  Rule,
} from '../graph/types.js';

interface Ref {
  ref: ConditionRef;
  name: string;
}

/** Visits every non-compound leaf of a condition tree. */
function walkConditionRefs(condition: Condition, visit: (ref: Ref) => void): void {
  if (condition.conditions !== undefined) {
    for (const child of condition.conditions) {
      walkConditionRefs(child, visit);
    }
    return;
  }
  if (condition.ref !== undefined && condition.name !== undefined) {
    visit({ ref: condition.ref, name: condition.name });
  }
}

function walkWhenRefs(when: Condition | undefined, visit: (ref: Ref) => void): void {
  if (when !== undefined) walkConditionRefs(when, visit);
}

/** Path of a rule inside its declaring offering's authoring file. */
function rulePath(ownerOfferingId: string, ruleId: string): (string | number)[] {
  const key = ruleId.includes('.')
    ? ruleId.split('.').slice(1).join('.')
    : ruleId;
  return ['offerings', ownerOfferingId, 'rules', key];
}

function rulePathOfOwner(rule: Rule): (string | number)[] {
  return rulePath(rule.ownerOfferingId, rule.id);
}

export function lintGraph(graph: Graph): Diagnostic[] {
  const warnings: Diagnostic[] = [];
  const warn = (
    code: string,
    message: string,
    path: (string | number)[],
    hint?: string,
  ): void => {
    warnings.push({
      severity: 'warning',
      code,
      message,
      path,
      ...(hint !== undefined ? { hint } : {}),
    });
  };

  const referencedFacts = new Set<string>();

  for (const offering of Object.values(graph.offerings)) {
    const paramsByName = new Map(
      offering.scope.parameters.map((p) => [p.name, p] as const),
    );

    // MISSING_DESCRIPTION — buyer agents describe the offering from this.
    if (offering.description === undefined || offering.description.trim() === '') {
      warn(
        'MISSING_DESCRIPTION',
        `offering '${offering.id}' has no description; buyer agents rely on it to decide what to buy`,
        ['offerings', offering.id],
        "add a 1–3 sentence 'description' naming what it is, for whom and what is included",
      );
    }

    // NO_PRICE — standalone products that charge nothing and have no adjustments.
    // Bundle-only components (bookable: false) are priced by their package.
    if (offering.kind === 'product' && offering.bookable) {
      const baseTotal = offering.scope.baseLines.reduce(
        (sum, line) => sum + line.amountCents * line.quantity,
        0,
      );
      if (baseTotal === 0 && offering.scope.adjustments.length === 0) {
        warn(
          'NO_PRICE',
          `product '${offering.id}' has a base price of 0 and no pricing entries; it quotes a total of 0`,
          ['offerings', offering.id, 'price'],
          "set a 'price', or add pricing entries if it is genuinely free",
        );
      }
    }

    for (const rule of offering.scope.rules) {
      // Collect fact references for UNUSED_FACT (across all offerings).
      walkWhenRefs(rule.when, (ref) => {
        if (ref.ref === 'fact') referencedFacts.add(ref.name);
      });
      if (rule.effect.kind === 'ask') {
        const gate = rule.effect.target;
        if (gate.type === 'parameter') {
          const param = paramsByName.get(gate.id);
          if (param?.internal === true) {
            warn(
              'GATE_ON_INTERNAL',
              `rule '${rule.id}' gates the internal parameter '${gate.id}', which is never asked; the gate has no effect`,
              rulePathOfOwner(rule),
              'remove the rule or make the parameter non-internal',
            );
          }
          if (param?.required === true && param.default !== undefined) {
            warn(
              'GATE_ON_REQUIRED_DEFAULT',
              `rule '${rule.id}' gates the required parameter '${gate.id}', which has a default; the default answers it either way so the gate cannot change the outcome`,
              rulePathOfOwner(rule),
              'drop the default (and let the gate decide when to ask) or drop the rule',
            );
          }
        }
      }
      if (rule.effect.kind === 'block' && rule.when !== undefined) {
        const factRefs: Ref[] = [];
        walkConditionRefs(rule.when, (ref) => {
          if (ref.ref === 'fact') factRefs.push(ref);
        });
        for (const ref of factRefs) {
          const fact = graph.business.facts[ref.name];
          if (fact !== undefined && !fact.required) {
            warn(
              'FACT_FAIL_OPEN',
              `block rule '${rule.id}' depends on the fact '${fact.name}', which is not required: when the fact is missing the rule never fires instead of blocking`,
              ['business', 'facts', fact.name],
              "add required: true so a missing fact blocks the request (fail closed)",
            );
          }
        }
      }
    }
    for (const adjustment of offering.scope.adjustments) {
      walkWhenRefs(adjustment.when, (ref) => {
        if (ref.ref === 'fact') referencedFacts.add(ref.name);
      });
    }
    for (const group of offering.scope.optionGroups) {
      for (const option of group.options) {
        for (const adjustment of option.adjustments) {
          walkWhenRefs(adjustment.when, (ref) => {
            if (ref.ref === 'fact') referencedFacts.add(ref.name);
          });
        }
      }
    }

    const ownAdjustments: Adjustment[] = [
      ...offering.scope.adjustments,
      ...offering.scope.optionGroups.flatMap((group) => group.options.flatMap((option) => option.adjustments)),
    ].filter((adjustment) => adjustment.ownerOfferingId === offering.id);
    const zeroBase = offering.scope.baseLines.every((line) => line.amountCents === 0);
    for (const adjustment of ownAdjustments) {
      const method = adjustment.method;
      // DISCOUNT_UNBOUNDED_QUANTITY — a buyer-chosen count with no ceiling sizes the discount,
      // unless the base price per unit of that same count is at least the discount per unit.
      if (adjustment.kind === 'discount' && (method.type === 'per_unit' || method.type === 'tiered')) {
        const param = paramsByName.get(method.per);
        const discountPerUnit = method.type === 'per_unit' ? method.amountCents : Math.max(...method.tiers.map((tier) => tier.amountCents));
        const basePerUnit = offering.scope.baseLines
          .filter((line) => line.per === method.per)
          .reduce((sum, line) => sum + line.amountCents * line.quantity, 0);
        if (param !== undefined && !param.internal && param.max === undefined && basePerUnit < discountPerUnit) {
          warn(
            'DISCOUNT_UNBOUNDED_QUANTITY',
            `discount '${adjustment.label}' is priced per '${method.per}', which has no max; a buyer can raise '${method.per}' until the discount takes the quote down to zero`,
            ['offerings', offering.id, 'parameters', method.per],
            `add 'max' to the parameter '${method.per}'`,
          );
        }
      }
      // PERCENT_OF_ZERO_BASE — a percent of a $0 base is always $0.
      if (method.type === 'percent' && method.basis === 'base' && zeroBase) {
        warn(
          'PERCENT_OF_ZERO_BASE',
          `'${adjustment.label}' is a percent of the base price (basis: base), but the base price of '${offering.id}' is 0, so it is always 0`,
          ['offerings', offering.id, 'pricing'],
          'use basis: running (the default) to take the percent of the running subtotal, which includes the choices that set the price',
        );
      }
    }

    // DATE_VALUE_WITHOUT_DATE — date-derived values are unknown without a date.
    // Components (bookable: false) are only scoped inside their packages, which may take one.
    if (offering.date === 'none' && offering.bookable) {
      const read = new Set<string>();
      const collect = (ref: Ref): void => {
        if (ref.ref === 'derived') read.add(ref.name);
      };
      for (const rule of offering.scope.rules) walkWhenRefs(rule.when, collect);
      for (const adjustment of ownAdjustments) walkWhenRefs(adjustment.when, collect);
      if (read.size > 0) {
        warn(
          'DATE_VALUE_WITHOUT_DATE',
          `offering '${offering.id}' takes no date, but its conditions read ${[...read].join(', ')}; without a date those are never known, so those conditions never apply`,
          ['offerings', offering.id, 'date'],
          "add 'date: required' (or 'date: optional') to the offering, or drop the date condition",
        );
      }
    }
  }

  // UNUSED_FACT — facts nothing reads.
  for (const fact of Object.values(graph.business.facts)) {
    if (!referencedFacts.has(fact.name)) {
      warn(
        'UNUSED_FACT',
        `fact '${fact.name}' is declared but no rule or pricing condition reads it`,
        ['business', 'facts', fact.name],
        'reference it in some `when:` condition, or delete it (your server still has to supply it otherwise)',
      );
    }
  }

  return warnings;
}
