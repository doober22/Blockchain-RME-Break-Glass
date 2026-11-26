import assert from "node:assert/strict";
import { test } from "node:test";
import hre from "hardhat";
import { createPublicClient, createWalletClient, custom, decodeEventLog, defineChain, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashEmergencyRequest, type RequestHashInput } from "../integration/request-hash.ts";
import { readArtifacts } from "../scripts/artifacts.ts";

const bytes32 = (value: number): Hex => toHex(value, { size: 32 });
const vector: RequestHashInput = {
  chainId: 1337n,
  controller: "0x1111111111111111111111111111111111111111",
  requestId: 1n,
  patient: "0x2222222222222222222222222222222222222222",
  clinician: "0x3333333333333333333333333333333333333333",
  requesterFacilityId: `0x${"44".repeat(32)}`,
  encounterId: `0x${"55".repeat(32)}`,
  recordIds: [bytes32(10)],
  reasonCode: 7,
  evidenceCommitment: `0x${"66".repeat(32)}`,
  requestedDuration: 900n,
  decisionDeadline: 1120n,
};

test("fixed single- and twenty-record vectors match Solidity's single-tuple encoding", () => {
  assert.equal(hashEmergencyRequest(vector), "0xbe75b384e22e59d38aea2d92d001f77e6543045d2d21fa53c701828595aa8652");
  assert.equal(hashEmergencyRequest({ ...vector, recordIds: Array.from({ length: 20 }, (_, i) => bytes32(10 + i)) }),
    "0x7b5057334a9afe14d62740bb842110d11c6ad6295c295b51b88577a654024239");
});

test("every request field and domain component participates in the hash", () => {
  const changes: Partial<RequestHashInput>[] = [
    { chainId: 1338n }, { controller: "0x7777777777777777777777777777777777777777" }, { requestId: 2n },
    { patient: vector.clinician }, { clinician: vector.patient }, { requesterFacilityId: bytes32(1) },
    { encounterId: bytes32(2) }, { recordIds: [bytes32(11)] }, { reasonCode: 8 },
    { evidenceCommitment: bytes32(3) }, { requestedDuration: 899n }, { decisionDeadline: 1121n },
  ];
  const original = hashEmergencyRequest(vector);
  const results = changes.map((change) => hashEmergencyRequest({ ...vector, ...change }));
  assert.ok(results.every((hash) => hash !== original));
  assert.equal(new Set(results).size, changes.length);
});

test("encoder rejects unsafe widths, zero identifiers, invalid duration, and noncanonical scope", () => {
  const invalid: Partial<RequestHashInput>[] = [
    { chainId: 0n }, { chainId: 1n << 256n }, { requestId: 0n }, { requestId: -1n },
    { controller: "0x0000000000000000000000000000000000000000" }, { patient: "0x1234" },
    { clinician: "0x0000000000000000000000000000000000000000" }, { requesterFacilityId: bytes32(0) },
    { encounterId: "0x1234" }, { evidenceCommitment: bytes32(0) },
    { requestedDuration: 0n }, { requestedDuration: 901n }, { requestedDuration: 1n << 64n },
    { decisionDeadline: 0n }, { decisionDeadline: 1n << 64n },
    { reasonCode: 0 }, { reasonCode: 65536 }, { reasonCode: 1.5 },
    { recordIds: [] }, { recordIds: [bytes32(0)] }, { recordIds: [bytes32(10), bytes32(10)] },
    { recordIds: [bytes32(11), bytes32(10)] }, { recordIds: Array.from({ length: 21 }, (_, i) => bytes32(i + 1)) },
  ];
  for (const change of invalid) assert.throws(() => hashEmergencyRequest({ ...vector, ...change }));
  assert.throws(() => hashEmergencyRequest({ ...vector, decisionDeadline: 1120 as unknown as bigint }));
});

test("encoder preserves caller-owned input and accepts valid boundary values", () => {
  const input = Object.freeze({ ...vector, recordIds: Object.freeze([bytes32(10), bytes32(11)]) });
  const before = structuredClone(input);
  hashEmergencyRequest(input);
  assert.deepEqual(input, before);
  assert.ok(hashEmergencyRequest({ ...vector, reasonCode: 65535, requestedDuration: 1n, decisionDeadline: (1n << 64n) - 1n }));
});

