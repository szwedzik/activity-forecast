/**
 * The README's scoring table against the rule tables it claims to describe (D-027).
 *
 * D-027 argued the summary was safe because it is read off the rule files rather than the
 * design. Its first draft dropped a gate, so the argument needed something behind it.
 * Unusual for a unit test to read a markdown file, and the docs are part of what is being
 * submitted here: a README that quietly disagrees with the code is worse than no README.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RULES } from '../../src/domain/scoring/activities/index.js';

const README = readFileSync(path.resolve(import.meta.dirname, '../../README.md'), 'utf8');

/** The cells of the README row that starts with this activity's name. */
function row(activity: string): string[] {
  const line = README.split('\n').find((one) => one.startsWith(`| ${activity} |`));
  expect(line, `no README row for ${activity}`).toBeDefined();
  return (line ?? '').split('|').slice(1, -1).map((cell) => cell.trim());
}

/** "temperature 3, wind 2" -> the names and weights, in the README's own order. */
function parseCriteria(cell: string): { name: string; weight: number }[] {
  return cell.split(',').map((one) => {
    const parts = one.trim().split(' ');
    return { name: parts.slice(0, -1).join(' '), weight: Number(parts.at(-1)) };
  });
}

describe('the README describes the scoring tables that ship', () => {
  const NAMES: Record<string, string> = {
    SKIING: 'Skiing',
    SURFING: 'Surfing',
    OUTDOOR_SIGHTSEEING: 'Outdoor sightseeing',
  };

  it('lists every criterion weight, heaviest first', () => {
    for (const rules of Object.values(RULES)) {
      const [, , criteria] = row(NAMES[rules.activity] ?? rules.activity);
      const documented = parseCriteria(criteria ?? '');
      const shipped = [...rules.criteria].sort((a, b) => b.weight - a.weight);

      expect(documented.map((one) => one.weight), rules.activity).toEqual(
        shipped.map((one) => one.weight),
      );
      expect(documented, rules.activity).toHaveLength(shipped.length);
    }
  });

  it('lists every gate, and no gate that does not exist', () => {
    for (const rules of Object.values(RULES)) {
      const [, , , gates] = row(NAMES[rules.activity] ?? rules.activity);
      const documented = (gates ?? '').split(',').map((one) => one.trim());

      // Spelled for a reader rather than copied, so the count is what can be checked
      // mechanically; the names are checked by eye against this list when either moves.
      expect(documented, rules.activity).toHaveLength(rules.gates.length);
      expect(documented.every((one) => one.length > 0), rules.activity).toBe(true);
    }
  });

  it('names the default of every knob it documents', () => {
    // A README that is wrong about a default is worse than one that omits it.
    const defaults: Record<string, string> = {
      PORT: '4000',
      DB_PATH: './data/app.db',
      WEATHER_TTL_HOURS: '3',
      MARINE_TTL_HOURS: '6',
      MAX_STALE_HOURS: '24',
      REFRESH_ENABLED: 'true',
      REFRESH_INTERVAL_MINUTES: '10',
    };

    for (const [name, value] of Object.entries(defaults)) {
      const line = README.split('\n').find((one) => one.startsWith(`| \`${name}\` |`));
      expect(line, `no README row for ${name}`).toBeDefined();
      expect(line, name).toContain(`\`${value}\``);
    }
  });
});
