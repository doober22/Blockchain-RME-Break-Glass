import { startGateway } from "./start.ts";

startGateway().catch(() => {
  console.error("Gateway startup failed. Check local Besu, the deployment manifest, and gateway configuration.");
  process.exitCode = 1;
});
