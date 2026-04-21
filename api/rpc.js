const https = require('https');

const RPCS = [
  { host: 'monad-mainnet.drpc.org',   path: '/' },
  { host: 'rpc.monad.xyz',            path: '/' },
  { host: 'monad-rpc.publicnode.com', path: '/' },
];

function httpsPost(host, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname: host, port: 443, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'User-Agent': 'monad-card/1.0' },
        timeout: 10000 },
      (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { reject(new Error('Bad JSON from ' + host)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data); req.end();
  });
}

function httpsGet(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: host, port: 443, path, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 },
      (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Single RPC call with fallback across providers
async function rpcCall(payload) {
  const errors = [];
  for (const { host, path } of RPCS) {
    try {
      const { status, body } = await httpsPost(host, path, payload);
      if (status === 200 && !body.error) return body;
      if (body.error) errors.push(host + ': ' + JSON.stringify(body.error));
      else errors.push(host + ': HTTP ' + status);
    } catch (e) { errors.push(host + ': ' + e.message); }
  }
  throw new Error('All RPCs failed: ' + errors.join(' | '));
}

// Single NFT balanceOf check
async function checkNft(wallet, contractAddr) {
  const padded = wallet.slice(2).padStart(64, '0');
  const data = '0x70a08231' + padded; // balanceOf(address)
  try {
    const res = await rpcCall({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: contractAddr, data }, 'latest']
    });
    if (!res.result || res.result === '0x') return false;
    return parseInt(res.result, 16) > 0;
  } catch {
    return false;
  }
}

async function calcBlocksPerDay() {
  try {
    const r1 = await rpcCall({ jsonrpc:'2.0', id:1, method:'eth_blockNumber', params:[] });
    const latestNum = parseInt(r1.result, 16);
    const oldNum = Math.max(1, latestNum - 5000);
    const [rb1, rb2] = await Promise.all([
      rpcCall({ jsonrpc:'2.0', id:2, method:'eth_getBlockByNumber', params:['0x'+latestNum.toString(16), false] }),
      rpcCall({ jsonrpc:'2.0', id:3, method:'eth_getBlockByNumber', params:['0x'+oldNum.toString(16), false] }),
    ]);
    const t1 = parseInt(rb1.result.timestamp, 16);
    const t0 = parseInt(rb2.result.timestamp, 16);
    const blockTime = (t1 - t0) / (latestNum - oldNum);
    return Math.round(86400 / blockTime);
  } catch { return 172800; }
}

async function getActiveDays(address, latestBlock, blocksPerDay, maxDays) {
  let lo = 0, hi = Math.min(maxDays, Math.floor(latestBlock / blocksPerDay));
  for (let i = 0; i < 10 && hi > lo; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const blk = '0x' + Math.max(1, latestBlock - mid * blocksPerDay).toString(16);
    try {
      const r = await rpcCall({ jsonrpc:'2.0', id:10, method:'eth_getTransactionCount', params:[address, blk] });
      parseInt(r.result, 16) > 0 ? hi = mid : lo = mid + 1;
    } catch { break; }
  }
  return Math.max(0, hi);
}

async function getExplorerTxCount(address) {
  try {
    const { status, body } = await httpsGet('monad.socialscan.io', `/api/v2/addresses/${address}`);
    if (status === 200) {
      const j = JSON.parse(body);
      if (j.transaction_count != null) return j.transaction_count;
    }
  } catch {}
  try {
    const { status, body } = await httpsGet('monadvision.com', `/address/${address}`);
    if (status === 200) {
      const m = body.match(/"transactionCount"\s*:\s*"?(\d+)"?/i)
             || body.match(/(\d[\d,]*)\s*transactions/i);
      if (m) return parseInt(m[1].replace(/,/g,''), 10);
    }
  } catch {}
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // ── walletStats action ──
  if (body.action === 'walletStats' && body.address) {
    const address = body.address;
    try {
      const [txRes, balRes, blockRes] = await Promise.all([
        rpcCall({ jsonrpc:'2.0', id:1, method:'eth_getTransactionCount', params:[address,'latest'] }),
        rpcCall({ jsonrpc:'2.0', id:2, method:'eth_getBalance',          params:[address,'latest'] }),
        rpcCall({ jsonrpc:'2.0', id:3, method:'eth_blockNumber',         params:[] }),
      ]);

      const outgoingTxns = parseInt(txRes.result, 16);
      const monBalance   = (Number(BigInt(balRes.result)) / 1e18).toFixed(3);
      const latestBlock  = parseInt(blockRes.result, 16);

      const mainnetLaunch = new Date('2025-11-24T00:00:00Z');
      const maxDays = Math.floor((Date.now() - mainnetLaunch.getTime()) / 86400000);

      const [blocksPerDay, explorerCount] = await Promise.all([
        calcBlocksPerDay(),
        getExplorerTxCount(address),
      ]);

      let activeDays = 0;
      if (outgoingTxns > 0) {
        activeDays = await getActiveDays(address, latestBlock, blocksPerDay, maxDays);
        activeDays = Math.min(activeDays, maxDays);
      }

      const totalTxns = (explorerCount != null && explorerCount >= outgoingTxns)
        ? explorerCount : outgoingTxns;
      const txSource = explorerCount != null ? 'explorer' : 'nonce';
      const dapps = outgoingTxns === 0 ? 0 : Math.min(60, Math.max(1, Math.round(Math.sqrt(outgoingTxns) * 1.5)));

      return res.status(200).json({ txns: totalTxns, outgoingTxns, monBalance, activeDays, maxDays, blocksPerDay, dapps, txSource });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── checkNft action: check a single NFT balance ──
  if (body.action === 'checkNft' && body.wallet && body.contract) {
    try {
      const holds = await checkNft(body.wallet, body.contract);
      return res.status(200).json({ holds });
    } catch (e) {
      return res.status(200).json({ holds: false, error: e.message });
    }
  }

  // ── plain RPC passthrough ──
  try {
    const data = await rpcCall(body);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
