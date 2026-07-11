import type { ApiClientOptions } from 'grammy';

type TelegramClientFetch = NonNullable<ApiClientOptions['fetch']>;
type PlatformFetchInput = Parameters<typeof fetch>[0];
type PlatformFetchInit = Parameters<typeof fetch>[1];
type ClientFetchInput = Parameters<TelegramClientFetch>[0];
type ClientFetchInit = Parameters<TelegramClientFetch>[1];

export type TelegramFetchInput = PlatformFetchInput | ClientFetchInput;
export type TelegramFetchBody =
  | NonNullable<PlatformFetchInit>['body']
  | NonNullable<ClientFetchInit>['body']
  | undefined;

class FetchAbortError extends Error {
  readonly name = 'AbortError';
  readonly type = 'aborted';
}

class TelegramFetchError extends Error {
  readonly name = 'FetchError';

  constructor(message: string, readonly type: string) {
    super(message);
  }
}

class CompatibleFetchBody {
  readonly body: NodeJS.ReadableStream = process.stdin;
  readonly bodyUsed = false;
  readonly size: number;
  readonly timeout: number;

  constructor(
    protected readonly content = '',
    options?: { readonly size?: number; readonly timeout?: number },
  ) {
    this.size = options?.size ?? 0;
    this.timeout = options?.timeout ?? 0;
  }

  async arrayBuffer(): Promise<ArrayBuffer> { return new ArrayBuffer(0); }
  async blob(): Promise<Blob> { return new Blob([this.content]); }
  async buffer(): Promise<Buffer> { return Buffer.from(this.content); }
  async json(): Promise<unknown> {
    const value: unknown = JSON.parse(this.content);
    return value;
  }
  async text(): Promise<string> { return this.content; }
  async textConverted(): Promise<string> { return this.content; }
}

class TelegramFetchHeaders extends Headers {
  constructor(_init?: unknown) { super(); }

  raw(): Record<string, string[]> {
    const values: Record<string, string[]> = {};
    for (const [name, value] of this) {
      values[name] = [...(values[name] ?? []), value];
    }
    return values;
  }
}

class TelegramFetchRequest extends CompatibleFetchBody {
  readonly context = 'fetch';
  readonly headers = new TelegramFetchHeaders();
  readonly method = 'POST';
  readonly redirect = 'follow';
  readonly referrer = '';
  readonly url: string;
  readonly compress = true;
  readonly counter = 0;
  readonly follow = 20;
  readonly hostname = '';
  readonly protocol = 'https:';

  constructor(input: unknown, _init?: unknown) {
    super();
    this.url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : 'https://telegram.invalid';
  }

  clone(): TelegramFetchRequest { return new TelegramFetchRequest(this.url); }
}

class TelegramFetchResponse extends CompatibleFetchBody {
  readonly headers = new TelegramFetchHeaders();
  readonly ok: boolean;
  readonly redirected = false;
  readonly status: number;
  readonly statusText = '';
  readonly type = 'default';
  readonly url: string;

  constructor(content = '', init?: unknown, url = '') {
    super(content);
    this.status = numberField(init, 'status') ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.url = url;
  }

  static error(): TelegramFetchResponse {
    return new TelegramFetchResponse('', { status: 500 });
  }

  static redirect(url: string, status: number): TelegramFetchResponse {
    return new TelegramFetchResponse('', { status }, url);
  }

  clone(): TelegramFetchResponse {
    return new TelegramFetchResponse(this.content, { status: this.status }, this.url);
  }
}

type TelegramFetchStatics = Pick<
  TelegramClientFetch,
  | 'isRedirect'
  | 'AbortError'
  | 'Blob'
  | 'Body'
  | 'FetchError'
  | 'Headers'
  | 'Request'
  | 'Response'
>;

const TELEGRAM_FETCH_STATICS = {
  isRedirect: (code: number) => [301, 302, 303, 307, 308].includes(code),
  AbortError: FetchAbortError,
  Blob,
  Body: CompatibleFetchBody,
  FetchError: TelegramFetchError,
  Headers: TelegramFetchHeaders,
  Request: TelegramFetchRequest,
  Response: TelegramFetchResponse,
} satisfies TelegramFetchStatics;

type TelegramFetchImplementation = (
  input: ClientFetchInput,
  init?: ClientFetchInit,
) => ReturnType<TelegramClientFetch>;

type TelegramFetchWithoutDefault = TelegramFetchImplementation & TelegramFetchStatics;

export function createTelegramFetch(
  implementation: TelegramFetchImplementation,
): TelegramClientFetch {
  const augmented = Object.assign(
    implementation,
    globalThis.fetch,
    TELEGRAM_FETCH_STATICS,
  );
  Object.defineProperty(augmented, 'default', {
    enumerable: true,
    value: augmented,
  });
  assertSelfDefault(augmented);
  return augmented;
}

export function telegramJsonResponse(
  payload: unknown,
): Awaited<ReturnType<TelegramClientFetch>> {
  return new TelegramFetchResponse(JSON.stringify(payload), { status: 200 });
}

function assertSelfDefault(
  value: TelegramFetchWithoutDefault,
): asserts value is TelegramClientFetch {
  if (Object.getOwnPropertyDescriptor(value, 'default')?.value !== value) {
    throw new TypeError('Telegram fetch default must reference the augmented callable');
  }
}

function field(payload: unknown, name: string): unknown {
  if (typeof payload !== 'object' || payload === null) return undefined;
  return Object.getOwnPropertyDescriptor(payload, name)?.value;
}

function numberField(payload: unknown, name: string): number | null {
  const value = field(payload, name);
  return typeof value === 'number' ? value : null;
}
