Task 8 wallet-intake correction summary

- Failing-first proof:
  - `task-8-failing-first-head-proof.txt` reran the new `/wallet` characterization against clean `HEAD` in a scratch worktree at `20e7d6d`.
  - Clean `HEAD` failed three ways:
    - pasted valid base58 text created a wallet link
    - orphan deposits were auto-credited on that paste path
    - invalid/reserved inputs returned old raw-intake copy instead of a uniform fail-closed response

- Scoped engine correction:
  - removed raw `/wallet <pubkey>` mutation behavior from the engine module
  - removed the now-unused `linkWallet` mutation seam from the wager DB interface and fake DB
  - replaced the old wallet-linking copy variants with one fail-closed response
  - updated deposit comments/tests and the migration comment to describe wallet verification instead of `/wallet link`

- Verification:
  - `task-8-engine-focused-tests.txt`
  - `task-8-db-wallet-tests.txt`
  - `task-8-typecheck-build-copy.txt`
  - `task-8-hygiene-checks.txt`
  - `task-8-manual-api-wallet-probe.txt`

- SQL harness:
  - `task-8-sql-wallet-identity-tests.txt` shows `scripts/sql-harness.wallet-identity.test.ts` is blocked in this shell because `DATABASE_URL` or `POSTGRES_URL` is unset.
  - No SQL source change was required for behavior beyond a stale comment rename in `packages/db/migrations/0002_wager.sql`.
