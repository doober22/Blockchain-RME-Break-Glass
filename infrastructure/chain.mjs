import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, copyFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  ROOT, INFRA, RUNTIME, NODES, BESU_IMAGE, PROBE_IMAGE, PROJECT, requireNode24,
  environment, settings, deployer, address, atomic, json, readJson, fingerprint,
  run, compose, loadState, writePermissions, requireStopped, running, health,
  resetTarget, clients,
} from './lib.mjs';

export function cidrRange(cidr) {
  const [ip, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255) || !Number.isInteger(bits) || bits < 0 || bits > 32) return undefined;
  const value = parts.reduce((sum, part) => sum * 256 + part, 0);
  const size = 2 ** (32 - bits);
  const low = Math.floor(value / size) * size;
  return [low, low + size - 1];
}

async function checkSubnet(config) {
  const ids = (await run('docker', ['network', 'ls', '-q'])).split(/\s+/).filter(Boolean);
  if (!ids.length) return;
  const networks = JSON.parse(await run('docker', ['network', 'inspect', ...ids]));
  const desired = cidrRange(config.subnet);
  for (const network of networks) {
    if (network.Labels?.['com.docker.compose.project'] === PROJECT) continue;
    for (const entry of network.IPAM?.Config ?? []) {
      const other = entry.Subnet && cidrRange(entry.Subnet);
      if (other && desired[0] <= other[1] && other[0] <= desired[1]) throw new Error('Docker subnet collision. Choose a different BESU_DOCKER_SUBNET before initialization.');
    }
  }
}

export function nodeConfig(node, config) {
  const toml = {
    'data-path': '/data', 'genesis-file': '/genesis.json', 'node-private-key-file': '/keys/key',
    'network-id': 1337, 'sync-mode': 'FULL', 'data-storage-format': 'BONSAI',
    'discovery-enabled': false, bootnodes: [], 'p2p-host': node.ip, 'p2p-interface': '0.0.0.0',
    'p2p-port': 30303, 'nat-method': 'DOCKER',
    'permissions-nodes-config-file-enabled': true,
    'permissions-accounts-config-file-enabled': true,
    'permissions-nodes-config-file': '/config/permissions_config.toml',
    'permissions-accounts-config-file': '/config/permissions_config.toml',
    'min-gas-price': 1000000000, 'min-priority-fee': 1000000000,
    // Empty private-chain history must not suggest a zero tip to EIP-1559 clients.
    'api-gas-price-blocks': 0,
    'rpc-http-enabled': node.name === 'rpc' || node.name === 'validator1',
    'rpc-ws-enabled': false, 'metrics-enabled': false,
  };
  if (toml['rpc-http-enabled']) {
    Object.assign(toml, { 'rpc-http-port': 8545,
      'rpc-http-host': node.name === 'rpc' ? '0.0.0.0' : '127.0.0.1',
      'rpc-http-api': node.name === 'rpc' ? ['ETH', 'NET', 'WEB3'] : ['ETH', 'QBFT'],
      'host-allowlist': node.name === 'rpc' ? config.hosts : ['localhost', '127.0.0.1'],
    });
    // Omit this option on the monitor: Besu rejects an empty CORS array.
    if (node.name === 'rpc') toml['rpc-http-cors-origins'] = config.origins;
  }
  return Object.entries(toml).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
}

async function ensureEnvironment() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) await atomic(path, await readFile(join(ROOT, '.env.example'), 'utf8'));
  let env = await environment();
  settings(env);
  if (!env.DEPLOYER_PRIVATE_KEY) {
    const key = generatePrivateKey();
    let text = await readFile(path, 'utf8');
    const matches = [...text.matchAll(/^DEPLOYER_PRIVATE_KEY\s*=.*$/gm)];
    if (matches.length > 1) throw new Error('Remove duplicate DEPLOYER_PRIVATE_KEY entries before initialization.');
    text = matches.length ? text.replace(/^DEPLOYER_PRIVATE_KEY\s*=.*$/m, `DEPLOYER_PRIVATE_KEY=${key}`) : `${text}\nDEPLOYER_PRIVATE_KEY=${key}\n`;
    await atomic(path, text);
    // An explicitly empty process variable must not mask the newly generated key.
    if (process.env.DEPLOYER_PRIVATE_KEY === '') delete process.env.DEPLOYER_PRIVATE_KEY;
    env = await environment();
  }
  deployer(env);
  return env;
}

