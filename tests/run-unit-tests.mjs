import { spawnSync } from 'node:child_process';

const unitTestFiles = [
  'tests/architecture-v3.test.ts',
  'tests/cross-process-safety.test.ts',
  'tests/fixedfloat-and-execution-class.test.ts',
  'tests/orchestrator-scenarios.test.ts',
  'tests/persistence.test.ts',
  'tests/pre-money-adversarial.test.ts',
  'tests/sovereign-atomic-core.test.ts',
  'tests/state-machine.test.ts',
  'tests/supply-chain-signature.test.ts',
  'tests/liquidity-accounting-safety.test.ts',
  'tests/liquidity-cross-process.test.ts',
  'tests/inventory-reconciliation-safety.test.ts',
  'tests/inventory-cross-process.test.ts',
  'tests/inventory-fail-closed-hardening.test.ts',
  'tests/inventory-stale-snapshot-cross-process.test.ts',
  'tests/production-bootstrap-safety.test.ts',
  'tests/inventory-final-four-blockers.test.ts',
  'tests/cross-rail-reservation-retention-cross-process.test.ts',
  'tests/final-blocker-remediation.test.ts',
  'tests/recovery-bootstrap-terminality.test.ts',
];

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...unitTestFiles],
  { stdio: 'inherit' }
);

process.exit(res.status ?? 0);
