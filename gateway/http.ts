import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getAddress, verifyMessage, type Hex } from "viem";
import { ReadDenied, type ReadScope, type connectGateway } from "./chain.ts";
import { RecordIntegrityError, type recordStore } from "./records.ts";

const randomId = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const challengeTtlMs = 30_000;
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"] !== "application/json") throw new HttpError(415, "json_required");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.from(part);
    length += chunk.length;
    if (length > 4096) {
      req.resume();
      throw new HttpError(413, "body_too_large");
    }
    chunks.push(chunk);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Invalid JSON is handled below. */ }
  throw new HttpError(400, "invalid_json");
}

function readScope(input: Record<string, unknown>): ReadScope {
  const { clinician, recordId, consentId } = input;
  if (typeof clinician !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(clinician)
      || /^0x0{40}$/.test(clinician) || typeof recordId !== "string"
      || !/^0x[0-9a-f]{64}$/.test(recordId) || /^0x0{64}$/.test(recordId)
      || typeof consentId !== "string" || !/^[1-9]\d{0,77}$/.test(consentId) || BigInt(consentId) >= (1n << 256n)) {
    throw new HttpError(400, "invalid_scope");
  }
  return { clinician: getAddress(clinician.toLowerCase()), recordId: recordId as Hex, consentId: BigInt(consentId) };
}

function json(res: ServerResponse, status: number, value: object) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function sendRecord(res: ServerResponse, record: Buffer, accessId: Hex) {
  if (res.destroyed) throw new Error("HTTP client disconnected");
  return new Promise<void>((resolve, reject) => {
    res.once("finish", resolve);
    res.once("close", () => { if (!res.writableFinished) reject(new Error("HTTP response interrupted")); });
    res.once("error", reject);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": record.length,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Access-Id": accessId });
    res.end(record);
  });
}

export function createGateway(config: {
  chain: Awaited<ReturnType<typeof connectGateway>>; store: ReturnType<typeof recordStore>; auditPath: string;
  gateway: string; controller: string; origin: () => string;
}) {
  const challenges = new Map<Hex, { scope: ReadScope; message: string; expiresAt: number }>();
  let authorizing = false;
  return createServer({ requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 }, async (req, res) => {
    try {
      if (req.method !== "POST" || (req.url !== "/challenge" && req.url !== "/records/read")) {
        throw new HttpError(404, "not_found");
      }
      const input = await body(req);
      if (req.url === "/challenge") {
        const scope = readScope(input);
        const now = Date.now();
        for (const [id, challenge] of challenges) if (challenge.expiresAt <= now) challenges.delete(id);
        if (challenges.size >= 512) throw new HttpError(429, "too_many_challenges");
        const nonce = randomId();
        const expiresAt = now + challengeTtlMs;
        const message = [
          "RME gateway authorization for one normal record read",
          `Service: ${config.origin()}`, "Chain ID: 1337", `Controller: ${config.controller}`,
          `Gateway: ${config.gateway}`, `Clinician: ${scope.clinician}`, `Record: ${scope.recordId}`,
          `Consent: ${scope.consentId}`, `Nonce: ${nonce}`, `Expires: ${new Date(expiresAt).toISOString()}`,
        ].join("\n");
        challenges.set(nonce, { scope, message, expiresAt });
        return json(res, 201, { nonce, message, expiresAt });
      }

      const { nonce, signature } = input;
      if (typeof nonce !== "string" || !/^0x[0-9a-f]{64}$/.test(nonce)
          || typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        throw new HttpError(400, "invalid_proof");
      }
      const challenge = challenges.get(nonce as Hex);
      challenges.delete(nonce as Hex);
      if (!challenge || challenge.expiresAt <= Date.now()) throw new HttpError(401, "invalid_challenge");
      const { scope, message } = challenge;
      if (!await verifyMessage({ address: scope.clinician, message, signature: signature as Hex }).catch(() => false)) {
        throw new HttpError(401, "invalid_signature");
      }
      if (challenge.expiresAt <= Date.now()) throw new HttpError(401, "invalid_challenge");
      // One signing wallet per process. Avoid concurrent nonce allocation.
      if (authorizing) throw new HttpError(503, "gateway_busy");
      authorizing = true;
      let transaction: Hex | undefined;
      const accessId = randomId();
      const audit = (outcome: string) => appendFile(config.auditPath, JSON.stringify({
        accessId, transaction, outcome, time: new Date().toISOString(),
      }) + "\n", { mode: 0o600 });
      let outcome = "failed";
      try {
        const record = await config.chain.check(scope);
        await audit("authorization_requested");
        transaction = await config.chain.submit(scope, accessId);
        await config.chain.confirm(scope, accessId, record.patient, transaction);
        await audit("authorized");
        const plaintext = await config.store.open(scope.recordId, record.ciphertextHash);
        const current = await config.chain.check(scope);
        if (current.ciphertextHash !== record.ciphertextHash) throw new RecordIntegrityError("Record commitment changed");
        await sendRecord(res, plaintext, accessId);
        outcome = "response_finished";
      } catch (error) {
        if (error instanceof ReadDenied) outcome = "denied";
        if (error instanceof RecordIntegrityError) outcome = "integrity_failed";
        throw error;
      } finally {
        try {
          await audit(outcome);
        } catch {
          // An HTTP response that already finished cannot be recalled.
          console.error("Gateway could not append the delivery outcome", accessId);
        } finally {
          authorizing = false;
        }
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      if (error instanceof HttpError) return json(res, error.status, { error: error.code });
      if (error instanceof ReadDenied) return json(res, 403, { error: "read_denied" });
      if (error instanceof RecordIntegrityError) return json(res, 502, { error: "record_integrity_failed" });
      return json(res, 503, { error: "record_unavailable" });
    }
  });
}
