/**
 * UNIVERSAL AGENT ASSET ROUTER — ARCHITECTURE V4
 * Pinned Cryptographic Binary Trust Manifest (Phase 2.2A)
 *
 * Explicit project-controlled, reviewable trust root specifications for
 * regtest binary dependencies (Bitcoin Core & LND).
 *
 * Binds:
 *   - Component & Exact Version
 *   - Authorized Signers (Full 40-character Fingerprints + Authoritative Provenance)
 *   - Required Distinct Signer Quorum
 *   - Archive & Executable SHA-256 Checksums
 *
 * NO SECRETS — Public fingerprints and deterministic content hashes only.
 */

export interface SignerTrustSpec {
  readonly identity: string;
  readonly fingerprint: string; // Full 40-character uppercase hex OpenPGP fingerprint
  readonly provenance: string; // Authoritative repository path / upstream source
}

export interface ComponentTrustSpec {
  readonly component: string;
  readonly version: string;
  readonly platform: string;
  readonly archiveFilename: string;
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly manifestUrl: string;
  readonly signatureUrl?: string;
  readonly binaries: Record<string, string>; // binary name -> expected SHA-256
  readonly trustedSigners: readonly SignerTrustSpec[];
  readonly minRequiredSignatures: number;
}

export const TRUSTED_BINARY_MANIFEST: Record<'BITCOIN_CORE' | 'LND', ComponentTrustSpec> = {
  BITCOIN_CORE: {
    component: 'Bitcoin Core',
    version: '28.0.0',
    platform: 'win64',
    archiveFilename: 'bitcoin-28.0-win64.zip',
    archiveUrl: 'https://bitcoincore.org/bin/bitcoin-core-28.0/bitcoin-28.0-win64.zip',
    archiveSha256: '85282f4ec1bcb0cfe8db0f195e8e0f6fb77cfbe89242a81fff2bc2e9292f7acf',
    manifestUrl: 'https://bitcoincore.org/bin/bitcoin-core-28.0/SHA256SUMS',
    signatureUrl: 'https://bitcoincore.org/bin/bitcoin-core-28.0/SHA256SUMS.asc',
    binaries: {
      // Deterministically verified against extracted archive
      'bitcoind.exe': '43fd568770dc6060493949a222a0b556c2a417ebb8853d5c313ae3755107f935',
    },
    // OWNER POLICY: Minimum 6 distinct verified builder signatures required
    minRequiredSignatures: 6,
    trustedSigners: [
      {
        identity: 'Sebastian Falbesoner (theStack) — Bitcoin Core Builder',
        fingerprint: '6A8F9C266528E25AEB1D7731C2371D91CB716EA7',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/theStack.gpg',
      },
      {
        identity: 'Michael Ford (fanquake) — Bitcoin Core Lead Maintainer',
        fingerprint: 'E777299FC265DD04793070EB944D35F9AC3DB76A',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/fanquake.gpg',
      },
      {
        identity: 'Andrew Chow (achow101) — Bitcoin Core Developer',
        fingerprint: '152812300785C96444D3334D17565732E08E5E41',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/achow101.gpg',
      },
      {
        identity: 'Hennadii Stepanov (hebasto) — Bitcoin Core Developer',
        fingerprint: 'D1DBF2C4B96F2DEBF4C16654410108112E7EA81F',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/hebasto.gpg',
      },
      {
        identity: 'Max Edwards (m3dwards) — Bitcoin Core Developer',
        fingerprint: 'E86AE73439625BBEE306AAE6B66D427F873CB1A3',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/m3dwards.gpg',
      },
      {
        identity: 'Wladimir J. van der Laan (laanwj) — Former Lead Maintainer',
        fingerprint: '71A3B16735405025D447E8F274810B012346C9A6',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/laanwj.gpg',
      },
      {
        identity: 'Emzy — Bitcoin Core Builder',
        fingerprint: '9EDAFF80E080659604F4A76B2EBB056FD847F8A7',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/Emzy.gpg',
      },
      {
        identity: 'Will Clark (willcl-ark) — Bitcoin Core Developer',
        fingerprint: '67AA5B46E7AF78053167FE343B8F814A784218F8',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/willcl-ark.gpg',
      },
      {
        identity: 'Pieter Wuille (sipa) — Bitcoin Core Architect',
        fingerprint: '133EAC179436F14A5CF1B794860FEB804E669320',
        provenance: 'bitcoin-core/guix.sigs:builder-keys/sipa.gpg',
      },
    ],
  },
  LND: {
    component: 'LND',
    version: '0.18.5-beta',
    platform: 'windows-amd64',
    archiveFilename: 'lnd-windows-amd64-v0.18.5-beta.zip',
    archiveUrl: 'https://github.com/lightningnetwork/lnd/releases/download/v0.18.5-beta/lnd-windows-amd64-v0.18.5-beta.zip',
    archiveSha256: '24b8b6ad91dd1487dfada1588e55de3d0b67af93e3b3cb1a2548c3fb56309b8e',
    manifestUrl: 'https://github.com/lightningnetwork/lnd/releases/download/v0.18.5-beta/manifest-v0.18.5-beta.txt',
    binaries: {
      'lnd.exe': '18427850a024f58cde8d7b863d71a001bb243449d75d4c5ae32a618be52daed1',
      'lncli.exe': '8f87436dbbc7d1e14c5b03e58f9f30a8ffe1cae7d40136a7765a1a5ae4cd6d7c',
    },
    // UPSTREAM REQUIREMENT: MIN_REQUIRED_SIGNATURES=5 from scripts/verify-install.sh
    minRequiredSignatures: 5,
    trustedSigners: [
      {
        identity: 'Oliver Gugger (guggero) — Lightning Labs Core Engineer',
        fingerprint: 'F4FC70F07310028424EFC20A8E4256593F177720',
        provenance: 'lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh (KEYS[0])',
      },
      {
        identity: 'Elle Mouton (ellemouton) — Lightning Labs Core Engineer',
        fingerprint: '26984CB69EB8C4A26196F7A4D7D916376026F177',
        provenance: 'lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh (KEYS[8])',
      },
      {
        identity: 'Olaoluwa Osuntokun (roasbeef) — Lightning Labs CTO / Author',
        fingerprint: 'A5B61896952D9FDA83BC054CDC42612E89237182',
        provenance: 'lightningnetwork/lnd:scripts/keys/roasbeef.asc (Attested key for v0.18.5-beta release)',
      },
      {
        identity: 'Yong Yu (yyforyongyu) — Lightning Labs Core Engineer',
        fingerprint: 'E85497D2DBA0EB9ADB0024279BCD95C4FF296868',
        provenance: 'lightningnetwork/lnd@v0.18.5-beta:scripts/verify-install.sh (KEYS[12])',
      },
      {
        identity: 'Ziggie (ziggie1984) — Core Contributor / Release Signer',
        fingerprint: '5F75437E11695F86D50C11BB1AFF9C4DCED6D666',
        provenance: 'lightningnetwork/lnd:scripts/verify-install.sh',
      },
    ],
  },
} as const;
