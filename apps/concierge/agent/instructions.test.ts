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
    // the exact fallback Callie may name.
    expect(combined).toContain('deterministic');
    expect(combined).toContain('`It happens` / `It does not`');
    expect(combined).toContain('the default tap books 0.01 SOL');
    expect(filenames).not.toContain('10-replay-demo.md');
    expect(combined).not.toMatch(/\bPractice Rep\b/i);
  });
});
