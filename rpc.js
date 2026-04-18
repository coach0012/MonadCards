export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const MONAD_RPCS = [
    'https://monad-mainnet.drpc.org',
    'https://rpc.monad.xyz',
    'https://monad-rpc.publicnode.com',
  ];

  const body = req.body;

  for (const rpcUrl of MONAD_RPCS) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) continue;

      const data = await response.json();
      return res.status(200).json(data);
    } catch (e) {
      continue;
    }
  }

  return res.status(502).json({ error: 'All RPC endpoints failed' });
}
