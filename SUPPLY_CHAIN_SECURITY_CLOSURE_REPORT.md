# SUPPLY-CHAIN SECURITY CLOSURE REPORT (PHASE 2.2B)
**Universal Agent Asset Router — Architecture V4**  
**Date**: September 3, 2026  
**Status**: COMPLETE — STRICT OPENPGP & VERSION-FROZEN HISTORICAL TRUST ROOTS

---

## 1. Executive Verdict

**STRICT OPENPGP CLOSURE PASSED — HISTORICAL TRUST ROOTS FROZEN — LIGHTNING SUPPLY CHAIN FULLY CLOSED**

Owner review identified two critical security concerns in Phase 2.2A:
1. `allowInsecureVerificationWithReformattedKeys: true` was temporarily active during OpenPGP verification.
2. LND public keys were fetched from mutable `master` branch rather than version-appropriate historical key material.

Both concerns have been resolved with zero compromises:
- **Zero Insecure Overrides**: `allowInsecureVerificationWithReformattedKeys` is completely removed from the repository. Standard, strict OpenPGP key validity checks are enforced.
- **Signature-Time Validity**: Signatures are evaluated at authenticated signature creation time (`sig.packets[0].created`), ensuring keys and subkey bindings were valid when the release was signed.
- **Historical Trust Roots Frozen**:
  - `roasbeef.asc`: Frozen to release-era commit `cb0f0dd8a4f4373c075028473c32e8dbac41b147` (October 2024), whose subkey binding signature was active at the February 2025 release date.
  - `achow101.asc`: Frozen to release-era commit `6c3eef4bd9cd3731c33b17d8e0b96d3de84f8724` (August 2024).
- **Offline Trust**: Trust root keys are bundled locally. Runtime performs zero network calls to keyservers or GitHub for key discovery.

---

## 2. Bitcoin Core Trust Chain & Provenance (Strict OpenPGP)

```
Upstream: bitcoincore.org / bitcoin-core/guix.sigs
  ├── Plaintext Manifest: https://bitcoincore.org/bin/bitcoin-core-28.0/SHA256SUMS
  └── Multi-Sig Attestation: https://bitcoincore.org/bin/bitcoin-core-28.0/SHA256SUMS.asc (13 detached PGP signatures)
        ↓
Strict Cryptographic Verification:
  - Tooling: pure-JS openpgp (v6.3.1, zero transitive dependencies)
  - Mode: STRICT (zero insecure overrides, date = sig.packets[0].created)
  - Quorum Required: >= 6 DISTINCT builder signatures
  - Actual Strict Verified Signers: 9 DISTINCT builders
        ↓
Authorized Pinned Builders & Authoritative Provenance:
  1. 6A8F9C266528E25AEB1D7731C2371D91CB716EA7 — Sebastian Falbesoner (theStack)
     Provenance: bitcoin-core/guix.sigs:builder-keys/theStack.gpg
  2. E777299FC265DD04793070EB944D35F9AC3DB76A — Michael Ford (fanquake, Lead Maintainer)
     Provenance: bitcoin-core/guix.sigs:builder-keys/fanquake.gpg
  3. 152812300785C96444D3334D17565732E08E5E41 — Andrew Chow (achow101)
     Provenance: bitcoin-core/guix.sigs:6c3eef4:builder-keys/achow101.gpg (Historical v28-era key)
  4. D1DBF2C4B96F2DEBF4C16654410108112E7EA81F — Hennadii Stepanov (hebasto)
     Provenance: bitcoin-core/guix.sigs:builder-keys/hebasto.gpg
  5. E86AE73439625BBEE306AAE6B66D427F873CB1A3 — Max Edwards (m3dwards)
     Provenance: bitcoin-core/guix.sigs:builder-keys/m3dwards.gpg
  6. 71A3B16735405025D447E8F274810B012346C9A6 — Wladimir J. van der Laan (laanwj, Former Lead)
     Provenance: bitcoin-core/guix.sigs:builder-keys/laanwj.gpg
  7. 9EDAFF80E080659604F4A76B2EBB056FD847F8A7 — Emzy
     Provenance: bitcoin-core/guix.sigs:builder-keys/Emzy.gpg
  8. 67AA5B46E7AF78053167FE343B8F814A784218F8 — Will Clark (willcl-ark)
     Provenance: bitcoin-core/guix.sigs:builder-keys/willcl-ark.gpg
  9. 133EAC179436F14A5CF1B794860FEB804E669320 — Pieter Wuille (sipa, Architect)
     Provenance: bitcoin-core/guix.sigs:builder-keys/sipa.gpg
        ↓
Archive Hash Verification:
  - Manifest contains: 85282f4ec1bcb0cfe8db0f195e8e0f6fb77cfbe89242a81fff2bc2e9292f7acf  bitcoin-28.0-win64.zip
  - Downloaded archive SHA-256 matches authenticated manifest byte-for-byte
        ↓
Extracted Binary Verification:
  - Extracted bitcoind.exe SHA-256: 43fd568770dc6060493949a222a0b556c2a417ebb8853d5c313ae3755107f935
  - Enforced before every startup via StartupVerifier.verifyTrustedBinarySet()
```

