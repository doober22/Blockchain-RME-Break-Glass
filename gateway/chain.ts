import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";

export const NORMAL_MODE = 0;
export const EMERGENCY_MODE = 1;
export type AccessMode = typeof NORMAL_MODE | typeof EMERGENCY_MODE;

export const controllerAbi = parseAbi([
  "function registerRecord(bytes32 recordId, address patient, bytes32 ciphertextHash, uint16 categoryCode)",
  "function grantConsent(address clinician, bytes32 recordId, uint64 expiresAt) returns (uint256 consentId)",
  "function revokeConsent(uint256 consentId)",
  "function requestEmergency(address patient, bytes32[] recordIds, bytes32 encounterId, uint16 reasonCode, bytes32 evidenceCommitment, uint64 duration) returns (uint256 requestId)",
  "function resolveEmergency(uint256 requestId, bool approved, bytes32 requestHash, uint64 observedAt, uint64 validUntil)",
  "function closeEmergency(uint256 requestId, uint16 closureCode)",
  "function submitReview(uint256 requestId, uint8 verdict, bytes32 reportCommitment)",
  "function canRead(address clinician, bytes32 recordId, uint8 mode, uint256 grantId) view returns (bool)",
  "function getRecord(bytes32 recordId) view returns ((bool exists,address patient,bytes32 facilityId,bytes32 ciphertextHash,uint16 categoryCode,bool active))",
  "function getConsent(uint256 consentId) view returns ((bool exists,address patient,address clinician,bytes32 recordId,uint64 createdAt,uint64 expiresAt,bool revoked))",
  "function getRequest(uint256 requestId) view returns ((bool exists,address patient,address clinician,bytes32 requesterFacilityId,bytes32 encounterId,uint16 reasonCode,bytes32 evidenceCommitment,bytes32 requestHash,uint64 requestedDuration,uint64 createdAt,uint64 decisionDeadline,uint64 activatedAt,uint64 expiresAt,uint8 status,bytes32 attestationHash))",
  "function getRequestRecords(uint256 requestId) view returns (bytes32[])",
  "function registry() view returns (address)",
  "function authorizeAccess(address clinician, bytes32 recordId, uint8 mode, uint256 grantId, bytes32 accessId)",
  "event ConsentGranted(uint256 indexed consentId, address indexed patient, address indexed clinician, bytes32 recordId, uint64 expiresAt)",
  "event EmergencyRequested(uint256 indexed requestId, address indexed patient, address indexed clinician, bytes32 facilityId, bytes32 requestHash, uint64 deadline)",
  "event EmergencyResolved(uint256 indexed requestId, bool approved, address indexed oracle, bytes32 attestationHash, uint64 activatedAt, uint64 expiresAt)",
  "event AccessAuthorized(bytes32 indexed accessId, bytes32 indexed recordId, address indexed patient,address clinician,address gateway,uint8 mode,uint256 grantId,uint64 timestamp)",
]);

const registryAbi = parseAbi([
  "function GATEWAY_ROLE() view returns (bytes32)",
  "function isEligible(address account, bytes32 role) view returns (bool)",
  "function getParticipant(address account) view returns ((bool exists,bytes32 facilityId,bool active,uint64 validUntil))",
]);

export class ReadDenied extends Error {}

