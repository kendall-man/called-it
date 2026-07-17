import type { Metadata } from 'next';
import { PageShell } from '@/components/ui';
import { buildTelegramGroupAddUrl } from '@/lib/entry';
import { isMainnet } from '@/lib/solana-network';

export const metadata: Metadata = {
  description: 'Add Called It to your Telegram group to put football calls on the record.',
};

const STEPS = [
  ['1', 'Add', 'Add Called It to your Telegram group.'],
  ['2', 'Say it', 'Make a clear football call in the chat.'],
  ['3', 'Take a side', 'Your group chooses whether it happens.'],
] as const;

export default function LandingPage() {
  const mainnet = isMainnet();
  const telegramGroupUrl = buildTelegramGroupAddUrl(
    process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME,
  );

  return (
    <PageShell
      topRight={
        telegramGroupUrl ? (
          <a
            href={telegramGroupUrl}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-pitch-300 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300"
          >
            Add to Telegram
          </a>
        ) : (
          <span className="text-xs text-fog">Telegram unavailable</span>
        )
      }
    >
      <section className="entry-page mt-2 border-b border-line pb-6 sm:mt-6">
        <p className="text-sm font-semibold text-pitch-300">Football calls, on the record</p>
        <h1 className="display-type mt-2 text-6xl text-chalk sm:text-7xl">
          Called <span className="text-pitch-400">It</span>
        </h1>
        <p className="mt-4 max-w-lg text-base leading-relaxed text-fog">
          &quot;Arsenal score before half-time.&quot; Add Called It to your Telegram group, say a football
          call, and let the group take a side from the live match data.
        </p>

        {telegramGroupUrl ? (
          <a
            href={telegramGroupUrl}
            className="display-type mt-6 flex min-h-11 items-center justify-center rounded-lg bg-pitch-500 px-5 py-3 text-center text-lg text-night-950 transition-colors hover:bg-pitch-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-night-950 motion-reduce:transition-none"
          >
            Add to Telegram group
          </a>
        ) : (
          <p role="status" className="mt-6 text-sm leading-relaxed text-fog">
            Telegram setup is unavailable. No call or SOL changed. Check the published bot
            configuration and try again.
          </p>
        )}

        <p className="mt-3 text-sm text-fog">
          {mainnet
            ? 'SOL positions use Solana mainnet.'
            : 'Runs on Solana devnet — these are test tokens.'}
        </p>
      </section>

      <section aria-labelledby="how-it-works" className="py-2">
        <h2 id="how-it-works" className="display-type text-xl text-chalk">
          Three moves
        </h2>
        <ol className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-3">
          {STEPS.map(([number, title, body]) => (
            <li key={title} className="grid grid-cols-[1.5rem_1fr] gap-2">
              <span className="display-type text-xl text-pitch-300" aria-hidden>
                {number}
              </span>
              <div>
                <h3 className="font-semibold text-chalk">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-fog">{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="proof-next" className="border-t border-line pt-5">
        <p className="text-sm font-semibold text-pitch-300">On the record</p>
        <h2 id="proof-next" className="display-type mt-1 text-2xl text-chalk">
          Settled calls carry their evidence.
        </h2>
        <p className="mt-2 max-w-lg text-sm leading-relaxed text-fog">
          Every settled call can have a public receipt with the match evidence and proof status.
        </p>
      </section>
    </PageShell>
  );
}
