'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import {
  ArrowRight,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Lock,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  WalletCards,
} from 'lucide-react';
import { Card } from '@/components/ui';
import {
  createEncryptedWallet,
  parseStoredVault,
  recoverEncryptedWallet,
  recoveryKeyFor,
  unlockEncryptedWallet,
  WALLET_VAULT_STORAGE_KEY,
  type EncryptedWalletVault,
} from '@/lib/wallet-vault';
import {
  explorerTransactionUrl,
  formatSol,
  MIN_WALLET_TRANSFER_LAMPORTS,
  parseSolAmount,
  sendWalletTransfer,
  walletBalance,
} from '@/lib/wallet-transfers';

type Phase = 'loading' | 'invalid' | 'create' | 'recover' | 'unlock' | 'backup' | 'linking' | 'ready';
type TransferMode = 'deposit' | 'send';

interface WalletManagerProps {
  readonly network: 'devnet' | 'mainnet-beta';
  readonly rpcUrl: string;
  readonly treasuryPubkey: string;
}

interface ChallengeResponse {
  readonly challengeId: string;
  readonly message: string;
}

export function WalletManager({ network, rpcUrl, treasuryPubkey }: WalletManagerProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [token, setToken] = useState('');
  const [vault, setVault] = useState<EncryptedWalletVault | null>(null);
  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryVisible, setRecoveryVisible] = useState(false);
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [confirmPasscode, setConfirmPasscode] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [transferMode, setTransferMode] = useState<TransferMode>('deposit');
  const [amount, setAmount] = useState('0.01');
  const [destination, setDestination] = useState('');
  const [transferPending, setTransferPending] = useState(false);
  const [lastSignature, setLastSignature] = useState('');
  const [forgetConfirm, setForgetConfirm] = useState(false);

  const configurationReady = rpcUrl.length > 0 && treasuryPubkey.length > 0;
  const pubkey = keypair?.publicKey.toBase58() ?? vault?.pubkey ?? '';

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const sessionToken = params.get('token') ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) {
      setPhase('invalid');
      return;
    }
    setToken(sessionToken);
    const stored = parseStoredVault(window.localStorage.getItem(WALLET_VAULT_STORAGE_KEY));
    setVault(stored);
    setPhase(stored === null ? 'create' : 'unlock');
  }, []);

  const refreshBalance = useCallback(async (wallet: Keypair | null = keypair) => {
    if (wallet === null || rpcUrl.length === 0) return;
    setBalanceLoading(true);
    try {
      setBalance(await walletBalance(rpcUrl, wallet.publicKey));
    } catch {
      setNotice('Balance could not refresh. Try again shortly.');
    } finally {
      setBalanceLoading(false);
    }
  }, [keypair, rpcUrl]);

  const linkWallet = useCallback(async (wallet: Keypair) => {
    if (token.length === 0) {
      setError('Open /wallet in Telegram again to get a fresh private link.');
      return;
    }
    setPhase('linking');
    setError('');
    try {
      const challengeResponse = await fetch('/api/wallet/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ token, pubkey: wallet.publicKey.toBase58() }),
      });
      const challengeBody = await readJson(challengeResponse);
      if (!challengeResponse.ok || !isChallenge(challengeBody)) {
        throw new Error(walletError(challengeBody));
      }
      const signature = nacl.sign.detached(
        new TextEncoder().encode(challengeBody.message),
        wallet.secretKey,
      );
      const verifyResponse = await fetch('/api/wallet/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          token,
          pubkey: wallet.publicKey.toBase58(),
          challengeId: challengeBody.challengeId,
          signatureHex: bytesToHex(signature),
        }),
      });
      const verifyBody = await readJson(verifyResponse);
      if (!verifyResponse.ok) throw new Error(walletError(verifyBody));
      setKeypair(wallet);
      setRecoveryKey('');
      setRecoveryVisible(false);
      setPhase('ready');
      setNotice('Wallet verified. You can fund this address and deposit SOL into Called It.');
      window.history.replaceState(null, '', '/wallet');
      void refreshBalance(wallet);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet linking failed.');
      setPhase(vault === null ? 'create' : 'unlock');
    }
  }, [refreshBalance, token, vault]);

  async function createWallet(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (passcode !== confirmPasscode) {
      setError('The passcodes do not match.');
      return;
    }
    try {
      const created = await createEncryptedWallet(passcode);
      window.localStorage.setItem(WALLET_VAULT_STORAGE_KEY, JSON.stringify(created.vault));
      setVault(created.vault);
      setKeypair(created.keypair);
      setRecoveryKey(created.recoveryKey);
      setRecoveryVisible(true);
      setPasscode('');
      setConfirmPasscode('');
      setPhase('backup');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet creation failed.');
    }
  }

  async function recoverWallet(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (passcode !== confirmPasscode) {
      setError('The passcodes do not match.');
      return;
    }
    try {
      const recovered = await recoverEncryptedWallet(recoveryInput, passcode);
      window.localStorage.setItem(WALLET_VAULT_STORAGE_KEY, JSON.stringify(recovered.vault));
      setVault(recovered.vault);
      setKeypair(recovered.keypair);
      setRecoveryKey('');
      setRecoveryInput('');
      setPasscode('');
      setConfirmPasscode('');
      await linkWallet(recovered.keypair);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet recovery failed.');
    }
  }

  async function unlockWallet(event: FormEvent) {
    event.preventDefault();
    if (vault === null) return;
    setError('');
    try {
      const unlocked = await unlockEncryptedWallet(vault, passcode);
      setKeypair(unlocked);
      setPasscode('');
      await linkWallet(unlocked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet unlock failed.');
    }
  }

  async function copyValue(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1500);
  }

  async function submitTransfer(event: FormEvent) {
    event.preventDefault();
    if (keypair === null) return;
    const lamports = parseSolAmount(amount);
    if (lamports === null || lamports < MIN_WALLET_TRANSFER_LAMPORTS) {
      setError('Enter at least 0.001 SOL.');
      return;
    }
    const target = transferMode === 'deposit' ? treasuryPubkey : destination.trim();
    if (target.length === 0) {
      setError('Enter a destination address.');
      return;
    }
    setTransferPending(true);
    setError('');
    setNotice('');
    setLastSignature('');
    try {
      const signature = await sendWalletTransfer({ rpcUrl, keypair, destination: target, lamports });
      setLastSignature(signature);
      setNotice(
        transferMode === 'deposit'
          ? 'Deposit sent. Your Called It balance should update in Telegram within about a minute.'
          : 'SOL sent successfully.',
      );
      await refreshBalance(keypair);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Transfer failed.');
    } finally {
      setTransferPending(false);
    }
  }

  function forgetWallet() {
    if (!forgetConfirm) {
      setForgetConfirm(true);
      return;
    }
    window.localStorage.removeItem(WALLET_VAULT_STORAGE_KEY);
    setVault(null);
    setKeypair(null);
    setRecoveryKey('');
    setRecoveryVisible(false);
    setForgetConfirm(false);
    setBalance(null);
    setPhase('create');
    setNotice('Wallet removed from this device. Recover it later with your recovery key.');
  }

  if (!configurationReady) {
    return <StatePanel title="Wallet unavailable" text="Wallet configuration is incomplete. No SOL moved." />;
  }
  if (phase === 'loading') {
    return <StatePanel title="Opening wallet" text="Checking this private wallet session..." loading />;
  }
  if (phase === 'invalid') {
    return (
      <StatePanel
        title="Open this from Telegram"
        text="Send /wallet to Called It in a private chat, then tap Create or manage wallet."
      />
    );
  }

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <p className="text-xs font-semibold uppercase text-pitch-300">Self-custody Solana wallet</p>
        <h1 className="display-type text-4xl text-chalk sm:text-5xl">Called It Wallet</h1>
        <p className="max-w-lg text-sm leading-6 text-fog">
          Your key is created and encrypted on this device. Called It never receives it.
        </p>
      </header>

      {error.length > 0 && <Status tone="error">{error}</Status>}
      {notice.length > 0 && <Status tone="success">{notice}</Status>}

      {phase === 'create' && (
        <Card className="rounded-lg">
          <WalletHeading icon={<WalletCards />} title="Create a wallet" subtitle="Choose a passcode to encrypt it on this device." />
          <form className="mt-5 space-y-4" onSubmit={createWallet}>
            <PasscodeFields
              passcode={passcode}
              confirmPasscode={confirmPasscode}
              onPasscode={setPasscode}
              onConfirm={setConfirmPasscode}
            />
            <PrimaryButton icon={<WalletCards size={18} />}>Create Solana wallet</PrimaryButton>
          </form>
          <button
            type="button"
            className="mt-4 w-full rounded-lg px-4 py-3 text-sm font-semibold text-sky-400 hover:bg-night-800 focus-visible:outline-2 focus-visible:outline-sky-400"
            onClick={() => { setError(''); setPhase('recover'); }}
          >
            I already have a recovery key
          </button>
        </Card>
      )}

      {phase === 'recover' && (
        <Card className="rounded-lg">
          <WalletHeading icon={<KeyRound />} title="Recover wallet" subtitle="Enter the recovery key and choose a new device passcode." />
          <form className="mt-5 space-y-4" onSubmit={recoverWallet}>
            <Field label="Recovery key">
              <textarea
                required
                rows={4}
                value={recoveryInput}
                onChange={(event) => setRecoveryInput(event.target.value)}
                className={inputClass}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </Field>
            <PasscodeFields
              passcode={passcode}
              confirmPasscode={confirmPasscode}
              onPasscode={setPasscode}
              onConfirm={setConfirmPasscode}
            />
            <PrimaryButton icon={<KeyRound size={18} />}>Recover and verify</PrimaryButton>
          </form>
          <button type="button" className="mt-4 w-full py-3 text-sm text-fog" onClick={() => setPhase('create')}>
            Back to wallet creation
          </button>
        </Card>
      )}

      {phase === 'unlock' && vault !== null && (
        <Card className="rounded-lg">
          <WalletHeading icon={<Lock />} title="Unlock wallet" subtitle={shortAddress(vault.pubkey)} />
          <form className="mt-5 space-y-4" onSubmit={unlockWallet}>
            <Field label="Passcode">
              <input required type="password" value={passcode} onChange={(event) => setPasscode(event.target.value)} className={inputClass} autoComplete="current-password" />
            </Field>
            <PrimaryButton icon={<Lock size={18} />}>Unlock and verify</PrimaryButton>
          </form>
          <button
            type="button"
            className="mt-4 w-full py-3 text-sm text-siren-300"
            onClick={() => { window.localStorage.removeItem(WALLET_VAULT_STORAGE_KEY); setVault(null); setPhase('recover'); }}
          >
            Recover a different wallet
          </button>
        </Card>
      )}

      {phase === 'backup' && keypair !== null && (
        <Card className="rounded-lg">
          <WalletHeading icon={<ShieldCheck />} title="Wallet created" subtitle="Save the recovery key before adding SOL." />
          <div className="mt-5 space-y-5">
            <ValueRow label="Wallet address" value={keypair.publicKey.toBase58()} copied={copied === 'address'} onCopy={() => copyValue('address', keypair.publicKey.toBase58())} />
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-semibold text-chalk">Recovery key</span>
                <button type="button" className="flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm text-fog hover:bg-night-800" onClick={() => setRecoveryVisible((visible) => !visible)}>
                  {recoveryVisible ? <EyeOff size={17} /> : <Eye size={17} />}
                  {recoveryVisible ? 'Hide' : 'Reveal'}
                </button>
              </div>
              <div className="rounded-lg border border-siren-500/40 bg-siren-500/10 p-4">
                <p className="break-all font-mono text-sm leading-6 text-siren-300">
                  {recoveryVisible ? recoveryKey : '********************************'}
                </p>
                {recoveryVisible && (
                  <button type="button" className="mt-3 flex min-h-11 items-center gap-2 text-sm font-semibold text-sky-400" onClick={() => copyValue('recovery', recoveryKey)}>
                    {copied === 'recovery' ? <Check size={17} /> : <Copy size={17} />}
                    {copied === 'recovery' ? 'Copied' : 'Copy recovery key'}
                  </button>
                )}
              </div>
            </div>
            <label className="flex cursor-pointer items-start gap-3 text-sm leading-5 text-fog">
              <input type="checkbox" checked={backupConfirmed} onChange={(event) => setBackupConfirmed(event.target.checked)} className="mt-1 size-4 accent-pitch-400" />
              <span>I saved the recovery key somewhere private. Losing it means losing access to this wallet.</span>
            </label>
            <PrimaryButton disabled={!backupConfirmed} icon={<ArrowRight size={18} />} onClick={() => void linkWallet(keypair)}>
              Verify wallet
            </PrimaryButton>
          </div>
        </Card>
      )}

      {phase === 'linking' && <StatePanel title="Verifying wallet" text="Signing an ownership message. No SOL is moving." loading />}

      {phase === 'ready' && keypair !== null && (
        <>
          <Card className="rounded-lg">
            <div className="flex items-start justify-between gap-3">
              <WalletHeading icon={<WalletCards />} title="Your wallet" subtitle={network === 'mainnet-beta' ? 'Solana mainnet' : 'Solana devnet'} />
              <button type="button" title="Refresh balance" className="grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fog hover:bg-night-800" onClick={() => void refreshBalance()}>
                <RefreshCw size={18} className={balanceLoading ? 'animate-spin' : ''} />
              </button>
            </div>
            <div className="mt-5 border-y border-line py-4">
              <p className="text-xs font-semibold uppercase text-fog">On-chain balance</p>
              <p className="mt-1 text-3xl font-bold text-chalk">{balance === null ? '-' : `${formatSol(balance)} SOL`}</p>
            </div>
            <div className="mt-4">
              <ValueRow label="Receive SOL at" value={pubkey} copied={copied === 'address'} onCopy={() => copyValue('address', pubkey)} />
            </div>
          </Card>

          <Card className="rounded-lg">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-night-800 p-1">
              <ModeButton active={transferMode === 'deposit'} onClick={() => setTransferMode('deposit')}>Deposit to Called It</ModeButton>
              <ModeButton active={transferMode === 'send'} onClick={() => setTransferMode('send')}>Send SOL</ModeButton>
            </div>
            <form className="mt-5 space-y-4" onSubmit={submitTransfer}>
              {transferMode === 'send' && (
                <Field label="Destination address">
                  <input required value={destination} onChange={(event) => setDestination(event.target.value)} className={inputClass} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                </Field>
              )}
              <Field label="Amount in SOL">
                <input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} className={inputClass} />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                {['0.01', '0.05', '0.1'].map((preset) => (
                  <button key={preset} type="button" className="min-h-11 rounded-lg border border-line text-sm font-semibold text-fog hover:border-pitch-500 hover:text-chalk" onClick={() => setAmount(preset)}>
                    {preset}
                  </button>
                ))}
              </div>
              <PrimaryButton disabled={transferPending} icon={transferPending ? <LoaderCircle className="animate-spin" size={18} /> : <Send size={18} />}>
                {transferMode === 'deposit' ? 'Deposit SOL' : 'Send SOL'}
              </PrimaryButton>
            </form>
            {lastSignature.length > 0 && (
              <a className="mt-4 block break-all text-sm text-sky-400 underline underline-offset-4" href={explorerTransactionUrl(lastSignature, network)} target="_blank" rel="noreferrer">
                View transaction
              </a>
            )}
          </Card>

          <Card className="rounded-lg">
            <WalletHeading icon={<KeyRound />} title="Recovery and device" subtitle="The recovery key is never sent to Called It." />
            <div className="mt-5 space-y-3">
              <button type="button" className="flex min-h-12 w-full items-center justify-between rounded-lg border border-line px-4 text-left text-sm font-semibold text-chalk hover:bg-night-800" onClick={() => { setRecoveryKey(recoveryKeyFor(keypair)); setRecoveryVisible((visible) => !visible); }}>
                <span>{recoveryVisible ? 'Hide recovery key' : 'Reveal recovery key'}</span>
                {recoveryVisible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
              {recoveryVisible && recoveryKey.length > 0 && (
                <div className="rounded-lg border border-siren-500/40 bg-siren-500/10 p-4">
                  <p className="break-all font-mono text-sm leading-6 text-siren-300">{recoveryKey}</p>
                  <button type="button" className="mt-3 flex min-h-11 items-center gap-2 text-sm font-semibold text-sky-400" onClick={() => copyValue('recovery', recoveryKey)}>
                    {copied === 'recovery' ? <Check size={17} /> : <Copy size={17} />}
                    {copied === 'recovery' ? 'Copied' : 'Copy recovery key'}
                  </button>
                </div>
              )}
              <button type="button" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-siren-500/40 px-4 text-sm font-semibold text-siren-300 hover:bg-siren-500/10" onClick={forgetWallet}>
                <Trash2 size={18} />
                {forgetConfirm ? 'Confirm: forget this device' : 'Forget this device'}
              </button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function PasscodeFields(props: {
  passcode: string;
  confirmPasscode: string;
  onPasscode(value: string): void;
  onConfirm(value: string): void;
}) {
  return (
    <>
      <Field label="Passcode">
        <input required minLength={8} type="password" value={props.passcode} onChange={(event) => props.onPasscode(event.target.value)} className={inputClass} autoComplete="new-password" />
      </Field>
      <Field label="Confirm passcode">
        <input required minLength={8} type="password" value={props.confirmPasscode} onChange={(event) => props.onConfirm(event.target.value)} className={inputClass} autoComplete="new-password" />
      </Field>
    </>
  );
}

function WalletHeading({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-pitch-500/15 text-pitch-300">{icon}</span>
      <div className="min-w-0">
        <h2 className="text-lg font-bold text-chalk">{title}</h2>
        <p className="text-sm leading-5 text-fog">{subtitle}</p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-2 text-sm font-semibold text-chalk"><span>{label}</span>{children}</label>;
}

function PrimaryButton(props: {
  children: ReactNode;
  icon: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type={props.onClick ? 'button' : 'submit'} disabled={props.disabled} onClick={props.onClick} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-pitch-400 px-4 text-sm font-bold text-night-950 hover:bg-pitch-300 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pitch-300">
      {props.icon}{props.children}
    </button>
  );
}

function ValueRow(props: { label: string; value: string; copied: boolean; onCopy(): void }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-fog">{props.label}</p>
      <div className="mt-2 flex items-start gap-2">
        <button type="button" className="min-w-0 flex-1 break-all text-left font-mono text-sm leading-6 text-sky-400" onClick={props.onCopy}>{props.value}</button>
        <button type="button" title={`Copy ${props.label}`} className="grid size-11 shrink-0 place-items-center rounded-lg border border-line text-fog hover:bg-night-800" onClick={props.onCopy}>
          {props.copied ? <Check size={18} /> : <Copy size={18} />}
        </button>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) {
  return <button type="button" className={`min-h-11 rounded-md px-2 text-sm font-semibold ${active ? 'bg-night-700 text-chalk' : 'text-fog'}`} onClick={onClick}>{children}</button>;
}

function Status({ tone, children }: { tone: 'error' | 'success'; children: ReactNode }) {
  return <div role="status" className={`rounded-lg border p-4 text-sm leading-6 ${tone === 'error' ? 'border-siren-500/40 bg-siren-500/10 text-siren-300' : 'border-pitch-500/40 bg-pitch-500/10 text-pitch-300'}`}>{children}</div>;
}

function StatePanel({ title, text, loading = false }: { title: string; text: string; loading?: boolean }) {
  return (
    <Card className="rounded-lg text-center">
      {loading && <LoaderCircle className="mx-auto mb-4 animate-spin text-pitch-300" size={28} />}
      <h1 className="text-xl font-bold text-chalk">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-fog">{text}</p>
    </Card>
  );
}

const inputClass = 'min-h-12 w-full rounded-lg border border-line bg-night-800 px-3 py-2 text-base text-chalk outline-none placeholder:text-fog/60 focus:border-pitch-400 focus:ring-2 focus:ring-pitch-400/20';

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isChallenge(value: unknown): value is ChallengeResponse {
  return typeof value === 'object' && value !== null &&
    'challengeId' in value && typeof value.challengeId === 'string' &&
    'message' in value && typeof value.message === 'string';
}

function walletError(value: unknown): string {
  const code = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
    ? value.error
    : '';
  switch (code) {
    case 'wallet_link_expired': return 'This private wallet link expired. Open /wallet in Telegram again.';
    case 'balance_nonzero': return 'Move or withdraw the existing Called It balance before changing wallets.';
    case 'positions_open': return 'Wait for your open positions to settle before changing wallets.';
    case 'withdrawal_pending': return 'Wait for the current withdrawal before changing wallets.';
    case 'pubkey_reserved': return 'This wallet is already linked to another Telegram account.';
    default: return 'Wallet verification failed. Open /wallet in Telegram and try again.';
  }
}
