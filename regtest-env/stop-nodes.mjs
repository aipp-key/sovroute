import { execSync } from 'node:child_process';
import { join } from 'node:path';

const rootDir = process.cwd();
const binDir = join(rootDir, 'regtest-env', 'bin');
const dataDir = join(rootDir, 'regtest-env', 'data');
const bitcoinCliBin = join(binDir, 'bitcoin-cli.exe');
const lncliBin = join(binDir, 'lncli.exe');

function runSafe(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore' });
  } catch {
    // Ignore errors during stop
  }
}

console.log('Stopping regtest daemons...');

// 1. Stop LND-A
runSafe(
  `"${lncliBin}" --rpcserver=127.0.0.1:10009 --lnddir="${join(dataDir, 'lnd-a')}" stop`
);

// 2. Stop LND-B
runSafe(
  `"${lncliBin}" --rpcserver=127.0.0.1:10010 --lnddir="${join(dataDir, 'lnd-b')}" stop`
);

// 3. Stop bitcoind
runSafe(
  `"${bitcoinCliBin}" -regtest -datadir="${join(dataDir, 'bitcoind')}" -rpcuser=regtest -rpcpassword=regtest stop`
);

// On Windows, also kill any lingering process if needed
if (process.platform === 'win32') {
  runSafe('taskkill /F /IM lnd.exe');
  runSafe('taskkill /F /IM bitcoind.exe');
}

console.log('All regtest daemons stopped.');
