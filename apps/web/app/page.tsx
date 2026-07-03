import type { Metadata } from 'next';
import { Badge, Card, PageShell, SectionTitle } from '@/components/ui';

export const metadata: Metadata = {
  description:
    'An agentic bot for your group chat that prices big match-night claims on the spot, settles them from verified data, and keeps the receipts forever.',
};

/**
 * Link placeholders — swap in the real demo group invite and a flagship
 * settled receipt before submission.
 */
const DEMO_GROUP_URL = '#demo-group';
const SAMPLE_RECEIPT_URL = '#sample-receipt';

const LOOP_STEPS = [
  {
    step: '01',
    title: 'Make the call',
    body: 'Someone talks big in the chat — “Mbappé scores twice today”. The bot prices it on the spot: Data says 9%. Anyone want to make him prove it?',
  },
  {
    step: '02',
    title: 'Back it or doubt it',
    body: 'One tap and your Rep is on the line at ×9 — the multiplier locks the second you commit. VAR check? Calls locked until it clears.',
  },
  {
    step: '03',
    title: 'Keep the receipt',
    body: 'The moment the deciding stat confirms, it settles — no arguments. The receipt lives on a public page with the evidence and a proof anyone can check on Solana.',
  },
] as const;

export default function LandingPage() {
  return (
    <PageShell topRight={<Badge tone="pitch">Live on Telegram</Badge>}>
      {/* Masthead */}
      <div className="mt-6 sm:mt-10">
        <p className="display-type text-[13px] tracking-[0.3em] text-pitch-400">
          Big mouth? Prove it.
        </p>
        <h1 className="display-type mt-2 text-6xl text-chalk sm:text-7xl">
          Called <span className="text-pitch-400">It</span>
        </h1>
        <p className="mt-4 max-w-md text-base leading-relaxed text-fog">
          The bot that lives in your group chat and turns match-night claims into priced calls —
          settled from cryptographically verified match data seconds after the moment, with
          receipts that never let anyone forget.
        </p>
      </div>

      {/* The loop */}
      <div className="mt-6 space-y-3">
        <SectionTitle>The loop</SectionTitle>
        {LOOP_STEPS.map(({ step, title, body }) => (
          <Card key={step} className="flex gap-4">
            <span className="display-type text-3xl text-line" aria-hidden>
              {step}
            </span>
            <div>
              <h3 className="display-type text-xl text-chalk">{title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-fog">{body}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Trust strip */}
      <Card className="border-pitch-500/30 bg-pitch-500/5">
        <div className="flex items-start gap-3">
          <Badge tone="pitch" className="mt-0.5 shrink-0">
            Chain-proven ✓
          </Badge>
          <p className="text-sm leading-relaxed text-fog">
            Team-stat verdicts are re-checkable against a Merkle root published on Solana — in
            your browser, on this site. No wallet, no login, no app install.
          </p>
        </div>
      </Card>

      {/* Calls to action */}
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <a
          href={DEMO_GROUP_URL}
          className="display-type rounded-2xl bg-pitch-500 px-5 py-4 text-center text-lg text-night-950 transition-transform hover:scale-[1.01]"
        >
          Join the demo group →
        </a>
        <a
          href={SAMPLE_RECEIPT_URL}
          className="display-type rounded-2xl border border-line bg-night-800 px-5 py-4 text-center text-lg text-chalk transition-colors hover:border-pitch-500/50"
        >
          See a sample receipt
        </a>
      </div>

      <p className="mt-1 text-center text-xs text-fog/80">
        Rep is the group’s points tally — it can’t be bought, sold, or cashed out.
      </p>
    </PageShell>
  );
}
