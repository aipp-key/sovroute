# SOVROUTE — CONTINUITY / HANDOFF FILE

**Purpose:** This file is the canonical handoff note to continue SovRoute work if the current ChatGPT session is lost, reset, or moved to a new session.

**How to use in a new ChatGPT session:**
1. Upload this file.
2. Say: **“SovRoute projesine bu dosyadaki kaldığımız yerden devam et.”**
3. Do not assume any live server state from this file alone. Re-run the read-only status checks in the relevant sections before taking action.
4. Never expose or paste secrets. Use only secret file paths already provisioned on the server.

---

# 1. PROJECT IDENTITY

**Product:** SovRoute  
**Descriptor:** Sovereign Agent-Native Asset Execution Infrastructure  
**Domain:** `sovroute.com`

**GitHub private repo:** `aipp-key/sovroute`  
**Remote:** `https://github.com/aipp-key/sovroute.git`

**Local Windows path:**
`C:\Users\faruk\Desktop\universal-agent-asset-router`

The local folder name and some internal package names intentionally still use `universal-agent-asset-router`. Do not mass-rename historical/internal identifiers unless there is a specific reason.

**Brand strategy:**
- Product/repo/readme/website use SovRoute.
- Internal package renames are not required.
- Product UI should be minimal and extremely simple.
- Core value is the execution/recovery engine, not the dashboard.

---

# 2. CANONICAL PRODUCT ARCHITECTURE

## Current V4 route

Customer path:

`Lightning BTC Hold Invoice`
↕ same SHA-256 hashlock/preimage
`Direct Base canonical Circle USDC HTLC`

No Arbitrum/tBTC/CCTP/DEX in the synchronous customer execution path.

CCTP/DEX may exist later only as asynchronous treasury/rebalancing functionality.

## Successful economic flow

`Request`
→ reserve Base USDC
→ create Lightning hold invoice
→ customer pays BTC
→ invoice becomes ACCEPTED/HELD
→ lock operator-owned USDC in Base HTLC
→ customer claims USDC
→ preimage is revealed on Base
→ SovRoute detects the preimage
→ settle Lightning hold invoice
→ `COMPLETED`

## Failure flow

`BTC held`
→ `USDC locked`
→ customer never claims
→ Base timelock expires
→ operator USDC is refunded
→ authoritative refund is confirmed
→ cancel Lightning hold invoice
→ customer BTC is not taken

## Core invariant

**Base-side authoritative economic truth must exist before an irreversible Lightning terminal decision.**

A local database must never fabricate external terminal economic truth.

## Non-custodial wording

Do **not** market the system as “100% non-custodial.”

Preferred wording:
- user-key non-custodial
- trust-minimized execution
- router holds no user private keys
- operator treasury custody exists for operator-owned Base USDC inventory

---

# 3. CORE ENGINE STATUS — FROZEN / CLOSED

The core engineering closure is complete.

## Historical architecture baseline
`5196968017cd78ef4ef35c8c3c2c105de2a794e2`
`docs: reconcile V4 direct Base route architecture`

## Historical V1 app/source baseline
`357c5ab85344a2fa5602a5e376efc7ea80685498`
`docs: record certified Node 24 runtime`

**Never rewrite/amend these historical baselines.**

## Liquidity accounting closure
Main:
`9955640662f79cd24390ef034ebcb0d7a07dafe7`
`fix: make Base USDC inventory accounting durable and unit-safe`

Cross-process certification:
`906e5d1720ccd00b89a3f00778c1c302d4fe1da9`
`test: prove cross-process liquidity reservation safety`

Certification result:
- 100 USDC initial inventory
- 5 concurrent attempts × 30 USDC
- 3 success / 2 fail
- durable 90 reserved / 10 available
- **FULL PASS**

## Final remediation candidate
`d4b9672a06e025729302f4e4243be74c464501d0`
`fix: fail closed on invalid durable reservation transitions`

Independent review result:
- **PASS**
- **MERGE SAFE: YES**
- **DEPLOY SAFE: NO**

Verified behavior includes:
- missing durable reservation → `RESERVATION_NOT_FOUND`
- incompatible reservation state → `INVALID_RESERVATION_STATUS`
- same target status remains idempotent replay
- coordinator escalates reservation transition failures to recovery instead of fabricating terminal success
- chain reconciler behaves fail-closed
- action-scoped durable retry budgets remain independent
- reservation ownership/swap binding is checked in the funded transition helper

## Current canonical branch baseline

The canonical branch `phase-7-production-readiness-closure` was fast-forwarded and pushed to:

**`d4b9672a06e025729302f4e4243be74c464501d0`**

This is the current frozen engineering baseline.

### Important
Do not casually reopen or modify the core engine.

P2 hardening backlog item only:
- generic transition helper could later gain additional ownership checks

This is **not** a blocker and must not reopen the finished phase.

---

# 4. ENGINEERING PRINCIPLES

These are permanent SovRoute rules:

- security and recovery first
- fail closed
- durable idempotency
- crash/restart recovery
- `UNKNOWN` is a first-class state
- timeout != success
- timeout != failure
- no blind financial retry
- side-effecting mutations have action-scoped durable retry budgets
- authoritative chain observation may continue indefinitely
- least privilege
- narrow blast radius
- real funds require explicit owner approval
- backup is valid only after restore test
- core engine > UI
- no real funds before safety gates
- local state must not invent external terminal state

