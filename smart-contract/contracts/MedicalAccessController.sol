// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ParticipantRegistry} from "./ParticipantRegistry.sol";

contract MedicalAccessController {
    ParticipantRegistry public immutable registry;

    uint64 public constant MAX_EMERGENCY_DURATION = 15 minutes;
    uint64 public constant MAX_ATTESTATION_AGE = 60 seconds;
    uint64 public constant REQUEST_TTL = 120 seconds;
    uint256 public constant MAX_RECORDS = 20;
    uint64 public constant REVIEW_TARGET = 24 hours;
    uint8 public constant NORMAL_MODE = 0;
    uint8 public constant EMERGENCY_MODE = 1;

    enum RequestStatus { PENDING, REJECTED, ACTIVE, CLOSED }
    enum EffectiveStatus { PENDING, REJECTED, ACTIVE, CLOSED, EXPIRED }
    enum ReviewVerdict { VALID, SUSPECTED_MISUSE }

    struct MedicalRecord {
        bool exists;
        address patient;
        bytes32 facilityId;
        bytes32 ciphertextHash;
        uint16 categoryCode;
        bool active;
    }

    struct Consent {
        bool exists;
        address patient;
        address clinician;
        bytes32 recordId;
        uint64 createdAt;
        uint64 expiresAt;
        bool revoked;
    }

    struct EmergencyRequest {
        bool exists;
        address patient;
        address clinician;
        bytes32 requesterFacilityId;
        bytes32 encounterId;
        uint16 reasonCode;
        bytes32 evidenceCommitment;
        bytes32 requestHash;
        uint64 requestedDuration;
        uint64 createdAt;
        uint64 decisionDeadline;
        uint64 activatedAt;
        uint64 expiresAt;
        RequestStatus status;
        bytes32 attestationHash;
    }

    struct Review {
        bool exists;
        address reviewer;
        ReviewVerdict verdict;
        bytes32 reportCommitment;
        uint64 reviewedAt;
    }

    mapping(bytes32 => MedicalRecord) private records;
    mapping(uint256 => Consent) private consents;
    mapping(uint256 => EmergencyRequest) private emergencyRequests;
    mapping(uint256 => Review) private reviews;
    mapping(uint256 => bytes32[]) private requestRecords;
    mapping(uint256 => mapping(bytes32 => bool)) private recordIncluded;
    mapping(bytes32 => bool) private usedAccessIds;

    uint256 private consentCounter;
    uint256 private requestCounter;

    error NotImplemented();
    error InvalidRegistry();
    error IneligibleParticipant(address account, bytes32 role);
    error InvalidRecordId();
    error InvalidCiphertextHash();
    error RecordAlreadyExists(bytes32 recordId);
    error RecordNotFound(bytes32 recordId);
    error RecordInactive(bytes32 recordId);
    error WrongFacility(bytes32 expected, bytes32 actual);
    error InactiveFacility(bytes32 facilityId);
    error NotRecordOwner(bytes32 recordId, address account);
    error InvalidConsentExpiry(uint64 expiresAt);
    error ConsentNotFound(uint256 consentId);
    error NotConsentOwner(uint256 consentId, address account);
    error ConsentAlreadyRevoked(uint256 consentId);
    error InvalidAccessId();
    error AccessIdAlreadyUsed(bytes32 accessId);
    error ReadAccessDenied();

    event RecordRegistered(
        bytes32 indexed recordId, address indexed patient, bytes32 indexed facilityId,
        bytes32 ciphertextHash
    );
    event RecordDeactivated(bytes32 indexed recordId, address indexed patient, bytes32 indexed facilityId);
    event ConsentGranted(
        uint256 indexed consentId, address indexed patient, address indexed clinician,
        bytes32 recordId, uint64 expiresAt
    );
    event ConsentRevoked(
        uint256 indexed consentId, address indexed patient, address indexed clinician, bytes32 recordId
    );
    event EmergencyRequested(
        uint256 indexed requestId, address indexed patient, address indexed clinician,
        bytes32 facilityId, bytes32 requestHash, uint64 deadline
    );
    event EmergencyResolved(
        uint256 indexed requestId, bool approved, address indexed oracle,
        bytes32 attestationHash, uint64 activatedAt, uint64 expiresAt
    );
    event EmergencyClosed(
        uint256 indexed requestId, address indexed actor, uint16 closureCode, uint64 timestamp
    );
    event AccessAuthorized(
        bytes32 indexed accessId, bytes32 indexed recordId, address indexed patient,
        address clinician, address gateway, uint8 mode, uint256 grantId, uint64 timestamp
    );
    event EmergencyReviewed(
        uint256 indexed requestId, address indexed auditor, ReviewVerdict verdict,
        bytes32 reportCommitment, uint64 timestamp
    );

    constructor(ParticipantRegistry participantRegistry) {
        if (address(participantRegistry) == address(0) || address(participantRegistry).code.length == 0) {
            revert InvalidRegistry();
        }
        registry = participantRegistry;
    }

    function registerRecord(bytes32 recordId, address patient, bytes32 ciphertextHash, uint16 categoryCode) external {
        ParticipantRegistry.Participant memory gateway = _requireEligible(msg.sender, registry.GATEWAY_ROLE());
        _requireEligible(patient, registry.PATIENT_ROLE());
        if (recordId == bytes32(0)) revert InvalidRecordId();
        if (ciphertextHash == bytes32(0)) revert InvalidCiphertextHash();
        if (records[recordId].exists) revert RecordAlreadyExists(recordId);

        records[recordId] = MedicalRecord({
            exists: true,
            patient: patient,
            facilityId: gateway.facilityId,
            ciphertextHash: ciphertextHash,
            categoryCode: categoryCode,
            active: true
        });
        emit RecordRegistered(recordId, patient, gateway.facilityId, ciphertextHash);
    }

    function deactivateRecord(bytes32 recordId) external {
        MedicalRecord storage record = _requireRecord(recordId);
        _requireIssuingGateway(record);
        if (!record.active) revert RecordInactive(recordId);
        record.active = false;
        emit RecordDeactivated(recordId, record.patient, record.facilityId);
    }

    function grantConsent(address clinician, bytes32 recordId, uint64 expiresAt) external returns (uint256 consentId) {
        MedicalRecord storage record = _requireActiveRecord(recordId);
        if (record.patient != msg.sender) revert NotRecordOwner(recordId, msg.sender);
        _requireEligible(msg.sender, registry.PATIENT_ROLE());
        _requireEligible(clinician, registry.CLINICIAN_ROLE());
        if (expiresAt <= block.timestamp) revert InvalidConsentExpiry(expiresAt);

        consentId = ++consentCounter;
        consents[consentId] = Consent({
            exists: true,
            patient: msg.sender,
            clinician: clinician,
            recordId: recordId,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            revoked: false
        });
        emit ConsentGranted(consentId, msg.sender, clinician, recordId, expiresAt);
    }

    function revokeConsent(uint256 consentId) external {
        Consent storage consent = consents[consentId];
        if (!consent.exists) revert ConsentNotFound(consentId);
        if (consent.patient != msg.sender) revert NotConsentOwner(consentId, msg.sender);
        if (consent.revoked) revert ConsentAlreadyRevoked(consentId);
        // Removing access remains possible after credentials or the record become inactive.
        consent.revoked = true;
        emit ConsentRevoked(consentId, consent.patient, consent.clinician, consent.recordId);
    }

    function canRead(address clinician, bytes32 recordId, uint8 mode, uint256 grantId) external view returns (bool) {
        return _canRead(clinician, recordId, mode, grantId);
    }

    function authorizeAccess(address clinician, bytes32 recordId, uint8 mode, uint256 grantId, bytes32 accessId) external {
        MedicalRecord storage record = _requireRecord(recordId);
        _requireIssuingGateway(record);
        if (accessId == bytes32(0)) revert InvalidAccessId();
        if (usedAccessIds[accessId]) revert AccessIdAlreadyUsed(accessId);
        if (!_canRead(clinician, recordId, mode, grantId)) revert ReadAccessDenied();
        usedAccessIds[accessId] = true;
        emit AccessAuthorized(
            accessId, recordId, record.patient, clinician, msg.sender, mode, grantId, uint64(block.timestamp)
        );
    }

    function requestEmergency(
        address patient, bytes32[] calldata recordIds, bytes32 encounterId,
        uint16 reasonCode, bytes32 evidenceCommitment, uint64 duration
    ) external pure returns (uint256 requestId) {
        revert NotImplemented();
    }

    function resolveEmergency(
        uint256 requestId, bool approved, bytes32 requestHash, uint64 observedAt, uint64 validUntil
    ) external pure {
        revert NotImplemented();
    }

    function closeEmergency(uint256 requestId, uint16 closureCode) external pure {
        revert NotImplemented();
    }

    function submitReview(uint256 requestId, uint8 verdict, bytes32 reportCommitment) external pure {
        revert NotImplemented();
    }

    function getEffectiveStatus(uint256 requestId) external pure returns (EffectiveStatus) {
        revert NotImplemented();
    }

    function getRequest(uint256 requestId) external view returns (EmergencyRequest memory) {
        return emergencyRequests[requestId];
    }

    function getConsent(uint256 consentId) external view returns (Consent memory) {
        return consents[consentId];
    }

    function getRecord(bytes32 recordId) external view returns (MedicalRecord memory) {
        return records[recordId];
    }

    function getReview(uint256 requestId) external view returns (Review memory) {
        return reviews[requestId];
    }

    function isReviewOverdue(uint256 requestId) external pure returns (bool) {
        revert NotImplemented();
    }

    function _requireEligible(address account, bytes32 role)
        internal view returns (ParticipantRegistry.Participant memory)
    {
        if (!registry.isEligible(account, role)) revert IneligibleParticipant(account, role);
        return registry.getParticipant(account);
    }

    function _requireRecord(bytes32 recordId) internal view returns (MedicalRecord storage record) {
        record = records[recordId];
        if (!record.exists) revert RecordNotFound(recordId);
    }

    function _requireActiveRecord(bytes32 recordId) internal view returns (MedicalRecord storage record) {
        record = _requireRecord(recordId);
        if (!record.active) revert RecordInactive(recordId);
        if (!registry.getFacility(record.facilityId).active) revert InactiveFacility(record.facilityId);
    }

    /// @dev Shared by queries and transaction-time authorization; gateway eligibility is checked separately.
    function _canRead(address clinician, bytes32 recordId, uint8 mode, uint256 grantId) internal view returns (bool) {
        // Emergency grants remain fail-closed until their policy is implemented.
        if (mode != NORMAL_MODE) return false;
        Consent storage consent = consents[grantId];
        MedicalRecord storage record = records[recordId];
        if (
            !consent.exists || consent.revoked || block.timestamp >= consent.expiresAt
            || consent.clinician != clinician || consent.recordId != recordId
            || !record.exists || !record.active || consent.patient != record.patient
        ) return false;
        return registry.isEligible(record.patient, registry.PATIENT_ROLE())
            && registry.isEligible(clinician, registry.CLINICIAN_ROLE())
            && registry.getFacility(record.facilityId).active;
    }

    function _requireIssuingGateway(MedicalRecord storage record) internal view {
        ParticipantRegistry.Participant memory gateway = _requireEligible(msg.sender, registry.GATEWAY_ROLE());
        if (gateway.facilityId != record.facilityId) revert WrongFacility(record.facilityId, gateway.facilityId);
    }
}