export async function initialize() {
  if (existsSync(join(RUNTIME, 'network.json'))) {
    const state = await loadState();
    console.log(`Existing chain preserved. Deployer: ${state.deployer}`);
    return state;
  }
  if (existsSync(RUNTIME) && (await readdir(RUNTIME)).length) throw new Error('Partial runtime state exists. Inspect infrastructure/.runtime; initialization will not replace identities or data.');
  const env = await ensureEnvironment();
  const config = settings(env);
  await checkSubnet(config);
  for (const image of [BESU_IMAGE, PROBE_IMAGE]) {
    try { await run('docker', ['image', 'inspect', image]); }
    catch { await run('docker', ['pull', image], { inherit: true, timeout: 600_000 }); }
  }
  const account = deployer(env);
  await mkdir(RUNTIME, { recursive: true });
  const bootstrap = {
    genesis: {
      config: { chainId: 1337, berlinBlock: 0, londonBlock: 0,
        qbft: { blockperiodseconds: 2, requesttimeoutseconds: 4, epochlength: 30000 } },
      nonce: '0x0', timestamp: '0x0', gasLimit: '0x1c9c380', difficulty: '0x1',
      mixHash: '0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365',
      coinbase: '0x0000000000000000000000000000000000000000',
      baseFeePerGas: '0x3b9aca00', alloc: { [account.address.slice(2)]: { balance: parseEther('1000').toString() } },
    }, blockchain: { nodes: { generate: true, count: 4 } },
  };
  await json(join(RUNTIME, 'bootstrap.json'), bootstrap);
  await run('docker', ['run', '--rm', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--mount',
    `type=bind,source=${RUNTIME},target=/work`, BESU_IMAGE, 'operator', 'generate-blockchain-config',
    '--config-file=/work/bootstrap.json', '--to=/work/generated', '--private-key-file-name=key']);
  await copyFile(join(RUNTIME, 'generated', 'genesis.json'), join(RUNTIME, 'genesis.json'));
  const directories = (await readdir(join(RUNTIME, 'generated', 'keys'))).sort();
  if (directories.length !== 4) throw new Error('Besu did not generate exactly four validators.');
  const nodes = [];
  for (const [index, name] of NODES.entries()) {
    const key = name === 'rpc' ? generatePrivateKey() : `0x${(await readFile(join(RUNTIME, 'generated', 'keys', directories[index], 'key'), 'utf8')).trim().replace(/^0x/, '')}`;
    const identity = privateKeyToAccount(key);
    const ip = `${config.prefix}.${11 + index}`;
    nodes.push({ name, address: identity.address, ip, enode: `enode://${identity.publicKey.slice(4)}@${ip}:30303` });
    await atomic(join(RUNTIME, 'keys', name, 'key'), key.slice(2));
    await mkdir(join(RUNTIME, 'data', name), { recursive: true });
  }
  const state = { schemaVersion: 1, settings: config, settingsHash: fingerprint(config), deployer: account.address,
    accounts: [account.address], nodes, immutableFiles: {} };
  await atomic(join(RUNTIME, 'compose.env'), `BESU_DOCKER_SUBNET=${config.subnet}\nBESU_IP_PREFIX=${config.prefix}\nBESU_UID=${process.getuid?.() ?? 1000}\nBESU_GID=${process.getgid?.() ?? 1000}\n`);
  for (const node of nodes) {
    await atomic(join(RUNTIME, 'nodes', node.name, 'besu.toml'), nodeConfig(node, config));
    // Static peer connections work without discovery or a public bootnode.
    await json(join(RUNTIME, 'data', node.name, 'static-nodes.json'), nodes.filter((n) => n.name !== node.name).map((n) => n.enode));
  }
  await writePermissions(state);
  for (const file of ['genesis.json', 'compose.env', ...nodes.flatMap((n) => [`keys/${n.name}/key`, `nodes/${n.name}/besu.toml`])]) {
    state.immutableFiles[file] = fingerprint(await readFile(join(RUNTIME, file), 'utf8'));
  }
  await json(join(RUNTIME, 'network.json'), state);
  console.log(JSON.stringify({ chainId: 1337, deployer: state.deployer, validators: nodes.slice(0, 4).map((n) => n.address), rpc: config.rpcUrl }, null, 2));
  return state;
}