Liquidity availability invariant:

`W_safe - R - P`

Do not double-subtract collateral/committed inventory.

---

# 5. PRODUCTION SERVER

**Server alias:** `aliasdesk-server`  
**Provider:** Hetzner  
**OS:** Ubuntu 24.04  
**Kernel:** 6.8.0-31  
**Machine:** CX53  
**CPU:** 16 vCPU  
**RAM:** ~30 GiB  
**Disk:** ~301 GB SSD  
**Docker:** 27.0.3

---

# 6. AIPP ISOLATION — DO NOT BREAK

Existing AIPP production network:

`core_aipp_net`
`172.23.0.0/16`

Existing AIPP containers include:
- `aipp-key`
- `db`
- `redis`
- `phoenixd`
- `lnbits`

**AIPP must remain untouched and isolated from SovRoute infrastructure.**

Never attach SovRoute Bitcoin Core directly to the AIPP network.

---

# 7. SOVROUTE BITCOIN NETWORK TOPOLOGY

SovRoute chain network:

`sovereign_chain_net`
`10.240.10.0/24`

Bitcoin Core was assigned:
`10.240.10.2`

Future topology:

`Internet → SovRoute Router → router_net → LND → chain_net → Bitcoin Core`

Rules:
- LND will be dual-homed.
- Bitcoin Core must never join `router_net`.
- SovRoute Router must never join `chain_net`.
- LND is the controlled bridge between the two networks.

---

# 8. BITCOIN CORE CONFIGURATION

Container:
`sovereign-bitcoind`

Version:
**Bitcoin Core v31.1**

Network:
**mainnet**

Important settings:
- `prune=55000`
- prune target ~57.67 GB
- `dbcache=2048`
- `disablewallet=1`
- `listen=0`
- outbound only
- no public 8333
- no public 8332
- no public ZMQ
- UID/GID 2101
- no funds

Restart safety:
- persistent `networkactive=0`
- runtime network was explicitly enabled for IBD

The intent is that an uncontrolled restart does not automatically resume external network activity until deliberately enabled.

---

# 9. BITCOIN CORE RPC SECRET HANDLING

Never paste or expose the Bitcoin RPC password.

Secret path:

`/srv/sovereign-router/secrets/bitcoind_rpc_password`

Use `bitcoin-cli -stdinrpcpass`.

The RPC user is derived from `rpcauth=` inside the config.

Do not put the RPC password in:
- shell command line arguments
- chat
- logs
- screenshots
- Git
- documentation

An earlier RPC credential incident was closed and the credential was rotated.

Use the phrase:
**“IBD resumed successfully after controlled restart.”**

Do not repeat the old credential.

---

# 10. BITCOIN CORE IBD STATUS

IBD started on the night of **4 September 2026**.

## Status: COMPLETED

IBD fully completed and reached 100% tip synchronization on **7 September 2026**.

See **Section 30** for the certified final IBD closure checkpoint.

---

# 11. SAFE READ-ONLY IBD STATUS COMMAND

Run this from Windows PowerShell:

```powershell
$script = @'
set -e

RPCUSER=$(docker exec sovereign-bitcoind sh -lc "grep '^rpcauth=' /config/bitcoin.conf | head -n1 | cut -d= -f2 | cut -d: -f1")

echo "=== BLOCKCHAIN ==="
sudo -n cat /srv/sovereign-router/secrets/bitcoind_rpc_password |
  docker exec -i sovereign-bitcoind bitcoin-cli \
    -conf=/config/bitcoin.conf \
    -rpcuser="$RPCUSER" \
    -stdinrpcpass \
    getblockchaininfo

echo "=== CONTAINER ==="
docker inspect sovereign-bitcoind --format='status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}}'
'@

$script | ssh -T aliasdesk-server "bash -s"
```

This is a read-only check.

Main fields to inspect:
- `blocks`
- `headers`
- `verificationprogress`
- `initialblockdownload`
- `size_on_disk`
- `pruneheight`
- `warnings`
- container `status`
- container `health`
- `restarts`

---

# 12. IBD COMPLETION GATE

Do not proceed to LND because progress “looks close.”

IBD is considered complete only after verification that:

- `initialblockdownload=false`
- blocks are near the current network tip
- headers are near the current network tip
- verification is effectively complete
- container is healthy
- restart count remains acceptable
- warnings are empty
- pruning is functioning normally
- no security/isolation controls changed

At that point create an operational closure note:

```text
BITCOIN CORE IBD CLOSURE

RESULT: PASS
IBD: COMPLETE
HEALTH: HEALTHY
WARNINGS: NONE
PRUNING: HEALTHY
READY FOR LND PHASE 2E: YES
```

Record:
- date/time
- Core version
- final height
- final best block hash
- health
- restart count
- pruning state
- configuration summary

“IBD closure certificate” is our internal operational acceptance checkpoint, not an official Bitcoin Core feature.

---

# 13. NEXT INFRASTRUCTURE PHASES

Do not install production LND until IBD is complete and explicitly approved.

Roadmap:

## Phase 2D
Bitcoin Core IBD closure certification

## Phase 2E
Install LND with zero funds

Requirements:
- LND UID/GID 2102
- zero funds
- least privilege
- future restricted macaroon
- payment permissions denied by default
- Aezeed never stored in plaintext
- preserve Router/LND/Core network isolation

