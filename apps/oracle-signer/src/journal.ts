import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface JournalEntry {
  readonly key: string;
  readonly canonicalSha256Hex: string;
  readonly recordedAt: string;
}

function validEntry(value: unknown): value is JournalEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<JournalEntry>;
  return typeof entry.key === 'string' && entry.key.length > 0 &&
    typeof entry.canonicalSha256Hex === 'string' && /^[0-9a-f]{64}$/.test(entry.canonicalSha256Hex) &&
    typeof entry.recordedAt === 'string' && Number.isFinite(Date.parse(entry.recordedAt));
}

export class OracleSignatureJournal {
  readonly #entries = new Map<string, string>();
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(readonly path: string) {}

  static async open(path: string): Promise<OracleSignatureJournal> {
    const journal = new OracleSignatureJournal(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let body = '';
    try {
      body = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of body.split('\n')) {
      if (line.length === 0) continue;
      const parsed: unknown = JSON.parse(line);
      if (!validEntry(parsed)) throw new Error('oracle signature journal is corrupt');
      const prior = journal.#entries.get(parsed.key);
      if (prior !== undefined && prior !== parsed.canonicalSha256Hex) {
        throw new Error('oracle signature journal contains equivocation');
      }
      journal.#entries.set(parsed.key, parsed.canonicalSha256Hex);
    }
    const handle = await open(path, 'a', 0o600);
    await handle.chmod(0o600);
    await handle.close();
    return journal;
  }

  async record(key: string, canonicalSha256Hex: string, now = new Date()): Promise<void> {
    const operation = this.#writeChain
      .catch(() => undefined)
      .then(() => this.recordSerially(key, canonicalSha256Hex, now));
    this.#writeChain = operation;
    await operation;
  }

  private async recordSerially(key: string, canonicalSha256Hex: string, now: Date): Promise<void> {
    const prior = this.#entries.get(key);
    if (prior !== undefined) {
      if (prior !== canonicalSha256Hex) throw new Error('oracle signer refused equivocation');
      return;
    }
    const entry: JournalEntry = { key, canonicalSha256Hex, recordedAt: now.toISOString() };
    const handle = await open(this.path, 'a', 0o600);
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#entries.set(key, canonicalSha256Hex);
  }
}
