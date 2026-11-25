/**
 * Option groups: the `choose:` block — selection-mode/min/max validation and
 * the options themselves, including the `price:` sugar that becomes an addon
 * adjustment (authored option `pricing:` entries are deferred until the
 * scope's parameters are known).
 */
import { z } from 'zod';
import { OptionGroupInput, PriceObject } from '../catalog/schema.js';
import type { Adjustment, Option, OptionGroup } from '../graph/types.js';
import { DEFAULT_ORDER, humanize, moneyToCents } from './context.js';
import type { AdjustmentData, OwnParts } from './context.js';
import type { Reporter } from './diagnostics.js';

type OptionGroupData = z.infer<typeof OptionGroupInput>;
type PriceObjectData = z.infer<typeof PriceObject>;

export function compileOptionGroup(
  ownerOfferingId: string,
  key: string,
  input: OptionGroupData,
  deferredOptionPer: OwnParts['deferredOptionPer'],
  deferredOptionPricing: OwnParts['deferredOptionPricing'],
  rep: Reporter,
  path: (string | number)[],
): OptionGroup | undefined {
  const minSelections = input.required
    ? Math.max(1, input.min ?? 1)
    : (input.min ?? 0);
  let maxSelections: number | undefined;
  if (input.mode === 'single') {
    if ((input.max ?? 1) > 1) {
      rep.error(
        'INVALID_OPTION_GROUP',
        `option group '${key}' is single-choice and cannot set max (${input.max}) above 1`,
        [...path, 'max'],
        "use 'mode: multi' to allow several selections",
      );
    }
    if (minSelections > 1) {
      rep.error(
        'INVALID_OPTION_GROUP',
        `option group '${key}' is single-choice and cannot require more than 1 selection (min ${input.min})`,
        [...path, 'min'],
      );
    }
    maxSelections = 1;
  } else {
    maxSelections = input.max;
  }
  if (maxSelections !== undefined && minSelections > maxSelections) {
    rep.error(
      'INVALID_OPTION_GROUP',
      `option group '${key}': min selections (${minSelections}) exceed max (${maxSelections})`,
      [...path, 'min'],
    );
  }

  const options: Option[] = [];
  const addOption = (
    optionKey: string,
    optionPath: (string | number)[],
    details: {
      label?: string;
      description?: string;
      price?: number | PriceObjectData;
      pricing?: AdjustmentData[];
      taxable?: boolean;
    },
  ): void => {
    const optionId = `${key}.${optionKey}`;
    const label = details.label ?? humanize(optionKey);
    const adjustments: Adjustment[] = [];
    if (details.price !== undefined) {
      const price = details.price;
      if (typeof price === 'number' || price.per === undefined) {
        const amount = typeof price === 'number' ? price : price.amount;
        adjustments.push({
          id: `${ownerOfferingId}.${optionId}.price`,
          label,
          kind: 'addon',
          method: { type: 'fixed', amountCents: moneyToCents(amount) },
          taxable: details.taxable ?? true,
          order: DEFAULT_ORDER.addon,
          ownerOfferingId,
          ownerOptionId: optionId,
        });
      } else {
        deferredOptionPer.push({
          param: price.per,
          what: `price of option '${optionId}'`,
          path: [...optionPath, 'price', 'per'],
        });
        adjustments.push({
          id: `${ownerOfferingId}.${optionId}.price`,
          label,
          kind: 'addon',
          method: {
            type: 'per_unit',
            amountCents: moneyToCents(price.amount),
            per: price.per,
          },
          taxable: details.taxable ?? true,
          order: DEFAULT_ORDER.addon,
          ownerOfferingId,
          ownerOptionId: optionId,
        });
      }
    }
    if (details.pricing !== undefined && details.pricing.length > 0) {
      deferredOptionPricing.push({
        optionId,
        entries: details.pricing,
        path: [...optionPath, 'pricing'],
      });
    }
    options.push({
      id: optionId,
      key: optionKey,
      groupKey: key,
      label,
      ...(details.description !== undefined ? { description: details.description } : {}),
      adjustments,
    });
  };

  if (Array.isArray(input.options)) {
    input.options.forEach((optionKey, index) => {
      addOption(optionKey, [...path, 'options', index], {});
    });
  } else {
    for (const [optionKey, details] of Object.entries(input.options)) {
      const spec = details ?? {};
      addOption(optionKey, [...path, 'options', optionKey], {
        label: spec.label,
        description: spec.description,
        price: spec.price,
        pricing: spec.pricing,
        taxable: spec.taxable,
      });
    }
  }

  if (minSelections > options.length) {
    rep.error(
      'INVALID_OPTION_GROUP',
      `option group '${key}': min selections (${minSelections}) exceed its ${options.length} option(s)`,
      [...path, 'min'],
    );
  }

  return {
    key,
    label: input.label ?? humanize(key),
    ...(input.description !== undefined ? { description: input.description } : {}),
    mode: input.mode,
    required: input.required,
    minSelections,
    ...(maxSelections !== undefined ? { maxSelections } : {}),
    options,
  };
}