export function besuClients(rpcUrl: string, customTransport?: Transport) {
  const chain = defineChain({
    id: 1337,
    name: "RME Besu",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = customTransport ?? http(rpcUrl, { timeout: 4_000, retryCount: 0 });
  const reader = createPublicClient({ chain, transport, cacheTime: 0, pollingInterval: 500 });
  return {
    reader,
    wallet: (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport }),
  };
}

export interface ReadScope {
  clinician: Address;
  recordId: Hex;
  mode?: AccessMode;
  grantId?: bigint;
  consentId?: bigint;
  requestId?: bigint;
}

export interface NormalizedReadScope {
  clinician: Address;
  recordId: Hex;
  mode: AccessMode;
  grantId: bigint;
}

export function normalizeReadScope(scope: ReadScope): NormalizedReadScope {
  const mode: AccessMode =
    scope.mode ?? (scope.requestId !== undefined && scope.consentId === undefined ? EMERGENCY_MODE : NORMAL_MODE);
  if (mode !== NORMAL_MODE && mode !== EMERGENCY_MODE) {
    throw new Error("Unsupported access mode");
  }
  const grantId =
    mode === EMERGENCY_MODE ? (scope.grantId ?? scope.requestId) : (scope.grantId ?? scope.consentId);
  if (typeof grantId !== "bigint" || grantId <= 0n || grantId >= 1n << 256n) {
    throw new Error("Invalid grant identifier");
  }
  return {
    clinician: getAddress(scope.clinician),
    recordId: scope.recordId.toLowerCase() as Hex,
    mode,
    grantId,
  };
}

export async function connectGateway(config: {
  rpcUrl: string;
  account: PrivateKeyAccount;
  controller: Address;
  registry: Address;
  genesisHash: Hex;
  transport?: Transport;
  clock?: () => bigint;
}) {
  const { reader, wallet } = besuClients(config.rpcUrl, config.transport);
  const writer = wallet(config.account);
  const controller = { abi: controllerAbi, address: config.controller };
  const registry = { abi: registryAbi, address: config.registry };
  const actualChain = await reader.getChainId();
  const genesis = await reader.getBlock({ blockNumber: 0n });
  if (
    actualChain !== 1337 ||
    !genesis.hash ||
    genesis.hash.toLowerCase() !== config.genesisHash.toLowerCase() ||
    getAddress(await reader.readContract({ ...controller, functionName: "registry" })) !== getAddress(config.registry)
  ) {
    throw new Error("Gateway deployment does not match the configured chain");
  }
  const gatewayRole = await reader.readContract({ ...registry, functionName: "GATEWAY_ROLE" });
  const now = config.clock ?? (() => BigInt(Math.floor(Date.now() / 1000)));

  async function check(rawScope: ReadScope) {
    const scope = normalizeReadScope(rawScope);
    const head = await reader.getBlock({ blockTag: "latest" });
    const assertFresh = () => {
      const current = now();
      if (head.timestamp < current - 12n || head.timestamp > current + 2n) {
        throw new Error("Besu head is stale or clock is out of sync");
      }
    };
    assertFresh();
    const at = { blockNumber: head.number };

    if (scope.mode === NORMAL_MODE) {
      const [allowed, record, consent, eligible, gateway] = await Promise.all([
        reader.readContract({
          ...controller,
          ...at,
          functionName: "canRead",
          args: [scope.clinician, scope.recordId, NORMAL_MODE, scope.grantId],
        }),
        reader.readContract({ ...controller, ...at, functionName: "getRecord", args: [scope.recordId] }),
        reader.readContract({ ...controller, ...at, functionName: "getConsent", args: [scope.grantId] }),
        reader.readContract({ ...registry, ...at, functionName: "isEligible", args: [config.account.address, gatewayRole] }),
        reader.readContract({ ...registry, ...at, functionName: "getParticipant", args: [config.account.address] }),
      ]);
      if ((await reader.getBlock({ blockTag: "latest" })).hash !== head.hash) {
        throw new Error("Besu head advanced during policy check");
      }
      assertFresh();
      if (
        !allowed ||
        !record.exists ||
        !record.active ||
        !consent.exists ||
        consent.revoked ||
        !eligible ||
        gateway.facilityId.toLowerCase() !== record.facilityId.toLowerCase() ||
        head.timestamp >= consent.expiresAt ||
        now() >= consent.expiresAt
      ) {
        throw new ReadDenied("Read denied");
      }
      return record;
    }

    const [allowed, record, request, scopedRecords, eligible, gateway, clinicianParticipant] = await Promise.all([
      reader.readContract({
        ...controller,
        ...at,
        functionName: "canRead",
        args: [scope.clinician, scope.recordId, EMERGENCY_MODE, scope.grantId],
      }),
      reader.readContract({ ...controller, ...at, functionName: "getRecord", args: [scope.recordId] }),
      reader.readContract({ ...controller, ...at, functionName: "getRequest", args: [scope.grantId] }),
      reader
        .readContract({ ...controller, ...at, functionName: "getRequestRecords", args: [scope.grantId] })
        .catch(() => [] as readonly Hex[]),
      reader.readContract({ ...registry, ...at, functionName: "isEligible", args: [config.account.address, gatewayRole] }),
      reader.readContract({ ...registry, ...at, functionName: "getParticipant", args: [config.account.address] }),
      reader.readContract({ ...registry, ...at, functionName: "getParticipant", args: [scope.clinician] }),
    ]);
    if ((await reader.getBlock({ blockTag: "latest" })).hash !== head.hash) {
      throw new Error("Besu head advanced during policy check");
    }
    assertFresh();
    const inScope = scopedRecords.some((id) => id.toLowerCase() === scope.recordId.toLowerCase());
    if (
      !allowed ||
      !record.exists ||
      !record.active ||
      !request.exists ||
      Number(request.status) !== 2 ||
      getAddress(request.clinician) !== scope.clinician ||
      getAddress(request.patient) !== getAddress(record.patient) ||
      !clinicianParticipant.exists ||
      !clinicianParticipant.active ||
      clinicianParticipant.facilityId.toLowerCase() !== request.requesterFacilityId.toLowerCase() ||
      !inScope ||
      !eligible ||
      gateway.facilityId.toLowerCase() !== record.facilityId.toLowerCase() ||
      head.timestamp >= request.expiresAt ||
      now() >= request.expiresAt
    ) {
      throw new ReadDenied("Read denied");
    }
    return record;
  }

  return {
    check,
    async submit(rawScope: ReadScope, accessId: Hex) {
      const scope = normalizeReadScope(rawScope);
      return writer.writeContract({
        ...controller,
        functionName: "authorizeAccess",
        args: [scope.clinician, scope.recordId, scope.mode, scope.grantId, accessId],
      });
    },
    async confirm(rawScope: ReadScope, accessId: Hex, patient: Address, hash: Hex) {
      const scope = normalizeReadScope(rawScope);
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 15_000, retryCount: 0 });
      if (
        receipt.status !== "success" ||
        receipt.transactionHash !== hash ||
        (await reader.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash
      ) {
        throw new Error("Missing successful committed QBFT receipt");
      }
      const matches = receipt.logs.filter((log) => {
        if (getAddress(log.address) !== getAddress(config.controller)) return false;
        try {
          const { args } = decodeEventLog({
            abi: controllerAbi,
            eventName: "AccessAuthorized",
            data: log.data,
            topics: log.topics,
          });
          return (
            args.accessId.toLowerCase() === accessId.toLowerCase() &&
            args.recordId.toLowerCase() === scope.recordId.toLowerCase() &&
            getAddress(args.patient) === getAddress(patient) &&
            getAddress(args.clinician) === scope.clinician &&
            getAddress(args.gateway) === getAddress(config.account.address) &&
            Number(args.mode) === scope.mode &&
            args.grantId === scope.grantId
          );
        } catch {
          return false;
        }
      });
      if (matches.length !== 1) throw new Error("Missing matching authorization event");
    },
  };
}
