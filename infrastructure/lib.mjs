import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getAddress, isAddress, createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const INFRA = join(ROOT, 'infrastructure');
export const RUNTIME = join(INFRA, '.runtime');
export const BESU_IMAGE = 'hyperledger/besu:26.11.0';
export const PROBE_IMAGE = 'node:24.22.2-alpine';
export const PROJECT = 'rme-break-glass';
export const NODES = ['validator1', 'validator2', 'validator3', 'validator4', 'rpc'];
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function requireNode24() {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Use Node.js 24.x; the system Node installation need not be replaced.');
}

export async function environment() {
  const path = join(ROOT, '.env');
  return { ...(existsSync(path) ? parseEnv(await readFile(path, 'utf8')) : {}), ...process.env };
}

export function settings(env) {
  if ((env.BESU_CHAIN_ID ?? '1337') !== '1337') throw new Error('BESU_CHAIN_ID must be 1337.');
  const rpcUrl = env.BESU_RPC_URL ?? 'http://127.0.0.1:8545';
  if (!['http://127.0.0.1:8545', 'http://localhost:8545'].includes(rpcUrl.replace(/\/$/, ''))) {
    throw new Error('BESU_RPC_URL must point to the local HTTP RPC on port 8545.');
  }
  const subnet = env.BESU_DOCKER_SUBNET ?? '172.28.133.0/24';
  const octets = subnet.match(/^(\d+)\.(\d+)\.(\d+)\.0\/24$/)?.slice(1).map(Number);
  if (!octets || octets.some((n) => n > 255) ||
      !(octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168))) throw new Error('Use a private IPv4 /24 subnet ending in .0/24.');
  const hosts = (env.BESU_HOST_ALLOWLIST ?? 'localhost,127.0.0.1,rpc').split(',').map((s) => s.trim());
  if (hosts.some((s) => !/^[a-zA-Z0-9.-]+$/.test(s))) throw new Error('Host allowlist requires explicit hostnames, without wildcards.');
  const origins = (env.BESU_CORS_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173,chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn').split(',').map((s) => s.trim());
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('CORS requires explicit origins.'); }
    if (!['http:', 'https:', 'chrome-extension:'].includes(url.protocol) || !url.hostname ||
        origin.includes('*') || url.username || url.password || url.search || url.hash ||
        !['', '/'].includes(url.pathname)) throw new Error('CORS requires explicit origins without credentials, paths, or wildcards.');
  }
  return { chainId: 1337, rpcUrl, subnet, prefix: octets.join('.'), hosts, origins, besuImage: BESU_IMAGE };
}

export function address(value) {
  if (typeof value !== 'string' || !isAddress(value, { strict: false }) || /^0x0{40}$/i.test(value)) throw new Error('Expected a nonzero EVM public address.');
  return getAddress(value.toLowerCase());
}

export function deployer(env) {
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(env.DEPLOYER_PRIVATE_KEY ?? '')) throw new Error();
    return privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
  } catch { throw new Error('Invalid development deployer key. Key material is never printed.'); }
}

export async function atomic(path, contents, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, contents, { mode });
  await rename(temp, path);
}
export const json = (path, value) => atomic(path, JSON.stringify(value, null, 2) + '\n');
export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function run(program, args, { inherit = false, timeout = 180_000 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { cwd: ROOT, windowsHide: true, shell: false,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); }, timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(stdout.trim());
      else reject(new Error(`${program} ${args[0] ?? ''} failed (exit ${code}). ${stderr.slice(-4000) || stdout.slice(-4000)}`));
    });
  });
}

export function compose(args, options) {
  return run('docker', ['compose', '-p', PROJECT, '--env-file', join(RUNTIME, 'compose.env'), '-f', join(INFRA, 'compose.yaml'), ...args], options);
}

export async function loadState({ runtime = RUNTIME, env } = {}) {
  if (!existsSync(join(runtime, 'network.json'))) throw new Error('Run npm run chain:init first. Partial runtime files must be inspected before retrying.');
  const state = await readJson(join(runtime, 'network.json'));
  const actualEnv = env ?? await environment();
  const config = settings(actualEnv);
  const account = deployer(actualEnv);
  if (state.settingsHash !== fingerprint(config) || state.deployer !== account.address) {
    throw new Error('Initialized configuration/deployer differs from the environment. Restore the original settings; chain:init never replaces a chain.');
  }
  for (const [file, hash] of Object.entries(state.immutableFiles)) {
    const content = await readFile(join(runtime, file), 'utf8');
    if (fingerprint(content) !== hash) throw new Error(`Initialized file changed: ${file}. Restore it before starting.`);
  }
  await checkPermissions(state, runtime);
  return state;
}

