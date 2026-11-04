import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Abi, Hex } from "viem";

export const contractNames = ["ParticipantRegistry", "MedicalAccessController"] as const;
export type ContractName = typeof contractNames[number];
export type ContractArtifact = {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences?: Record<string, { start: number; length: number }[]>;
};
export type ContractArtifacts = Record<ContractName, ContractArtifact>;
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export async function readArtifacts(): Promise<ContractArtifacts> {
  const entries = await Promise.all(contractNames.map(async (name) => [name,
    JSON.parse(await readFile(join(projectRoot, "artifacts", "contracts", `${name}.sol`, `${name}.json`), "utf8")),
  ]));
  return Object.fromEntries(entries) as ContractArtifacts;
}

export async function writeJson(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function exportAbis(artifacts: ContractArtifacts, directory = join(projectRoot, "abi")) {
  await mkdir(directory, { recursive: true });
  for (const name of contractNames) await writeJson(join(directory, `${name}.json`), artifacts[name].abi);
}
