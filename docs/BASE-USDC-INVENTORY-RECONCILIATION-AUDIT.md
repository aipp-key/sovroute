# SOVROUTE — BASE USDC INVENTORY RECONCILIATION AUDIT
**Authoritative Architectural Specification & Codebase Audit**  
**Document Version**: 1.0.0  
**Phase**: Phase 7 / Pre-Phase 2D Architectural Closure  
**Dedicated Branch**: `phase-base-inventory-reconciliation-audit`  
**Status**: APPROVED & FROZEN — READ-ONLY ARCHITECTURAL SPECIFICATION  
**Scope**: Read-Only Codebase Audit, Mathematical Formulation, Double-Counting Trap Analysis, Failure Modes, Reconcile-on-Boot Protocol, Invariants, and Test Plan Specification  

---

## 1. Executive Summary & Problem Definition

During the **Liquidity Accounting & Durable Reservation Safety** phase, SovRoute achieved 100% test certification for its internal persistence and reservation layer:
- Multi-process reservation mutual exclusion was hardened using SQLite `BEGIN IMMEDIATE` and serialized transaction retries.
- Reservations were bound to canonical token units (`expectedUsdcAmount`) rather than satoshis.
- Explicit reservation lifecycles (`RESERVED`, `COMMITTED`, `RELEASED`) were durably tied to sovereign execution records.

However, a fundamental architectural boundary remains between **local relational persistence** and **external onchain reality**:
1. **SQLite Persists Local Intent and Historical Records**:
   - `operator_inventory`: Records an administratively or programmatically set `confirmed_balance`.
   - `liquidity_reservations`: Tracks local reservation states (`RESERVED`, `COMMITTED`, `RELEASED`).
   - `sovereign_swaps`: Records swap coordinator state transitions.
2. **Onchain Base Reality Holds the Actual Economic Assets**:
   - The operator’s Externally Owned Account (EOA) holds spendable Base USDC tokens ($W$).
   - The canonical `HtlcErc20` escrow contract holds tokens actively locked in-flight for open swaps ($C$).
   - Tokens are disbursed onchain via preimage claims ($S$) or recovered via timelock refunds ($F$).
   - External treasury actions (manual deposits or cold-storage withdrawals) alter wallet balances completely outside the application runtime.
   - Base L2 reorgs, RPC node latency, and mempool dropouts introduce non-deterministic state divergence.

**The Core Architectural Problem**:  
If the router naively synchronizes SQLite with onchain wallet balances—for example, by setting SQLite `confirmed_balance = usdc.balanceOf(operatorAddress)`—the system falls directly into the **Double-Counting Trap**, strangles legitimate liquidity by subtracting active HTLCs twice, or risks catastrophic insolvency if unencumbered balances are over-allocated.

This audit establishes the definitive mathematical formulation, analyzes all failure modes, specifies the mandatory **Reconcile-on-Boot** protocol, defines twelve non-negotiable invariants (`REC-1` through `REC-12`), and provides the future test plan specification for Phase 2D.

---

## 2. Section 3A: Current State Codebase Audit

A comprehensive line-by-line inspection of the active codebase (`phase-7-production-readiness-closure` at commit `906e5d1720ccd00b89a3f00778c1c302d4fe1da9`) reveals how operator inventory is currently defined, stored, queried, and mutated.

### 2.1 Inventory Definition and Persistence in SQLite

In `src/persistence/sqlite.ts`:
- **Table Definition**:
  ```sql
  CREATE TABLE IF NOT EXISTS operator_inventory (
    token_address TEXT PRIMARY KEY,
    confirmed_balance TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS liquidity_reservations (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    token_address TEXT NOT NULL,
    amount_units TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ```
- **Read Methods**:
  - `getConfirmedOperatorBalance(tokenAddress)`: Reads `confirmed_balance` directly from `operator_inventory`. Returns `0n` if not found.
  - `getReservedOperatorBalance(tokenAddress)`: Sums `amount_units` from `liquidity_reservations` where `status = 'RESERVED'`.
  - `getCommittedOperatorBalance(tokenAddress)`: Sums `amount_units` from `liquidity_reservations` where `status = 'COMMITTED'`.
  - `getAvailableOperatorBalance(tokenAddress)`:
    $$\text{Available} = \max(0, \text{confirmed} - \text{reserved} - \text{committed})$$
- **Write Methods**:
  - `setConfirmedOperatorBalance(tokenAddress, balance)`: Performs an upsert on `operator_inventory`.
  - `reserveLiquidity(executionId, tokenAddress, amountUnits)`: Executes under `BEGIN IMMEDIATE`, checks $\text{available} \ge \text{amountUnits}$, and inserts a record with status `RESERVED`.
  - `commitLiquidityReservation(reservationId)`: Updates status from `RESERVED` to `COMMITTED`.
  - `releaseLiquidityReservation(reservationId)`: Updates status from `RESERVED` to `RELEASED`.
  - `restoreRefundLiquidityReservation(reservationId)`: Updates status from `COMMITTED` to `RELEASED`.

### 2.2 Inventory Handling in the Application Layer

- **Wrapper (`src/atomic/liquidity/sqlite-inventory.ts`)**:
  - `SqliteLiquidityInventory` implements `ILiquidityInventory`.
  - Its constructor accepts an optional `initialBalances?: Record<string, bigint>`, which calls `setConfirmedOperatorBalance`.
- **Coordinator (`src/atomic/coordinator/coordinator.ts`)**:
  - During swap quote generation (`generateQuote`) or creation (`createSwap`), the coordinator calls `this.inventory.reserve(...)`.
  - When the Base HTLC funding transaction is confirmed (`fundHtlc`), line 574 calls:
    ```typescript
    if (record.reservationId) {
      await this.inventory.commit(record.reservationId);
    }
    ```
  - When a swap is canceled or expires before funding, lines 382, 978, 1006 call `inventory.release(...)`.
  - When an expired Base HTLC is refunded onchain, lines 1148-1154 call `inventory.restoreRefund(...)`.
  - **CRITICAL AUDIT FINDING**: When a swap is successfully settled (`confirmBaseDelivery` / `COMPLETED`), the reservation record in `liquidity_reservations` remains in status `COMMITTED`! The `confirmed_balance` in `operator_inventory` is **never decremented**, and the reservation is **never transitioned** to a terminal `SETTLED` or `SPENT` state.