export function permissionText(state) {
  return `nodes-allowlist=${JSON.stringify(state.nodes.map((n) => n.enode))}\naccounts-allowlist=${JSON.stringify(state.accounts)}\n`;
}
export async function writePermissions(state, runtime = RUNTIME) {
  for (const node of state.nodes) await atomic(join(runtime, 'nodes', node.name, 'permissions_config.toml'), permissionText(state));
}
export async function checkPermissions(state, runtime = RUNTIME) {
  for (const node of state.nodes) {
    const text = await readFile(join(runtime, 'nodes', node.name, 'permissions_config.toml'), 'utf8');
    // Besu may rewrite whitespace and address casing; compare parsed allowlists.
    for (const [key, expected] of [['nodes-allowlist', state.nodes.map((n) => n.enode)], ['accounts-allowlist', state.accounts]]) {
      const match = text.match(new RegExp(`${key}\\s*=\\s*(\\[[\\s\\S]*?\\])`));
      let actual;
      try { actual = JSON.parse(match?.[1]); } catch { throw new Error(`Invalid ${key} in ${node.name}.`); }
      if (JSON.stringify(actual.map((s) => s.toLowerCase()).sort()) !== JSON.stringify(expected.map((s) => s.toLowerCase()).sort())) {
        throw new Error(`Inconsistent ${key} on ${node.name}; stop the chain and restore matching permission files.`);
      }
    }
  }
}

export async function running() {
  return (await compose(['ps', '--status', 'running', '--services'])).split(/\r?\n/).filter(Boolean);
}
export async function requireStopped() {
  if ((await running()).length) throw new Error('Stop the chain before updating permission files.');
}

export async function rpc(method, params = [], url = 'http://127.0.0.1:8545') {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
  if (!Object.hasOwn(body, 'result')) throw new Error('Malformed RPC result.');
  return body.result;
}

export async function validators() {
  const id = await compose(['ps', '-q', 'validator1']);
  if (!id) throw new Error('validator1 is required for the private monitoring probe.');
  const output = await run('docker', ['run', '--rm', '--network', `container:${id}`, '--mount',
    `type=bind,source=${join(INFRA, 'probe.mjs')},target=/probe.mjs,readonly`, PROBE_IMAGE, 'node', '/probe.mjs']);
  return JSON.parse(output);
}

export async function health({ waitMs = 120_000 } = {}) {
  const state = await loadState();
  const end = Date.now() + waitMs;
  let last = 'RPC not ready';
  while (Date.now() < end) {
    try {
      if (Number(await rpc('eth_chainId')) !== 1337) throw new Error('RPC chain ID differs from 1337.');
      const first = BigInt(await rpc('eth_blockNumber'));
      await sleep(6000);
      const second = BigInt(await rpc('eth_blockNumber'));
      if (second <= first) throw new Error('Block height is not advancing.');
      const actual = (await validators()).map((s) => address(s).toLowerCase()).sort();
      const expected = state.nodes.filter((n) => n.name !== 'rpc').map((n) => n.address.toLowerCase()).sort();
      if (actual.length !== 4 || new Set(actual).size !== 4 || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('QBFT validator set differs from the four initialized addresses.');
      const genesis = await rpc('eth_getBlockByNumber', ['0x0', false]);
      if (state.genesisHash && state.genesisHash !== genesis.hash) throw new Error('RPC genesis identity changed.');
      if (!state.genesisHash) { state.genesisHash = genesis.hash; await json(join(RUNTIME, 'network.json'), state); }
      const result = { chainId: 1337, fromBlock: first.toString(), toBlock: second.toString(), validators: actual, genesisHash: genesis.hash };
      console.log(JSON.stringify(result, null, 2));
      return result;
    } catch (error) { last = error.message; await sleep(2000); }
  }
  throw new Error(`Chain health timed out: ${last}`);
}

export function clients(env) {
  const config = settings(env);
  const account = deployer(env);
  const chain = defineChain({ id: 1337, name: 'RME Besu Local', nativeCurrency: { name: 'Development Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [config.rpcUrl] } } });
  const transport = http(config.rpcUrl, { timeout: 30_000, retryCount: 0 });
  return { account, chain, publicClient: createPublicClient({ chain, transport }), walletClient: createWalletClient({ account, chain, transport }) };
}

/** Reset may delete only the canonical ledger directory, never links or parents. */
export function resetTarget(runtime, target) {
  const base = realpathSync(runtime);
  const expected = join(base, 'data');
  const resolved = resolve(target);
  if (base !== resolve(runtime) || resolved !== expected || relative(base, resolved).startsWith(`..${sep}`) || realpathSync(resolved) !== expected) {
    throw new Error('Refusing reset outside the canonical runtime data directory.');
  }
  return expected;
}