## Phase 2F
Wallet initialization / offline Aezeed owner approval

## Phase 2G
Bitcoin Core ↔ LND RPC/ZMQ integration

## Phase 2H
24-hour zero-fund burn-in

## Phase 2I
Router ↔ LND restricted API integration

## Phase 2J
Tiny BTC canary

**No real BTC until explicit owner approval.**

---

# 14. PRODUCT ROADMAP AFTER LND

Engineering priorities after LND infrastructure:

## 1. Quote Engine / Price Discovery / FX Risk — COMPLETED & VERIFIED

Status: **COMPLETED** (`src/pricing/`, 100% test pass rate, 11/11 tests).

Implementation details:
- Multi-source price aggregation: Coinbase, Kraken, Binance feeds.
- Median reference pricing with stale-price rejection (>30s).
- Quorum enforcement (>= 2 active feeds) and cross-feed dispersion ceiling (max 1.5% spread).
- Integer-safe math using BigInt (0 float rounding precision errors).
- Short quote validity: 20 seconds (`validityMs: 20_000`).
- Cryptographic HMAC-SHA256 signature binding all quote parameters against tampering.
- Frozen Core integration: Outputs clean `{ amountSats, expectedUsdcAmount }` matching `AtomicCoordinator.prepareSwap`.

## 2. Gasless Base UX

User should not need ETH just to claim Base USDC.

Candidate approach:
- relayer
- paymaster
- gas sponsorship

Gas layer must remain separate from core HTLC safety.

Gas cost may eventually be included in the quote.

## 3. Large-Scale Liquidity Management

Start with:
- safety buffer
- max concurrent exposure
- per-swap limits
- per-user limits
- replenishment thresholds
- low-liquidity `NOT_READY`

Do not jump directly to automatic treasury movement.

Treasury automation is a later phase.

## 4. Minimal Swap UI

Target user experience:

`You send sats`
`You receive USDC`
`Network: Base`
`Receive address`
`Continue`

Principle:
**Complexity inside, simplicity outside.**

---

# 15. PUBLIC PRODUCT / COMMERCIAL SURFACES

Potential product surfaces:

- SovRoute Core
- SDK/API
- Merchant Pay
- `swap.sovroute.com`
- Embedded/OEM
- self-hosted enterprise
- regulated partner mode

Long-term architecture may support two operating modes:

## Sovereign mode
Our infrastructure / our treasury / our execution

## Regulated provider mode
A licensed partner provides the regulated rail/compliance/treasury layer while SovRoute remains the execution/orchestration technology

Do not redesign Core around any specific partner yet.

---

# 16. LEGAL / COMPANY STRATEGY — CURRENT DECISION

Current decision:

**Do not incorporate yet.**

Reason:
- product is not yet fully live
- no meaningful revenue yet
- no need to start annual corporate fee clock prematurely
- current capital is better preserved for infrastructure, testing and liquidity

Target sequence:

`Core`
→ `LND`
→ `Quote Engine`
→ `Gasless UX`
→ `Minimal swap demo`
→ `tiny real canary`
→ `first users / first revenue signal`
→ `choose company/jurisdiction/legal structure`

Long-term goal:
A fully legal, low-maintenance global operation with:
- real legal entity
- registered office
- Terms
- Privacy
- geo-policy
- required registration/license if applicable

Current legal research candidates previously discussed:
- Anguilla
- Belize
- Nevis
- BVI

Re-check all rules and actual agent quotes at the time of incorporation. Do not rely on old research as final legal advice.

Zero local corporate tax in a foreign jurisdiction does not automatically eliminate the owner’s personal/tax-residency obligations.

---

# 17. LICENSED PARTNER / WHITE-LABEL IDEA — PARKED

This idea is valid but intentionally parked until the product is working.

Concept:
- licensed partner is the financial/legal counterparty
- partner handles KYC/KYB/sanctions/regulatory rails
- SovRoute provides execution engine, orchestration, SDK/API/UI
- partner may provide its own BTC/USDC liquidity

Lightspark was identified as an example of the model:
“Bring your license. Or ride ours.”

Important:
- “unlicensed platform” does not necessarily mean “individual with no legal entity”
- production onboarding/KYB/commercial terms must be checked later
- do not modify SovRoute Core around Lightspark now

This topic is **not current priority**.

---

# 18. SATORA COMPETITOR NOTES

Satora was researched as a benchmark.

Technical operation:
- active product
- `satora.io`
- `app.satora.io`
- npm package `@satora/swap`
- GitHub org `satoraHQ`
- Lendasat/Lendaswap technical rebrand confirmed

Corporate verification report result:
- `Sofbear Consulting Ltd.` existence: **UNVERIFIED**
- BVI registration: **UNVERIFIED**
- no independently verified public financial license found
- technical operation: verified
- legal operating entity: unclear from independent public records

Lesson:
- a working product can precede a highly visible corporate/legal wrapper
- SovRoute must never fabricate a company or address
- legal structure will be formalized once product/revenue justify it

---

# 19. SOVROUTE PRODUCT POSITIONING

Preferred positioning:

**Sovereign Agent-Native Asset Execution Infrastructure**

Core concept:
Receiver chooses what they receive.
Sender pays with what they have.
SovRoute clears the difference.

