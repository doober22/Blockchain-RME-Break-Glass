import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { settings, address, deployer, json, fingerprint, writePermissions, checkPermissions, loadState, resetTarget, atomic } from '../lib.mjs';
import { nodeConfig, cidrRange, main } from '../chain.mjs';

test('rejects conflicting network settings and unsafe host/origin values', () => {
  assert.equal(settings({}).chainId, 1337);
  assert.equal(settings({ BESU_DOCKER_SUBNET: '10.90.1.0/24' }).prefix, '10.90.1');
  for (const env of [
    { BESU_CHAIN_ID: '1' }, { BESU_RPC_URL: 'https://example.com' },
    { BESU_RPC_URL: 'http://user:password@127.0.0.1:8545' },
    { BESU_DOCKER_SUBNET: '172.28.999.0/24' }, { BESU_DOCKER_SUBNET: '8.8.8.0/24' },
    { BESU_DOCKER_SUBNET: '172.28.1.0/16' }, { BESU_HOST_ALLOWLIST: '*' },
    { BESU_CORS_ORIGINS: '*' }, { BESU_CORS_ORIGINS: 'http://localhost:3000/path' },
  ]) assert.throws(() => settings(env));
});

test('rejects invalid, zero, and private-key-shaped public addresses without echoing keys', () => {
  const key = generatePrivateKey();
  assert.equal(address(privateKeyToAccount(key).address), privateKeyToAccount(key).address);
  for (const bad of [key, '0x1234', `0x${'0'.repeat(40)}`, '', null]) assert.throws(() => address(bad));
  try { deployer({ DEPLOYER_PRIVATE_KEY: key.slice(0, -1) }); assert.fail(); }
  catch (error) { assert.ok(!error.message.includes(key.slice(0, -1))); }
});

test('RPC management is isolated to validator loopback; public RPC omits privileged namespaces', () => {
  const config = settings({});
  const rpc = nodeConfig({ name: 'rpc', ip: '172.28.133.15' }, config);
  assert.match(rpc, /rpc-http-api=\["ETH","NET","WEB3"\]/);
  assert.doesNotMatch(rpc, /"ADMIN"|"PERM"|"QBFT"/);
  assert.match(rpc, /min-priority-fee=1000000000/);
  assert.match(rpc, /api-gas-price-blocks=0/);
  const monitor = nodeConfig({ name: 'validator1', ip: '172.28.133.11' }, config);
  assert.match(monitor, /rpc-http-host="127.0.0.1"/);
  assert.match(monitor, /"QBFT"/);
  assert.match(nodeConfig({ name: 'validator2', ip: '172.28.133.12' }, config), /rpc-http-enabled=false/);
  assert.deepEqual(cidrRange('172.28.133.0/24'), [2887550208, 2887550463]);
  assert.equal(cidrRange('::/0'), undefined);
});

test('initialized state is reusable, detects drift/partial state and inconsistent permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rme-init-'));
  try {
    const key = generatePrivateKey();
    const env = { DEPLOYER_PRIVATE_KEY: key };
    const state = { settingsHash: fingerprint(settings(env)), deployer: privateKeyToAccount(key).address,
      immutableFiles: { 'genesis.json': fingerprint('{}') },
      nodes: ['validator1', 'validator2', 'validator3', 'validator4', 'rpc'].map((name, i) => ({ name, enode: `enode://test${i}@172.28.133.${i + 11}:30303` })),
      accounts: [privateKeyToAccount(key).address] };
    await assert.rejects(loadState({ runtime: dir, env }), /chain:init/);
    await atomic(join(dir, 'genesis.json'), '{}');
    await writePermissions(state, dir);
    await json(join(dir, 'network.json'), state);
    const before = await readFile(join(dir, 'network.json'), 'utf8');
    assert.deepEqual(await loadState({ runtime: dir, env }), state);
    assert.deepEqual(await loadState({ runtime: dir, env }), state);
    assert.equal(await readFile(join(dir, 'network.json'), 'utf8'), before);
    await assert.rejects(loadState({ runtime: dir, env: { ...env, BESU_DOCKER_SUBNET: '10.90.1.0/24' } }), /differs/);
    await assert.rejects(loadState({ runtime: dir, env: { DEPLOYER_PRIVATE_KEY: generatePrivateKey() } }), /differs/);
    await atomic(join(dir, 'nodes', 'rpc', 'permissions_config.toml'), 'accounts-allowlist=[]\nnodes-allowlist=[]\n');
    await assert.rejects(checkPermissions(state, dir), /Inconsistent/);
    await writePermissions(state, dir);
    await atomic(join(dir, 'genesis.json'), '{"changed":true}');
    await assert.rejects(loadState({ runtime: dir, env }), /file changed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reset refuses missing confirmation, parents, sibling paths and directory links', async () => {
  await assert.rejects(main(['reset']), /confirm-delete-chain-data/);
  const dir = await mkdtemp(join(tmpdir(), 'rme-reset-'));
  try {
    const runtime = join(dir, 'runtime');
    const outside = join(dir, 'outside');
    await mkdir(join(runtime, 'data'), { recursive: true });
    await mkdir(outside);
    assert.equal(resetTarget(runtime, join(runtime, 'data')), join(runtime, 'data'));
    for (const target of [runtime, outside, join(runtime, '..', 'outside')]) assert.throws(() => resetTarget(runtime, target));
    await rm(join(runtime, 'data'), { recursive: true });
    await symlink(outside, join(runtime, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resetTarget(runtime, join(runtime, 'data')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
