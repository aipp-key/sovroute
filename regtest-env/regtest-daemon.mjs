import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { StartupVerifier } from '../src/supply-chain/startup-verifier.ts';

const rootDir = process.cwd();
const regtestDir = join(rootDir, 'regtest-env');
const binDir = join(regtestDir, 'bin');
const dataDir = join(regtestDir, 'data');

// Enforce cryptographic supply-chain verification before any binary execution
console.log('Enforcing cryptographic supply-chain binary verification...');
StartupVerifier.verifyTrustedBinarySet(binDir);
console.log('[PASS] All regtest binaries verified against trusted manifest.');

const bitcoindBin = join(binDir, 'bitcoind.exe');
const bitcoinCliBin = join(binDir, 'bitcoin-cli.exe');
const lndBin = join(binDir, 'lnd.exe');
const lncliBin = join(binDir, 'lncli.exe');

mkdirSync(join(dataDir, 'bitcoind'), { recursive: true });
mkdirSync(join(dataDir, 'lnd-a'), { recursive: true });
mkdirSync(join(dataDir, 'lnd-b'), { recursive: true });

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function runBtc(cmd) {
  return execSync(
    `"${bitcoinCliBin}" -regtest -datadir="${join(dataDir, 'bitcoind')}" -rpcuser=regtest -rpcpassword=regtest ${cmd}`,
    { encoding: 'utf8' }
  ).trim();
}

function runLnA(cmd) {
  return execSync(
    `"${lncliBin}" --network=regtest --rpcserver=127.0.0.1:10009 --lnddir="${join(dataDir, 'lnd-a')}" ${cmd}`,
    { encoding: 'utf8' }
  ).trim();
}

function runLnB(cmd) {
  return execSync(
    `"${lncliBin}" --network=regtest --rpcserver=127.0.0.1:10010 --lnddir="${join(dataDir, 'lnd-b')}" ${cmd}`,
    { encoding: 'utf8' }
  ).trim();
}

async function waitForBitcoind(maxSeconds = 30) {
  for (let i = 0; i < maxSeconds; i++) {
    try {
      const res = runBtc('getblockchaininfo');
      if (res && res.includes('"chain": "regtest"')) {
        return true;
      }
    } catch {
      // Retry
    }
    await sleep(1000);
  }
  throw new Error('bitcoind failed to respond to RPC within timeout');
}

async function waitForLnd(lndDataDir, rpcPort, maxSeconds = 30) {
  for (let i = 0; i < maxSeconds; i++) {
    try {
      const lncmd = rpcPort === 10009 ? runLnA : runLnB;
      const res = lncmd('getinfo');
      if (res && res.includes('"identity_pubkey"')) {
        return true;
      }
    } catch {
      // Retry
    }
    await sleep(1000);
  }
  throw new Error(`LND at port ${rpcPort} failed to getinfo within timeout`);
}