Higher-level product idea:
SovRoute is not merely a “payment network.”
It is an **asset / claim settlement preference and execution layer**.

Example:

`payer_asset → best route → receiver_preference`

Possible future receiver preferences:
- Base USDC
- Lightning BTC
- Solana USDC
- future bank settlement
- future fiat/stable routes

But do not expand current technical scope before the Lightning ↔ Base route is proven.

---

# 20. WHAT NOT TO DO

Do not:
- deploy real funds before explicit owner approval
- install LND before IBD closure
- expose Core RPC publicly
- expose ZMQ publicly
- connect Core to AIPP network
- connect Router directly to chain network
- store Aezeed plaintext
- paste secrets into chat
- mass-rename frozen internal packages/history
- reopen the closed core accounting phase without a concrete blocker
- add CCTP/DEX/Arbitrum/tBTC to the synchronous customer path
- fabricate company/legal address
- promise “safest bridge”
- promise fixed “3 second” execution
- call the system 100% non-custodial
- treat timeout as success/failure
- retry financial side effects blindly

---

# 21. IMMEDIATE NEXT ACTION

Phase 2D, Phase 2E, Phase 2F, and **Phase 2G (Bitcoin Core ↔ LND Backend Integration)** are **100% complete, audited and certified (PASS)**.

The single next safe action is:

**Phase 2H: LND Zero-Fund Reliability Burn-In (24-Hour Observation).**

Scope of Phase 2H:
- Monitor LND and Bitcoin Core over a 24-hour window under real network gossip.
- Verify zero unexpected container restarts.
- Verify memory and CPU stability within assigned limits (LND max 2048M, Core max 4096M).
- Verify AIPP isolation remains 100% intact with 0 restarts.
- Hard Guard: Zero funds funded, zero channels opened, port 9735 remains closed/unpublished.
- Provide a read-only telemetry script to check health during and at completion of burn-in.

---

# 22. NEW-SESSION STARTING PROMPT

Copy this into a new ChatGPT session together with this file:

> We are continuing the SovRoute project. Treat the uploaded continuity file as the canonical handoff state. First summarize the current state in no more than 10 bullets. Then identify the single next safe action. Do not change frozen architecture or production systems unless I explicitly approve it. Security, recovery, fail-closed behavior, AIPP isolation, and no-real-funds gates are mandatory. Never expose secrets. If live server state matters, give me a read-only command to verify it before making any decision.

---

# 23. OWNER WORKING PREFERENCES

- User prefers Turkish.
- User wants concise, direct, technically rigorous answers.
- For reviews, use explicit:
  - PASS
  - CONDITIONAL PASS
  - FAIL
- Avoid unnecessary architecture churn.
- Avoid long incremental prompts.
- When giving an Antigravity/Hermes prompt, make it one complete standalone copy-paste-ready prompt.
- Antigravity quota is limited; prompts should be narrow and efficient.
- Security and future recovery must be designed from the beginning.
- Do not create local/server drift.
- Prefer GitHub-based deployment flow.
- User is a solo operator and wants low-maintenance, “set and forget” operation.
- Minimal UI; strongest possible core.

---

# 24. CURRENT CANONICAL CHECKPOINT SUMMARY

```text
PROJECT: SovRoute
CORE ENGINE: CLOSED / FROZEN
CANONICAL CODE BASELINE:
d4b9672a06e025729302f4e4243be74c464501d0

BITCOIN CORE:
v31.1 mainnet
container: sovereign-bitcoind
health: healthy
restarts: 0
pruned: true
IBD: COMPLETE (100% tip synced, block 965,949+)
PHASE 2D: PASS

LND DEPLOYMENT:
version: v0.21.3-beta
image digest: sha256:d29074335f3bffb2ac0e789b0d023c24fbb85ce67ecbfb7d677399842fe0535c
host user: 2102:2102 (sovereign-lnd)
filesystem: /srv/sovereign-router/lightning (0750 / 0700)
security: readonly rootfs, cap_drop ALL, no-new-privileges
networking: Mode A (outbound only, port 9735 unpublished)
AIPP isolation: 100% INTACT (0 restarts, untouched)
wallet status: INITIALIZED & UNLOCKED (wallet.db mode 0600, encrypted)
seed custody: 100% OFFLINE PHYSICAL VAULT (0 LEAKAGE)
chain sync: SYNCED TO CHAIN (synced_to_chain: true, wallet_synced: true)
block height: 965,949 (matches Core tip)
peers: 3+ outbound peers
funding status: ZERO FUNDS (0 sats total / 0 sats channels)
PHASE 2E: PASS
PHASE 2F: PASS
PHASE 2G: PASS

NEXT PHASE:
Phase 2H — LND Zero-Fund Reliability Burn-In (24-Hour Observation)

REAL FUNDS:
NOT APPROVED
```

---
\n\n

# 25. PUBLIC BETA ABUSE / VOLUME POLICY

**Status: IMPLEMENTED & VERIFIED** (`src/anti-abuse/`, 12/12 tests passing, SQLite durable persistence, strict fail-closed).

This policy is enforced **server-side as durable Core policy**, not only in the UI, sitting between quote generation and the frozen Sovereign Coordinator (`AtomicCoordinator.prepareSwap`).

## Per-wallet limits

