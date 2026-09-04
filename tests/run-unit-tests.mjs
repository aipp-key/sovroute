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
];

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...unitTestFiles],
  { stdio: 'inherit' }
);

process.exit(res.status ?? 0);
