import { configVariable, defineConfig } from "hardhat/config";
import { networkSettings } from "./scripts/environment.ts";

const { chainId, rpcUrl } = networkSettings();

export default defineConfig({
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris",
    },
  },
  networks: {
    local: { type: "edr-simulated", chainType: "l1", chainId },
    besu: {
      type: "http",
      chainType: "l1",
      url: rpcUrl,
      chainId,
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
});
