import assert from "node:assert/strict";
import { test } from "node:test";
import hre from "hardhat";
import { createPublicClient, createWalletClient, custom, decodeEventLog, defineChain, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashEmergencyAttestation, type AttestationHashInput } from "../integration/attestation-hash.ts";
import { readArtifacts } from "../scripts/artifacts.ts";

const vector: AttestationHashInput = {
  chainId: 1337n, controller: "0x1111111111111111111111111111111111111111", requestId: 1n,
  requestHash: "0xbe75b384e22e59d38aea2d92d001f77e6543045d2d21fa53c701828595aa8652",
  approved: true, observedAt: 1000n, validUntil: 1060n,
};

test("approval and rejection vectors match Solidity ABI encoding", () => {
  assert.equal(hashEmergencyAttestation(vector), "0xb12cb5883140d1c0368649fe0ce0e70e2899b7358ddfe8b763cff27518417549");
  assert.equal(hashEmergencyAttestation({ ...vector, approved: false }), "0x3434a6118639de46ef1c823bfe7083550e2797d73216e8dbad812b7b9713755f");
});

test("attestation binds every field, chain, and controller without mutating input", () => {
  const changes: Partial<AttestationHashInput>[] = [
    { chainId: 1338n }, { controller: "0x2222222222222222222222222222222222222222" }, { requestId: 2n },
    { requestHash: toHex(99, { size: 32 }) }, { approved: false }, { observedAt: 1001n }, { validUntil: 1059n },
  ];
  const input = Object.freeze({ ...vector });
  const before = structuredClone(input);
  const original = hashEmergencyAttestation(input);
  const results = changes.map((change) => hashEmergencyAttestation({ ...input, ...change }));
  assert.ok(results.every((hash) => hash !== original));
  assert.equal(new Set(results).size, 7);
  assert.deepEqual(input, before);
});

test("attestation helper rejects malformed fields and invalid validity windows", () => {
  const invalid: Partial<AttestationHashInput>[] = [
    { chainId: 0n }, { chainId: 1n << 256n }, { requestId: 0n }, { requestId: -1n },
    { controller: "0x0000000000000000000000000000000000000000" }, { controller: "0x1234" },
    { requestHash: "0x1234" }, { requestHash: toHex(0, { size: 32 }) },
    { observedAt: -1n }, { observedAt: 1n << 64n }, { validUntil: 1n << 64n },
    { validUntil: 1000n }, { validUntil: 999n }, { validUntil: 1061n },
  ];
  for (const change of invalid) assert.throws(() => hashEmergencyAttestation({ ...vector, ...change }));
  assert.throws(() => hashEmergencyAttestation({ ...vector, approved: 1 as unknown as boolean }));
  assert.throws(() => hashEmergencyAttestation({ ...vector, observedAt: 1000 as unknown as bigint }));
  // Zero is a valid uint64 observation time; freshness needs the actual chain timestamp.
  assert.ok(hashEmergencyAttestation({ ...vector, observedAt: 0n, validUntil: 1n }));
});

