import { execSync } from 'node:child_process';
import { join } from 'node:path';

const rootDir = process.cwd();
const binDir = join(rootDir, 'regtest-env', 'bin');
const dataDir = join(rootDir, 'regtest-env', 'data');
const bitcoinCliBin = join(binDir, 'bitcoin-cli.exe');
const lncliBin = join(binDir, 'lncli.exe');

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

async function main() {
  console.log('======================================================');
  console.log('BOOTSTRAPPING REGTEST BITCOIN & LIGHTNING CHANNEL');
  console.log('======================================================');

  // 1. Create bitcoind miner wallet
  try {
    runBtc('createwallet "miner"');
    console.log('Created bitcoind wallet "miner".');
  } catch {
    // Already created
  }

  const minerAddr = runBtc('-rpcwallet=miner getnewaddress');
  console.log('Mining 101 blocks to mature coinbase...');
  runBtc(`-rpcwallet=miner generatetoaddress 101 ${minerAddr}`);

  // 2. Generate addresses on LND-A and LND-B
  const addrAJson = JSON.parse(runLnA('newaddress p2wkh'));
  const addrBJson = JSON.parse(runLnB('newaddress p2wkh'));
  const addrA = addrAJson.address;
  const addrB = addrBJson.address;

  console.log(`LND-A Address: ${addrA}`);
  console.log(`LND-B Address: ${addrB}`);

  // 3. Fund LND-A and LND-B
  console.log('Sending 5 BTC to LND-A and LND-B...');
  runBtc(`-rpcwallet=miner sendtoaddress ${addrA} 5`);
  runBtc(`-rpcwallet=miner sendtoaddress ${addrB} 5`);
  runBtc(`-rpcwallet=miner generatetoaddress 6 ${minerAddr}`);

  // 4. Wait for LND-B confirmed balance
  console.log('Waiting for LND-B confirmed balance...');
  for (let i = 0; i < 30; i++) {
    const bal = JSON.parse(runLnB('walletbalance'));
    if (BigInt(bal.confirmed_balance) > 0n) {
      console.log(`LND-B confirmed balance: ${bal.confirmed_balance} sats`);
      break;
    }
    await sleep(1000);
  }

  // 5. Connect LND-B to LND-A
  const infoA = JSON.parse(runLnA('getinfo'));
  const pubkeyA = infoA.identity_pubkey;
  console.log(`LND-A Identity Pubkey: ${pubkeyA}`);

  try {
    runLnB(`connect ${pubkeyA}@127.0.0.1:9735`);
    console.log('LND-B connected to LND-A peer.');
  } catch {
    // Already connected
  }

  // 6. Check if channel exists, if not open
  const channels = JSON.parse(runLnB('listchannels')).channels;
  if (!channels || channels.length === 0) {
    console.log('Opening Lightning channel: 1,000,000 sats (push 500,000 sats)...');
    runLnB(`openchannel --node_key=${pubkeyA} --local_amt=1000000 --push_amt=500000`);

    console.log('Mining 6 blocks to confirm channel...');
    runBtc(`-rpcwallet=miner generatetoaddress 6 ${minerAddr}`);
    await sleep(3000);
  } else {
    console.log('Channel already exists.');
    const chan = channels[0];
    const localBal = BigInt(chan.local_balance || 0);
    const remoteBal = BigInt(chan.remote_balance || 0);
    if (localBal < 350_000n && remoteBal > 200_000n) {
      const rebalanceAmt = 350_000n;
      console.log(`Rebalancing channel: restoring Node B local liquidity by ${rebalanceAmt} sats...`);
      try {
        const inv = JSON.parse(runLnB(`addinvoice --amt=${rebalanceAmt} --memo="auto-bootstrap-rebalance"`));
        runLnA(`payinvoice --force ${inv.payment_request}`);
        runBtc(`-rpcwallet=miner generatetoaddress 1 ${minerAddr}`);
        console.log('Channel rebalanced successfully.');
      } catch (err) {
        console.warn('Channel rebalance warning:', err.message);
      }
    }
  }

  // 7. Verify active channel
  for (let i = 0; i < 30; i++) {
    const chanList = JSON.parse(runLnB('listchannels')).channels;
    if (chanList && chanList.length > 0 && chanList[0].active) {
      console.log('Channel is ACTIVE and ready for payments!');
      console.log(`  Channel ID: ${chanList[0].chan_id}`);
      console.log(`  Capacity:   ${chanList[0].capacity} sats`);
      console.log(`  Local Bal:  ${chanList[0].local_balance} sats`);
      console.log(`  Remote Bal: ${chanList[0].remote_balance} sats`);
      break;
    }
    await sleep(1000);
  }

  console.log('======================================================');
  console.log('REGTEST BOOTSTRAP COMPLETE — READY FOR ATOMIC SWAP');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
