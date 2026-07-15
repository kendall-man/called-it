import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, truncate, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function decisionFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class OracleSignatureJournal {
  readonly #entries = new Map<string, string>();
  readonly #decisionDirectory: string;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(readonly path: string) {
    this.#decisionDirectory = `${path}.decisions`;
  }

  static async open(path: string): Promise<OracleSignatureJournal> {
    const journal = new OracleSignatureJournal(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await mkdir(journal.#decisionDirectory, { recursive: true, mode: 0o700 });

    const journalEntries = new Map<string, JournalEntry>();
    let body = '';
    try {
      body = await readFile(path, 'utf8');
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const lines = body.split('\n');
    let interruptedAuditOffset: number | null = null;
    let offset = 0;
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) {
        offset += 1;
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        if (index === lines.length - 1 && !body.endsWith('\n')) {
          interruptedAuditOffset = offset;
          break;
        }
        throw new Error('oracle signature journal is corrupt');
      }
      if (!validEntry(parsed)) {
        if (index === lines.length - 1 && !body.endsWith('\n')) {
          interruptedAuditOffset = offset;
          break;
        }
        throw new Error('oracle signature journal is corrupt');
      }
      const prior = journalEntries.get(parsed.key);
      if (prior !== undefined && prior.canonicalSha256Hex !== parsed.canonicalSha256Hex) {
        throw new Error('oracle signature journal contains equivocation');
      }
      journalEntries.set(parsed.key, parsed);
      offset += Buffer.byteLength(line) + 1;
    }

    for (const fileName of await readdir(journal.#decisionDirectory)) {
      if (!fileName.endsWith('.json')) continue;
      const decision = await journal.readDecision(join(journal.#decisionDirectory, fileName));
      if (decisionFileName(decision.key) !== fileName) {
        throw new Error('oracle signature decision is corrupt');
      }
      journal.remember(decision);
    }

    for (const entry of journalEntries.values()) {
      const decision = await journal.installDecision(entry);
      if (decision.canonicalSha256Hex !== entry.canonicalSha256Hex) {
        throw new Error('oracle signature journal contains equivocation');
      }
      journal.remember(entry);
    }

    const handle = await open(path, 'a', 0o600);
    await handle.chmod(0o600);
    await handle.close();
    if (interruptedAuditOffset !== null) await truncate(path, interruptedAuditOffset);

    for (const [key, canonicalSha256Hex] of journal.#entries) {
      if (journalEntries.get(key)?.canonicalSha256Hex !== canonicalSha256Hex) {
        await journal.appendEntry({ key, canonicalSha256Hex, recordedAt: new Date().toISOString() });
      }
    }
    return journal;
  }

  async record(key: string, canonicalSha256Hex: string, now = new Date()): Promise<void> {
    const operation = this.#writeChain
      .catch(() => undefined)
      .then(() => this.recordSerially(key, canonicalSha256Hex, now));
    this.#writeChain = operation;
    await operation;
  }

  private remember(entry: JournalEntry): void {
    const prior = this.#entries.get(entry.key);
    if (prior !== undefined && prior !== entry.canonicalSha256Hex) {
      throw new Error('oracle signature journal contains equivocation');
    }
    this.#entries.set(entry.key, entry.canonicalSha256Hex);
  }

  private async readDecision(path: string): Promise<JournalEntry> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('oracle signature decision is corrupt');
      throw error;
    }
    if (!validEntry(parsed)) throw new Error('oracle signature decision is corrupt');
    return parsed;
  }

  private async installDecision(entry: JournalEntry): Promise<JournalEntry> {
    if (!validEntry(entry)) throw new Error('oracle signature decision is invalid');
    const decisionPath = join(this.#decisionDirectory, decisionFileName(entry.key));
    const temporaryPath = join(this.#decisionDirectory, `.pending-${process.pid}-${randomUUID()}`);
    const temporary = await open(temporaryPath, 'wx', 0o600);
    try {
      await temporary.writeFile(`${JSON.stringify(entry)}\n`);
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    try {
      try {
        // The deterministic hard link atomically selects one fully fsynced winner across processes.
        await link(temporaryPath, decisionPath);
        await syncDirectory(this.#decisionDirectory);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const decision = await this.readDecision(decisionPath);
      if (decision.key !== entry.key) throw new Error('oracle signature decision is corrupt');
      return decision;
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }

  private async appendEntry(entry: JournalEntry): Promise<void> {
    const handle = await open(this.path, 'a', 0o600);
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async recordSerially(key: string, canonicalSha256Hex: string, now: Date): Promise<void> {
    const prior = this.#entries.get(key);
    if (prior !== undefined) {
      if (prior !== canonicalSha256Hex) throw new Error('oracle signer refused equivocation');
      return;
    }

    const entry: JournalEntry = { key, canonicalSha256Hex, recordedAt: now.toISOString() };
    const decision = await this.installDecision(entry);
    if (decision.canonicalSha256Hex !== canonicalSha256Hex) {
      throw new Error('oracle signer refused equivocation');
    }
    await this.appendEntry(decision);
    this.remember(decision);
  }
}
