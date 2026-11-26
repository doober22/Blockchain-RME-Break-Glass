import { createPublicClient, createWalletClient, http, defineChain, parseAbi, getAddress, decodeEventLog, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export const controllerAbi = parseAbi([
  "function registerRecord(bytes32 recordId, address patient, bytes32 ciphertextHash, uint16 categoryCode)",
  "function grantConsent(address clinician, bytes32 recordId, uint64 expiresAt) returns (uint256 consentId)",
  "function revokeConsent(uint256 consentId)",
  "function canRead(address clinician, bytes32 recordId, uint8 mode, uint256 grantId) view returns (bool)",
  "function getRecord(bytes32 recordId) view returns ((bool exists,address patient,bytes32 facilityId,bytes32 ciphertextHash,uint16 categoryCode,bool active))",
  "function getConsent(uint256 consentId) view returns ((bool exists,address patient,address clinician,bytes32 recordId,uint64 createdAt,uint64 expiresAt,bool revoked))",
  "function registry() view returns (address)",
  "function authorizeAccess(address clinician, bytes32 recordId, uint8 mode, uint256 grantId, bytes32 accessId)",
  "event ConsentGranted(uint256 indexed consentId, address indexed patient, address indexed clinician, bytes32 recordId, uint64 expiresAt)",
  "event AccessAuthorized(bytes32 indexed accessId, bytes32 indexed recordId, address indexed patient,address clinician,address gateway,uint8 mode,uint256 grantId,uint64 timestamp)",
]);

const registryAbi = parseAbi([
  "function GATEWAY_ROLE() view returns (bytes32)",
  "function isEligible(address account, bytes32 role) view returns (bool)",
  "function getParticipant(address account) view returns ((bool exists,bytes32 facilityId,bool active,uint64 validUntil))",
]);

export class ReadDenied extends Error {}

export function besuClients(rpcUrl: string) {
  const chain = defineChain({ id: 1337, name: "RME Besu", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } } });
  const transport = http(rpcUrl, { timeout: 4_000, retryCount: 0 });
  const reader = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 500 });
  return { reader, wallet: (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport }) };
}

export interface ReadScope {
  clinician: Address;
  recordId: Hex;
  consentId: bigint;
}

export async function connectGateway(config: {
  rpcUrl: string; account: PrivateKeyAccount; controller: Address; registry: Address; genesisHash: Hex;
}) {
  const { reader, wallet } = besuClients(config.rpcUrl);
  const writer = wallet(config.account);
  const controller = { abi: controllerAbi, address: config.controller };
  const registry = { abi: registryAbi, address: config.registry };
  const actualChain = await reader.getChainId();
  const genesis = await reader.getBlock({ blockNumber: 0n });
  if (actualChain !== 1337 || genesis.hash !== config.genesisHash
      || getAddress(await reader.readContract({ ...controller, functionName: "registry" })) !== getAddress(config.registry)) {
    throw new Error("Gateway deployment does not match the configured chain");
  }
  const gatewayRole = await reader.readContract({ ...registry, functionName: "GATEWAY_ROLE" });

  async function check(scope: ReadScope) {
    const head = await reader.getBlock({ blockTag: "latest" });
    const now = () => BigInt(Math.floor(Date.now() / 1000));
    const assertFresh = () => {
      if (head.timestamp < now() - 12n || head.timestamp > now() + 2n) throw new Error("Besu head is stale or clock is out of sync");
    };
    assertFresh();
    const at = { blockNumber: head.number };
    const [allowed, record, consent, eligible, gateway] = await Promise.all([
      reader.readContract({ ...controller, ...at, functionName: "canRead", args: [scope.clinician, scope.recordId, 0, scope.consentId] }),
      reader.readContract({ ...controller, ...at, functionName: "getRecord", args: [scope.recordId] }),
      reader.readContract({ ...controller, ...at, functionName: "getConsent", args: [scope.consentId] }),
      reader.readContract({ ...registry, ...at, functionName: "isEligible", args: [config.account.address, gatewayRole] }),
      reader.readContract({ ...registry, ...at, functionName: "getParticipant", args: [config.account.address] }),
    ]);
    // Retry the entire read at the client if the head advanced during this check.
    if ((await reader.getBlock({ blockTag: "latest" })).hash !== head.hash) throw new Error("Besu head advanced during policy check");
    assertFresh();
    if (!allowed || !record.exists || !record.active || !eligible || gateway.facilityId !== record.facilityId || now() >= consent.expiresAt) {
      throw new ReadDenied("Read denied");
    }
    return record;
  }

  return {
    check,
    async submit(scope: ReadScope, accessId: Hex) {
      return writer.writeContract({ ...controller, functionName: "authorizeAccess", args: [scope.clinician, scope.recordId, 0, scope.consentId, accessId] });
    },
    async confirm(scope: ReadScope, accessId: Hex, patient: Address, hash: Hex) {
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 15_000, retryCount: 0 });
      if (receipt.status !== "success" || receipt.transactionHash !== hash
          || (await reader.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
        throw new Error("Missing successful committed QBFT receipt");
      }
      const matches = receipt.logs.filter((log) => {
        if (getAddress(log.address) !== getAddress(config.controller)) return false;
        try {
          const { args } = decodeEventLog({ abi: controllerAbi, eventName: "AccessAuthorized", data: log.data, topics: log.topics });
          return args.accessId === accessId && args.recordId === scope.recordId && getAddress(args.patient) === getAddress(patient)
            && getAddress(args.clinician) === scope.clinician && getAddress(args.gateway) === config.account.address
            && args.mode === 0 && args.grantId === scope.consentId;
        } catch {
          return false;
        }
      });
      if (matches.length !== 1) throw new Error("Missing matching authorization event");
    },
  };
}
