import { startOracle } from "./start.ts";

startOracle().catch(() => {
  console.error("Oracle worker startup failed. Check local Besu, the deployment manifest, and oracle configuration.");
  process.exitCode = 1;
});