---

## 3. LND Trust Chain & Provenance (Strict OpenPGP)

```
Upstream: lightningnetwork/lnd @ tag v0.18.5-beta
  ├── Manifest: manifest-v0.18.5-beta.txt
  └── Detached Signatures: 5 .sig files uploaded to GitHub release
        ↓
Strict Cryptographic Verification:
  - Tooling: pure-JS openpgp (v6.3.1)
  - Mode: STRICT (zero insecure overrides, date = sig.packets[0].created)
  - Quorum Required: >= 5 DISTINCT maintainer signatures (Exact upstream requirement)
  - Actual Strict Verified Signers: 5 DISTINCT maintainers
        ↓
Authorized Pinned Maintainers & Authoritative Provenance:
  1. F4FC70F07310028424EFC20A8E4256593F177720 — Oliver Gugger (guggero)
     Provenance: lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh:KEYS[0]
  2. 26984CB69EB8C4A26196F7A4D7D916376026F177 — Elle Mouton (ellemouton)
     Provenance: lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh:KEYS[8]
  3. A5B61896952D9FDA83BC054CDC42612E89237182 — Olaoluwa Osuntokun (roasbeef)
     Provenance: lightningnetwork/lnd:cb0f0dd:scripts/keys/roasbeef.asc (Historical release key)
  4. E85497D2DBA0EB9ADB0024279BCD95C4FF296868 — Yong Yu (yyforyongyu)
     Provenance: lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh:KEYS[12]
  5. 5F75437E11695F86D50C11BB1AFF9C4DCED6D666 — Ziggie (ziggie1984)
     Provenance: lightningnetwork/lnd:scripts/verify-install.sh
        ↓
Archive & Binary Hashes Verification:
  - Archive: 24b8b6ad91dd1487dfada1588e55de3d0b67af93e3b3cb1a2548c3fb56309b8e (lnd-windows-amd64-v0.18.5-beta.zip)
  - lnd.exe: 18427850a024f58cde8d7b863d71a001bb243449d75d4c5ae32a618be52daed1
  - lncli.exe: 8f87436dbbc7d1e14c5b03e58f9f30a8ffe1cae7d40136a7765a1a5ae4cd6d7c
        ↓
Runtime Startup Gate:
  - Re-verified on disk prior to any child process spawn
```

---

## 4. Why Strict Verification Failed Initially & Root Cause Analysis

### Roasbeef (LND)
- **Symptom**: `Could not find valid signing key packet in key dc42612e89237182: Signature creation time is in the future`.
- **Root Cause**: The key file obtained from `master` (`81ff01c9cc`) was updated on October 22, 2025. Its subkey binding signature had a timestamp of `2025-10-22T11:03:01Z`. When OpenPGP evaluated the release signature (created on February 11, 2025), the subkey binding signature did not yet exist in historical time.
- **Fix**: Replaced with historical key from commit `cb0f0dd8a4f4373c075028473c32e8dbac41b147` (October 21, 2024), which contains subkey binding signatures created before the release was signed. Under strict verification at `sigDate`, this key strictly passes.