async function main() {
  console.log('======================================================');
  console.log('LAUNCHING REGTEST DAEMON STACK');
  console.log('======================================================');

  // 1. Spawn bitcoind
  console.log('[1/4] Spawning bitcoind...');
  const btcProc = spawn(bitcoindBin, [
    `-conf=${join(regtestDir, 'bitcoind.conf')}`,
    `-datadir=${join(dataDir, 'bitcoind')}`,
  ], { stdio: 'inherit' });

  btcProc.on('exit', (code) => {
    console.error(`bitcoind exited with code ${code}`);
  });

  await waitForBitcoind();
  console.log('bitcoind is online.');

  // 2. Spawn LND-A (Router node)
  console.log('[2/4] Spawning LND-A (Router node)...');
  const lndAProc = spawn(lndBin, [
    `--configfile=${join(regtestDir, 'lnd-a.conf')}`,
    `--lnddir=${join(dataDir, 'lnd-a')}`,
  ], { stdio: 'inherit' });

  lndAProc.on('exit', (code) => {
    console.error(`LND-A exited with code ${code}`);
  });

  // 3. Spawn LND-B (Payer node)
  console.log('[3/4] Spawning LND-B (Payer node)...');
  const lndBProc = spawn(lndBin, [
    `--configfile=${join(regtestDir, 'lnd-b.conf')}`,
    `--lnddir=${join(dataDir, 'lnd-b')}`,
  ], { stdio: 'inherit' });

  lndBProc.on('exit', (code) => {
    console.error(`LND-B exited with code ${code}`);
  });

  await waitForLnd(join(dataDir, 'lnd-a'), 10009);
  console.log('LND-A is online.');
  await waitForLnd(join(dataDir, 'lnd-b'), 10010);
  console.log('LND-B is online.');

  // 4. Bootstrap funds and Lightning channel
  console.log('[4/4] Bootstrapping funds and channel...');
  try {
    runBtc('loadwallet "miner"');
  } catch {
    try {
      runBtc('createwallet "miner"');
    } catch {
      // Ignore if already loaded or exists
    }
  }

  const minerAddr = runBtc('-rpcwallet=miner getnewaddress');
  const btcInfo = JSON.parse(runBtc('getblockchaininfo'));
  if (btcInfo.blocks < 101) {
    console.log(`Mining ${101 - btcInfo.blocks} blocks to reach coinbase maturity...`);
    runBtc(`-rpcwallet=miner generatetoaddress ${101 - btcInfo.blocks} ${minerAddr}`);
  }

  const addrA = JSON.parse(runLnA('newaddress p2wkh')).address;
  const addrB = JSON.parse(runLnB('newaddress p2wkh')).address;

  const balB = JSON.parse(runLnB('walletbalance'));
  if (BigInt(balB.confirmed_balance) < 1_000_000n) {
    console.log('Funding LND-A and LND-B from miner wallet...');
    runBtc(`-rpcwallet=miner sendtoaddress ${addrA} 5`);
    runBtc(`-rpcwallet=miner sendtoaddress ${addrB} 5`);
    runBtc(`-rpcwallet=miner generatetoaddress 6 ${minerAddr}`);

    console.log('Waiting for LND-B confirmed balance...');
    for (let i = 0; i < 30; i++) {
      const b = JSON.parse(runLnB('walletbalance'));
      if (BigInt(b.confirmed_balance) >= 500_000_000n) break;
      await sleep(1000);
    }
  }

  const infoA = JSON.parse(runLnA('getinfo'));
  const pubkeyA = infoA.identity_pubkey;

  try {
    runLnB(`connect ${pubkeyA}@127.0.0.1:9735`);
  } catch {
    // Already connected
  }

  const chanData = JSON.parse(runLnB('listchannels'));
  if (!chanData.channels || chanData.channels.length === 0) {
    console.log('Opening Lightning channel: 1,000,000 sats (push 500,000 sats)...');
    runLnB(`openchannel --node_key=${pubkeyA} --local_amt=1000000 --push_amt=500000`);
    runBtc(`-rpcwallet=miner generatetoaddress 6 ${minerAddr}`);
    await sleep(3000);
  }

  for (let i = 0; i < 30; i++) {
    const list = JSON.parse(runLnB('listchannels')).channels;
    if (list && list.length > 0 && list[0].active) {
      console.log('======================================================');
      console.log('REGTEST STACK IS FULLY READY FOR ATOMIC SWAP TESTS');
      console.log(`  Channel Active: ${list[0].active}`);
      console.log(`  Channel ID:     ${list[0].chan_id}`);
      console.log(`  Capacity:       ${list[0].capacity} sats`);
      console.log(`  Local Balance:  ${list[0].local_balance} sats`);
      console.log(`  Remote Balance: ${list[0].remote_balance} sats`);
      console.log('======================================================');
      break;
    }
    await sleep(1000);
  }

  // Keep daemon alive indefinitely
  setInterval(() => {}, 60000);
}

main().catch((err) => {
  console.error('Fatal regtest daemon error:', err);
  process.exit(1);
});