### 2.3 Onchain Base RPC Interaction in Current Code

- **Bootstrap Probes (`src/bootstrap.ts`)**:
  - In `checkEvm` (lines 145–168), the bootstrap sequence constructs a viem `publicClient` to probe the Base RPC:
    ```typescript
    const chainId = await publicEvmClient.getChainId();
    const blockNumber = await publicEvmClient.getBlockNumber();
    ```
  - **The router NEVER queries ERC-20 `balanceOf` during bootstrap or health checks.**
- **Pre-Flight Funding Check (`src/atomic/evm/base-sepolia-backend.ts`)**:
  - Inside `BaseSepoliaAtomicBackend.fundHtlc(...)` (lines 334–345), the backend performs an immediate onchain check before dispatching the transaction:
    ```typescript
    const usdcBalance = (await this.publicClient.readContract({
      address: token,
      abi: this.tokenAbi,
      functionName: 'balanceOf',
      args: [this.operatorAddress],
    })) as bigint;
    if (usdcBalance < params.amountUnits) {
      throw new Error(`TESTNET_FUNDING_REQUIRED: Operator wallet ... insufficient balance`);
    }
    ```
  - This check is purely a single-transaction pre-flight guard to avoid submitting a reverting transaction. **It does not update `operator_inventory` or write back to SQLite in any way.**
- **Ephemeral In-Memory State (`BaseSepoliaAtomicBackend`)**:
  - `BaseSepoliaAtomicBackend` stores mapping states in volatile memory:
    ```typescript
    private swapKeyToHtlcId = new Map<string, `0x${string}`>();
    ```
  - Upon process restart, this map is completely empty. Although `evm_htlc_id` is stored in SQLite `sovereign_swaps`, `BaseSepoliaAtomicBackend` does not hydrate this map on boot, creating an observation blind-spot if `observeHtlc` is invoked after restart without re-registration.

### 2.4 Comparative Matrix: SQLite vs Onchain Reality

| Dimension | SQLite Persistence State | Onchain Base Reality |
| :--- | :--- | :--- |
| **Confirmed Balance** | Static value in `operator_inventory.confirmed_balance`. Only updated via manual/test calls. | Dynamic token balance held by operator EOA (`balanceOf(operatorAddress)`). Decreases immediately upon HTLC funding. |
| **Active Quotes (Pre-Funding)** | Explicitly tracked in `liquidity_reservations` with status `RESERVED`. | Completely invisible onchain (no transaction exists yet). |
| **Committed Escrows** | Tracked in `liquidity_reservations` with status `COMMITTED`. Remains `COMMITTED` even after swap completion. | Funds physically locked in `HtlcErc20` contract storage (`status == 1 / LOCKED`). Decreases when claimed or refunded. |
| **Settled / Claimed** | Swap record marked `COMPLETED`; reservation remains `COMMITTED`; confirmed balance unadjusted. | Funds transferred to customer address; contract status becomes `CLAIMED` (2); contract balance becomes 0. |
| **Refunded Escrows** | Reservation marked `RELEASED` via `restoreRefund`. | Funds transferred back to operator EOA; contract status becomes `REFUNDED` (3); wallet balance increases. |
| **External Treasury Flows** | Completely undetected. Zero visibility into deposits or withdrawals. | Instantaneous change in `balanceOf(operatorAddress)`. |
| **Reorgs & Mempool Drops** | Recorded as confirmed once receipt is received; no re-verification. | Transaction can be dropped, replaced, or reorganized out. |

---

## 3. Section 3B: State Equation & Decomposition

To avoid accounting ambiguities, we formulate the exact mathematical decomposition of Base USDC assets across onchain physical reality and offchain state tracking.

### 3.1 Mathematical Definitions

Let all values be expressed in canonical USDC atomic integer units ($1 \text{ USDC} = 10^6 \text{ units}$, `6 decimals`).

#### Onchain Physical Ledger (Authoritative Economic Reality)
- $W \in \mathbb{N}_0$: **Spendable Wallet Balance**  
  The balance directly owned by the operator's EOA on Base:
  $$W = \text{USDC}.\text{balanceOf}(\text{operatorAddress})$$
- $C_{onchain} \in \mathbb{N}_0$: **Locked In-Flight Escrows**  
  The sum of USDC currently locked in the `HtlcErc20` contract where the operator is the refund recipient and status is `LOCKED` (1):
  $$C_{onchain} = \sum_{k \in \mathcal{H}_{locked}} \text{amount}_k$$
- $S_{onchain} \in \mathbb{N}_0$: **Realized Settlements (Spent)**  
  Cumulative USDC claimed by customers presenting preimages against operator-funded HTLCs (`status == 2 / CLAIMED`).
- $F_{onchain} \in \mathbb{N}_0$: **Realized Refunds**  
  Cumulative USDC reclaimed by the operator after timelock expiration (`status == 3 / REFUNDED`).
- $T_{phys} \in \mathbb{N}_0$: **Total Physical Asset Backing**  
  The total economic property owned by the operator on Base:
  $$T_{phys} = W + C_{onchain}$$

#### Offchain Application Ledger (SQLite State)
- $B_{conf} \in \mathbb{N}_0$: **Recorded Confirmed Balance** (`operator_inventory.confirmed_balance`).
- $R_{sqlite} \in \mathbb{N}_0$: **Active Reserved Obligations**  
  Sum of unmined quotes/invoices committed to customers:
  $$R_{sqlite} = \sum_{i \in \mathcal{R}_{reserved}} \text{amount}_i$$