test("signed pending requests expose bounded scope, matching hashes/events, and exact deadline expiry", async (t) => {
  const connection = await hre.network.create({ network: "local" });
  t.after(async () => connection.close());
  const transport = custom(connection.provider);
  const chain = defineChain({ id: 1337, name: "Request integration", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://unused.invalid"] } } });
  const publicClient = createPublicClient({ chain, transport });
  const accounts = Array.from({ length: 4 }, () => privateKeyToAccount(generatePrivateKey()));
  for (const account of accounts) await connection.provider.request({ method: "hardhat_setBalance", params: [account.address, toHex(10n ** 20n)] });
  const [admin, patient, clinician, gateway] = accounts.map((account) => createWalletClient({ chain, account, transport }));
  const artifacts = await readArtifacts();
  const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: await admin.deployContract({ ...artifacts.ParticipantRegistry, args: [admin.account.address] }) });
  assert.equal(registryReceipt.status, "success");
  const registry = registryReceipt.contractAddress!;
  const controllerReceipt = await publicClient.waitForTransactionReceipt({ hash: await admin.deployContract({ ...artifacts.MedicalAccessController, args: [registry] }) });
  assert.equal(controllerReceipt.status, "success");
  const controller = controllerReceipt.contractAddress!;
  async function write(client: typeof admin, target: "registry" | "controller", functionName: string, args: readonly unknown[]) {
    const hash = await client.writeContract({ address: target === "registry" ? registry : controller,
      abi: target === "registry" ? artifacts.ParticipantRegistry.abi : artifacts.MedicalAccessController.abi, functionName, args });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt;
  }
  const facility = bytes32(1);
  const credentialExpiry = (await publicClient.getBlock()).timestamp + 10_000n;
  await write(admin, "registry", "registerFacility", [facility]);
  for (const [client, role] of [[patient, "PATIENT_ROLE"], [clinician, "CLINICIAN_ROLE"], [gateway, "GATEWAY_ROLE"]] as const) {
    await write(admin, "registry", "registerParticipant", [client.account.address, keccak256(toHex(role)), facility, credentialExpiry]);
  }
  const records = Array.from({ length: 20 }, (_, i) => bytes32(10 + i));
  for (const record of records) await write(gateway, "controller", "registerRecord", [record, patient.account.address, bytes32(99), 1]);
  let lastDeadline = 0n;
  for (const [index, count] of [1, 20].entries()) {
    const scope = records.slice(0, count);
    const receipt = await write(clinician, "controller", "requestEmergency", [patient.account.address, scope, vector.encounterId, 7, vector.evidenceCommitment, 900n]);
    const requestId = BigInt(index + 1);
    const read = (functionName: string, args: readonly unknown[]) => publicClient.readContract({ address: controller, abi: artifacts.MedicalAccessController.abi, functionName, args });
    const request = await read("getRequest", [requestId]) as { exists: boolean; requestHash: Hex; createdAt: bigint; decisionDeadline: bigint; activatedAt: bigint; expiresAt: bigint; status: number };
    assert.equal(request.exists, true);
    const blockTime = (await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
    assert.equal(request.createdAt, blockTime);
    assert.equal(request.decisionDeadline, blockTime + 120n);
    assert.equal(request.status, 0);
    assert.equal(request.activatedAt, 0n);
    assert.equal(request.expiresAt, 0n);
    assert.deepEqual(await read("getRequestRecords", [requestId]), scope);
    const expectedHash = hashEmergencyRequest({ ...vector, chainId: BigInt(await publicClient.getChainId()), controller,
      requestId, patient: patient.account.address, clinician: clinician.account.address, requesterFacilityId: facility,
      recordIds: scope, decisionDeadline: request.decisionDeadline });
    assert.equal(request.requestHash, expectedHash);
    assert.equal(receipt.logs.length, 1);
    const decoded = decodeEventLog({ abi: artifacts.MedicalAccessController.abi, data: receipt.logs[0].data, topics: receipt.logs[0].topics });
    assert.equal(decoded.eventName, "EmergencyRequested");
    assert.deepEqual(decoded.args, { requestId, patient: patient.account.address, clinician: clinician.account.address,
      facilityId: facility, requestHash: expectedHash, deadline: request.decisionDeadline });
    assert.equal(await read("getEffectiveStatus", [requestId]), 0);
    assert.equal(await read("canRead", [clinician.account.address, scope[0], 1, requestId]), false);
    lastDeadline = request.decisionDeadline;
  }
  for (const [timestamp, expected] of [[lastDeadline - 1n, 0], [lastDeadline, 4], [lastDeadline + 1n, 4]] as const) {
    await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(timestamp)] });
    await connection.provider.request({ method: "evm_mine", params: [] });
    assert.equal(await publicClient.readContract({ address: controller, abi: artifacts.MedicalAccessController.abi, functionName: "getEffectiveStatus", args: [2n] }), expected);
  }
});
