# Releases

## 0.1.1-devnet.0 - 2026-07-16

- Devnet escrow position approvals sign directly through the embedded Privy wallet.
- The Telegram Mini App no longer opens Privy's modal, which crashes in Telegram's webview.
- Replay approvals retain a usable real-time signing window and replay setup has an admin grace period.

Deployment target: `called-it-snowy.vercel.app` (devnet test assets).

## Release Rules

- Each deployed change is committed before deployment.
- Each release receives an annotated Git tag matching this file and `package.json`.
- Patch releases fix behavior without changing user-facing protocol terms; minor releases add a user-facing capability.