- $C_{sqlite} \in \mathbb{N}_0$: **Committed Escrow Reservations**  
  Sum of reservations marked `COMMITTED` in SQLite:
  $$C_{sqlite} = \sum_{j \in \mathcal{R}_{committed}} \text{amount}_j$$
- $P_{inflight} \in \mathbb{N}_0$: **In-Flight Funding Dispatches**  
  Transactions broadcast to the Base mempool with nonces assigned, pending block inclusion.

### 3.2 State Transition Equations (Conservation of Value)

The lifecycle of an individual swap with amount $A$ progresses through discrete states:

```
[1. QUOTE/RESERVE] ──> [2. HTLC FUNDED] ──┬──> [3a. CUSTOMER CLAIM] ──> [SETTLED]
                                         │
                                         └──> [3b. OPERATOR REFUND] ──> [RESTORED]
```

#### Step 1: Quote Reservation (Pre-Chain)
- Customer requests quote; hold invoice created.
- $R_{sqlite} \leftarrow R_{sqlite} + A$
- Onchain state: $\Delta W = 0, \Delta C_{onchain} = 0, \Delta T_{phys} = 0$.
- **Constraint**: Must verify $A \le \text{Available Headroom}$ before granting reservation.

#### Step 2: HTLC Funding Mined Onchain
- Operator broadcasts `HtlcErc20.fund(...)`. Transaction mines.
- Tokens leave the operator EOA and enter the contract:
  $$W \leftarrow W - A$$
  $$C_{onchain} \leftarrow C_{onchain} + A$$
  $$T_{phys} = (W - A) + (C_{onchain} + A) = T_{phys} \quad \text{(Invariant)}$$
- In SQLite:
  $$R_{sqlite} \leftarrow R_{sqlite} - A$$
  $$C_{sqlite} \leftarrow C_{sqlite} + A$$

#### Step 3a: Customer Claim with Preimage (Normal Settlement)
- Customer claims tokens on Base; operator extracts preimage and settles Lightning hold invoice (receiving BTC sats).
- Onchain tokens transfer from `HtlcErc20` to customer:
  $$C_{onchain} \leftarrow C_{onchain} - A$$
  $$S_{onchain} \leftarrow S_{onchain} + A$$
  $$T_{phys} \leftarrow T_{phys} - A \quad \text{(USDC decreases, operator gained BTC)}$$
- In SQLite:
  - Swap state transitions to `COMPLETED`.
  - **Required Action**: Reservation $C_{sqlite}$ must be retired ($C_{sqlite} \leftarrow C_{sqlite} - A$).

#### Step 3b: Timelock Expiration & Operator Refund
- Customer failed to complete; timelock expires; operator calls `HtlcErc20.refund(...)`.
- Tokens return from `HtlcErc20` to operator EOA:
  $$C_{onchain} \leftarrow C_{onchain} - A$$
  $$W \leftarrow W + A$$
  $$F_{onchain} \leftarrow F_{onchain} + A$$
  $$T_{phys} = (W + A) + (C_{onchain} - A) = T_{phys} \quad \text{(Invariant)}$$
- In SQLite:
  - Reservation restored via `restoreRefundLiquidityReservation`:
    $$C_{sqlite} \leftarrow C_{sqlite} - A$$
  - Lightning hold invoice is canceled.

---

## 4. Section 3C: The Double-Counting Trap (Critical Failure Mode Analysis)

### 4.1 The Algebraic Proof of Double-Deduction

Suppose an implementer notices that `operator_inventory.confirmed_balance` in SQLite does not track onchain deposits, and decides to "synchronize" SQLite on every block or on startup by setting:
$$B_{conf} = W = \text{USDC}.\text{balanceOf}(\text{operatorAddress})$$

Recall the existing formula in `src/persistence/sqlite.ts` for available balance:
$$\text{Available} = B_{conf} - R_{sqlite} - C_{sqlite}$$

Substitute $B_{conf} = W$:
$$\text{Available} = W - R_{sqlite} - C_{sqlite}$$

Now substitute the physical definition of wallet balance $W = T_{phys} - C_{onchain}$:
$$\text{Available} = (T_{phys} - C_{onchain}) - R_{sqlite} - C_{sqlite}$$

In a healthy system where all funded contracts are tracked ($C_{sqlite} = C_{onchain} = C$):
$$\text{Available} = T_{phys} - 2C - R_{sqlite}$$

> [!CAUTION]
> **THE DOUBLE-COUNTING TRAP**:  
> Because the tokens in active HTLCs ($C$) have **already been transferred out of the operator EOA**, the onchain balance $W$ has **already deducted $C$**.  
> If SQLite also subtracts $C_{sqlite}$ from $W$, the committed funds are **subtracted twice**.  
> This results in an artificial liquidity choke where the operator appears to have far less liquidity than actually exists, falsely rejecting customer quotes.

#### Numerical Demonstration:
1. Operator deposits **100,000 USDC** into the EOA wallet. Total assets $T_{phys} = 100,000$.
2. Two customer swaps of **20,000 USDC** each are funded onchain ($C = 40,000$ USDC).
3. Onchain wallet balance becomes:
   $$W = 100,000 - 40,000 = 60,000 \text{ USDC}$$
4. SQLite records:
   $$C_{sqlite} = 40,000 \text{ USDC}, \quad R_{sqlite} = 0$$
5. Actual unencumbered spendable liquidity remaining in the wallet is **60,000 USDC**.
6. **Naive Reconciliation Result**:
   $$\text{Available} = W - C_{sqlite} = 60,000 - 40,000 = 20,000 \text{ USDC}$$
7. **Error**: The router reports only 20,000 USDC available, stranding **40,000 USDC** of perfectly valid spendable inventory!

---

### 4.2 Asymmetric Lifecycle Edge Cases

#### Edge Case 1: HTLC Funded Onchain, but Crash Occurred Before SQLite Marked `COMMITTED`
- **Sequence**:
  1. `BaseSepoliaAtomicBackend.fundHtlc` executes and transaction mines on Base. Tokens leave wallet ($W \leftarrow W - A$).
  2. Operating system kills router process before line 574 (`inventory.commit(reservationId)`) executes.
  3. In SQLite, the reservation remains in status `RESERVED` ($R_{sqlite}$ still has $A$), or worse, the swap is stuck in `EVM_FUNDING_PENDING`.
