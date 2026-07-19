import {
  ArrowUpRight,
  CircleDollarSign,
  Database,
  FileCheck2,
  MessageCircle,
  ScanLine,
  ShieldCheck,
  Users,
} from 'lucide-react';

const TXLINE_URL = 'https://txodds.net/our-products/tx-line/';

const FLOW_STEPS = [
  {
    number: '01',
    icon: MessageCircle,
    title: 'Make a prediction',
    body: 'Post a football prediction in your Telegram group.',
    signal: 'TELEGRAM',
  },
  {
    number: '02',
    icon: Users,
    title: 'Pick yes or no',
    body: 'Friends choose whether they agree and add SOL.',
    signal: 'YES OR NO',
  },
  {
    number: '03',
    icon: ShieldCheck,
    title: 'Rumble settles it',
    body: 'After the match, Rumble checks the result and pays the winners.',
    signal: 'RESULT',
  },
  {
    number: '04',
    icon: FileCheck2,
    title: 'Everyone gets the receipt',
    body: 'The group can see the result, payouts and refunds.',
    signal: 'RECEIPT',
  },
] as const;

const FAQS = [
  {
    question: 'What is Rumble?',
    answer:
      'Rumble is a Telegram bot where friends put SOL on football predictions. The group picks yes or no, and Rumble settles it after the match.',
  },
  {
    question: 'How do I make a prediction?',
    answer:
      'Tag Rumble with a football prediction. If Rumble notices one on its own, it asks the person who said it before posting anything.',
  },
  {
    question: 'What can I pick?',
    answer:
      'Pick yes or no. A tap adds 0.01 SOL, or you can choose an allowed larger amount privately.',
  },
  {
    question: 'Who decides the result?',
    answer:
      'Rumble checks verified match results. AI never decides who won or who gets paid.',
  },
  {
    question: 'What happens to unmatched SOL?',
    answer:
      'If there is not enough SOL on the other side, the extra comes back to you.',
  },
  {
    question: 'What does the receipt show?',
    answer:
      'It shows the prediction, result, group totals, matched SOL, payouts and refunds. Messages, wallets, balances and individual picks stay private.',
  },
  {
    question: 'Does Rumble charge a fee?',
    answer: 'No. The current Rumble beta does not charge a platform fee.',
  },
  {
    question: 'What will Rumble never ask for?',
    answer:
      'Rumble will never ask for your seed phrase, private key or SOL in a private message.',
  },
] as const;

interface RumbleLandingProps {
  readonly mainnet: boolean;
  readonly qrCodeDataUrl: string | null;
  readonly telegramGroupUrl: string | null;
}

function RumbleWordmark() {
  return (
    <span className="rumble-wordmark">
      <span>Rumble</span>
      <span className="rumble-wordmark-stop" aria-hidden>.</span>
    </span>
  );
}

function QrPanel({ qrCodeDataUrl }: Pick<RumbleLandingProps, 'qrCodeDataUrl'>) {
  return (
    <aside className="qr-panel" aria-labelledby="qr-title">
      <span className="corner corner-tl" aria-hidden />
      <span className="corner corner-tr" aria-hidden />
      <span className="corner corner-bl" aria-hidden />
      <span className="corner corner-br" aria-hidden />
      <div className="qr-panel-heading">
        <ScanLine aria-hidden size={18} strokeWidth={1.6} />
        <h2 id="qr-title">Scan to add Rumble</h2>
      </div>
      {qrCodeDataUrl ? (
        <div className="qr-code-frame">
          <img
            src={qrCodeDataUrl}
            width="320"
            height="320"
            alt="QR code to add Rumble to a Telegram group"
          />
        </div>
      ) : (
        <div className="qr-unavailable">QR code unavailable</div>
      )}
    </aside>
  );
}

