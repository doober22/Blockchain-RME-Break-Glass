/** Proposed synthetic project API response, NOT a SATUSEHAT API or validator. */
export interface EmergencyContext {
  /** Random synthetic bytes32 encoded as 0x-prefixed hex. */
  encounterId: `0x${string}`;
  patientWallet: `0x${string}`;
  clinicianWallet: `0x${string}`;
  facilityId: `0x${string}`;
  encounterActive: boolean;
  emergency: boolean;
  patientUnableToConsent: boolean;
  clinicianAssigned: boolean;
  evidenceCommitment: `0x${string}`;
  /** Integer Unix seconds, not milliseconds. Validate at runtime. */
  observedAt: number;
  /** Integer Unix seconds; expiry must be checked against chain time too. */
  validUntil: number;
}
