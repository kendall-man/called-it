import { describe, expect, it } from 'vitest';
import { classifyMessage } from './classify.js';
import { CLASSIFIER_MODEL } from './constants.js';
import { AgentResponseFormatError } from './errors.js';
import { makeTextClient } from './test-helpers.js';

const hints = { teamNames: ['France', 'Brazil'], playerNames: ['Kylian Mbappé'] };

describe('classifyMessage', () => {
  it('parses a strict-JSON claim verdict', async () => {
    const client = makeTextClient(
      '{"is_claim": true, "confidence": 0.93, "claim_type_guess": "match_winner"}',
    );
    const result = await classifyMessage('france win this easy', hints, { client });
    expect(result).toEqual({ isClaim: true, confidence: 0.93, claimTypeGuess: 'match_winner' });
  });

  it('parses a non-claim verdict with null guess', async () => {
    const client = makeTextClient('{"is_claim": false, "confidence": 0.1, "claim_type_guess": null}');
    const result = await classifyMessage('what a save!!!', hints, { client });
    expect(result).toEqual({ isClaim: false, confidence: 0.1, claimTypeGuess: null });
  });

  it('tolerates code fences and surrounding prose', async () => {
    const client = makeTextClient(
      'Here you go:\n```json\n{"is_claim": true, "confidence": 0.7, "claim_type_guess": "btts"}\n```',
    );
    const result = await classifyMessage('btts tonight', hints, { client });
    expect(result.isClaim).toBe(true);
    expect(result.claimTypeGuess).toBe('btts');
  });

  it('maps an unknown claim_type_guess to null instead of leaking it', async () => {
    const client = makeTextClient(
      '{"is_claim": true, "confidence": 0.8, "claim_type_guess": "first_goalscorer"}',
    );
    const result = await classifyMessage('kane scores first', hints, { client });
    expect(result.claimTypeGuess).toBeNull();
  });

  it('clamps confidence into [0, 1]', async () => {
    const high = makeTextClient('{"is_claim": true, "confidence": 1.7, "claim_type_guess": null}');
    const low = makeTextClient('{"is_claim": false, "confidence": -3, "claim_type_guess": null}');
    expect((await classifyMessage('x', hints, { client: high })).confidence).toBe(1);
    expect((await classifyMessage('x', hints, { client: low })).confidence).toBe(0);
  });

  it('throws AgentResponseFormatError on non-JSON output', async () => {
    const client = makeTextClient('sorry, I cannot do that');
    await expect(classifyMessage('x', hints, { client })).rejects.toBeInstanceOf(
      AgentResponseFormatError,
    );
  });

  it('throws AgentResponseFormatError on JSON with the wrong shape', async () => {
    const client = makeTextClient('{"verdict": "claim"}');
    await expect(classifyMessage('x', hints, { client })).rejects.toBeInstanceOf(
      AgentResponseFormatError,
    );
  });

  it('uses the pinned classifier model and sends the entity hints', async () => {
    const client = makeTextClient('{"is_claim": false, "confidence": 0, "claim_type_guess": null}');
    await classifyMessage('hello', hints, { client });
    expect(client.requests).toHaveLength(1);
    const request = client.requests[0]!;
    expect(request.model).toBe(CLASSIFIER_MODEL);
    expect(request.system).toContain('JSON');
    const userContent = JSON.stringify(request.messages);
    expect(userContent).toContain('France');
    expect(userContent).toContain('Kylian Mbappé');
  });
});