export async function start() {
  const state = await loadState();
  await checkSubnet(state.settings);
  // reset removes databases only; reconstruct public peer lists on every start.
  for (const node of state.nodes) {
    await mkdir(join(RUNTIME, 'data', node.name), { recursive: true });
    await json(join(RUNTIME, 'data', node.name, 'static-nodes.json'), state.nodes.filter((n) => n.name !== node.name).map((n) => n.enode));
  }
  await compose(['up', '-d', '--remove-orphans'], { inherit: true });
  await health({ waitMs: 300_000 });
}

export async function fund(target, amount, { allowUnapproved = false } = {}) {
  const state = await loadState();
  const recipient = address(target);
  if (!allowUnapproved && !state.accounts.some((a) => a.toLowerCase() === recipient.toLowerCase())) throw new Error('Approve the recipient first; funding does not grant account permission.');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(amount ?? '') || parseEther(amount) <= 0n || parseEther(amount) > parseEther('1000')) throw new Error('Amount must be positive and at most 1000 ETH, with up to 18 decimal places.');
  const { publicClient, walletClient, account } = clients(await environment());
  if (await publicClient.getChainId() !== 1337 || (await publicClient.getBlock({ blockNumber: 0n })).hash !== state.genesisHash) throw new Error('Run chain:health and verify chain/genesis before funding.');
  const hash = await walletClient.sendTransaction({ account, to: recipient, value: parseEther(amount) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error('Development funding transaction reverted.');
  console.log(JSON.stringify({ recipient, amount, transactionHash: hash }));
  return receipt;
}

export async function main(args) {
  requireNode24();
  const [command, ...rest] = args;
  const known = ['init', 'start', 'status', 'health', 'stop', 'restart', 'logs', 'accounts', 'approve', 'fund', 'reset'];
  if (!known.includes(command)) throw new Error('Unknown chain command. Use the root chain:* npm scripts.');
  if (!['approve', 'fund', 'reset'].includes(command) && rest.length) throw new Error('Unexpected command arguments.');
  if (command === 'reset' && (rest.length !== 1 || rest[0] !== '--confirm-delete-chain-data')) throw new Error('Reset deletes local chain data. Explicitly pass --confirm-delete-chain-data.');
  let target, amount;
  if (['approve', 'fund'].includes(command)) {
    if (rest[0] !== '--address' || (command === 'approve' ? rest.length !== 2 : rest.length !== 4 || rest[2] !== '--amount')) throw new Error('Use --address ADDRESS and, for funding, --amount AMOUNT.');
    target = address(rest[1]); amount = rest[3];
  }
  // Serialize lifecycle operations, including initialization and destructive reset.
  const lockPath = join(INFRA, '.chain.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(() => { throw new Error('Another chain command is active. Remove a stale infrastructure/.chain.lock only after confirming the process stopped.'); });
  try {
    if (command === 'init') { await initialize(); return; }
    const state = await loadState();
    if (command === 'start') await start();
    if (command === 'health') await health();
    if (command === 'status') { console.log(await compose(['ps'])); await health(); }
    if (command === 'stop') await compose(['stop'], { inherit: true });
    if (command === 'restart') { await compose(['stop'], { inherit: true }); await start(); }
    if (command === 'logs') console.log(await compose(['logs', '--tail', '80', '--no-color']));
    if (command === 'accounts') console.log(JSON.stringify({ accounts: state.accounts }, null, 2));
    if (command === 'approve') {
      await requireStopped();
      if (!state.accounts.some((a) => a.toLowerCase() === target.toLowerCase())) state.accounts.push(target);
      await writePermissions(state);
      await json(join(RUNTIME, 'network.json'), state);
      console.log(`Approved ${target} on all five nodes. Start the chain, then fund separately.`);
    }
    if (command === 'fund') await fund(target, amount);
    if (command === 'reset') {
      // Verify the absolute target before stopping anything or issuing deletion.
      const data = resetTarget(RUNTIME, join(RUNTIME, 'data'));
      await compose(['down'], { inherit: true });
      await rm(data, { recursive: true });
      await mkdir(data);
      console.log('Deleted local ledger databases only. Keys, genesis, approvals, and .env remain. Redeploy contracts explicitly.');
    }
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    // Never print nested viem errors, environment contents, or signed transaction data.
    const message = error?.name?.endsWith('Error') && error?.shortMessage ? 'Transaction failed. Check local RPC health, allowlisting, development balance, and nonce.' : error.message;
    console.error(message); process.exitCode = 1;
  });
}
