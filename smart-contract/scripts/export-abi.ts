import { exportAbis, readArtifacts } from "./artifacts.ts";

await exportAbis(await readArtifacts());
console.log("Exported ParticipantRegistry and MedicalAccessController ABIs.");
