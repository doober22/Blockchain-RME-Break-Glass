// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MedicalAccessController} from "../contracts/MedicalAccessController.sol";
import {ControllerFixture} from "./ControllerFixture.sol";

contract EmergencyResolutionTest is ControllerFixture {
    bytes32 private requestHash;
    bytes32 private constant ACCESS_ID = keccak256("emergency-access");
    event EmergencyResolved(
        uint256 indexed requestId, bool approved, address indexed oracle,
        bytes32 attestationHash, uint64 activatedAt, uint64 expiresAt
    );

    function setUp() public override {
        super.setUp();
        _registerRecord();
    }

    function testApprovalActivatesFromDecisionTimeAndEmitsBoundAttestation() public {
        uint256 id = _request(900);
        vm.warp(1_050);
        bytes32 expected = _attestation(id, true, 1_049, 1_109);
        vm.expectEmit(true, true, false, true, address(controller));
        emit EmergencyResolved(id, true, ORACLE_B, expected, 1_050, 1_950);
        _resolve(id, true, 1_049, 1_109);
        MedicalAccessController.EmergencyRequest memory request = controller.getRequest(id);
        require(request.status == MedicalAccessController.RequestStatus.ACTIVE);
        require(request.activatedAt == 1_050 && request.expiresAt == 1_950 && request.attestationHash == expected);
        require(request.requestHash == requestHash && request.decisionDeadline == 1_120);
        require(controller.getEffectiveStatus(id) == MedicalAccessController.EffectiveStatus.ACTIVE);
        require(controller.canRead(CLINICIAN_B, RECORD, 1, id));
        require(!controller.getConsent(1).exists);
    }

    function testNegativeDecisionIsTerminalWithoutActivationOrReadAccess() public {
        uint256 id = _request(900);
        bytes32 expected = _attestation(id, false, 1_000, 1_060);
        vm.expectEmit(true, true, false, true, address(controller));
        emit EmergencyResolved(id, false, ORACLE_B, expected, 0, 0);
        _resolve(id, false, 1_000, 1_060);
        MedicalAccessController.EmergencyRequest memory request = controller.getRequest(id);
        require(request.status == MedicalAccessController.RequestStatus.REJECTED);
        require(request.activatedAt == 0 && request.expiresAt == 0 && request.attestationHash == expected);
        _assertDenied(id, CLINICIAN_B, RECORD);
        vm.warp(10_000);
        require(controller.getEffectiveStatus(id) == MedicalAccessController.EffectiveStatus.REJECTED);
    }

    function testOnlyEligibleOracleOfRequestingFacilityCanResolve() public {
        uint256 id = _request(900);
        bytes32 role = registry.ORACLE_ROLE();
        address[6] memory callers = [address(this), PATIENT, CLINICIAN_B, GATEWAY_B, AUDITOR, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            _expectIneligible(callers[i], role);
            vm.prank(callers[i]);
            controller.resolveEmergency(id, true, requestHash, 1_000, 1_060);
        }
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.WrongFacility.selector, FACILITY_B, FACILITY_A));
        vm.prank(ORACLE_A);
        controller.resolveEmergency(id, true, requestHash, 1_000, 1_060);
        _resolve(id, true, 1_000, 1_060);
    }

    function testInactiveRevokedExpiredAndShutdownOracleCannotDecide() public {
        uint256 id = _request(900);
        bytes32 role = registry.ORACLE_ROLE();
        registry.updateParticipant(ORACLE_B, FACILITY_B, CREDENTIAL_EXPIRY, false);
        _expectIneligible(ORACLE_B, role);
        _resolve(id, false, 1_000, 1_060);
        registry.updateParticipant(ORACLE_B, FACILITY_B, CREDENTIAL_EXPIRY, true);
        registry.revokeRole(role, ORACLE_B);
        _expectIneligible(ORACLE_B, role);
        _resolve(id, true, 1_000, 1_060);
        registry.grantRole(role, ORACLE_B);
        registry.setFacilityActive(FACILITY_B, false);
        _expectIneligible(ORACLE_B, role);
        _resolve(id, true, 1_000, 1_060);
        registry.setFacilityActive(FACILITY_B, true);
        registry.updateParticipant(ORACLE_B, FACILITY_B, 1_010, true);
        vm.warp(1_010);
        _expectIneligible(ORACLE_B, role);
        _resolve(id, true, 1_010, 1_060);
        require(controller.getRequest(id).status == MedicalAccessController.RequestStatus.PENDING);
    }

    function testUnknownRequestAndMismatchedHashCannotResolve() public {
        uint256 id = _request(900);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestNotFound.selector, id + 1));
        _resolve(id + 1, true, 1_000, 1_060);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestHashMismatch.selector, id));
        vm.prank(ORACLE_B);
        controller.resolveEmergency(id, true, bytes32(0), 1_000, 1_060);
        require(controller.getRequest(id).attestationHash == bytes32(0));
    }

    function testAnotherRequestsHashCannotBeReplayedAndSecondDecisionCannotExtendGrant() public {
        uint256 first = _request(900);
        bytes32 firstHash = requestHash;
        uint256 second = _request(900);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestHashMismatch.selector, second));
        vm.prank(ORACLE_B);
        controller.resolveEmergency(second, true, firstHash, 1_000, 1_060);
        _resolve(second, true, 1_000, 1_060);
        vm.warp(1_001);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestNotPending.selector, second));
        _resolve(second, true, 1_001, 1_060);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestNotPending.selector, second));
        _resolve(second, false, 1_001, 1_060);
        require(controller.getRequest(second).expiresAt == 1_900);
        require(controller.getRequest(first).status == MedicalAccessController.RequestStatus.PENDING);
    }

    function testRejectedRequestCannotBeApprovedOrRejectedAgain() public {
        uint256 id = _request(900);
        _resolve(id, false, 1_000, 1_060);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestNotPending.selector, id));
        _resolve(id, true, 1_000, 1_060);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestNotPending.selector, id));
        _resolve(id, false, 1_000, 1_060);
    }

    function testDeadlineIsExclusiveForApprovalAndRejection() public {
        uint256 id = _request(900);
        vm.warp(1_120);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestDeadlinePassed.selector, id));
        _resolve(id, true, 1_120, 1_180);
        vm.warp(1_121);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestDeadlinePassed.selector, id));
        _resolve(id, false, 1_121, 1_181);
        require(controller.getEffectiveStatus(id) == MedicalAccessController.EffectiveStatus.EXPIRED);
        require(controller.getRequest(id).attestationHash == bytes32(0));
    }

    function testApprovalJustBeforeDeadlineUsesActivationNotRequestTime() public {
        uint256 id = _request(900);
        vm.warp(1_119);
        _resolve(id, true, 1_119, 1_179);
        require(controller.getRequest(id).expiresAt == 2_019);
        vm.warp(1_180);
        require(controller.canRead(CLINICIAN_B, RECORD, 1, id));
    }

    function testFutureStaleExpiredReversedAndOverlongAttestationsFailClosed() public {
        uint256 id = _request(900);
        uint64[2][8] memory invalid = [
            [uint64(1_001), uint64(1_060)], [uint64(939), uint64(999)],
            [uint64(1_000), uint64(1_000)], [uint64(1_000), uint64(999)],
            [uint64(1_000), uint64(1_061)], [uint64(940), uint64(1_000)],
            [uint64(0), uint64(60)], [type(uint64).max, type(uint64).max]
        ];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidAttestationTimestamps.selector));
            _resolve(id, i % 2 == 0, invalid[i][0], invalid[i][1]);
        }
        require(controller.getRequest(id).status == MedicalAccessController.RequestStatus.PENDING);
        require(controller.getRequest(id).attestationHash == bytes32(0));
        _resolve(id, true, 941, 1_001); // age 59, window 60, one second remaining
        require(controller.canRead(CLINICIAN_B, RECORD, 1, id));
    }

    function testApprovalRechecksClinicianEligibilityAndOriginalAffiliation() public {
        uint256 id = _request(900);
        bytes32 role = registry.CLINICIAN_ROLE();
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, false);
        _expectIneligible(CLINICIAN_B, role);
        _resolve(id, true, 1_000, 1_060);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, true);
        registry.revokeRole(role, CLINICIAN_B);
        _expectIneligible(CLINICIAN_B, role);
        _resolve(id, true, 1_000, 1_060);
        registry.grantRole(role, CLINICIAN_B);
        registry.updateParticipant(CLINICIAN_B, FACILITY_A, CREDENTIAL_EXPIRY, true);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.WrongFacility.selector, FACILITY_B, FACILITY_A));
        _resolve(id, true, 1_000, 1_060);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, 1_010, true);
        vm.warp(1_010);
        _expectIneligible(CLINICIAN_B, role);
        _resolve(id, true, 1_010, 1_060);
    }

    function testApprovalRechecksPatientEligibility() public {
        uint256 id = _request(900);
        bytes32 role = registry.PATIENT_ROLE();
        registry.revokeRole(role, PATIENT);
        _expectIneligible(PATIENT, role);
        _resolve(id, true, 1_000, 1_060);
        registry.grantRole(role, PATIENT);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        _expectIneligible(PATIENT, role);
        _resolve(id, true, 1_000, 1_060);
        registry.updateParticipant(PATIENT, bytes32(0), 1_010, true);
        vm.warp(1_010);
        _expectIneligible(PATIENT, role);
        _resolve(id, true, 1_010, 1_060);
    }

    function testApprovalRechecksEveryScopedRecordAndIssuingFacility() public {
        bytes32 second = bytes32(uint256(11));
        vm.prank(GATEWAY_A);
        controller.registerRecord(second, PATIENT, CIPHERTEXT_HASH, 1);
        bytes32[] memory scope = new bytes32[](2);
        scope[0] = RECORD;
        scope[1] = second;
        vm.prank(CLINICIAN_B);
        uint256 id = controller.requestEmergency(PATIENT, scope, keccak256("encounter"), 1, keccak256("evidence"), 900);
        requestHash = controller.getRequest(id).requestHash;
        registry.setFacilityActive(FACILITY_A, false);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InactiveFacility.selector, FACILITY_A));
        _resolve(id, true, 1_000, 1_060);
        registry.setFacilityActive(FACILITY_A, true);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(second);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordInactive.selector, second));
        _resolve(id, true, 1_000, 1_060);
        require(controller.getRequest(id).status == MedicalAccessController.RequestStatus.PENDING);
    }

    function testNegativeDecisionMayRejectAfterClinicianOrPatientDeactivation() public {
        uint256 id = _request(900);
        registry.updateParticipant(CLINICIAN_B, FACILITY_A, CREDENTIAL_EXPIRY, false);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        _resolve(id, false, 1_000, 1_060);
        require(controller.getRequest(id).status == MedicalAccessController.RequestStatus.REJECTED);
    }

    function testEmergencyReadIsScopedToDoctorPatientAndRecord() public {
        uint256 id = _request(900);
        _resolve(id, true, 1_000, 1_060);
        address[6] memory wrong = [CLINICIAN_A, PATIENT, GATEWAY_A, ORACLE_B, AUDITOR, address(this)];
        for (uint256 i; i < wrong.length; ++i) _assertDenied(id, wrong[i], RECORD);
        bytes32 second = bytes32(uint256(11));
        vm.prank(GATEWAY_A);
        controller.registerRecord(second, PATIENT, CIPHERTEXT_HASH, 1);
        _assertDenied(id, CLINICIAN_B, second);
        vm.prank(GATEWAY_A);
        controller.registerRecord(bytes32(uint256(12)), OTHER_PATIENT, CIPHERTEXT_HASH, 1);
        _assertDenied(id, CLINICIAN_B, bytes32(uint256(12)));
        require(!controller.canRead(CLINICIAN_B, bytes32(0), 1, id));
        require(!controller.canRead(CLINICIAN_B, RECORD, 1, id + 1));
        require(!controller.canRead(CLINICIAN_B, RECORD, 255, id));
    }

    function testEmergencyAuthorizationEmitsFullPayloadAndChecksIssuingGateway() public {
        uint256 id = _request(900);
        _resolve(id, true, 1_000, 1_060);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.WrongFacility.selector, FACILITY_A, FACILITY_B));
        vm.prank(GATEWAY_B);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 1, id, ACCESS_ID);
        _expectIneligible(CLINICIAN_B, registry.GATEWAY_ROLE());
        vm.prank(CLINICIAN_B);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 1, id, ACCESS_ID);
        vm.expectEmit(true, true, true, true, address(controller));
        emit AccessAuthorized(ACCESS_ID, RECORD, PATIENT, CLINICIAN_B, GATEWAY_A, 1, id, 1_000);
        _authorize(id, ACCESS_ID);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.AccessIdAlreadyUsed.selector, ACCESS_ID));
        _authorize(id, ACCESS_ID);
    }

    function testNormalAndEmergencyAccessIdsShareReplayProtection() public {
        uint256 consentId = _grantConsent();
        uint256 id = _request(900);
        _resolve(id, true, 1_000, 1_060);
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 0, consentId, ACCESS_ID);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.AccessIdAlreadyUsed.selector, ACCESS_ID));
        _authorize(id, ACCESS_ID);
        bytes32 emergencyId = keccak256("emergency-second-access");
        _authorize(id, emergencyId);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.AccessIdAlreadyUsed.selector, emergencyId));
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 0, consentId, emergencyId);
    }

    function testRevokingNormalConsentDoesNotRevokeEmergencyGrant() public {
        uint256 consentId = _grantConsent();
        uint256 id = _request(900);
        _resolve(id, true, 1_000, 1_060);
        vm.prank(PATIENT);
        controller.revokeConsent(consentId);
        require(!controller.canRead(CLINICIAN_B, RECORD, 0, consentId));
        _authorize(id, ACCESS_ID);
    }

    function testCurrentClinicianRoleCredentialsAndAffiliationAreCheckedOnRead() public {
        uint256 id = _request(900);
        _resolve(id, true, 1_000, 1_060);
        registry.updateParticipant(CLINICIAN_B, FACILITY_A, CREDENTIAL_EXPIRY, true);
        _assertDenied(id, CLINICIAN_B, RECORD);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, false);
        _assertDenied(id, CLINICIAN_B, RECORD);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, true);
        registry.revokeRole(registry.CLINICIAN_ROLE(), CLINICIAN_B);
        _assertDenied(id, CLINICIAN_B, RECORD);
        registry.grantRole(registry.CLINICIAN_ROLE(), CLINICIAN_B);
        registry.setFacilityActive(FACILITY_B, false);
        _assertDenied(id, CLINICIAN_B, RECORD);
        registry.setFacilityActive(FACILITY_B, true);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, 1_010, true);
        vm.warp(1_010);
        _assertDenied(id, CLINICIAN_B, RECORD);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, true);
        _authorize(id, ACCESS_ID);
    }

    function testCurrentPatientCredentialsAndRoleAreCheckedOnRead() public {
        uint256 id = _request(900);
        _resolve(id, true, 1_000, 1_060);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        _assertDenied(id, CLINICIAN_B, RECORD);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, true);
        registry.revokeRole(registry.PATIENT_ROLE(), PATIENT);
        _assertDenied(id, CLINICIAN_B, RECORD);
        registry.grantRole(registry.PATIENT_ROLE(), PATIENT);
        registry.updateParticipant(PATIENT, bytes32(0), 1_010, true);
        vm.warp(1_010);
        _assertDenied(id, CLINICIAN_B, RECORD);
    }

    function testCurrentRecordAndIssuerAreCheckedOnRead() public {
        uint256 id = _request(900);
        _resolve(id, true, 1_000, 1_060);
        registry.setFacilityActive(FACILITY_A, false);
        require(!controller.canRead(CLINICIAN_B, RECORD, 1, id));
        _expectIneligible(GATEWAY_A, registry.GATEWAY_ROLE());
        _authorize(id, ACCESS_ID);
        registry.setFacilityActive(FACILITY_A, true);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        _assertDenied(id, CLINICIAN_B, RECORD);
    }

    function testRevokingOracleBlocksNewDecisionsButDoesNotRewriteAcceptedDecision() public {
        uint256 id = _request(900);
        _resolve(id, true, 1_000, 1_060);
        bytes32 attestation = controller.getRequest(id).attestationHash;
        uint256 second = _request(900);
        registry.revokeRole(registry.ORACLE_ROLE(), ORACLE_B);
        _expectIneligible(ORACLE_B, registry.ORACLE_ROLE());
        _resolve(second, true, 1_000, 1_060);
        require(controller.getRequest(id).attestationHash == attestation);
        _authorize(id, ACCESS_ID);
    }

    function testGrantTimestampOverflowIsRejectedWithoutActivation() public {
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, type(uint64).max, true);
        registry.updateParticipant(PATIENT, bytes32(0), type(uint64).max, true);
        registry.updateParticipant(ORACLE_B, FACILITY_B, type(uint64).max, true);
        vm.warp(uint256(type(uint64).max) - 200);
        uint256 id = _request(900);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRequestTimestamp.selector));
        _resolve(id, true, type(uint64).max - 200, type(uint64).max - 140);
        require(controller.getRequest(id).attestationHash == bytes32(0));
    }

    function testFuzzGrantExpiryQueryAndAuthorizationAgree(uint16 durationSeed) public {
        uint64 duration = uint64(durationSeed % 900) + 1;
        uint256 id = _request(duration);
        _resolve(id, true, 1_000, 1_060);
        vm.warp(1_000 + duration - 1);
        _authorize(id, keccak256("before-expiry"));
        vm.warp(1_000 + duration);
        _assertDenied(id, CLINICIAN_B, RECORD);
        require(controller.getEffectiveStatus(id) == MedicalAccessController.EffectiveStatus.EXPIRED);
        vm.warp(1_001 + duration);
        _assertDenied(id, CLINICIAN_B, RECORD);
        require(controller.getRequest(id).status == MedicalAccessController.RequestStatus.ACTIVE);
    }

    function testFuzzAttestationAcceptanceUsesExactWindowAndFutureBounds(uint8 age, uint8 window) public {
        uint256 id = _request(900);
        uint64 observed = 1_000 - uint64(age);
        uint64 validUntil = observed + uint64(window);
        bool accepted = age <= 60 && window > 0 && window <= 60 && window > age;
        if (!accepted) vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidAttestationTimestamps.selector));
        _resolve(id, true, observed, validUntil);
        require(controller.canRead(CLINICIAN_B, RECORD, 1, id) == accepted);
    }

    function testFixedApprovalAndRejectionAttestationVectors() public pure {
        bytes32 hash = 0xbe75b384e22e59d38aea2d92d001f77e6543045d2d21fa53c701828595aa8652;
        address target = address(0x1111111111111111111111111111111111111111);
        require(keccak256(abi.encode(uint256(1337), target, uint256(1), hash, true, uint64(1_000), uint64(1_060)))
            == 0xb12cb5883140d1c0368649fe0ce0e70e2899b7358ddfe8b763cff27518417549);
        require(keccak256(abi.encode(uint256(1337), target, uint256(1), hash, false, uint64(1_000), uint64(1_060)))
            == 0x3434a6118639de46ef1c823bfe7083550e2797d73216e8dbad812b7b9713755f);
    }

    function _request(uint64 duration) private returns (uint256 id) {
        bytes32[] memory scope = new bytes32[](1);
        scope[0] = RECORD;
        vm.prank(CLINICIAN_B);
        id = controller.requestEmergency(PATIENT, scope, keccak256("encounter"), 1, keccak256("evidence"), duration);
        requestHash = controller.getRequest(id).requestHash;
    }

    function _resolve(uint256 id, bool approved, uint64 observedAt, uint64 validUntil) private {
        vm.prank(ORACLE_B);
        controller.resolveEmergency(id, approved, requestHash, observedAt, validUntil);
    }

    function _attestation(uint256 id, bool approved, uint64 observedAt, uint64 validUntil) private view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(controller), id, requestHash, approved, observedAt, validUntil));
    }

    function _authorize(uint256 id, bytes32 accessId) private {
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 1, id, accessId);
    }

    function _assertDenied(uint256 id, address clinician, bytes32 recordId) private {
        require(!controller.canRead(clinician, recordId, 1, id));
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.ReadAccessDenied.selector));
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(clinician, recordId, 1, id, ACCESS_ID);
    }
}