export function RumbleLanding({ mainnet, qrCodeDataUrl, telegramGroupUrl }: RumbleLandingProps) {
  return (
    <div className="rumble-landing">
      <div className="landing-grid" aria-hidden />
      <div className="landing-aurora landing-aurora-top" aria-hidden />

      <header className="landing-header">
        <a href="/" className="rumble-mark" aria-label="Rumble home">
          <RumbleWordmark />
        </a>

        {telegramGroupUrl ? (
          <a href={telegramGroupUrl} className="header-add-link">
            Add to group
            <ArrowUpRight aria-hidden size={16} strokeWidth={1.8} />
          </a>
        ) : (
          <span className="header-unavailable">TELEGRAM / UNAVAILABLE</span>
        )}
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-title">
          <div className="hero-copy">
            <h1 id="landing-title" className="hero-statement">
              <span>Got a football take?</span>
              <strong>Put it to the group.</strong>
            </h1>
            <p className="hero-description">
              Rumble is a Telegram bot where friends put SOL on football predictions. The group
              picks yes or no. Rumble settles it after the match.
            </p>

            {telegramGroupUrl ? (
              <div className="hero-actions">
                <a href={telegramGroupUrl} className="telegram-cta">
                  <MessageCircle aria-hidden size={19} strokeWidth={1.8} />
                  Add Rumble to your group
                  <span className="cta-arrow" aria-hidden>
                    <ArrowUpRight size={17} strokeWidth={1.8} />
                  </span>
                </a>
              </div>
            ) : (
              <p role="status" className="landing-error">
                Telegram setup is unavailable. No call or SOL changed. Check the published bot
                configuration and try again.
              </p>
            )}

            {!mainnet && (
              <p className="network-disclosure">
                <span aria-hidden>PUBLIC BETA</span>
                Rumble is currently in public beta and only supports Solana devnet.
              </p>
            )}
          </div>

          <QrPanel qrCodeDataUrl={qrCodeDataUrl} />
        </section>

        <section className="signal-strip" aria-label="Rumble trust summary">
          <div><ShieldCheck aria-hidden size={16} /> You stay in control</div>
          <div>
            <Database aria-hidden size={16} />
            <span>
              Match results by <a href={TXLINE_URL} target="_blank" rel="noreferrer">TxLINE</a>
            </span>
          </div>
          <div><FileCheck2 aria-hidden size={16} /> Clear receipts</div>
          <div><CircleDollarSign aria-hidden size={16} /> No platform fee</div>
        </section>

        <section className="landing-section flow-section" aria-labelledby="flow-title">
          <div className="section-intro">
            <h2 id="flow-title">How it works.</h2>
            <p>Everything happens in Telegram.</p>
          </div>

          <ol className="flow-grid">
            {FLOW_STEPS.map(({ number, icon: Icon, title, body, signal }) => (
              <li key={number} className="flow-card">
                <div className="flow-card-meta">
                  <span>{number}</span>
                  <span>{signal}</span>
                </div>
                <Icon aria-hidden size={22} strokeWidth={1.5} />
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section proof-section" aria-labelledby="proof-title">
          <div className="proof-copy">
            <h2 id="proof-title">This is what Rumble posts after the match.</h2>
          </div>

          <div className="receipt-preview" aria-label="Rumble result posted in Telegram">
            <div className="receipt-message-header">
              <span className="receipt-avatar" aria-hidden>R</span>
              <div>
                <strong>Rumble</strong>
                <span>Prediction settled</span>
              </div>
            </div>
            <p className="receipt-prediction">Will Arsenal score before half-time?</p>
            <div className="receipt-result">
              <span>Result</span>
              <strong>Yes won</strong>
            </div>
            <dl className="receipt-totals">
              <div><dt>Matched</dt><dd>0.08 SOL</dd></div>
              <div><dt>Paid to winners</dt><dd>0.08 SOL</dd></div>
              <div><dt>Returned</dt><dd>0.02 SOL</dd></div>
            </dl>
            <div className="receipt-links">
              <a href={TXLINE_URL} target="_blank" rel="noreferrer">Match result by TxLINE</a>
              <span>Payment confirmed on Solana</span>
            </div>
          </div>
        </section>

        <section className="landing-section faq-section" aria-labelledby="faq-title">
          <div className="section-intro faq-intro">
            <h2 id="faq-title">FAQ</h2>
          </div>

          <div className="faq-list">
            {FAQS.map(({ question, answer }, index) => (
              <details key={question} className="faq-item">
                <summary>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{question}</strong>
                  <span className="faq-toggle" aria-hidden>+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div>
          <a href="/" className="footer-mark" aria-label="Rumble home">
            <RumbleWordmark />
          </a>
          <p>You call it. Rumble settles it.</p>
        </div>
        <p className="footer-copy">© 2026 RUMBLE</p>
      </footer>
    </div>
  );
}