- Maximum **1 swap/request per wallet every 60 seconds** (`WalletCooldownActiveError`)
- Maximum **$500 total swap volume per wallet in a rolling 24-hour window** (`RollingVolumeLimitExceededError`)
- Use a **rolling 24h window**, not a calendar-day reset, to prevent midnight-boundary abuse
- Maximum **$250 per single swap** beta limit
- Maximum **$500 per destination address rolling 24-hour window** across all funnel wallets (anti-sybil)
- Global **$2,500 concurrent in-flight exposure limit** to protect operator inventory
- **Atomic SQLite persistence (WAL mode)** survives service restart without losing rate limits or rolling volume

Example:

```text
wallet A
request 1 → ALLOWED

another request before 60 seconds
→ RATE_LIMITED

rolling 24h volume = $487
new swap request = $25
→ VOLUME_LIMIT_EXCEEDED
```

## Additional anti-abuse layers

A wallet-only limit is not sufficient because bots can create new wallets cheaply. The beta policy should also support:

- **Per-swap maximum** — initial beta value to be defined, likely around $100–250
- **Per-destination wallet limit** — prevent many source wallets from funneling excessive volume to one receiver
- **Per-IP / edge velocity limit** — abuse control only; do not treat IP as identity
- **Global daily system cap** — cap total beta exposure
- **Concurrent liquidity exposure cap** — maximum total USDC/BTC economic exposure simultaneously in-flight
- **Repeated failure / quote-expiry cooldown** — throttle actors that continuously create quotes, expire them, or trigger failures
- **Low-liquidity guard** — return `NOT_READY` when safety headroom is below policy threshold

## User-facing UX

Where useful, the UI may show:

```text
Daily limit: $500
Used: $487
Remaining: $13
Rolling 24h limit
```

## Security principle

These controls are **not cosmetic UI rules**.

They must remain effective when:
- frontend is bypassed
- requests are sent directly to the API
- multiple browser sessions are used
- bots generate many requests
- the process restarts

Rate/volume state that affects economic safety must be durable enough to survive restart where required.

## Purpose

The policy exists primarily to:

- reduce bot exploitation
- protect liquidity
- reduce blast radius from quote/execution bugs
- limit automated draining attempts
- keep early public beta economically bounded
- make failure/recovery behavior easier to observe safely

These limits are risk controls. They do not by themselves determine regulatory status or create a legal exemption.

---

# 26. LANDING PAGE — CURRENT STATE

A new isolated branch was created for the website:

`landing-page-v1`

Current website location in the repo:

`web/index.html`

The landing page is intentionally:
- static
- dependency-free
- almost zero JavaScript
- isolated from Core
- isolated from Bitcoin Core / LND / Base infrastructure
- not deployed to production yet

At the first implementation pass, only `web/index.html` was added. Core, `src`, `tests`, production infrastructure, Bitcoin Core, LND and AIPP were not modified.

## Current approved visual direction

The **Claude-produced compact centered design** is the current visual reference.

The target visual language is:

- white / near-white background
- subtle technical dotted/grid texture
- compact centered hero
- small technical eyebrow text
- `SovRoute` product name around 32–36px
- calm blue as the only accent
- three equal compact product cards
- small consistent line icons
- thin light-gray borders
- no heavy shadows
- no gradients
- no neon
- no glassmorphism
- no stock images
- no giant marketing headline
- no generic AI-startup template look
- premium developer/fintech/infrastructure quality
- approximately 900px centered content width
- strong visual quality through spacing, typography, alignment and icon consistency

## Current hero direction

Eyebrow:

`receiver-defined settlement · lightning ↔ base`

Product:

`SovRoute`

Primary explanatory copy currently follows the compact technical style:

`Trust-minimized settlement between Lightning and Base. Self-host it, use a managed API later, or embed it in your product.`

Microcopy:

`recovery-first · direct-to-wallet · self-hosted first`

CTA direction:

- `View architecture`
- `How it works`

The phrase:

`Pay with what you have. Receive what you want.`

remains a canonical product thesis/slogan, but **must not be used as a giant hero headline in the current compact visual design**.

## Product cards

### Sovereign
Primary offering.

`Run SovRoute on your own Bitcoin Core, LND and Base infrastructure.`

`Self-hosted first. Full control.`

### Hosted
Coming later.

Managed execution API / infrastructure.

### Embedded / OEM
Embed SovRoute into wallets, fintechs and agent products.

## Visual micro-polish requirements

Current final visual refinement direction:

- dotted/grid background should be visible only subtly and must not compete with content
- Sovereign card may retain blue outline, but any blue tint should remain almost white
- hero description should stay compact, centered and optically light
- card-to-Why-SovRoute spacing should be slightly tighter
- icons must use one consistent line-SVG family:
  - 16–18px
  - ~1.5–1.75 stroke
  - round linecap / linejoin
  - muted gray
  - blue only for restrained emphasis
- all card heights and baselines should align
- spacing system should be consistent rather than arbitrary

## Why SovRoute

Compact 2x2 icon/text grid.

Current intended concepts:

- Receiver-defined settlement / or non-custodial-by-design wording where appropriate
- Recovery-aware / deterministic recovery
- Direct-to-wallet / Lightning-to-Base execution
- Self-hosted first

Avoid oversized feature cards.

## How it works

Compact horizontal desktop flow, vertical on mobile:

1. Fund Lightning hold invoice
2. Lock matching USDC on Base
3. Claim reveals preimage
4. Lightning settles

