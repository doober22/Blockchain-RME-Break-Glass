import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";

const maxRecordBytes = 64 * 1024;
const envelopeOverhead = 12 + 16;

export class RecordIntegrityError extends Error {}

export function recordFile(directory: string, recordId: Hex) {
  if (!/^0x[0-9a-f]{64}$/.test(recordId)) throw new Error("Invalid record ID");
  return join(directory, `${recordId}.encrypted`);
}

export function recordStore(directory: string, secret: Uint8Array) {
  if (secret.length !== 32) throw new Error("Record encryption requires a 32-byte key");
  const key = Buffer.from(secret);
  return {
    async put(recordId: Hex, plaintext: Uint8Array) {
      if (plaintext.length === 0 || plaintext.length > maxRecordBytes) throw new Error("Invalid record size");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(recordId, "ascii"));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(recordFile(directory, recordId), envelope, { flag: "wx", mode: 0o600 });
      return keccak256(envelope);
    },
    async open(recordId: Hex, expectedHash: Hex) {
      const file = recordFile(directory, recordId);
      const info = await stat(file);
      if (!info.isFile() || info.size <= envelopeOverhead || info.size > maxRecordBytes + envelopeOverhead) {
        throw new RecordIntegrityError("Invalid encrypted record");
      }
      const envelope = await readFile(file);
      if (envelope.length !== info.size || keccak256(envelope) !== expectedHash) {
        throw new RecordIntegrityError("Encrypted record hash mismatch");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(0, 12));
        decipher.setAAD(Buffer.from(recordId, "ascii"));
        decipher.setAuthTag(envelope.subarray(12, 28));
        return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]);
      } catch {
        throw new RecordIntegrityError("Encrypted record failed authentication");
      }
    },
  };
}