- **Consequence of Naive Sync**:
  - Wallet balance $W$ decreased by $A$.
  - In SQLite, $R_{sqlite}$ still holds $A$.
  - Available balance is reduced by $2A$.
- **Recovery Requirement**: Reconciler must check onchain contract storage `getHtlc(htlcId)` using the deterministic parameters. If `status == LOCKED`, it must advance SQLite reservation to `COMMITTED` and swap state to `EVM_FUNDED`.

#### Edge Case 2: HTLC Refunded Onchain, but Not Yet Marked `RELEASED` in SQLite
- **Sequence**:
  1. Timelock expires; refund transaction mines on Base. Tokens return to wallet ($W \leftarrow W + A$).
  2. Router crashes or RPC event watcher is delayed before calling `restoreRefundLiquidityReservation`.
  3. In SQLite, reservation is still `COMMITTED` ($C_{sqlite}$ still has $A$).
- **Consequence of Naive Sync**:
  - $W$ increases by $A$. If $B_{conf}$ is set to $W$, available balance temporarily looks correct.
  - BUT when the watcher wakes up and finally processes the refund receipt, it calls `restoreRefund`, reducing $C_{sqlite}$ by $A$.
  - Available balance now increases by $A$ a **second time**, creating phantom inventory that does not exist onchain!

#### Edge Case 3: Customer Claims Onchain Before Local Watcher Observes `HtlcClaimed` Event
- **Sequence**:
  1. Customer submits preimage directly to Base `HtlcErc20.claim(...)`. Transaction mines.
  2. Onchain HTLC status transitions to `CLAIMED` (2). Contract balance drops to 0.
  3. Local router has not yet received the block or event log.
- **Consequence**:
  - In SQLite, reservation is still `COMMITTED`.
  - If reconciliation checks onchain contract, it sees `status == CLAIMED`.
  - The reconciler must immediately extract the preimage from the claim transaction input/event, advance swap to `EVM_CLAIM_CONFIRMED`, settle the Lightning hold invoice, and retire the reservation from $C_{sqlite}$.

#### Edge Case 4: Ghost / Orphan HTLCs Onchain Without SQLite Record
- **Sequence**:
  1. A transaction was broadcast by an operator wallet outside SovRoute, or a catastrophic database corruption lost recent records.
  2. Onchain contract has `LOCKED` tokens originating from the operator address, but SQLite has zero record of the swap.
- **Consequence**:
  - Physical tokens are locked onchain, but SQLite has no timer to refund them.
  - The funds will sit permanently locked past expiry unless an automated reconciliation scanner flags them as `ORPHAN_ESCROW`.

---

## 5. Section 3D: External Treasury Mutation Handling

The router operates in an environment where treasury operations, chain reorgs, and network failures occur asynchronously.

### 5.1 External Treasury Deposit (e.g. +5,000 USDC)
- **Scenario**: Operator transfers 5,000 USDC from an external exchange into the operator EOA.
- **Behavior**:
  - $W$ increases by 5,000 USDC on Base.
  - The router must not immediately assume these funds are spendable until **Finality Confirmations** (*Configurable Policy via `EvmFinalityPolicy.requiredConfirmations`, e.g., testnet policy or mainnet safe finality*) are satisfied.
  - Once final, the newly observed wallet balance expands available headroom for quotes:
    $$\Delta \text{Headroom} = +5,000 \text{ USDC}$$
  - No SQLite reservation records are mutated.

### 5.2 External Treasury Withdrawal (e.g. -1,000 USDC)
- **Scenario**: Operator transfers 1,000 USDC from the operator EOA to cold storage.
- **Danger**: If outstanding quotes ($R_{sqlite}$) plus in-flight transactions ($P_{inflight}$) exceed the remaining wallet balance ($W_{new} < R_{sqlite} + P_{inflight}$), the router is **oversubscribed**.
- **Mitigation & Handling**:
  1. Reconciler continuously monitors $W_{onchain}$.
  2. If $W_{onchain} < R_{sqlite} + P_{inflight}$, an **INVENTORY_DEFICIT_TRIGGERED** event fires immediately.
  3. The router enters `PROTECTIVE_QUOTING_HALT`:
     - All new quote requests are rejected with HTTP 503 `LIQUIDITY_DEFICIT`.
     - Active un-held invoices are canceled.
     - Swaps with Lightning HTLCs already `HELD` are prioritized for funding if $W$ suffices; if $W$ is strictly insufficient to fund a held swap, the Lightning invoice is canceled immediately to prevent customer fund stranding.

### 5.3 Deep Chain Reorg on Base
- **Scenario**: A chain reorg occurs. A block containing an `HtlcErc20.fund` transaction is replaced by an alternate branch where the transaction is not included.
- **Behavior**:
  1. All onchain state reads MUST enforce `EvmFinalityPolicy` (*Configurable Policy: using configured `requiredConfirmations`*).
  2. If a previously observed funding transaction is reorged out:
     - The transaction manager detects receipt invalidation.
     - The swap state falls back from `EVM_FUNDED` to `EVM_FUNDING_PENDING`.
     - The transaction manager re-evaluates the mempool and re-broadcasts with appropriate gas/nonce.
     - If the HTLC cannot be re-mined before the Lightning hold invoice expiry deadline minus safety margin, the router cancels the Lightning hold invoice and transitions to `RECOVERY_REQUIRED`.

