import assert from 'node:assert/strict';
import { join } from 'node:path';
import { open, unlink } from 'node:fs/promises';
import { keccak256, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { INFRA, RUNTIME, environment, loadState, running, compose, health, rpc, clients, json, requireNode24, run, PROJECT } from './lib.mjs';
import { fund, start } from './chain.mjs';

// Explicit integration command. Sends synthetic transactions and briefly stops
// one validator, then all five nodes for persistence testing. Never resets data.
requireNode24();
const state = await loadState();
const lockPath = join(INFRA, '.chain.lock');
const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Another chain command is active. Retry verification after it finishes.'); });
const report = { checkedAt: new Date().toISOString(), chainId: 1337, checks: {} };
try {
  assert.equal((await running()).length, 5);
  report.checks.initialHealth = await health();
  const { publicClient, walletClient, account } = clients(await environment());
  const priorityFee = BigInt(await rpc('eth_maxPriorityFeePerGas'));
  assert.ok(priorityFee >= 1000000000n, 'RPC must suggest a tip compatible with validator inclusion policy.');
  report.checks.priorityFeeWei = priorityFee.toString();
  const approvedHash = await walletClient.sendTransaction({ account, to: account.address, value: 0n });
  const approvedReceipt = await publicClient.waitForTransactionReceipt({ hash: approvedHash, timeout: 60_000 });
  assert.equal(approvedReceipt.status, 'success');
  report.checks.approvedTransaction = approvedHash;

  const outsider = privateKeyToAccount(generatePrivateKey());
  await fund(outsider.address, '0.1', { allowUnapproved: true });
  assert.ok(await publicClient.getBalance({ address: outsider.address }) >= parseEther('0.1'));
  const raw = await outsider.signTransaction({ chainId: 1337, type: 'legacy', nonce: 0, gas: 21000n,
    gasPrice: 2000000000n, to: outsider.address, value: 0n });
  let rejection;
  try { await rpc('eth_sendRawTransaction', [raw]); } catch (error) { rejection = error.message; }
  assert.match(rejection ?? '', /not authorized|not permitted|not.*allow|not permissioned|account.*permission/i);
  assert.equal(await publicClient.getTransactionCount({ address: outsider.address }), 0);
  assert.equal(await publicClient.getTransaction({ hash: keccak256(raw) }).catch(() => null), null);
  report.checks.unauthorizedTransaction = { address: outsider.address, funded: true, rejection, nonce: 0 };

  for (const method of ['admin_nodeInfo', 'perm_getAccountsAllowlist', 'qbft_getValidatorsByBlockNumber', 'debug_traceBlockByNumber']) {
    await assert.rejects(rpc(method, method.startsWith('qbft_') ? ['latest'] : []), /-32601|not enabled|not supported|not found/i);
  }
  const containerIds = (await compose(['ps', '-q'])).split(/\s+/);
  const containers = JSON.parse(await run('docker', ['inspect', ...containerIds]));
  for (const container of containers) {
    const service = container.Config.Labels['com.docker.compose.service'];
    const bindings = container.HostConfig.PortBindings ?? {};
    if (service === 'rpc') assert.deepEqual(bindings['8545/tcp'], [{ HostIp: '127.0.0.1', HostPort: '8545' }]);
    else assert.equal(Object.keys(bindings).length, 0);
    assert.equal(container.Config.Labels['com.docker.compose.project'], PROJECT);
  }
  report.checks.rpcExposure = 'loopback RPC only; ADMIN/PERM/QBFT/DEBUG unavailable on host endpoint';

  try {
    await compose(['stop', 'validator4'], { inherit: true });
    report.checks.oneValidatorStopped = await health({ waitMs: 90_000 });
    const hash = await walletClient.sendTransaction({ account, to: account.address, value: 0n });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })).status, 'success');
    report.checks.oneValidatorStopped.transactionHash = hash;
  } finally {
    await compose(['start', 'validator4'], { inherit: true });
  }

  const savedBlock = await publicClient.getBlock({ blockNumber: approvedReceipt.blockNumber });
  try {
    await compose(['stop'], { inherit: true });
    assert.equal((await running()).length, 0);
  } finally { await start(); }
  assert.equal((await publicClient.getBlock({ blockNumber: savedBlock.number })).hash, savedBlock.hash);
  assert.equal((await publicClient.getTransactionReceipt({ hash: approvedHash })).status, 'success');
  report.checks.persistence = { blockNumber: savedBlock.number.toString(), blockHash: savedBlock.hash, transactionHash: approvedHash };
  report.checks.finalHealth = await health();
  report.passed = true;
} catch (error) {
  report.passed = false;
  // Suppress nested client errors; they may include full transaction data.
  report.failure = error.shortMessage ? 'Integration transaction failed; inspect account permission, fees, and RPC health.' : error.message;
  process.exitCode = 1;
} finally {
  try {
    await json(join(RUNTIME, 'validation.json'), report);
    console.log(JSON.stringify(report, null, 2));
  } finally { await lock.close(); await unlink(lockPath); }
}
