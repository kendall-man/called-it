import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const INSTRUCTION_DIR = new URL('./instructions/', import.meta.url);

describe('concierge instruction bundle', () => {
  it('loads the active direct-onboarding instructions without the removed demo guide', async () => {
    // Given the Eve instruction directory shipped with the concierge app
    const filenames = (await readdir(INSTRUCTION_DIR))
      .filter((name) => name.endsWith('.md'))
      .sort();

    // When the instruction bundle is loaded from disk
    const files = await Promise.all(
      filenames.map(async (filename) => ({
        filename,
        body: await readFile(join(INSTRUCTION_DIR.pathname, filename), 'utf8'),
      })),
    );
    const combined = files.map((file) => file.body).join('\n');

    // Then every active file is nonempty and the direct SOL contract is present
    expect(filenames).toEqual([
      '00-callie.md',
      '10-house-rules.md',
      '10-placing-bets.md',
      '10-receipts-and-proof.md',
      '10-voice.md',
    ]);
    expect(files.every((file) => file.body.trim().length > 0)).toBe(true);
    expect(combined).toContain('SOL/test SOL on Solana devnet only');
    // Side labels are deterministic per-claim templates; the binary pair is
    // the exact fallback Rumble may name.
    expect(combined).toContain('deterministic');
    expect(combined).toContain('`It happens` / `It does not`');
    // The default card tap is the anchor stake; the value ladder shows the
    // rest, so Rumble never recites rung amounts.
    expect(combined).toContain('the default tap books 0.01 SOL');
    expect(filenames).not.toContain('10-replay-demo.md');
    expect(combined).not.toMatch(/\bPractice Rep\b/i);
  });

  it('encodes the Poke-style voice: length-match, no menu, no preamble, no emoji-first', async () => {
    // Given the instruction bundle shipped with the concierge app
    const filenames = (await readdir(INSTRUCTION_DIR))
      .filter((name) => name.endsWith('.md'))
      .sort();
    const combined = (
      await Promise.all(
        filenames.map((filename) =>
          readFile(join(INSTRUCTION_DIR.pathname, filename), 'utf8'),
        ),
      )
    ).join('\n');

    // Then the hard voice rules are present verbatim so the persona cannot
    // regress into a feature-menu chatbot.
    // Match-length rule (Poke: reply length ~ the user's).
    expect(combined).toContain('Match your reply length to theirs');
    // No preamble/postamble/sign-offs.
    expect(combined).toContain(
      'Never open with a preamble or close with a postamble',
    );
    // Emoji only after the member uses one first (default: none).
    expect(combined).toContain(
      'Do not use emoji unless the member used one first',
    );
    // "What can you do?" is one line + one example, never a capabilities list.
    expect(combined).toContain('Never a feature menu');
    expect(combined).toMatch(/what can you do\??/i);
    expect(combined).toContain('france score 2 today');

    // And the stale escrow ladder wording is gone: 0.05 is the devnet cap and
    // 0.10 is no longer a valid rung, so neither amount is recited.
    expect(combined).not.toContain('0.10 SOL');
    expect(combined).not.toContain('0.05 SOL');
  });
});