Small recovery note:

`If claim doesn't happen, refund path is deterministic.`

## Architecture statement

Keep extremely small:

`Receiver defines the outcome. SovRoute determines the route.`

Mono flow:

`payer asset → receiver preference → route → execution → recovery → settlement`

## Website constraints

Do not add:
- pricing yet
- testimonials
- logo walls
- fake metrics
- fake reviews
- fake company information
- fake registered address
- unnecessary navigation
- large animation
- heavy framework dependencies

Pricing is intentionally not finalized.

---

# 27. SEO / GOOGLE / AI DISCOVERY — REQUIRED BEFORE PUBLIC DEPLOY

SovRoute must be easy for both humans and machine crawlers to understand.

The website should remain static-first so important product facts exist in raw crawlable HTML.

## Canonical domain

`https://sovroute.com/`

The domain is managed through Cloudflare.

Future preferred publishing model:

`GitHub → Cloudflare Pages preview → visual approval → sovroute.com`

This keeps the landing page completely isolated from the Hetzner Bitcoin Core / IBD workload.

Do not deploy the website to the Bitcoin Core production server merely to host the landing page.

## Canonical SEO title

`SovRoute — Receiver-Defined Settlement Infrastructure`

## Canonical meta description

`Pay with what you have. Receive what you want. SovRoute is recovery-aware settlement infrastructure, starting with Lightning BTC to Base USDC.`

## Machine-readable canonical facts

A crawler should quickly be able to answer:

**What is SovRoute?**  
Receiver-defined settlement infrastructure.

**What is the current route?**  
Lightning BTC → Base USDC.

**What is the main technical differentiation?**  
Recovery-aware execution.

**What is the settlement model?**  
Direct-to-wallet settlement with no custodial user balance.

**What is the initial operating model?**  
Self-hosted first.

Important terms should appear naturally in visible HTML:

- receiver-defined settlement
- Lightning BTC to Base USDC
- trust-minimized settlement
- recovery-aware execution
- direct-to-wallet settlement
- self-hosted settlement infrastructure

Do not keyword-stuff.

## Required web discovery files

Before public deployment, the `web/` surface should include:

- `index.html`
- `robots.txt`
- `sitemap.xml`
- `llms.txt`

### robots.txt

Default intent:

```text
User-agent: *
Allow: /

Sitemap: https://sovroute.com/sitemap.xml
```

Do not blanket-block ordinary search or AI search/agent crawlers.

Search/agent discovery should remain allowed.

AI training policy can be decided separately later.

### sitemap.xml

For the first public version, include only real public URLs.

At minimum:

`https://sovroute.com/`

Do not list page anchors as separate URLs.

Do not invent docs/pricing/about URLs.

### llms.txt

Keep concise and factual.

Canonical content direction:

```text
# SovRoute

SovRoute is receiver-defined settlement infrastructure.

Pay with what you have. Receive what you want.

## Current route

Lightning BTC -> Base USDC

## Core properties

- Recovery-aware execution
- Trust-minimized settlement
- Direct-to-wallet settlement
- No custodial user balance
- Self-hosted first

## Product model

Receiver defines the outcome. SovRoute determines the route.

payer asset -> receiver preference -> route -> execution -> recovery -> settlement

## Website

https://sovroute.com/
```

Do not expose the private GitHub repository in `llms.txt`.

## Structured data

Use minimal valid JSON-LD only with known facts.

Potential schemas:
- `WebSite`
- `SoftwareApplication` / `SoftwareSourceCode` only if semantically appropriate

Do not fabricate:
- legal entity
- address
- founder
- pricing
- ratings
- reviews
- offers

SovRoute is currently a product/brand for public-page purposes.

## Post-deploy Cloudflare / Google checklist

After the site is approved and deployed:

1. Verify `https://sovroute.com/` as canonical
2. Redirect `www.sovroute.com` to apex
3. Verify HTTPS
4. Verify `/robots.txt`
5. Verify `/sitemap.xml`
6. Verify `/llms.txt`
7. Verify Cloudflare bot controls do not accidentally block Google or AI search/agent crawlers
8. Configure Google Search Console domain property
9. Submit `sitemap.xml`
10. Verify production HTML canonical metadata

## Current status

The final combined **visual polish + SEO / AI discovery** Antigravity prompt has been prepared.

**Do not assume that this final pass has been completed until its actual output, git diff and git status are reviewed.**

No production deployment has yet been approved from this handoff state.

---

# 28. IMMEDIATE PARALLEL WORK STATE

There are currently two independent tracks:

## Track A — Bitcoin Core

Continue IBD.

Last known checkpoint remains:

```text
blocks: 853443
headers: 965734
progress: 74.44538855462569%
initialblockdownload: true
health: healthy
restarts: 0
warnings: none
```

If `initialblockdownload=true`:
→ leave Core alone.

If `initialblockdownload=false`:
→ perform IBD closure certification before LND.

## Track B — Landing page

Safe to continue locally / on Git branch while IBD runs.

Current sequence:

`Claude visual reference`
→ `Antigravity final polish + SEO/AI discovery pass`
→ review local page
→ review `git diff -- web/`
→ review `git status --short`
→ commit only after approval
→ push `landing-page-v1`
→ Cloudflare Pages preview
→ final mobile/desktop review
→ connect `sovroute.com`

The landing page track must not touch the Hetzner Bitcoin Core production environment.

