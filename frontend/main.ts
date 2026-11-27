import { startFrontend } from "./start.ts";

startFrontend().catch(() => {
  console.error("Frontend startup failed. Check local Besu, the deployment manifest, and port configuration.");
  process.exitCode = 1;
});
