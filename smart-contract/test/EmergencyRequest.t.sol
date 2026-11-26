// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MedicalAccessController} from "../contracts/MedicalAccessController.sol";
import {ControllerFixture} from "./ControllerFixture.sol";

contract EmergencyRequestTest is ControllerFixture {
    bytes32 private constant ENCOUNTER = keccak256("synthetic-encounter");
    bytes32 private constant EVIDENCE = keccak256("synthetic-evidence-commitment");

    event EmergencyRequested(
        uint256 indexed requestId, address indexed patient, address indexed clinician,
        bytes32 facilityId, bytes32 requestHash, uint64 deadline
    );

    function setUp() public override {
        super.setUp();
        _registerRecord();
    }

    function testRequestStoresScopeMetadataAndEmitsPendingEventWithoutConsent() public {
        bytes32[] memory scope = _scope(1);
        bytes32 expectedHash = _expectedHash(1, scope);
        vm.expectEmit(true, true, true, true, address(controller));
        emit EmergencyRequested(1, PATIENT, CLINICIAN_B, FACILITY_B, expectedHash, 1_120);
        uint256 id = _request(scope, 60);
        MedicalAccessController.EmergencyRequest memory request = controller.getRequest(id);
        require(id == 1 && request.exists && request.patient == PATIENT && request.clinician == CLINICIAN_B);
        require(request.requesterFacilityId == FACILITY_B && request.encounterId == ENCOUNTER);
        require(request.reasonCode == 1 && request.evidenceCommitment == EVIDENCE && request.requestedDuration == 60);
        require(request.createdAt == 1_000 && request.decisionDeadline == 1_120 && request.requestHash == expectedHash);
        require(request.status == MedicalAccessController.RequestStatus.PENDING);
        require(request.activatedAt == 0 && request.expiresAt == 0 && request.attestationHash == bytes32(0));
        require(!controller.getConsent(1).exists);
        require(keccak256(abi.encode(controller.getRequestRecords(id))) == keccak256(abi.encode(scope)));
        require(controller.getEffectiveStatus(id) == MedicalAccessController.EffectiveStatus.PENDING);
    }

    function testOnlyEligibleCliniciansCanRequest() public {
        bytes32[] memory scope = _scope(1);
        address[7] memory callers = [address(this), PATIENT, GATEWAY_A, ORACLE_A, AUDITOR, OUTSIDER, address(0)];
        bytes32 role = registry.CLINICIAN_ROLE();
        for (uint256 i; i < callers.length; ++i) {
            _expectIneligible(callers[i], role);
            vm.prank(callers[i]);
            controller.requestEmergency(PATIENT, scope, ENCOUNTER, 1, EVIDENCE, 60);
        }
        require(_request(scope, 60) == 1);
    }

    function testInactiveRevokedExpiredAndShutdownClinicianCannotRequest() public {
        bytes32[] memory scope = _scope(1);
        bytes32 role = registry.CLINICIAN_ROLE();
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, false);
        _expectIneligible(CLINICIAN_B, role);
        _request(scope, 60);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, true);
        registry.revokeRole(role, CLINICIAN_B);
        _expectIneligible(CLINICIAN_B, role);
        _request(scope, 60);
        registry.grantRole(role, CLINICIAN_B);
        registry.setFacilityActive(FACILITY_B, false);
        _expectIneligible(CLINICIAN_B, role);
        _request(scope, 60);
        registry.setFacilityActive(FACILITY_B, true);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, 1_100, true);
        vm.warp(1_100);
        _expectIneligible(CLINICIAN_B, role);
        _request(scope, 60);
    }

    function testRequestRequiresEligiblePatientNotJustAddress() public {
        bytes32[] memory scope = _scope(1);
        address[3] memory invalid = [address(0), OUTSIDER, CLINICIAN_A];
        bytes32 role = registry.PATIENT_ROLE();
        for (uint256 i; i < invalid.length; ++i) {
            _expectIneligible(invalid[i], role);
            vm.prank(CLINICIAN_B);
            controller.requestEmergency(invalid[i], scope, ENCOUNTER, 1, EVIDENCE, 60);
        }
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        _expectIneligible(PATIENT, role);
        _request(scope, 60);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, true);
        registry.revokeRole(role, PATIENT);
        _expectIneligible(PATIENT, role);
        _request(scope, 60);
        registry.grantRole(role, PATIENT);
        registry.updateParticipant(PATIENT, bytes32(0), 1_100, true);
        vm.warp(1_100);
        _expectIneligible(PATIENT, role);
        _request(scope, 60);
    }

    function testRejectsEmptyAndOversizedScope() public {
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRecordCount.selector, uint256(0)));
        _request(new bytes32[](0), 60);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRecordCount.selector, uint256(21)));
        _request(new bytes32[](21), 60);
        require(!controller.getRequest(1).exists);
    }

    function testTwentySortedRecordsAcrossFacilitiesAreAccepted() public {
        bytes32[] memory scope = _scope(20);
        uint256 id = _request(scope, 900);
        bytes32[] memory stored = controller.getRequestRecords(id);
        require(stored.length == 20 && keccak256(abi.encode(stored)) == keccak256(abi.encode(scope)));
        require(controller.getRequest(id).requestedDuration == 900);
    }

    function testRejectsZeroDuplicateAndDescendingIdsWithoutSilentSorting() public {
        bytes32[] memory scope = new bytes32[](1);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRecordId.selector));
        _request(scope, 60);
        scope = _scope(2);
        scope[1] = scope[0];
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRecordOrder.selector, RECORD, RECORD));
        _request(scope, 60);
        scope[0] = bytes32(uint256(11));
        scope[1] = RECORD;
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRecordOrder.selector, scope[0], scope[1]));
        _request(scope, 60);
        require(!controller.getRequest(1).exists);
    }

    function testRejectsUnknownInactiveWrongPatientAndShutdownRecords() public {
        bytes32[] memory scope = _scope(1);
        scope[0] = bytes32(uint256(99));
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordNotFound.selector, scope[0]));
        _request(scope, 60);
        scope[0] = RECORD;
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordPatientMismatch.selector, RECORD, OTHER_PATIENT, PATIENT));
        vm.prank(CLINICIAN_B);
        controller.requestEmergency(OTHER_PATIENT, scope, ENCOUNTER, 1, EVIDENCE, 60);
        registry.setFacilityActive(FACILITY_A, false);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InactiveFacility.selector, FACILITY_A));
        _request(scope, 60);
        registry.setFacilityActive(FACILITY_A, true);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordInactive.selector, RECORD));
        _request(scope, 60);
    }

    function testLaterInvalidRecordLeavesNoPartialScopeAndDoesNotConsumeId() public {
        bytes32[] memory scope = new bytes32[](2);
        scope[0] = RECORD;
        scope[1] = bytes32(uint256(99));
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordNotFound.selector, scope[1]));
        _request(scope, 60);
        require(!controller.getRequest(1).exists);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestNotFound.selector, uint256(1)));
        controller.getRequestRecords(1);
        uint256 id = _request(_scope(1), 60);
        require(id == 1 && controller.getRequestRecords(id).length == 1);
    }

    function testRejectsMissingEncounterReasonAndEvidence() public {
        bytes32[] memory scope = _scope(1);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidEncounterId.selector));
        vm.prank(CLINICIAN_B);
        controller.requestEmergency(PATIENT, scope, bytes32(0), 1, EVIDENCE, 60);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidReasonCode.selector));
        vm.prank(CLINICIAN_B);
        controller.requestEmergency(PATIENT, scope, ENCOUNTER, 0, EVIDENCE, 60);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidEvidenceCommitment.selector));
        vm.prank(CLINICIAN_B);
        controller.requestEmergency(PATIENT, scope, ENCOUNTER, 1, bytes32(0), 60);
    }

    function testDurationBoundariesAndRepeatedRequestsUseDistinctIds() public {
        bytes32[] memory scope = _scope(1);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidEmergencyDuration.selector, uint64(0)));
        _request(scope, 0);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidEmergencyDuration.selector, uint64(901)));
        _request(scope, 901);
        require(_request(scope, 1) == 1);
        require(_request(scope, 900) == 2);
        uint256 third = _request(scope, 900);
        require(third == 3 && controller.getRequest(third).requestHash != controller.getRequest(2).requestHash);
    }

    function testUnknownRequestStatusAndScopeRevertButMetadataShowsAbsence() public {
        require(!controller.getRequest(0).exists && !controller.getRequest(1).exists);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestNotFound.selector, uint256(0)));
        controller.getEffectiveStatus(0);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RequestNotFound.selector, uint256(1)));
        controller.getRequestRecords(1);
    }

    function testPendingRequestNeverAuthorizesEmergencyReadsOrChangesConsent() public {
        uint256 consentId = _grantConsent();
        uint256 id = _request(_scope(1), 60);
        require(controller.canRead(CLINICIAN_B, RECORD, 0, consentId));
        require(!controller.canRead(CLINICIAN_B, RECORD, 1, id));
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.ReadAccessDenied.selector));
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 1, id, keccak256("pending-read"));
        vm.warp(1_120);
        require(!controller.canRead(CLINICIAN_B, RECORD, 1, id));
        require(controller.canRead(CLINICIAN_B, RECORD, 0, consentId));
    }

    function testScopeAndHashStayFixedAfterCredentialChangesAndExpiry() public {
        uint256 id = _request(_scope(1), 60);
        bytes32 hash = controller.getRequest(id).requestHash;
        registry.updateParticipant(CLINICIAN_B, FACILITY_A, CREDENTIAL_EXPIRY, true);
        registry.setFacilityActive(FACILITY_B, false);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        vm.warp(1_121);
        require(controller.getRequest(id).requesterFacilityId == FACILITY_B);
        require(controller.getRequest(id).requestHash == hash && controller.getRequestRecords(id)[0] == RECORD);
        require(controller.getEffectiveStatus(id) == MedicalAccessController.EffectiveStatus.EXPIRED);
        require(controller.getRequest(id).status == MedicalAccessController.RequestStatus.PENDING);
    }

    function testDeadlineUint64OverflowIsRejectedWithoutWrapping() public {
        registry.updateParticipant(PATIENT, bytes32(0), type(uint64).max, true);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, type(uint64).max, true);
        vm.warp(uint256(type(uint64).max) - 119);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRequestTimestamp.selector));
        _request(_scope(1), 60);
        require(!controller.getRequest(1).exists);
    }

    function testFuzzPendingExpiryBoundary(uint32 elapsed) public {
        uint256 id = _request(_scope(1), 60);
        vm.warp(1_119);
        require(controller.getEffectiveStatus(id) == MedicalAccessController.EffectiveStatus.PENDING);
        vm.warp(1_120);
        require(controller.getEffectiveStatus(id) == MedicalAccessController.EffectiveStatus.EXPIRED);
        vm.warp(1_000 + uint256(elapsed));
        MedicalAccessController.EffectiveStatus expected = elapsed < 120
            ? MedicalAccessController.EffectiveStatus.PENDING : MedicalAccessController.EffectiveStatus.EXPIRED;
        require(controller.getEffectiveStatus(id) == expected);
        require(controller.getRequest(id).status == MedicalAccessController.RequestStatus.PENDING);
    }

    function testFixedSingleAndTwentyRecordHashVectors() public pure {
        MedicalAccessController.EmergencyRequestBinding memory binding;
        binding.chainId = 1337;
        binding.controller = address(0x1111111111111111111111111111111111111111);
        binding.requestId = 1;
        binding.patient = address(0x2222222222222222222222222222222222222222);
        binding.clinician = address(0x3333333333333333333333333333333333333333);
        binding.requesterFacilityId = bytes32(uint256(0x4444444444444444444444444444444444444444444444444444444444444444));
        binding.encounterId = bytes32(uint256(0x5555555555555555555555555555555555555555555555555555555555555555));
        binding.recordIds = new bytes32[](1);
        binding.recordIds[0] = RECORD;
        binding.reasonCode = 7;
        binding.evidenceCommitment = bytes32(uint256(0x6666666666666666666666666666666666666666666666666666666666666666));
        binding.requestedDuration = 900;
        binding.decisionDeadline = 1_120;
        require(keccak256(abi.encode(binding)) == 0xbe75b384e22e59d38aea2d92d001f77e6543045d2d21fa53c701828595aa8652);
        binding.recordIds = new bytes32[](20);
        for (uint256 i; i < 20; ++i) binding.recordIds[i] = bytes32(uint256(10 + i));
        require(keccak256(abi.encode(binding)) == 0x7b5057334a9afe14d62740bb842110d11c6ad6295c295b51b88577a654024239);
    }

    function _scope(uint256 count) private returns (bytes32[] memory scope) {
        scope = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            scope[i] = bytes32(uint256(10 + i));
            if (i > 0) {
                vm.prank(i % 2 == 0 ? GATEWAY_A : GATEWAY_B);
                controller.registerRecord(scope[i], PATIENT, CIPHERTEXT_HASH, 1);
            }
        }
    }

    function _request(bytes32[] memory scope, uint64 duration) private returns (uint256) {
        vm.prank(CLINICIAN_B);
        return controller.requestEmergency(PATIENT, scope, ENCOUNTER, 1, EVIDENCE, duration);
    }

    function _expectedHash(uint256 id, bytes32[] memory scope) private view returns (bytes32) {
        MedicalAccessController.EmergencyRequestBinding memory binding;
        binding.chainId = block.chainid;
        binding.controller = address(controller);
        binding.requestId = id;
        binding.patient = PATIENT;
        binding.clinician = CLINICIAN_B;
        binding.requesterFacilityId = FACILITY_B;
        binding.encounterId = ENCOUNTER;
        binding.recordIds = scope;
        binding.reasonCode = 1;
        binding.evidenceCommitment = EVIDENCE;
        binding.requestedDuration = 60;
        binding.decisionDeadline = uint64(block.timestamp) + 120;
        return keccak256(abi.encode(binding));
    }
}