---


# 29. CLOUDFLARE / GOOGLE DEPLOYMENT STATUS — LIVE

This section supersedes the earlier “not deployed yet” website state where applicable.

## Current public website status

SovRoute landing page is now live on Cloudflare without touching the Hetzner production server.

Canonical public URL:

`https://sovroute.com/`

Temporary Cloudflare preview/upload URL used during setup:

`https://green-block-2664.farukucal.workers.dev/`

Random Cloudflare project/service name:

`green-block-2664`

This random name is not product-facing. The product-facing canonical domain is:

`https://sovroute.com/`

## Deployment model actually used

Initial GitHub integration attempt for Cloudflare Pages/Workers failed with a Git account connection error.

Final successful path:

`Cloudflare Workers & Pages → Upload and deploy → static web files`

Uploaded root-level files:

- `index.html`
- `robots.txt`
- `sitemap.xml`
- `llms.txt`

These came from local repo path:

`C:\Users\faruk\Desktop\universal-agent-asset-router\web`

Important: files were uploaded at the deployment root, not nested under `/web/`.

## Live verification

The following were manually verified as working:

- `https://sovroute.com/`
- `https://sovroute.com/robots.txt`
- `https://sovroute.com/sitemap.xml`
- `https://sovroute.com/llms.txt`

`llms.txt` intentionally renders as plain text. That is correct.

## robots.txt

Live expected content:

```text
User-agent: *
Allow: /

Sitemap: https://sovroute.com/sitemap.xml
```

## sitemap.xml

Live sitemap contains the canonical URL:

`https://sovroute.com/`

## llms.txt

Live `llms.txt` clearly states:

- SovRoute is receiver-defined settlement infrastructure
- Current route is Lightning BTC → Base USDC
- Core properties:
  - recovery-aware execution
  - trust-minimized settlement
  - direct-to-wallet settlement
  - no custodial user balance
  - self-hosted first

## www redirect

`https://www.sovroute.com/` redirects to:

`https://sovroute.com/`

A Cloudflare Page Rule was created:

```text
www.sovroute.com/*
→ 301 Permanent Redirect
→ https://sovroute.com/$1
```

Cloudflare rule status: enabled.

Canonical domain strategy:

```text
www.sovroute.com → sovroute.com
```

Chrome may display only `sovroute.com` while still using HTTPS. That is normal.

## Cloudflare DNS state observed

Cloudflare DNS showed:

```text
sovroute.com
Type: Worker
Content: green-block-2664
Proxy: Proxied
TTL: Auto
```

If `www` ever fails with DNS error in a future check, add or verify:

```text
Type: CNAME
Name: www
Target: sovroute.com
Proxy status: Proxied
TTL: Auto
```

Do not touch Hetzner for this.

## Cloudflare AI bot setting

On the Cloudflare dashboard, the AI bot access setting was observed as:

`Do not block (allow crawlers)`

This is currently intentional for discovery.

Policy:
- allow Google/search crawlers
- allow AI search / AI agent discovery crawlers
- do not block discovery at this stage
- AI training policy can be reviewed separately later

## Google Search Console

Google Search Console domain property was created and verified for:

`sovroute.com`

Verification result shown:

```text
Sahiplik doğrulandı
Doğrulama yöntemi: Alan adı sağlayıcı
```

Meaning:

`Google Search Console ownership: VERIFIED`

Do not remove the Google DNS verification record from Cloudflare DNS.

## Google sitemap submission

Google Search Console sitemap submission was completed.

Google message:

```text
Site haritası başarıyla gönderildi
```

Meaning:

`Google sitemap submit: PASS`

Google may take time to crawl/index the site. Immediate indexing is not guaranteed and delay is normal.

## Regulatory note for website state

Current public website is a static product/technical landing page.

It is not yet:
- live swap service
- user funds flow
- custody product
- regulated/licensed claim
- KYC-free swap marketing page
- financial service launch
- pricing page
- transactional app

Current regulatory exposure is considered lower because no live funds or public swap flow exists yet.

Before any real transaction flow is enabled, copy/legal/risk wording must be reviewed again.

Do not use risky wording such as:
- anonymous swap
- untraceable
- avoid banks
- no regulation
- guaranteed risk-free
- licensed/regulated unless actually true
- 100% non-custodial

Preferred wording remains:
- receiver-defined settlement
- trust-minimized settlement
- recovery-aware execution
- direct-to-wallet settlement
- no custodial user balance
- self-hosted first

---

# 30. LATEST BITCOIN CORE IBD CHECKPOINT — IBD COMPLETED (PHASE 2D PASS)

This section supersedes older IBD checkpoints in the handoff file.

Latest observed command output:

```json
{
  "chain": "main",
  "blocks": 965946,
  "headers": 965946,
  "bestblockhash": "00000000000000000001c2f9e9f9401cddec5e1814b5698770b5865c3cdeebca",
  "bits": "1702355e",
  "target": "00000000000000000002355e0000000000000000000000000000000000000000",
  "difficulty": 127450789715843.1,
  "time": 1788794608,
  "mediantime": 1788789142,
  "verificationprogress": 1,
  "initialblockdownload": false,
  "chainwork": "00000000000000000000000000000000000000014592cfa71043ab3d8b3e530a",
  "size_on_disk": 57527915096,
  "pruned": true,
  "pruneheight": 934530,
  "automatic_pruning": true,
  "prune_target_size": 57671680000,
  "warnings": []
}
```