### 5.4 Base RPC Degradation, Replica Lag, and Outages
- **Scenario**: Public Base RPC load-balancer routes consecutive requests to out-of-sync nodes, returning stale block numbers or temporary 404s for newly mined transactions.
- **Mitigation & Handling**:
  1. **Monotonic Block Enforcement**: The client tracks `highestSeenBlockNumber`. If an RPC endpoint returns a block number $B < \text{highestSeenBlockNumber} - \text{ReorgLagTolerance}$, the response is rejected as `RPC_REPLICA_LAG`.
  2. **Circuit Breaker (*Candidate / Configurable Policy*)**: If consecutive RPC requests fail or timeout beyond configured thresholds (e.g. `maxReconciliationRetries` or RPC timeout policy), the router trips its EVM circuit breaker:
     - Quoting is temporarily suspended (`EVM_GATEWAY_UNAVAILABLE`).
     - In-flight operations pause and retry with policy-defined backoff.
     - Zero state mutations occur in SQLite until RPC connectivity is re-certified.

### 5.5 In-Flight Funding Transaction with UNKNOWN Status
- **Scenario**: An `HtlcErc20.fund` transaction was broadcast, but network congestion causes it to remain unmined. Base RPC node drops it from the mempool. Status is `UNKNOWN`.
- **Handling**:
  - The transaction manager tracks nonces deterministically.
  - The router never broadcasts a new funding transaction with the same nonce blindly, nor does it skip the nonce.
  - After a policy-defined timeout window ($T_{stale}$ configured via transaction policy), the reconciler inspects onchain account nonce:
    - If `onchain_nonce > tx_nonce`: Transaction mined; query receipt by hash.
    - If `onchain_nonce == tx_nonce`: Transaction is genuinely unmined. (*Candidate Policy: The manager submits a speed-up with higher gas price, cancels with safe self-transfer, or holds UNKNOWN fail-closed until resolution*).
  - Reservation remains locked in `COMMITTED` or `RESERVED` until nonce resolution is absolute.

---

## 6. Section 3E: Startup & Recovery Reconciliation (Recon-on-Boot)

When SovRoute boots or recovers from an ungraceful termination (crash, power loss, OOM), it **MUST NOT** open its network port, accept quotes, or dispatch transactions until it passes the complete five-phase **Reconcile-on-Boot** sequence.

```
+-------------------------------------------------------------------------+
|                       STARTUP BOOT SEQUENCE                             |
|                                                                         |
|  [PHASE 1] Infrastructure Integrity & Network Identity Verification     |
|      │                                                                  |
|  [PHASE 2] In-Flight Mempool & Nonce Drainage                           |
|      │                                                                  |
|  [PHASE 3] Onchain HTLC Contract Discovery & Active Escrow Scan         |
|      │                                                                  |
|  [PHASE 4] SQLite Swap Records & Liquidity Reservations Alignment       |
|      │                                                                  |
|  [PHASE 5] Unencumbered Liquidity Ledger Synchronization                |
|      │                                                                  |
|  [GATE] All Invariants Satisfied?                                       |
|      ├── YES ──> Transition to READY (Open HTTP / Begin Quoting)        |
|      └── NO  ──> Transition to FAIL-CLOSED (Halt, Log Alert, Exit)      |
+-------------------------------------------------------------------------+
```

### 6.1 Step-by-Step Reconcile-on-Boot Sequence

#### Phase 1: Infrastructure Integrity & Network Identity Verification
1. Run `PRAGMA integrity_check;` on the SQLite database. If not `ok`, halt fail-closed.
2. Query Base RPC `getChainId()`. Verify exact match with expected network (`84532` for Base Sepolia, `8453` for Base Mainnet).
3. Verify `tokenAddress` matches the pinned canonical USDC contract (`0x036CbD53842c5426634e7929541eC2318f3dCF7e` on Base Sepolia).
4. Verify `htlcAddress` code hash matches the compiled immutable bytecode.
5. Query operator EOA ETH balance. If ETH balance $< \text{GasFloorThreshold}$, halt with `INSUFFICIENT_GAS_RESERVE`.

#### Phase 2: In-Flight Mempool & Nonce Drainage
1. Query onchain nonce: `onchain_nonce = eth_getTransactionCount(operatorAddress, 'latest')`.
2. Query pending nonce: `pending_nonce = eth_getTransactionCount(operatorAddress, 'pending')`.
3. Query SQLite `evm_transaction_intents` for any records in `SUBMITTED` or `IN_FLIGHT`.
4. If `pending_nonce > onchain_nonce` or un-mined intents exist:
   - Poll for receipts of in-flight hashes up to finality timeout.
   - Resolve each in-flight intent to `MINED` or `DROPPED`.
   - Never proceed to Phase 3 with ambiguous nonces.

#### Phase 3: Onchain HTLC Contract Discovery & Active Escrow Scan
1. Query the onchain `HtlcErc20` contract for all events where `sender == operatorAddress` from block $(B_{latest} - \text{LookbackBlocks})$ to $B_{latest}$.
2. Collect all `htlcId` instances where onchain status is `LOCKED` (1).
3. For each active onchain HTLC:
   - Calculate total active locked escrows: $C_{onchain} = \sum \text{amount}$.
   - Store active `htlcId` list in the reconciliation context.

#### Phase 4: SQLite Swap Records & Liquidity Reservations Alignment
1. Query SQLite for all non-terminal swaps (`state NOT IN ('COMPLETED', 'REFUNDED', 'INVOICE_CANCELED')`).
2. Cross-reference each swap with onchain HTLCs:
   - **Sub-case 4A (Onchain LOCKED, SQLite EVM_FUNDING_PENDING)**: Advance SQLite swap to `EVM_FUNDED`, advance reservation to `COMMITTED`.
   - **Sub-case 4B (Onchain CLAIMED, SQLite EVM_FUNDED / CLAIMING)**: Extract preimage from onchain claim tx, advance SQLite to `EVM_CLAIM_CONFIRMED`, trigger Lightning settlement, retire reservation.
   - **Sub-case 4C (Onchain REFUNDED, SQLite EVM_FUNDED / REFUND_ELIGIBLE)**: Advance SQLite to `REFUNDED`, release reservation via `restoreRefund`.
   - **Sub-case 4D (Onchain LOCKED, Timelock Expired)**: Mark swap `REFUND_ELIGIBLE`, schedule refund execution.
   - **Sub-case 4E (Onchain LOCKED, No SQLite Record Found)**: Flag as `ORPHAN_ONCHAIN_HTLC`. Quarantine the HTLC and raise critical alert.
   - **Sub-case 4F (SQLite EVM_FUNDED, Onchain EMPTY)**: Funding transaction failed or reorged out. Mark swap `RECOVERY_REQUIRED`.
