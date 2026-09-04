# UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
# PHASE 4 / 4.0A: DIRECT BASE USDC ROUTE REPORT (BASE SEPOLIA PUBLIC TESTNET)

**Project:** Universal Agent Asset Router  
**Repository:** `c:\Users\faruk\Desktop\universal-agent-asset-router`  
**Phase:** Phase 4.0A — Base Deployment Identity + Live Refund Closure  
**Mode:** Public Testnet Protocol Validation (Zero Economic Value)  
**Target Chain:** Base Sepolia (Chain ID 84532)  
**Status:** **BASE DEPLOYMENT IDENTITY + LIVE REFUND CLOSURE PASSED — DIRECT BASE ROUTE FULLY FROZEN — READY FOR OWNER REVIEW**  
**Final Verdict:** **Choice A**  

---

## 1. Executive Verdict

**Verdict: Choice A**
> **BASE DEPLOYMENT IDENTITY + LIVE REFUND CLOSURE PASSED — DIRECT BASE ROUTE FULLY FROZEN — READY FOR OWNER REVIEW**  
> 
> The architectural transition to the direct Base USDC route and deployment freeze is 100% complete and proven live on-chain:
> - **Canonical Raw Bytecode Hashing:** Pinned identity upgraded from legacy UTF-8 hex text to SHA-256 of raw decoded runtime bytecode bytes (`8627fe35109888bbb58873f4e8f3beb90c7c0efee1411f81de9aa21a602e1d67`). Matches clean local compiler output and on-chain Base Sepolia `eth_getCode` 100%.
> - **Build Configuration Freeze:** Hardhat `evmVersion: "paris"` explicitly pinned in `hardhat.config.cjs`. Build-info audit confirmed 0 source drift and 0 bytecode drift between local devnet and Base Sepolia.
> - **Live Public Base Sepolia Deployment:** `HtlcErc20.sol` deployed live at [`0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f`](https://sepolia.basescan.org/address/0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f).
> - **Live Public Base Sepolia Refund Proof:** Executed on Base Sepolia with compressed test timelock (120s). Early refund reverted with `TIMELOCK_NOT_EXPIRED`. Refund transaction succeeded in block `46341949`. Contract state verified `REFUNDED` (3). Tokens returned to operator (+0.01 USDC). Post-refund claim reverted with `NOT_LOCKED`. Linked LND invoice canceled safely (`CANCELED`, 0 sats lost).
> - **Live Cross-Rail Atomic Happy Path Proven:** Real LND hold invoice on regtest $\longleftrightarrow$ live Base Sepolia HTLC holding official Circle test USDC $\rightarrow$ sovereign client claim broadcast $\rightarrow$ verified claim evidence $\rightarrow$ LND hold invoice settled.
> - **Test Suite:** **274 / 274 tests passing (100%)**. Clean typecheck. Clean secret scan (0 secrets).

---

## 2. Frozen Deployment Identity Record

The exact deployment identity is frozen in [`regtest-env/data/base-sepolia-deployment.json`](file:///c:/Users/faruk/Desktop/universal-agent-asset-router/regtest-env/data/base-sepolia-deployment.json):

| Property | Value | Notes |
|:---|:---|:---|
| **Protocol Version** | `4.0.0` | Architecture V4 Sovereign Core |
| **Chain ID** | `84532` (`0x14a34`) | Base Sepolia Public Testnet |
| **Network** | `base-sepolia` | Guarded by `BaseNetworkGuard` |
| **Contract Address** | `0x3e4b1374d2a42ed3aca3470978fc4ec52914ae6f` | Immutable `HtlcErc20.sol` |
| **Official USDC Address** | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Official Circle Base Sepolia Test USDC |
| **USDC Decimals** | `6` | Strictly enforced |
| **Deployment Tx Hash** | `0x520ea899fe981d49a1c718acd256436d9c6b19e905e32f70428691bc82a33760` | Base Sepolia |
| **Deployment Block** | `46341060` | Mined block |
| **Solc Version** | `0.8.28` | Exact compiler release |
| **Solc Commit** | `0.8.28+commit.7893614a` | Build commit |
| **Optimizer** | `enabled: true`, `runs: 200` | Verified |
| **EVM Version** | `paris` | Explicitly pinned in `hardhat.config.cjs` |
| **Source Code SHA-256** | `738496dd9b2364f7d042e7347d1b6913973534784594ca3b85f94c848085626d` | `contracts/HtlcErc20.sol` (0 semantic drift) |
| **Canonical Raw Bytecode SHA-256** | `8627fe35109888bbb58873f4e8f3beb90c7c0efee1411f81de9aa21a602e1d67` | SHA-256 of raw binary decoded bytes |
| **Legacy Hex-String Hash** | `10dc4b0c4864722e9770f035a0d64f2963d642bc165146bba4871a0e131a58cd` | SHA-256 of UTF-8 string (historical) |

---

## 3. Build Configuration Drift Audit Result

### Investigation Details:
1. **Hardhat Compiler Output:** Inspected `artifacts/build-info/5e1d6425b01d7776ef2d8818419f0e9f.json`. The compiler input settings show `"evmVersion": "paris"`.
2. **Hardhat Default:** Hardhat's internal Solidity compiler wrapper targets `"paris"` by default when no `evmVersion` is specified.
3. **Phase 3 Documentation Discrepancy:** Phase 3 documentation text mentioned `cancun` based on upstream solc 0.8.28 default, while Hardhat had compiled with `"paris"`.
4. **Resolution:**
   - `hardhat.config.cjs` was updated to explicitly specify `evmVersion: "paris"`.
   - Recompilation confirmed that local runtime bytecode and deployed Base Sepolia runtime bytecode are 100% byte-for-byte identical (`8627fe35109888bbb58873f4e8f3beb90c7c0efee1411f81de9aa21a602e1d67`).
   - Zero source code changes. Zero bytecode drift. Complete configuration freeze.

---

## 4. Canonical Raw Bytecode Hashing & Guard Hardening

The bytecode guard implementation was upgraded from hashing the UTF-8 hex string to the canonical raw binary byte hashing pipeline:
$$\text{eth\_getCode} \longrightarrow \text{strip } 0x \longrightarrow \text{validate even-length hex} \longrightarrow \text{decode to raw bytes} \longrightarrow \text{SHA-256}(\text{raw bytes})$$

### Guard Tests Added & Passing (`tests/base-sepolia-route.test.ts`):
1. **Exact Raw Bytecode Passes:** Live on-chain raw bytecode matches `PINNED_HTLC_BYTECODE_RAW_SHA256`.
2. **One-Byte Mutation Fails:** Mutating any byte fails fail-closed with `BaseBytecodeMismatchError`.
3. **Hex Representation Independence:** Uppercase and lowercase hex produce identical raw byte hashes.
4. **Prefix Independence:** Bytecode with or without `0x` produces identical raw byte hashes.
5. **Malformed Hex Handling:** Odd-length hex and non-hex characters fail closed immediately.

---

## 5. Live Public Base Sepolia Refund Proof Evidence

To prove the failure and refund path without waiting 12 hours, a live test swap was executed on Base Sepolia using a compressed test-specific timelock (120 seconds).

### Public Transaction Evidence:
- **Funding Transaction:** [`0xcc03039230d138fcd3e14b833a328d89f13645fbf5aaa21fe7c47e81a1778b56`](https://sepolia.basescan.org/tx/0xcc03039230d138fcd3e14b833a328d89f13645fbf5aaa21fe7c47e81a1778b56)
- **Fund Block:** `46341888`
- **Canonical HTLC ID:** `0x1ecac6f9010ae9812839dd753d12fd9ff0bcf37f1c0ab3c489e6a8f5ee9e7321`
- **Amount:** `10,000` base units (`0.01` Base Sepolia test USDC)
- **Test Timelock Duration:** `120` seconds (test-only compressed duration; production remains 12h)
- **Early Refund Rejection Proof:** Prior to timestamp `1788452180`, operator refund simulation reverted with `TIMELOCK_NOT_EXPIRED`.
- **Refund Transaction:** [`0x4b479716da9cd208c141d978e6026e4a7cec731b831ce79c4dc34cec17d3089f`](https://sepolia.basescan.org/tx/0x4b479716da9cd208c141d978e6026e4a7cec731b831ce79c4dc34cec17d3089f)
- **Refund Block:** `46341949`
- **Final Contract Storage:** Verified `getHtlc(htlcId).status == 3` (`REFUNDED`).
- **Token Balance Restoration:** Operator USDC balance increased by exactly `+10,000` units (`+0.01 USDC`).
- **Post-Refund Claim Mutual Exclusion Proof:** Client simulation of `claim(htlcId, preimage)` after refund reverted with `NOT_LOCKED`.
- **Lightning Safe Cancellation:** Linked LND hold invoice verified in terminal `CANCELED` state (0 sats lost).

---

## 6. Public Chain Confirmation & Finality Policy

- **Base Sepolia Phase 4 Test Policy:**
  $$\mathbf{FINAL\_ENOUGH\_FOR\_PROTOCOL} = \mathbf{2\ confirmations}$$
  *(Explicit note: This is the configured Base Sepolia testnet safety policy. Mainnet production policy will evaluate sequencer soft-finality, L1 batch publication, and challenge windows).*
- **Detection vs Confirmation Gate:**
  - `EVM_CLAIM_DETECTED`: Mempool or 0 confirmations. Does not authorize settlement.
  - `EVM_CLAIM_CONFIRMED`: Mined on-chain with $\ge 2$ block confirmations.
  - Only confirmed claim evidence at `FINAL_ENOUGH_FOR_PROTOCOL` authorizes Lightning hold invoice settlement.

---

## 7. Wording Corrections & MEV Clarification

- **Accurate DEX / MEV Scoping:** Direct Base route eliminates DEX routing MEV, sandwich attacks, and liquidity pool slippage in the customer path because the operator directly quotes the swap without on-chain AMM pools.
- **General Public-Chain Considerations:** General public-chain transaction ordering, sequencer latency, and reorg considerations remain applicable to HTLC transactions and are guarded by explicit confirmation thresholds, replica polling, and mutual exclusion gates.

---

## 8. Test & Audit Summary Matrix

| Suite | Tests | Passed | Failed | Status |
|:---|:---:|:---:|:---:|:---:|
| Core Sovereign Unit Tests (`npm test`) | 155 | 155 | 0 | **PASS** |
| Real LND Regtest Suite (`npm run regtest:test`) | 63 | 63 | 0 | **PASS** |
| Real EVM HTLC Suite (`npm run evm:test`) | 24 | 24 | 0 | **PASS** |
| Real Cross-Rail Integration Suite (`npm run test:cross-rail`) | 6 | 6 | 0 | **PASS** |
| Base Sepolia Route & Live Suite (`npm run base:test`) | 26 | 26 | 0 | **PASS** |
| **TOTAL (`npm run test:all`)** | **274** | **274** | **0** | **PASS** |

- **TypeScript Typecheck (`npm run typecheck`):** Clean (0 errors).
- **Secret Scanner (`python tests/scan-secrets.py`):** Clean (0 secrets).
- **Zero Real Money:** Confirmed.
- **Zero Mainnet Writes:** Confirmed.
- **Zero CCTP / Zero DEX in Initial Route:** Confirmed.
