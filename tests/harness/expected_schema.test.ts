import { describe, it, expect } from 'vitest';
import { compareExpected, ExpectedBlockSchema } from '../../src/harness/expected_schema.js';

describe('compareExpected', () => {
  it('matches scalar equality', () => {
    expect(compareExpected('d', true, true).pass).toBe(true);
    expect(compareExpected('d', false, true).pass).toBe(false);
    expect(compareExpected('d', 7, 7).pass).toBe(true);
  });

  it('supports the long-form equals matcher', () => {
    expect(compareExpected('d', 'hello\nworld', { equals: 'hello\nworld' }).pass).toBe(true);
    expect(compareExpected('d', 'hello', { equals: 'hello\nworld' }).pass).toBe(false);
  });

  it('supports the matches (regex) matcher', () => {
    expect(compareExpected('d', 'Should vaccinate client', { matches: '^Should vaccinate' }).pass).toBe(true);
    expect(compareExpected('d', 'Nope', { matches: '^Should vaccinate' }).pass).toBe(false);
  });

  it('supports isNull / isNotNull', () => {
    expect(compareExpected('d', null, { isNull: true }).pass).toBe(true);
    expect(compareExpected('d', undefined, { isNull: true }).pass).toBe(true);
    expect(compareExpected('d', 0, { isNull: true }).pass).toBe(false);
    expect(compareExpected('d', 0, { isNotNull: true }).pass).toBe(true);
  });
});

describe('ExpectedBlockSchema', () => {
  it('rejects multiple matchers in one long-form', () => {
    expect(() =>
      ExpectedBlockSchema.parse({
        defines: { d: { equals: 1, matches: 'x' } },
      }),
    ).toThrow();
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() =>
      ExpectedBlockSchema.parse({ defines: {}, bogus: 1 }),
    ).toThrow();
  });

  it('requires defines', () => {
    expect(() => ExpectedBlockSchema.parse({})).toThrow();
  });
});
