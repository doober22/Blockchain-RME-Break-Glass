import "./environment.ts";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

try {
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error();
  console.log(privateKeyToAccount(key as Hex).address);
} catch {
  console.error("Set a valid throwaway DEPLOYER_PRIVATE_KEY first. No key material is printed.");
  process.exitCode = 1;
}