Container state:

```text
status=running
health=healthy
restarts=0
```

Operational certification:

```text
BITCOIN CORE IBD CLOSURE

RESULT: PASS
IBD: COMPLETE
HEALTH: HEALTHY
WARNINGS: NONE
PRUNING: HEALTHY (size: ~57.53 GB / target: 57.67 GB)
TIP SYNCED: YES (blocks: 965,946 / headers: 965,946)
VERIFICATION PROGRESS: 1.0 (100%)
INITIAL BLOCK DOWNLOAD: FALSE
READY FOR LND PHASE 2E: YES
ACTION: PREPARE LND PHASE 2E PLAN (REQUIRES OWNER APPROVAL)
```

---

# 31. CURRENT NEXT STEPS

## Completed today

- SovRoute landing page published through Cloudflare
- `sovroute.com` live
- `www.sovroute.com` redirects to `sovroute.com`
- `robots.txt` live
- `sitemap.xml` live
- `llms.txt` live
- Google Search Console domain ownership verified
- sitemap submitted successfully
- Hetzner/Bitcoin Core remained untouched during web deployment
- **Bitcoin Core IBD fully completed (100%, blocks/headers: 965,946, verificationprogress: 1, initialblockdownload: false)**
- **Phase 2D (Bitcoin Core IBD Closure Certification): PASS**
- **LND v0.21.3-beta supply-chain cryptographically verified (7 Lightning Labs core developer signatures, /verify-install.sh pass)**
- **Image digest pinned: sha256:d29074335f3bffb2ac0e789b0d023c24fbb85ce67ecbfb7d677399842fe0535c**
- **Host UID/GID 2102:2102 (sovereign-lnd) & /srv/sovereign-router/lightning filesystem provisioned (0750/0700)**
- **Docker Compose updated with hardened sovereign-lnd service & sovereign_router_net**
- **Phase 2E (LND Base Installation — Zero Wallet): PASS**
- **Interactive wallet creation executed via lncli create (wallet.db & macaroons.db initialized, mode 0600)**
- **Aezeed 24-word recovery seed safely taken offline by owner (0 plaintext leakage to server/logs/chat)**
- **Phase 2F (LND Wallet Initialization & Physical Seed Custody): PASS**
- **Bitcoin Core RPC & ZMQ configured over sovereign_chain_net (10.240.10.2:8332, 28332, 28333)**
- **LND authenticated via dedicated rpcauth and unlocked by owner**
- **LND chain synchronization verified: synced_to_chain=true, wallet_synced=true, block 965,949**
- **Phase 2G (Bitcoin Core ↔ LND Backend Integration): PASS**
- **Quote Engine & FX Risk module developed & verified (11/11 tests pass, 375/375 total tests pass)**
- **Multi-source feeds (Coinbase, Kraken, Binance) + median aggregation + 20s HMAC signature**
- **Anti-Abuse & Volume Safety Engine implemented & verified (12/12 dedicated tests pass, SQLite persistence, strict 60s cooldown, rolling 24h $500 limit, 398 total tests passing)**
- **Gasless Base UX (EIP-712 Authorization, Nonce/Replay Defense, Fail-Closed Relayer) implemented & verified (14/14 dedicated tests pass, 412 total tests passing)**
- **Unified Swap API & Orchestrator implemented & verified (13/13 dedicated tests pass, 425 total tests passing)**
- **Interactive Swap Widget & Settlement Pipeline integrated into `web/index.html`:**
  - Live Coinbase BTC/USD price ticker with graceful fallback
  - Dynamic 20s quote expiry countdown ring / progress bar
  - Instant satoshi-to-USDC converter with fee transparency (50 bps)
  - Section 25 anti-abuse limits clearly surfaced (60s cooldown, $500 24h rolling, $250 max single swap)
  - Interactive modal demonstrating EIP-712 Gasless Permit signing
  - Dynamic SVG QR code generation and copyable Bolt11 hold invoice
  - 4-phase live atomic HTLC settlement simulation (HTLC Held -> Base USDC Locked -> Preimage Revealed -> Lightning Settled)
  - Zero external heavyweight dependencies; 100% responsive vanilla HTML/CSS/JS
- **Invariance verified: AIPP 0 restarts (100% isolated), zero host ports exposed**

## Pending / Next Actions

1. Deploy updated `web/` folder to Cloudflare Pages (via git push or drag-and-drop to Cloudflare Pages dashboard).
2. Phase 2H: 24-Hour Zero-Fund Reliability Burn-In observation period (in progress until ~19:00 on 2026-09-08).
3. Monitor memory, CPU, container restart stability, and gossip advancement on `aliasdesk-server`.
4. Keep real funds strictly disabled (`NOT APPROVED`).
5. Keep AIPP network isolation completely intact (`core_aipp_net` untouched).
6. After 24h burn-in completes, proceed to Phase 2I (Router ↔ LND Restricted API Integration).

## Important repository note

Local branch:

`landing-page-v1`

GitHub commit reported by Antigravity:

`5005013`

Pushed branch:

`landing-page-v1`

Untracked local folder still reported:

`tmp_phase7_test/`

Do not commit `tmp_phase7_test/`.

Avoid `git add .`.

---

**End of continuity file.**