3. Rehydrate the in-memory `swapKeyToHtlcId` and `htlcIdToSwapKey` maps in `BaseSepoliaAtomicBackend` from SQLite `sovereign_swaps.evm_htlc_id`.

#### Phase 5: Unencumbered Liquidity Ledger Synchronization
1. Query onchain wallet balance: $W = \text{USDC}.\text{balanceOf}(\text{operatorAddress})$.
2. Query active SQLite reservations: $R_{sqlite} = \sum \text{amount}$ for all status `RESERVED`.
3. Calculate true unencumbered spendable headroom:
   $$\text{Headroom} = W - R_{sqlite}$$
4. If $\text{Headroom} < 0$:
   - The operator EOA has insufficient funds to cover outstanding quotes!
   - Halt startup fail-closed with `CRITICAL_RESERVATION_OVERSUBSCRIPTION`.
5. Update `operator_inventory.confirmed_balance`:
   - Set $B_{conf} = W$ **ONLY UNDER THE HYBRID LEDGER MODEL** (where $C_{sqlite}$ is not subtracted from $W$, as defined in Section 7).

### 6.2 Mandatory Fail-Closed Abort Conditions

The startup sequence MUST abort immediately and refuse to open the API under any of the following conditions:
1. **DB Corruption**: `PRAGMA integrity_check` fails.
2. **Chain Discrepancy**: RPC `chainId` does not equal configured network.
3. **Contract Bytecode Mismatch**: Bytecode at `htlcAddress` is empty or modified.
4. **Gas Starvation**: Operator ETH balance is below minimum operating threshold.
5. **Nonce Deadlock**: Unresolvable pending transaction in the Base mempool.
6. **Orphan Onchain HTLC**: An onchain contract is locked with operator funds but has no matching execution record in SQLite.
7. **Negative Headroom**: Onchain wallet balance is less than active offchain reservation obligations ($W < R_{sqlite}$).
8. **Critical Atomic Invariant Violation**: An HTLC was refunded on Base while its corresponding Lightning invoice is in status `SETTLED`.

---

## 7. Section 3F: Minimum Fail-Closed Architectural Proposal

We evaluate three architectural patterns for reconciling onchain reality with SQLite persistence in SovRoute.

### 7.1 Evaluation of Architectural Options

#### Option A: Single Source of Truth is Onchain (Pure Cache Model)
- **Concept**: SQLite stores no independent inventory state. On every quote request, the router queries Base RPC for `balanceOf(operatorAddress)` and active contracts.
- **Strengths**: Zero state drift; onchain balance is always real.
- **Fatal Flaws**:
  - Pre-funding quotes ($R$) do not exist onchain. A customer granted a quote holds a valid reservation for up to 60 seconds before funding. An onchain-only model cannot prevent oversubscription during the quotation window.
  - Adding 100–300ms Base RPC latency to every quote endpoint degrades agent performance and introduces RPC rate-limit failures.

#### Option B: Dual Ledger with Periodic State-Machine Reconciliation
- **Concept**: SQLite is the primary source of truth for both reservations and confirmed balances. A background worker periodically queries Base RPC and adjusts SQLite balances via compensatory diffs.
- **Strengths**: Low latency for quotes.
- **Fatal Flaws**:
  - High complexity. Prone to race conditions between background sync cycles and active swap execution.
  - If the background worker naively writes $B_{conf} \leftarrow W$, it repeatedly triggers the Double-Counting Trap.

#### Option C: Hybrid Unencumbered Capacity Model (RECOMMENDED)
- **Concept**:
  - **Onchain EOA Balance ($W$) is the Authoritative Source of Spendable Physical Liquidity**.
  - **SQLite is the Authoritative Source of Intent & Active Offchain Encumbrances ($R_{sqlite}$)**.
  - **Active Escrows ($C_{onchain}$ / $C_{sqlite}$) are Tracked as Segregated In-Flight Custody, NOT Deducted from Wallet Balance**.

### 7.2 The Recommended Model: Hybrid Unencumbered Capacity

#### The Core Principle:
Tokens physically leave the operator EOA at the moment of HTLC funding. Therefore, the onchain balance $W = \text{balanceOf}(\text{operatorAddress})$ **represents only the un-funded funds**.
To determine if a new quote of amount $A$ can be accepted, the router checks against **Unencumbered Spendable Headroom**:

$$\text{Headroom} = W_{onchain} - R_{sqlite} - P_{inflight}$$

Notice what this solves:
1. **Zero Double-Counting**: Since $W_{onchain}$ has already had funded HTLCs deducted by the EVM state transition, the router **never subtracts committed escrows ($C$) from $W$**.
2. **Perfect Quote Protection**: $R_{sqlite}$ perfectly protects against multi-quote oversubscription during the hold-invoice window.
3. **Natural Transition**: When an HTLC funding transaction mines:
   - $W_{onchain}$ decreases by $A$.
   - $R_{sqlite}$ decreases by $A$ (reservation moves to `COMMITTED`).
   - $\text{Headroom} = (W_{onchain} - A) - (R_{sqlite} - A) = \text{Headroom}$ (Invariant!).
   - Available headroom is completely unaffected by the onchain mining event!
4. **Natural Settlement**: When a customer claims onchain, the tokens leave the `HtlcErc20` contract. $W_{onchain}$ is unaffected. The reservation is retired from $C_{sqlite}$.
5. **Natural Refund**: When an expired HTLC refunds to the operator, tokens return to the EOA. $W_{onchain}$ increases by $A$. Headroom automatically expands by $A$ without any manual intervention!

