/**
 * Parameter compilation: the `ask:` block — select/multiselect options,
 * min/max bounds, RE2 patterns, internal parameters and full default-value
 * validation per type.
 */
import { z } from 'zod';
import { ParameterInput } from '../catalog/schema.js';
import type { Parameter } from '../graph/types.js';
import { PATTERN_HINT, patternError, patternTest } from '../conditions/index.js';
import { humanize, isCalendarDate, isRealMonthDay } from './context.js';
import type { Reporter } from './diagnostics.js';

type ParameterData = z.infer<typeof ParameterInput>;

export function compileParameter(
  ownerOfferingId: string,
  name: string,
  input: ParameterData,
  rep: Reporter,
  path: (string | number)[],
): Parameter | undefined {
  const type = input.type;
  let options: Parameter['options'];
  if (type === 'select' || type === 'multiselect') {
    if (!input.options || input.options.length === 0) {
      rep.error(
        'INVALID_PARAMETER',
        `${type} parameter '${name}' needs 'options' with at least one value`,
        [...path, 'options'],
        "e.g. options: [small, medium, large]",
      );
    } else {
      options = input.options.map((option) =>
        typeof option === 'string'
          ? { value: option, label: option }
          : { value: option.value, label: option.label ?? option.value },
      );
    }
  } else if (input.options !== undefined) {
    rep.error(
      'INVALID_PARAMETER',
      `parameter '${name}' (${type}) cannot use 'options'; they apply to select/multiselect only`,
      [...path, 'options'],
      'for a fixed set of values use type: select',
    );
  }

  if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
    rep.error(
      'INVALID_PARAMETER',
      `parameter '${name}': min (${input.min}) is greater than max (${input.max})`,
      [...path, 'min'],
    );
  }
  if (
    (input.min !== undefined || input.max !== undefined) &&
    type !== 'number' &&
    type !== 'integer' &&
    type !== 'string'
  ) {
    rep.warn(
      'INVALID_PARAMETER',
      `parameter '${name}' (${type}): min/max apply to number, integer and string parameters`,
      [...path, input.min !== undefined ? 'min' : 'max'],
    );
  }

  if (input.pattern !== undefined) {
    if (type !== 'string') {
      rep.warn(
        'INVALID_PARAMETER',
        `parameter '${name}' (${type}): 'pattern' applies to string parameters`,
        [...path, 'pattern'],
      );
    }
    const problem = patternError(input.pattern);
    if (problem !== undefined) {
      rep.error(
        'INVALID_PARAMETER',
        `parameter '${name}': pattern cannot be used: ${problem}`,
        [...path, 'pattern'],
        PATTERN_HINT,
      );
    }
  }

  if (input.default !== undefined) {
    validateDefault(name, type, input, rep, [...path, 'default']);
  }
  if (input.internal === true && input.default === undefined) {
    rep.error(
      'INVALID_PARAMETER',
      `parameter '${name}' is internal and needs a 'default' (it is never asked)`,
      [...path, 'internal'],
    );
  }

  return {
    name,
    label: input.label ?? humanize(name),
    ...(input.description !== undefined ? { description: input.description } : {}),
    type,
    required: input.required,
    ...(options !== undefined ? { options } : {}),
    ...(input.min !== undefined ? { min: input.min } : {}),
    ...(input.max !== undefined ? { max: input.max } : {}),
    ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
    ...(input.default !== undefined ? { default: input.default } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    internal: input.internal ?? false,
    ownerOfferingId,
  };
}

/** Checks the `default` value against the parameter's type, options and constraints. */
function validateDefault(
  name: string,
  type: Parameter['type'],
  input: ParameterData,
  rep: Reporter,
  path: (string | number)[],
): void {
  const value = input.default!;
  const fail = (reason: string, hint?: string): void => {
    rep.error(
      'INVALID_PARAMETER',
      `parameter '${name}': default ${JSON.stringify(value)} is invalid: ${reason}`,
      path,
      hint,
    );
  };

  if (type === 'select') {
    const values = (input.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
    if (typeof value !== 'string' || !values.includes(value)) {
      fail(`it must be one of: ${values.join(', ')}`);
    }
    return;
  }
  if (type === 'multiselect') {
    const values = (input.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string' || !values.includes(item))
    ) {
      fail(`every entry must be one of: ${values.join(', ')}`, 'defaults for multiselect are lists, e.g. [a, b]');
    }
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') fail('it must be true or false');
    return;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail('it must be a number');
      return;
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      fail('it must be a whole number');
      return;
    }
    if (input.min !== undefined && value < input.min) fail(`it must be at least ${input.min}`);
    if (input.max !== undefined && value > input.max) fail(`it must be at most ${input.max}`);
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') {
      fail('it must be a string');
      return;
    }
    if (input.min !== undefined && value.length < input.min) {
      fail(`it must be at least ${input.min} characters`);
    }
    if (input.max !== undefined && value.length > input.max) {
      fail(`it must be at most ${input.max} characters`);
    }
    if (input.pattern !== undefined && patternError(input.pattern) === undefined && !patternTest(input.pattern, value)) {
      fail(`it must match the pattern ${input.pattern}`);
    }
    return;
  }
  if (type === 'date') {
    if (typeof value !== 'string' || !isCalendarDate(value)) {
      fail('it must be a real YYYY-MM-DD date');
    }
    return;
  }
  if (type === 'time') {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
      fail('it must be a time of day (HH:MM or HH:MM:SS, 24-hour)');
    }
    return;
  }
  if (type === 'datetime' && typeof value === 'string') {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
        value,
      );
    const ok =
      match !== null &&
      isRealMonthDay(match[2]!, match[3]!, Number(match[1])) &&
      Number.isFinite(Date.parse(value));
    if (!ok) fail('it must be a date-time with a UTC offset (RFC 3339)');
  }
}
