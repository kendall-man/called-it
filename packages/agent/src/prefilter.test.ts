import { describe, expect, it } from 'vitest';
import { goldenEntities, goldenSet } from './goldenSet.js';
import { prefilter } from './prefilter.js';

describe('prefilter matrix over the golden set', () => {
  const claims = goldenSet.filter((f) => f.expected !== null);
  const prefilterKills = goldenSet.filter((f) => f.tags?.includes('prefilter_kill'));
  const classifierRejects = goldenSet.filter((f) => f.tags?.includes('needs_classifier'));

  it('golden set is large enough to mean something', () => {
    expect(goldenSet.length).toBeGreaterThanOrEqual(50);
    expect(claims.length).toBeGreaterThanOrEqual(25);
    expect(prefilterKills.length + classifierRejects.length).toBeGreaterThanOrEqual(15);
  });

  it.each(claims.map((f) => [f.text] as const))(
    'passes claim: %s',
    (text) => {
      expect(prefilter(text, goldenEntities)).toBe(true);
    },
  );

  it.each(prefilterKills.map((f) => [f.text] as const))(
    'kills non-claim chatter: %s',
    (text) => {
      expect(prefilter(text, goldenEntities)).toBe(false);
    },
  );

  it.each(classifierRejects.map((f) => [f.text] as const))(
    'lets plausible-but-wrong banter through for the classifier: %s',
    (text) => {
      expect(prefilter(text, goldenEntities)).toBe(true);
    },
  );
});

describe('prefilter unit behaviour', () => {
  it('kills empty and whitespace-only messages', () => {
    expect(prefilter('', goldenEntities)).toBe(false);
    expect(prefilter('   \n ', goldenEntities)).toBe(false);
  });

  it('an entity mention alone is not a claim', () => {
    expect(prefilter('mbappe looked tired out there', goldenEntities)).toBe(false);
    expect(prefilter('france france france', goldenEntities)).toBe(false);
  });

  it('a claim verb alone with no entity or number is not enough', () => {
    expect(prefilter("we're winning", goldenEntities)).toBe(false);
    expect(prefilter('guaranteed', goldenEntities)).toBe(false);
  });

  it('matches entities through diacritics and possessives', () => {
    expect(prefilter("Mbappé's scoring twice tonight, 2 minimum", goldenEntities)).toBe(true);
    expect(prefilter('VINI cooks today, 1 goal min', goldenEntities)).toBe(true);
  });

  it('does not match entity names inside longer words', () => {
    // "kane" must not fire inside "hurricane".
    expect(prefilter('a hurricane is coming apparently', goldenEntities)).toBe(false);
  });

  it('does not match claim verbs inside longer words', () => {
    // "won" inside "wonderful", "win" inside "winter" must not count.
    expect(prefilter('mbappe is wonderful', goldenEntities)).toBe(false);
    expect(prefilter('france in winter is beautiful', goldenEntities)).toBe(false);
  });

  it('works with an empty dictionary — only standalone patterns pass', () => {
    const empty = { teamNames: [], playerNames: [] };
    expect(prefilter('over 2.5 easy', empty)).toBe(true);
    expect(prefilter('france win this easy', empty)).toBe(false);
  });
});
