import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const rootDir = process.cwd();
const regtestDir = join(rootDir, 'regtest-env');
const binDir = join(regtestDir, 'bin');
const dataDir = join(regtestDir, 'data');

const bitcoindBin = join(binDir, 'bitcoind.exe');
const bitcoinCliBin = join(binDir, 'bitcoin-cli.exe');
const lndBin = join(binDir, 'lnd.exe');
const lncliBin = join(binDir, 'lncli.exe');

mkdirSync(join(dataDir, 'bitcoind'), { recursive: true });
mkdirSync(join(dataDir, 'lnd-a'), { recursive: true });
mkdirSync(join(dataDir, 'lnd-b'), { recursive: true });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runBtcCli(cmd) {
  try {
    return execSync(
      `"${bitcoinCliBin}" -regtest -datadir="${join(dataDir, 'bitcoind')}" -rpcuser=regtest -rpcpassword=regtest ${cmd}`,
      { encoding: 'utf8' }
    ).trim();
  } catch (err) {
    return null;
  }
}

async function waitForBitcoind(maxSeconds = 30) {
  console.log('Waiting for bitcoind RPC...');
  for (let i = 0; i < maxSeconds; i++) {
    const res = runBtcCli('getblockchaininfo');
    if (res && res.includes('"chain": "regtest"')) {
      console.log('bitcoind RPC is online (regtest).');
      return true;
    }
    await sleep(1000);
  }
  throw new Error('bitcoind failed to start within timeout');
}

async function waitForLnd(lndDir, restPort, maxSeconds = 30) {
  console.log(`Waiting for LND at ${lndDir} (REST ${restPort})...`);
  const certPath = join(lndDir, 'tls.cert');
  const macaroonPath = join(lndDir, 'data', 'chain', 'bitcoin', 'regtest', 'admin.macaroon');

  for (let i = 0; i < maxSeconds; i++) {
    if (existsSync(certPath) && existsSync(macaroonPath)) {
      try {
        const https = await import('node:https');
        const cert = readFileSync(certPath);
        const macHex = readFileSync(macaroonPath).toString('hex');

        const agent = new https.Agent({
          ca: cert,
          checkServerIdentity: () => undefined,
        });

        const res = await new Promise((resolve, reject) => {
          const req = https.request(
            `https://127.0.0.1:${restPort}/v1/getinfo`,
            {
              method: 'GET',
              agent,
              headers: { 'Grpc-Metadata-macaroon': macHex },
              timeout: 2000,
            },
            (resp) => {
              let data = '';
              resp.on('data', (c) => (data += c));
              resp.on('end', () => resolve(data));
            }
          );
          req.on('error', reject);
          req.on('timeout', () => {
            req.destroy();
            reject(new Error('timeout'));
          });
          req.end();
        });

        if (res.includes('"version"') || res.includes('"identity_pubkey"')) {
          console.log(`LND at port ${restPort} is online & authenticated.`);
          return true;
        }
      } catch (err) {
        // Retry
      }
    }
    await sleep(1000);
  }
  throw new Error(`LND at port ${restPort} failed to become ready within timeout`);
}

async function main() {
  console.log('======================================================');
  console.log('STARTING LOCAL REGTEST ENVIRONMENT');
  console.log('======================================================');

  // 1. Launch bitcoind
  const btcProc = spawn(
    bitcoindBin,
    [
      `-conf=${join(regtestDir, 'bitcoind.conf')}`,
      `-datadir=${join(dataDir, 'bitcoind')}`,
    ],
    { stdio: 'ignore', detached: true }
  );
  btcProc.unref();

  await waitForBitcoind();

  // 2. Launch LND-A (Router Node)
  const lndAProc = spawn(
    lndBin,
    [
      `--configfile=${join(regtestDir, 'lnd-a.conf')}`,
      `--lnddir=${join(dataDir, 'lnd-a')}`,
    ],
    { stdio: 'ignore', detached: true }
  );
  lndAProc.unref();

  // 3. Launch LND-B (Payer Node)
  const lndBProc = spawn(
    lndBin,
    [
      `--configfile=${join(regtestDir, 'lnd-b.conf')}`,
      `--lnddir=${join(dataDir, 'lnd-b')}`,
    ],
    { stdio: 'ignore', detached: true }
  );
  lndBProc.unref();

  await waitForLnd(join(dataDir, 'lnd-a'), 18080);
  await waitForLnd(join(dataDir, 'lnd-b'), 18081);

  console.log('======================================================');
  console.log('ALL REGTEST NODES ONLINE:');
  console.log('  bitcoind: 127.0.0.1:18443');
  console.log('  LND-A (Router): 127.0.0.1:18080 (REST), 127.0.0.1:10009 (gRPC)');
  console.log('  LND-B (Payer):  127.0.0.1:18081 (REST), 127.0.0.1:10010 (gRPC)');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('Fatal error starting regtest nodes:', err);
  process.exit(1);
});
