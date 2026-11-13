// Runs in validator1's network namespace; no credentials or dependencies.
const response = await fetch('http://127.0.0.1:8545', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'qbft_getValidatorsByBlockNumber', params: ['latest'] }),
  signal: AbortSignal.timeout(30000),
});
const body = await response.json();
if (!response.ok || body.error || !Array.isArray(body.result)) throw new Error('QBFT monitoring query failed.');
console.log(JSON.stringify(body.result));
