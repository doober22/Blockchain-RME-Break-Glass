import { defineConfig } from "hardhat/config";

const chainId = process.env.BESU_CHAIN_ID;
if (chainId !== undefined && (!/^\d+$/.test(chainId) || !Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0)) {
  throw new Error("BESU_CHAIN_ID must be a positive safe integer matching the Besu genesis.");
}

export default defineConfig({
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Match the Besu genesis fork schedule when the private chain is configured.
      evmVersion: "paris",
    },
  },
  networks: {
    besu: {
      type: "http",
      chainType: "l1",
      url: process.env.BESU_RPC_URL ?? "http://127.0.0.1:8545",
      ...(chainId === undefined ? {} : { chainId: Number(chainId) }),
      accounts: [],
    },
  },
});