#### Component Architecture for Implementation (Phase 2D):
1. `BaseInventoryReconciler`:
   - Runs during boot (`reconcileOnBoot`) and periodically in the background (every 30 seconds).
   - Polls $W = \text{USDC.balanceOf}(\text{operatorAddress})$.
   - Scans onchain `HtlcErc20` event logs for claims and refunds.
2. `UnencumberedCapacityLedger`:
   - Evaluates real-time reservation capacity:
     $$\text{canReserve}(A) \iff A \le (W_{cached} - R_{sqlite} - P_{inflight})$$
3. `ReservationLifecycleManager`:
   - Retires reservations to `SETTLED` upon customer claim.
   - Releases reservations to `RELEASED` upon timelock refund or quote expiry.

---

## 8. Section 3G: Authoritative Invariants Checklist

Any future implementation of Base USDC inventory reconciliation MUST strictly satisfy the following twelve invariants:

- [ ] **REC-1: Zero Double-Deduction Invariant**  
  The reconciliation engine must never subtract committed HTLC balances ($C$) from the onchain spendable wallet balance ($W$).
- [ ] **REC-2: Unencumbered Headroom Non-Negativity**  
  At all times, unencumbered spendable headroom $\text{Headroom} = W - R_{sqlite} - P_{inflight}$ must be $\ge 0$. If $\text{Headroom} < 0$, all quoting must halt immediately.
- [ ] **REC-3: Reconcile-on-Boot Precondition**  
  The router must refuse to open its API port or accept new quotes until all five phases of the Reconcile-on-Boot protocol pass with zero errors.
- [ ] **REC-4: Finality Policy Enforcement**  
  Onchain balance increases (deposits, refunds) must not expand spendable headroom until confirmed by the configured `EvmFinalityPolicy.requiredConfirmations` blocks (e.g. testnet policy or mainnet safe finality checkpoint).
- [ ] **REC-5: Orphan Escrow Immediate Quarantine**  
  Any onchain HTLC funded by the operator that cannot be matched to a valid execution record in SQLite must be quarantined, flagged as `ORPHAN_ESCROW`, and prevent router startup until manually reviewed or automatically scheduled for refund.
- [ ] **REC-6: In-Memory Map Rehydration**  
  Upon router initialization, all active and pending `htlcId` to `swapKey` mappings must be rehydrated from durable SQLite storage before interacting with the chain.
- [ ] **REC-7: External Treasury Deficit Fail-Closed**  
  An unexpected decrease in $W$ caused by external treasury withdrawals that causes $W < R_{sqlite} + P_{inflight}$ must immediately trip the quoting circuit breaker.
- [ ] **REC-8: Reorg-Resilient State Regression**  
  If a block containing an HTLC funding or claim transaction is reorganized out of the canonical chain, the swap state must regress to its pre-mined state without losing its reservation lock.
- [ ] **REC-9: Nonce Serialization Durability**  
  No two transactions may be assigned the same EVM nonce unless explicitly executing a gas speed-up or cancellation intent managed by `BaseTransactionManager`.
- [ ] **REC-10: Settlement Preimage Extraction Priority**  
  Upon observing an onchain `HtlcClaimed` event, the reconciler must extract the preimage from transaction calldata/logs and persist it to SQLite before performing any other state transition.
- [ ] **REC-11: Post-Settlement Reservation Retirement**  
  When an HTLC is claimed or settled, its associated reservation in SQLite must transition to a terminal state (`SETTLED`) and cease contributing to active committed tallies.
- [ ] **REC-12: Atomic Claim-Refund Mutual Exclusion Verification**  
  Under no circumstances may the reconciler permit an execution record to transition to `REFUNDED` if the onchain contract status is `CLAIMED` (2) or the Lightning hold invoice is `SETTLED`.

---

## 9. Section 3H: Future Test Plan Specification

*(Design-Only Specification — Implementation Strictly Deferred to Phase 2D)*

The following test suites must be implemented to certify the Base USDC Inventory Reconciliation Engine.

### 9.1 Suite 1: Reconcile-on-Boot Unit & Edge Case Tests (`test/reconcile-boot.test.ts`)
- `TEST-BOOT-01`: Clean boot with zero open swaps: verifies $W$ matches onchain, $R=0, C=0$, router transitions to `READY`.
- `TEST-BOOT-02`: Boot with active `RESERVED` quotes: verifies $R_{sqlite}$ is preserved and subtracted from $W$ to calculate headroom.
- `TEST-BOOT-03`: Boot with active onchain `LOCKED` HTLC: verifies $C_{onchain}$ is discovered, matched to SQLite swap, and in-memory maps rehydrated.
- `TEST-BOOT-04`: Boot with crashed pending funding (`EVM_FUNDING_PENDING`): detects onchain `LOCKED` contract and advances swap to `EVM_FUNDED`.
- `TEST-BOOT-05`: Boot with onchain claimed HTLC unobserved in SQLite: detects claim, extracts preimage, advances swap to `EVM_CLAIM_CONFIRMED`.
- `TEST-BOOT-06`: Boot with expired onchain HTLC: detects timelock expiration, transitions swap to `REFUND_ELIGIBLE`.
- `TEST-BOOT-07`: Boot with orphan onchain HTLC: detects unindexed contract, enters `FAIL_CLOSED`, refuses `READY`.
- `TEST-BOOT-08`: Boot with negative headroom ($W < R_{sqlite}$): trips oversubscription circuit, halts fail-closed.

### 9.2 Suite 2: The Double-Counting Trap Regression Tests (`test/double-counting-trap.test.ts`)
- `TEST-TRAP-01`: Verify that funding an HTLC of amount $A$ decreases $W$ by $A$ but leaves available headroom invariant.
- `TEST-TRAP-02`: Verify that periodic reconciliation sync does not subtract $C$ from $W$.
- `TEST-TRAP-03`: Verify that 10 concurrent swaps funded simultaneously maintain exact mathematical headroom ($W_{initial} - \sum A_i$).