test("signed cross-facility decisions activate scoped access, reject replay, and expire at the grant boundary", async (t) => {
  const connection = await hre.network.create({ network: "local", override: { throwOnTransactionFailures: false } });
  t.after(async () => connection.close());
  const transport = custom(connection.provider);
  const chain = defineChain({ id: 1337, name: "Resolution integration", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://unused.invalid"] } } });
  const publicClient = createPublicClient({ chain, transport });
  const accounts = Array.from({ length: 6 }, () => privateKeyToAccount(generatePrivateKey()));
  for (const account of accounts) await connection.provider.request({ method: "hardhat_setBalance", params: [account.address, toHex(10n ** 20n)] });
  const [admin, patient, clinician, gateway, oracle, wrongOracle] = accounts.map((account) => createWalletClient({ chain, account, transport }));
  const artifacts = await readArtifacts();
  const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: await admin.deployContract({ ...artifacts.ParticipantRegistry, args: [admin.account.address] }) });
  assert.equal(registryReceipt.status, "success");
  const registry = registryReceipt.contractAddress!;
  const controllerReceipt = await publicClient.waitForTransactionReceipt({ hash: await admin.deployContract({ ...artifacts.MedicalAccessController, args: [registry] }) });
  assert.equal(controllerReceipt.status, "success");
  const controller = controllerReceipt.contractAddress!;
  async function write(client: typeof admin, target: "registry" | "controller", functionName: string, args: readonly unknown[], expected: "success" | "reverted" = "success") {
    const hash = await client.writeContract({ address: target === "registry" ? registry : controller,
      abi: target === "registry" ? artifacts.ParticipantRegistry.abi : artifacts.MedicalAccessController.abi, functionName, args, gas: 3_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, expected);
    if (expected === "reverted") assert.equal(receipt.logs.length, 0);
    return receipt;
  }
  const read = (functionName: string, args: readonly unknown[]) => publicClient.readContract({ address: controller, abi: artifacts.MedicalAccessController.abi, functionName, args });
  const facilityA = toHex(1, { size: 32 }), facilityB = toHex(2, { size: 32 });
  const expiry = (await publicClient.getBlock()).timestamp + 10_000n;
  await write(admin, "registry", "registerFacility", [facilityA]);
  await write(admin, "registry", "registerFacility", [facilityB]);
  for (const [client, role, facility] of [[patient, "PATIENT_ROLE", facilityA], [clinician, "CLINICIAN_ROLE", facilityB],
    [gateway, "GATEWAY_ROLE", facilityA], [oracle, "ORACLE_ROLE", facilityB], [wrongOracle, "ORACLE_ROLE", facilityA]] as const) {
    await write(admin, "registry", "registerParticipant", [client.account.address, keccak256(toHex(role)), facility, expiry]);
  }
  const records = Array.from({ length: 21 }, (_, i) => toHex(10 + i, { size: 32 }));
  for (const record of records) await write(gateway, "controller", "registerRecord", [record, patient.account.address, toHex(99, { size: 32 }), 1]);
  const scope = records.slice(0, 20);
  await write(clinician, "controller", "requestEmergency", [patient.account.address, scope, toHex(50, { size: 32 }), 1, toHex(60, { size: 32 }), 120n]);
  const pending = await read("getRequest", [1n]) as { requestHash: Hex };
  const observation = (await publicClient.getBlock()).timestamp;
  const validUntil = observation + 60n;
  const decisionArgs = [1n, true, pending.requestHash, observation, validUntil] as const;
  const accessId = keccak256(toHex("synthetic-emergency-read"));
  const readArgs = [clinician.account.address, scope[0], 1, 1n, accessId] as const;
  await write(gateway, "controller", "authorizeAccess", readArgs, "reverted");
  await write(wrongOracle, "controller", "resolveEmergency", decisionArgs, "reverted");
  const resolved = await write(oracle, "controller", "resolveEmergency", decisionArgs);
  const activatedAt = (await publicClient.getBlock({ blockNumber: resolved.blockNumber })).timestamp;
  const grantExpiry = activatedAt + 120n;
  const attestationHash = hashEmergencyAttestation({ ...vector, controller, requestHash: pending.requestHash, observedAt: observation, validUntil });
  const active = await read("getRequest", [1n]) as { status: number; activatedAt: bigint; expiresAt: bigint; attestationHash: Hex };
  assert.equal(active.status, 2);
  assert.equal(active.activatedAt, activatedAt);
  assert.equal(active.expiresAt, grantExpiry);
  assert.equal(active.attestationHash, attestationHash);
  const resolutionEvent = decodeEventLog({ abi: artifacts.MedicalAccessController.abi, data: resolved.logs[0].data, topics: resolved.logs[0].topics });
  assert.equal(resolutionEvent.eventName, "EmergencyResolved");
  assert.deepEqual(resolutionEvent.args, { requestId: 1n, approved: true, oracle: oracle.account.address, attestationHash, activatedAt, expiresAt: grantExpiry });
  assert.equal(await read("canRead", [clinician.account.address, scope[0], 1, 1n]), true);
  assert.equal(await read("canRead", [clinician.account.address, records[20], 1, 1n]), false);
  await write(gateway, "controller", "authorizeAccess", [clinician.account.address, records[20], 1, 1n, accessId], "reverted");
  const authorized = await write(gateway, "controller", "authorizeAccess", readArgs);
  const accessEvent = decodeEventLog({ abi: artifacts.MedicalAccessController.abi, data: authorized.logs[0].data, topics: authorized.logs[0].topics });
  assert.equal(accessEvent.eventName, "AccessAuthorized");
  assert.deepEqual(accessEvent.args, { accessId, recordId: scope[0], patient: patient.account.address,
    clinician: clinician.account.address, gateway: gateway.account.address, mode: 1, grantId: 1n,
    timestamp: (await publicClient.getBlock({ blockNumber: authorized.blockNumber })).timestamp });
  await write(oracle, "controller", "resolveEmergency", decisionArgs, "reverted");
  assert.equal((await read("getRequest", [1n]) as { expiresAt: bigint }).expiresAt, grantExpiry);
  await write(gateway, "controller", "authorizeAccess", readArgs, "reverted");

  await write(clinician, "controller", "requestEmergency", [patient.account.address, [scope[0]], toHex(51, { size: 32 }), 1, toHex(61, { size: 32 }), 120n]);
  const rejectedRequest = await read("getRequest", [2n]) as { requestHash: Hex };
  const rejectionTime = (await publicClient.getBlock()).timestamp;
  await write(oracle, "controller", "resolveEmergency", [2n, false, rejectedRequest.requestHash, rejectionTime, rejectionTime + 60n]);
  const rejected = await read("getRequest", [2n]) as { status: number; activatedAt: bigint; expiresAt: bigint; attestationHash: Hex };
  assert.equal(rejected.status, 1);
  assert.equal(rejected.activatedAt, 0n);
  assert.equal(rejected.expiresAt, 0n);
  assert.equal(rejected.attestationHash, hashEmergencyAttestation({ ...vector, controller, requestId: 2n,
    requestHash: rejectedRequest.requestHash, approved: false, observedAt: rejectionTime, validUntil: rejectionTime + 60n }));
  assert.equal(await read("canRead", [clinician.account.address, scope[0], 1, 2n]), false);

  await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(validUntil + 1n)] });
  await connection.provider.request({ method: "evm_mine", params: [] });
  assert.equal(await read("canRead", [clinician.account.address, scope[0], 1, 1n]), true);
  await write(gateway, "controller", "authorizeAccess", [...readArgs.slice(0, 4), keccak256(toHex("after-attestation-expiry"))]);
  for (const [timestamp, expected] of [[grantExpiry - 1n, true], [grantExpiry, false], [grantExpiry + 1n, false]] as const) {
    await connection.provider.request({ method: "evm_setNextBlockTimestamp", params: [Number(timestamp)] });
    await connection.provider.request({ method: "evm_mine", params: [] });
    assert.equal(await read("canRead", [clinician.account.address, scope[0], 1, 1n]), expected);
    assert.equal(await read("getEffectiveStatus", [1n]), expected ? 2 : 4);
  }
  await write(gateway, "controller", "authorizeAccess", [...readArgs.slice(0, 4), keccak256(toHex("after-grant-expiry"))], "reverted");
});
