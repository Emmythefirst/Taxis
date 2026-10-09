# Taxis

**An autonomous agent for recurring cross-border payments that never has unbounded access to your money, and never acts without showing its work first.**

Built for [Monad's Metropolis hackathon](https://monad.xyz) — Consumer Products & Payments track.

- **Live product:** https://taxis-pi.vercel.app
- **Backend API:** https://taxis-production-e532.up.railway.app

---

## The problem

Recurring cross-border payments force a bad tradeoff: either someone manually repeats the same transfer every cycle, or they hand it to automation that executes blindly on a fixed schedule with no visibility into what it's about to do. Crypto-native "payment agents" often make this worse — asking users to grant a bot broad, standing access to a wallet and simply trust it.

## The solution

Taxis gives an agent **bounded, verifiable authority**, never custody:

- The user's funds live in their own non-custodial embedded wallet (Privy — no seed phrase). Taxis never takes custody of it.
- The agent gets a narrow, cryptographically scoped, instantly revocable **session key** — a specific recipient, a specific cap, a specific expiry.
- **Before any payment executes** — a recurring cycle, a merchant-style checkout, or a peer-to-peer request — Taxis generates a **signed, expiring quote**: exact recipient, amount, live FX rate, itemized fee, nonce, all bound together.
- That quote is checked against limits the user set themselves (FX drift tolerance, fee ceiling, monthly cap). Only inside those bounds does it auto-execute. Outside them, it pauses and shows the user the exact numbers — current cost vs. their limit — rather than executing anyway or silently failing.
- A one-tap **kill switch** revokes the agent's access instantly, independent of any schedule.
- A **dead-man's-switch**: if the user goes inactive for a period they choose, scheduled payments can redirect to a pre-authorized backup recipient instead of silently stalling — set up as its own separate, independently-revocable grant, never bundled into day-to-day authority.

The same quote-then-bounded-authorize mechanism also powers:
- **Merchant checkout** — a live, owner-approved, single-use authorization per purchase.
- **Peer-to-peer requests** — any user can generate a QR code or link asking to be paid a specific amount; anyone else can scan or open it to pay, going through the identical signed-quote flow.

Settlement is in **AUSD** (Agora's stablecoin) on **Monad**. Scheduling is built on **Chainlink CRE**'s workflow model.

**Explicitly out of scope for this build:** a real fiat-to-AUSD on-ramp (a regulated money-transmission problem, not a hackathon-scope one) — the demo assumes the user already holds AUSD, via testnet faucet or exchange withdrawal.

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────┐
│  Frontend   │ ───▶ │  Backend API      │ ───▶ │  Privy      │
│  (Vite/     │      │  (Node/SQLite)    │      │  (session   │
│   React)    │ ◀─── │                   │ ◀─── │   keys +    │
└─────────────┘      └──────────────────┘      │   policy    │
                              │                  │   engine)   │
                              ▼                  └─────────────┘
                      ┌──────────────┐                  │
                      │ Chainlink CRE│                  ▼
                      │  (schedule / │          ┌─────────────┐
                      │   trigger)   │          │   Monad     │
                      └──────────────┘          │  (AUSD /    │
                                                 │   Agora)    │
                                                 └─────────────┘
```

- **Custody**: session-key model, not a vault. The user's wallet (Privy embedded wallet) holds funds at all times; the agent holds only a scoped, revocable permission on that wallet, enforced natively by Privy's policy engine (recipient allowlist, per-transaction cap, expiry) — not just promised in application code.
- **Trust layer**: every execution path runs the same per-cycle decision loop — is this due, is the recipient still allowlisted, what's the live FX-adjusted cost, is it within tolerance, is there enough balance, atomically reserve the cumulative-cap allocation, sign the quote, execute or pause for approval. See `backend/src/domain/decisionLoop.ts`.
- **Explainability**: every payment — executed or paused — comes with a plain-language breakdown of exactly which checks passed or failed, not a generic status.
- **Scheduling**: a Chainlink CRE cron workflow (`automation/taxis-cre/`) calls the backend's trigger endpoint on a schedule. A local in-process scheduler (`backend/src/server.ts`'s `startLocalScheduler`) stands in for the always-on production trigger while CRE DON deployment access is pending approval — the decision loop and trigger endpoint themselves are real and already proven against a live CRE workflow; the always-on polling layer is the piece not yet live.

## Repo structure

```
backend/      HTTP API, domain logic, Privy/Monad integration, SQLite persistence
frontend/     Vite + React + TypeScript SPA
automation/   Chainlink CRE workflow (cron trigger -> backend)
progress.md   Full build log and design-decision history (local-only, not committed)
```

## Tech stack

| Layer | Choice |
|---|---|
| Settlement | AUSD (Agora) on Monad |
| Wallet / session keys | Privy — embedded wallets, policy engine |
| Scheduling | Chainlink CRE |
| Backend | Node.js, TypeScript, SQLite (`better-sqlite3`), `viem` |
| Frontend | Vite, React, TypeScript, React Router |

## Running locally

Requires Node >= 20.

```bash
git clone https://github.com/Emmythefirst/Taxis.git
cd Taxis
npm install

# Backend
cp backend/.env.example backend/.env   # fill in Privy/Monad credentials — see comments in the file
npm run server --workspace=backend     # http://localhost:8787

# Frontend (separate terminal)
cp frontend/.env.example frontend/.env
npm run dev --workspace=frontend       # http://localhost:5173
```

Without a filled-in `backend/.env`, the backend still starts in **list-only mode** — obligations/cycles can be read but nothing executes live, and checkout/payment-request routes return 503. Full `.env.example` files in both `backend/` and `frontend/` document every variable and how to obtain it (Privy key quorums, Monad testnet RPC, AUSD contract address, etc.).

### Tests

```bash
npm test               # backend test suite (vitest)
npm run typecheck      # both workspaces
```

## Deployment

- **Frontend** deploys to Vercel from `frontend/` (Vite preset, auto-detected).
- **Backend** deploys to Railway from `backend/` — a long-running Node process, not serverless, since it holds a local SQLite file and runs the in-process scheduler. Needs a persistent volume for `TAXIS_DB_PATH`.

## Bounty targets

- **Agora** — Best Cross-Border Payments App on Monad
- **Privy** — wallet/session-key layer
- **Chainlink** — Best workflow with CRE