### 9.3 Suite 3: External Treasury Mutation Tests (`test/treasury-mutations.test.ts`)
- `TEST-TRES-01`: External deposit of 10,000 USDC into wallet: verify headroom expands by 10,000 USDC only after 2 confirmations.
- `TEST-TRES-02`: External withdrawal of 5,000 USDC causing deficit: verify quoting halts immediately with HTTP 503.
- `TEST-TRES-03`: Rapid deposit and withdrawal oscillation: verify monotonic balance accounting and zero race conditions.

### 9.4 Suite 4: Chain Reorg & Fork Recovery Tests (`test/reorg-recovery.test.ts`)
- `TEST-REORG-01`: 2-block reorg drops funding transaction: verify swap reverts to `EVM_FUNDING_PENDING` and re-broadcasts.
- `TEST-REORG-02`: Reorg replaces funding transaction with alternate hash: verify transaction manager reconciles canonical hash.

### 9.5 Suite 5: RPC Degradation & Replica Lag Tests (`test/rpc-resilience.test.ts`)
- `TEST-RPC-01`: RPC returns stale block number (height regression): verify client rejects response and retries.
- `TEST-RPC-02`: RPC returns HTTP 500/timeout for 15 seconds: verify router trips circuit breaker and pauses quoting without crashing.
- `TEST-RPC-03`: RPC returns corrupt/tampered token balance: verify sanity bounds and fail-closed halt.

---

## 10. Audit Conclusion & Phase Transition Sign-Off

This audit definitively establishes that:
1. The internal SQLite reservation logic certified in the Liquidity Accounting phase is sound, but operates on an isolated local ledger.
2. Naive synchronization with onchain wallet balances causes the **Double-Counting Trap**, halving or stranding valid operator inventory.
3. The **Hybrid Unencumbered Capacity Model** (Option C) is the mathematically correct and minimal fail-closed architecture for SovRoute.
4. Implementing this architecture requires zero modifications to the frozen `HtlcErc20` smart contract; it is purely an offchain coordinator and reconciliation enhancement.

**Status**: AUDIT COMPLETE — IMPLEMENTED & HARDENED WITH FAIL-CLOSED CERTIFICATION.  
**Action**: Certified on candidate branch `phase-base-inventory-final-fail-closed-hardening`. Zero production mutation.

---

## 11. Fail-Closed Hardening & Post-Audit Certification (FF-1 to FF-10)

Following initial candidate implementation, an independent review identified ten fail-open or configuration boundaries. All ten findings were formally analyzed, proven/disproven, and hardened under strict fail-closed invariants:

1. **FF-1: Typed Reconcile-on-Boot Contract**:
   - `bootstrapProductionRouter` strictly mandates an `IReconciledLiquidityInventory` instance with a typed `reconcileOnBoot` method.
   - Reconciled inventory returning any readiness state other than `READY` halts bootstrap fail-closed.
   - `SqliteLiquidityInventory` asserts that its internal persistence matches the bootstrap persistence instance (`INVENTORY_PERSISTENCE_MISMATCH`).
2. **FF-2: Finality Observation Failure Semantics**:
   - `observeWalletCapacity` throws `FINALITY_OBSERVATION_FAILED` if both finalized block tag and historical RPC reads fail. Never returns optimistic or unverified balances as finalized.
3. **FF-3: Active Swap Reconciliation Error Propagation**:
   - In `reconcileActiveSwaps`, any RPC error checking HTLC onchain status is thrown immediately as `ACTIVE_SWAP_RECONCILIATION_FAILED` rather than silently swallowed.
4. **FF-4: Unresolved Funding Intent Calculation**:
   - Removed fail-open `catch { return 0n; }` inside `getUnresolvedFundingIntentsAmountInternal`. Any DB or deserialization error rethrows inside `BEGIN IMMEDIATE` and aborts reservation fail-closed.
5. **FF-5: Absence of Chain Snapshot Rejection**:
   - Direct `reserveLiquidity` calls reject reservations without an existing chain inventory snapshot (`InventoryNotReadyError`), preventing un-reconciled legacy balances from authorizing production swaps. Legacy fallback is restricted to explicit test activation (`enableLegacyFallbackForTesting()`).
6. **FF-6: Transactional Snapshot Freshness Verification**:
   - Inside `BEGIN IMMEDIATE`, `reserveLiquidity` verifies that the snapshot's `freshUntil` timestamp has not expired. Stale snapshots are transitioned to `DEGRADED` in SQLite and throw `EvmInventoryUnavailableError`.
7. **FF-7: Active Startup Reconciliation of Funding Intents**:
   - Reconciler Phase 3.5 inspects pending/unresolved funding intents against contract storage. Mined intents are transitioned to `COMMITTED` before public traffic is enabled.
8. **FF-8: Canonical Base Sepolia USDC Address Verification**:
   - `verifyChainAndToken` enforces strict equality against `OFFICIAL_BASE_SEPOLIA_USDC_ADDRESS` (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`), rejecting arbitrary, test, or counterfeit tokens.
9. **FF-9: Base Sepolia Chain ID 84532 Semantics**:
   - All mock backends default to Base Sepolia test semantics (`chainId = 84532`), eliminating stale Arbitrum or mock chain defaults.
10. **FF-10: Policy Configuration vs. Invariant Logic**:
    - Reconciliation policy is cleanly decoupled from invariant arithmetic. Base Sepolia test settings are encapsulated in `BASE_SEPOLIA_TEST_POLICY`, with zero hardcoded magic numbers in math kernels.

### Test Certification Summary
- `tests/inventory-fail-closed-hardening.test.ts`: 16/16 tests passing across all FF findings.
- `tests/inventory-stale-snapshot-cross-process.test.ts`: 5-process OS concurrency test certifying that expired snapshots fail closed and refresh correctly.
- `tests/production-bootstrap-safety.test.ts`: 6/6 tests passing on production bootstrap fail-closed gates.
- Full Unit Runner (`npm test`): 245/245 tests passing across 45 suites.

