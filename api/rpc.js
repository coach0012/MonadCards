const https = require('https');

const RPCS = [
  { host: 'monad-mainnet.drpc.org', path: '/' },
  { host: 'rpc.monad.xyz',          path: '/' },
  { host: 'monad-rpc.publicnode.com', path: '/' },
];

function postRpc(host, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: host,
      port: 443,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'monad-card/1.0',
      },
      timeout: 9000,
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Bad JSON from ' + host)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + host)); });
    req.write(data);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (!body) {
    return res.status(400).json({ error: 'Empty body' });
  }

  const errors = [];
  for (const { host, path } of RPCS) {
    try {
      const data = await postRpc(host, path, body);
      return res.status(200).json(data);
    } catch (e) {
      errors.push(`${host}: ${e.message}`);
    }
  }

  return res.status(502).json({
    error: 'All RPC endpoints failed',
    details: errors,
  });
};
