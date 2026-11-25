/**
 * Mermaid flowchart rendering of a compiled graph — for eyeballing catalog
 * structure (humans and agents). One star per offering:
 *
 *   offering ──> option groups ──> options
 *   offering -.-> parameters
 *   offering ──> rules ──|require / exclude / ask|──> targets
 *   package ══|contains ×N|══> contained offerings
 *
 * With `offeringId`, only that offering is expanded (contained offerings
 * appear as plain nodes). Throws when the id is unknown.
 */
import type { Graph, Offering, Rule } from '../graph/types.js';

class NodeIds {
  private readonly used = new Set<string>();

  next(prefix: string, key: string): string {
    const base = `${prefix}_${key}`.replace(/[^A-Za-z0-9_]/g, '_');
    let candidate = base;
    let suffix = 2;
    while (this.used.has(candidate)) candidate = `${base}_${suffix++}`;
    this.used.add(candidate);
    return candidate;
  }
}

/** Escape mermaid label text (called per segment; `<br/>` is inserted after). */
function esc(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, "'")
    .replace(/[[\]|<>#`]/g, (match) =>
      match === '[' ? '(' : match === ']' ? ')' : match === '|' ? '/' : '',
    )
    .trim();
}

function label(...parts: Array<string | number | undefined>): string {
  const text = parts.filter((part) => part !== undefined && part !== '').join(' · ');
  return esc(text.length > 80 ? `${text.slice(0, 77)}...` : text);
}

/** Wrap a pre-escaped label (may contain `<br/>`) in mermaid quotes. */
function quoted(text: string): string {
  return `"${text}"`;
}

function drawOffering(ids: NodeIds, lines: string[], offering: Offering): string {
  const id = ids.next('o', offering.id);
  const flags = [
    offering.kind,
    offering.status === 'active' ? undefined : offering.status,
    offering.bookable ? undefined : 'not bookable',
  ];
  const text = quoted(label(offering.id, offering.name, ...flags));
  const shape = offering.kind === 'package' ? `[[${text}]]` : `[${text}]`;
  lines.push(`  ${id}${shape}`);
  return id;
}

interface OfferingNodes {
  offering: string;
  parameters: Map<string, string>;
  groups: Map<string, string>;
  /** Keyed by full option id `<group>.<option>`. */
  options: Map<string, string>;
}

function ruleLabel(rule: Rule): string {
  const effect =
    rule.effect.kind === 'block'
      ? `block: ${rule.effect.message}`
      : `${rule.effect.kind} ${rule.effect.target.id}`;
  const note =
    rule.description ??
    (rule.effect.kind === 'block' || rule.effect.kind === 'ask' ? undefined : rule.effect.message);
  const first = label(rule.id, effect, rule.active ? undefined : 'inactive');
  return note ? `${first}<br/>${label(note)}` : first;
}

function renderInternals(
  ids: NodeIds,
  lines: string[],
  offering: Offering,
  offeringNodeId: string,
): OfferingNodes {
  const nodes: OfferingNodes = {
    offering: offeringNodeId,
    parameters: new Map(),
    groups: new Map(),
    options: new Map(),
  };
  for (const parameter of offering.scope.parameters) {
    const nodeId = ids.next(`p_${offering.id}`, parameter.name);
    nodes.parameters.set(parameter.name, nodeId);
    lines.push(
      `  ${nodeId}(${quoted(label(parameter.name, parameter.type, parameter.required ? 'required' : 'optional', parameter.internal ? 'internal' : undefined))})`,
    );
    lines.push(`  ${offeringNodeId} -.-> ${nodeId}`);
  }
  for (const group of offering.scope.optionGroups) {
    const groupId = ids.next(`g_${offering.id}`, group.key);
    nodes.groups.set(group.key, groupId);
    lines.push(
      `  ${groupId}[${quoted(label(group.key, group.mode, group.required ? 'required' : undefined))}]`,
    );
    lines.push(`  ${offeringNodeId} --> ${groupId}`);
    for (const option of group.options) {
      const optionId = ids.next(`opt_${offering.id}`, option.id);
      nodes.options.set(option.id, optionId);
      const optionLabel = option.label === option.key ? option.key : `${option.key} — ${option.label}`;
      lines.push(`  ${optionId}(${quoted(label(optionLabel))})`);
      lines.push(`  ${groupId} --> ${optionId}`);
    }
  }
  for (const rule of offering.scope.rules) {
    const ruleId = ids.next(`r_${offering.id}`, rule.id);
    lines.push(`  ${ruleId}{${quoted(ruleLabel(rule))}}`);
    lines.push(`  ${offeringNodeId} --> ${ruleId}`);
    const targets: Array<{ label: string; node?: string }> =
      rule.effect.kind === 'ask'
        ? [
            {
              label: 'ask',
              node: nodes.parameters.get(rule.effect.target.id) ?? nodes.groups.get(rule.effect.target.id),
            },
          ]
        : rule.effect.kind === 'block'
          ? []
          : [
              {
                label: rule.effect.kind,
                node:
                  rule.effect.target.type === 'option'
                    ? nodes.options.get(rule.effect.target.id) ?? nodes.groups.get(rule.effect.target.id)
                    : nodes.groups.get(rule.effect.target.id) ?? nodes.options.get(rule.effect.target.id),
              },
            ];
    for (const target of targets) {
      if (target.node) lines.push(`  ${ruleId} -->|${target.label}| ${target.node}`);
    }
  }
  return nodes;
}

export function lookupOffering(graph: Graph, id: string): Offering {
  const offering = Object.hasOwn(graph.offerings, id) ? graph.offerings[id] : undefined;
  if (!offering) throw new Error(`offering '${id}' not found in catalog`);
  return offering;
}

export function renderMermaid(graph: Graph, offeringId?: string): string {
  const ids = new NodeIds();
  const lines: string[] = ['flowchart TD'];
  const offerings = offeringId !== undefined ? [lookupOffering(graph, offeringId)] : Object.values(graph.offerings);
  lines.push(`%% ${esc(graph.business.name)} (${graph.business.currency})`);

  // Offering nodes first so contains edges can link to them.
  const nodeOf = new Map<string, string>();
  for (const offering of offerings) {
    nodeOf.set(offering.id, drawOffering(ids, lines, offering));
  }
  for (const offering of offerings) {
    renderInternals(ids, lines, offering, nodeOf.get(offering.id)!);
  }
  for (const offering of offerings) {
    const source = nodeOf.get(offering.id)!;
    for (const item of offering.contains) {
      let target = nodeOf.get(item.offeringId);
      if (!target) {
        const child = graph.offerings[item.offeringId];
        target = child
          ? drawOffering(ids, lines, child)
          : ids.next('o', `${item.offeringId}_missing`);
        if (!child) lines.push(`  ${target}[${quoted(label(item.offeringId, 'missing'))}]`);
        nodeOf.set(item.offeringId, target);
      }
      lines.push(`  ${source} ==>|contains ×${item.quantity}| ${target}`);
    }
  }
  return lines.join('\n');
}
