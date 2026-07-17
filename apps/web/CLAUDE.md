# apps/web, receipts, group page, landing (Next.js 15 App Router)

Read-only shop window. It talks to Supabase with the anon key and reads only `public_*`
views (`public_receipts`, `public_evidence`), never tables, never the service key. No
auth, no writes, no API routes. Every page degrades gracefully when env or data is
missing instead of white-screening. Keep it that way.

## Routes

- `/`, the landing page. Optional `NEXT_PUBLIC_TELEGRAM_GROUP_URL` and
  `NEXT_PUBLIC_SAMPLE_RECEIPT_URL` power the CTAs (note: those two names are missing from
  the root `.env.example`).
- `/r/[marketId]`, the receipt: terms, price, outcome, evidence timeline, trust badge.
- `/g/[slug]`, the group page, a flat "On the record" receipts list (the Rep-era
  leaderboard is gone, and `public_leaderboard` still exists in the DB but has no consumer
  here).

`/g/[slug]` returns 404 for `web_enabled=false` groups by construction: the view filters
those rows out, so zero rows leads to `notFound()`.

## The verify bridge (the one tricky part)

In-browser Merkle re-verification imports `solana-verify-bridge`, an alias defined in
`next.config.ts`:
- it resolves to the built `@calledit/solana/verify` (isomorphic, no node imports, no
  `@solana/web3.js`) when `packages/solana/dist` exists,
- and falls back to `lib/verify-fallback.ts` (same surface, but verification reports
  "unavailable") when it does not, so a web-only checkout still builds.

Never import `@calledit/solana/verify` directly from web code, and never add a node-only
import to the verify surface. The real call path is `components/trust-badge.tsx` calling
`fetchOnchainRoots` (plural, because the daily PDA holds 288 five-minute root slots) plus
`verifyMerkleProof`. It requires BOTH `NEXT_PUBLIC_SOLANA_RPC_URL` and
`NEXT_PUBLIC_TXORACLE_PROGRAM_ID`, and if either is missing the badge shows "no public
RPC configured" instead of failing.

## Env (all public)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SOLANA_RPC_URL`,
`NEXT_PUBLIC_TXORACLE_PROGRAM_ID`, in `apps/web/.env.local` (never the service-role key).
Vercel deploys via `apps/web/vercel.json`.

## Stale-comment warning

`lib/receipts.ts` claims `merkle_proof` is "not exposed by the current view", which is
wrong: it has been in `public_receipts` since 0001 and is what the trust badge consumes.
Row shapes actually come from migrations 0001 plus 0002 plus 0003 combined (`currency`
arrived in 0002/0003), not 0001 alone as the header comment says.

Dev: `pnpm --dir apps/web exec next dev --hostname 127.0.0.1 --port 3020`.
