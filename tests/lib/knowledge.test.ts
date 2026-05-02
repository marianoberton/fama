import { describe, it, expect, beforeEach } from 'vitest';
import { searchKnowledge, _resetKnowledgeCacheForTests } from '../../src/lib/knowledge.js';

beforeEach(() => {
  _resetKnowledgeCacheForTests();
});

describe('searchKnowledge', () => {
  it('finds the pricing tiers when asked about Equipo', () => {
    const results = searchKnowledge('qué incluye el plan Equipo');
    expect(results.length).toBeGreaterThan(0);
    const sources = results.map((r) => r.source);
    expect(sources).toContain('pricing');
    const equipoMatch = results.find(
      (r) => r.source === 'pricing' && /equipo/i.test(r.title),
    );
    expect(equipoMatch).toBeDefined();
  });

  it('finds employee descriptions by role', () => {
    const results = searchKnowledge('cobranzas Mateo');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe('employees');
    expect(results[0]!.content.toLowerCase()).toContain('cobranza');
  });

  it('matches accent-insensitive (información ↔ informacion)', () => {
    const accented = searchKnowledge('información de contacto');
    const stripped = searchKnowledge('informacion de contacto');
    expect(accented.length).toBeGreaterThan(0);
    expect(stripped.length).toBeGreaterThan(0);
    expect(stripped[0]!.source).toBe(accented[0]!.source);
    expect(stripped[0]!.title).toBe(accented[0]!.title);
  });

  it('returns empty when the query has no usable tokens', () => {
    expect(searchKnowledge('a')).toEqual([]);
    expect(searchKnowledge('   ')).toEqual([]);
    expect(searchKnowledge('!!!')).toEqual([]);
  });

  it('respects the limit parameter', () => {
    const tight = searchKnowledge('FOMO', 2);
    expect(tight.length).toBeLessThanOrEqual(2);
  });

  it('ranks pricing-page Enterprise section first when asked about Enterprise', () => {
    const results = searchKnowledge('Enterprise plan custom precio');
    expect(results[0]!.source).toBe('pricing');
    expect(results[0]!.title).toBe('Enterprise');
  });

  it('truncates content to ~800 chars max with ellipsis when needed', () => {
    const results = searchKnowledge('FOMO consultora');
    for (const r of results) {
      expect(r.content.length).toBeLessThanOrEqual(800);
    }
  });
});