### Andrew Chow (Bitcoin Core)
- **Symptom**: `Could not find valid self-signature in key 17565732e08e5e41: Signature creation time is in the future`.
- **Root Cause**: The key from `master` was updated on August 21, 2025 (`5462aee6`), with self-signatures dated 2025. The Bitcoin Core v28.0.0 release was signed on October 2, 2024.
- **Fix**: Replaced with historical key from commit `6c3eef4bd9cd3731c33b17d8e0b96d3de84f8724` (August 28, 2024). Under strict verification at `sigDate`, this key strictly passes.

---

## 5. Real Release Artifact Verification Evidence (Strict OpenPGP)

Direct execution against official production release artifacts with zero insecure overrides:

### Bitcoin Core v28.0.0
- **Signatures present in `SHA256SUMS.asc`**: 13
- **Signatures strictly valid & matching pinned signers**: 9
- **Required quorum**: 6
- **Strictly verified builder fingerprints**:
  - `6A8F9C266528E25AEB1D7731C2371D91CB716EA7` (theStack)
  - `133EAC179436F14A5CF1B794860FEB804E669320` (sipa)
  - `E86AE73439625BBEE306AAE6B66D427F873CB1A3` (m3dwards)
  - `67AA5B46E7AF78053167FE343B8F814A784218F8` (willcl-ark)
  - `9EDAFF80E080659604F4A76B2EBB056FD847F8A7` (Emzy)
  - `E777299FC265DD04793070EB944D35F9AC3DB76A` (fanquake)
  - `152812300785C96444D3334D17565732E08E5E41` (achow101)
  - `71A3B16735405025D447E8F274810B012346C9A6` (laanwj)
  - `D1DBF2C4B96F2DEBF4C16654410108112E7EA81F` (hebasto)
- **Verdict**: **STRICT PASS (9 / 6 met)**

### LND v0.18.5-beta
- **Signatures present on GitHub release**: 5
- **Signatures strictly valid & matching pinned signers**: 5
- **Required upstream quorum**: 5
- **Strictly verified maintainer fingerprints**:
  - `26984CB69EB8C4A26196F7A4D7D916376026F177` (ellemouton)
  - `F4FC70F07310028424EFC20A8E4256593F177720` (guggero)
  - `A5B61896952D9FDA83BC054CDC42612E89237182` (roasbeef)
  - `E85497D2DBA0EB9ADB0024279BCD95C4FF296868` (yyforyongyu)
  - `5F75437E11695F86D50C11BB1AFF9C4DCED6D666` (ziggie1984)
- **Verdict**: **STRICT PASS (5 / 5 met)**

---

## 6. Test Suite Coverage & Regression Evidence

| Suite | File | Tests | Result |
|:------|:-----|:------|:-------|
| Strict OpenPGP & Trust Root | `tests/supply-chain-signature.test.ts` | 21 | ✅ 21/21 PASS |
| Phase 2 Real LND Regtest | `tests/lnd-regtest-atomic.test.ts` | 42 | ✅ 42/42 PASS |
| Phase 2.1 LND Security Closure | `tests/lnd-security-closure.test.ts` | 21 | ✅ 21/21 PASS |
| Core & Orchestrator Unit Tests | 11 remaining unit test files | 134 | ✅ 134/134 PASS |
| **Total Automated Executions** | | **218** | **✅ 218/218 PASS** |

- **Typecheck**: `npm run typecheck` $\rightarrow$ **0 errors**
- **Secret Scanner**: `python tests/scan-secrets.py` $\rightarrow$ **SCAN CLEAN (0 secrets found)**

---

## 7. Remaining Supply-Chain Risks

| Risk | Severity | Mitigation / Status |
|:-----|:---------|:---------------------|
| Upstream key compromise | Negligible | Protected by multi-builder and multi-maintainer distinct quorum thresholds ($\ge 6$ and $\ge 5$). |
| Memory compromise of running binary | Residual | Process isolation; non-custodial architecture; zero client secrets stored. |
| Future node upgrade supply-chain | Informational | Pinned version policy requires explicit owner approval for version bumps. |
