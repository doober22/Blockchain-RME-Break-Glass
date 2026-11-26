// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MedicalAccessController} from "../contracts/MedicalAccessController.sol";
import {ControllerFixture} from "./ControllerFixture.sol";

contract NormalConsentTest is ControllerFixture {
    bytes32 private constant ACCESS_ID = keccak256("synthetic-access-1");

    function setUp() public override {
        super.setUp();
        _registerRecord();
    }

    function testGrantStoresScopeAndEmitsConsentForCrossFacilityDoctor() public {
        vm.expectEmit(true, true, true, true, address(controller));
        emit ConsentGranted(1, PATIENT, CLINICIAN_B, RECORD, 2_000);
        uint256 id = _grantConsent();
        MedicalAccessController.Consent memory consent = controller.getConsent(id);
        require(id == 1 && consent.exists && !consent.revoked);
        require(consent.patient == PATIENT && consent.clinician == CLINICIAN_B && consent.recordId == RECORD);
        require(consent.createdAt == 1_000 && consent.expiresAt == 2_000);
        require(controller.canRead(CLINICIAN_B, RECORD, 0, id));
    }

    function testOnlyRecordOwnerCanGrantNotAdminOrServiceRoles() public {
        address[7] memory callers = [address(this), OTHER_PATIENT, CLINICIAN_A, GATEWAY_A, ORACLE_A, AUDITOR, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.NotRecordOwner.selector, RECORD, callers[i]));
            vm.prank(callers[i]);
            controller.grantConsent(CLINICIAN_B, RECORD, 2_000);
        }
        require(!controller.getConsent(1).exists);
        require(_grantConsent() == 1);
    }

    function testGrantRejectsUnknownInactiveRecordAndInactiveIssuer() public {
        bytes32 missing = bytes32(uint256(99));
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordNotFound.selector, missing));
        vm.prank(PATIENT);
        controller.grantConsent(CLINICIAN_B, missing, 2_000);
        registry.setFacilityActive(FACILITY_A, false);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InactiveFacility.selector, FACILITY_A));
        vm.prank(PATIENT);
        controller.grantConsent(CLINICIAN_B, RECORD, 2_000);
        registry.setFacilityActive(FACILITY_A, true);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordInactive.selector, RECORD));
        vm.prank(PATIENT);
        controller.grantConsent(CLINICIAN_B, RECORD, 2_000);
    }

    function testGrantRejectsExpiryNowAndInPastWithoutConsumingIds() public {
        uint64[3] memory invalid = [uint64(0), uint64(999), uint64(1_000)];
        for (uint256 i; i < invalid.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidConsentExpiry.selector, invalid[i]));
            vm.prank(PATIENT);
            controller.grantConsent(CLINICIAN_B, RECORD, invalid[i]);
        }
        require(_grantConsent() == 1);
    }

    function testGrantRejectsMissingAndWrongRoleClinicians() public {
        address[6] memory invalid = [address(0), OUTSIDER, address(this), PATIENT, ORACLE_A, GATEWAY_A];
        bytes32 role = registry.CLINICIAN_ROLE();
        for (uint256 i; i < invalid.length; ++i) {
            _expectIneligible(invalid[i], role);
            vm.prank(PATIENT);
            controller.grantConsent(invalid[i], RECORD, 2_000);
        }
    }

    function testGrantRejectsInactiveRevokedAndExpiredPatient() public {
        bytes32 role = registry.PATIENT_ROLE();
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        _expectIneligible(PATIENT, role);
        vm.prank(PATIENT);
        controller.grantConsent(CLINICIAN_B, RECORD, 2_000);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, true);
        registry.revokeRole(role, PATIENT);
        _expectIneligible(PATIENT, role);
        vm.prank(PATIENT);
        controller.grantConsent(CLINICIAN_B, RECORD, 2_000);
        registry.grantRole(role, PATIENT);
        registry.updateParticipant(PATIENT, bytes32(0), 1_100, true);
        vm.warp(1_100);
        _expectIneligible(PATIENT, role);
        vm.prank(PATIENT);
        controller.grantConsent(CLINICIAN_B, RECORD, 2_000);
    }

    function testGrantRejectsInactiveRevokedExpiredOrUnbackedClinician() public {
        bytes32 role = registry.CLINICIAN_ROLE();
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, false);
        _expectClinicianGrantDenied(role);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, true);
        registry.revokeRole(role, CLINICIAN_B);
        _expectClinicianGrantDenied(role);
        registry.grantRole(role, CLINICIAN_B);
        registry.setFacilityActive(FACILITY_B, false);
        _expectClinicianGrantDenied(role);
        registry.setFacilityActive(FACILITY_B, true);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, 1_100, true);
        vm.warp(1_100);
        _expectClinicianGrantDenied(role);
    }

    function testCanReadFailsClosedForWrongIdentityScopeModeAndUnknownGrant() public {
        uint256 id = _grantConsent();
        address[6] memory wrongReaders = [CLINICIAN_A, PATIENT, address(this), GATEWAY_A, ORACLE_A, AUDITOR];
        for (uint256 i; i < wrongReaders.length; ++i) {
            require(!controller.canRead(wrongReaders[i], RECORD, 0, id));
        }
        require(!controller.canRead(CLINICIAN_B, bytes32(0), 0, id));
        require(!controller.canRead(CLINICIAN_B, RECORD, 0, 0));
        require(!controller.canRead(CLINICIAN_B, RECORD, 0, id + 1));
        _assertDenied(CLINICIAN_A, RECORD, 0, id);
        _assertDenied(CLINICIAN_B, RECORD, 0, id + 1);
        _assertDenied(CLINICIAN_B, RECORD, 1, id);
        _assertDenied(CLINICIAN_B, RECORD, type(uint8).max, id);
    }

    function testConsentCannotAuthorizeAnotherExistingRecordOrPatient() public {
        uint256 id = _grantConsent();
        bytes32 second = bytes32(uint256(11));
        bytes32 third = bytes32(uint256(12));
        vm.prank(GATEWAY_A);
        controller.registerRecord(second, PATIENT, CIPHERTEXT_HASH, 1);
        vm.prank(GATEWAY_A);
        controller.registerRecord(third, OTHER_PATIENT, CIPHERTEXT_HASH, 1);
        _assertDenied(CLINICIAN_B, second, 0, id);
        _assertDenied(CLINICIAN_B, third, 0, id);
    }

    function testOnlyIssuingGatewayCanAuthorizeDespitePublicReadQuery() public {
        uint256 id = _grantConsent();
        address[6] memory callers = [address(this), PATIENT, CLINICIAN_B, ORACLE_A, AUDITOR, OUTSIDER];
        bytes32 gatewayRole = registry.GATEWAY_ROLE();
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            require(controller.canRead(CLINICIAN_B, RECORD, 0, id));
            _expectIneligible(callers[i], gatewayRole);
            vm.prank(callers[i]);
            controller.authorizeAccess(CLINICIAN_B, RECORD, 0, id, ACCESS_ID);
        }
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.WrongFacility.selector, FACILITY_A, FACILITY_B));
        vm.prank(GATEWAY_B);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 0, id, ACCESS_ID);
        _authorize(id, ACCESS_ID);
    }

    function testAuthorizationEmitsCompleteAuditPayloadAndAllowsDistinctReads() public {
        uint256 id = _grantConsent();
        vm.expectEmit(true, true, true, true, address(controller));
        emit AccessAuthorized(ACCESS_ID, RECORD, PATIENT, CLINICIAN_B, GATEWAY_A, 0, id, 1_000);
        _authorize(id, ACCESS_ID);
        _authorize(id, keccak256("second-read"));
        require(controller.canRead(CLINICIAN_B, RECORD, 0, id));
    }

    function testZeroAndReplayedAccessIdsAreRejectedGlobally() public {
        uint256 id = _grantConsent();
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidAccessId.selector));
        _authorize(id, bytes32(0));
        _authorize(id, ACCESS_ID);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.AccessIdAlreadyUsed.selector, ACCESS_ID));
        _authorize(id, ACCESS_ID);
        bytes32 second = bytes32(uint256(11));
        vm.prank(GATEWAY_B);
        controller.registerRecord(second, PATIENT, CIPHERTEXT_HASH, 1);
        vm.prank(PATIENT);
        uint256 otherId = controller.grantConsent(CLINICIAN_A, second, 2_000);
        require(controller.canRead(CLINICIAN_A, second, 0, otherId));
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.AccessIdAlreadyUsed.selector, ACCESS_ID));
        vm.prank(GATEWAY_B);
        controller.authorizeAccess(CLINICIAN_A, second, 0, otherId, ACCESS_ID);
    }

    function testDeniedAuthorizationDoesNotConsumeAccessId() public {
        uint256 id = _grantConsent();
        _assertDenied(CLINICIAN_A, RECORD, 0, id);
        _assertDenied(CLINICIAN_B, RECORD, 1, id);
        _authorize(id, ACCESS_ID);
    }

    function testRevocationEmitsEventPreservesMetadataAndDeniesFutureAccess() public {
        uint256 id = _grantConsent();
        _authorize(id, keccak256("before-revoke"));
        vm.expectEmit(true, true, true, true, address(controller));
        emit ConsentRevoked(id, PATIENT, CLINICIAN_B, RECORD);
        vm.prank(PATIENT);
        controller.revokeConsent(id);
        MedicalAccessController.Consent memory consent = controller.getConsent(id);
        require(consent.exists && consent.revoked && consent.createdAt == 1_000 && consent.expiresAt == 2_000);
        require(consent.patient == PATIENT && consent.clinician == CLINICIAN_B && consent.recordId == RECORD);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
        require(controller.getRecord(RECORD).active);
    }

    function testOnlyOriginalPatientMayRevokeAndCannotRevokeTwice() public {
        uint256 id = _grantConsent();
        address[7] memory callers = [address(this), OTHER_PATIENT, CLINICIAN_B, GATEWAY_A, ORACLE_A, AUDITOR, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.NotConsentOwner.selector, id, callers[i]));
            vm.prank(callers[i]);
            controller.revokeConsent(id);
        }
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.ConsentNotFound.selector, id + 1));
        vm.prank(PATIENT);
        controller.revokeConsent(id + 1);
        vm.prank(PATIENT);
        controller.revokeConsent(id);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.ConsentAlreadyRevoked.selector, id));
        vm.prank(PATIENT);
        controller.revokeConsent(id);
    }

    function testPatientCanRevokeAfterAllCredentialsAndRecordBecomeInactive() public {
        uint256 id = _grantConsent();
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        registry.revokeRole(registry.PATIENT_ROLE(), PATIENT);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        registry.setFacilityActive(FACILITY_A, false);
        vm.warp(CREDENTIAL_EXPIRY + 1);
        vm.prank(PATIENT);
        controller.revokeConsent(id);
        require(controller.getConsent(id).revoked);
    }

    function testNewConsentNeverReactivatesRevokedConsentOrOtherGrant() public {
        uint256 first = _grantConsent();
        uint256 second = _grantConsent();
        require(second == first + 1);
        vm.prank(PATIENT);
        controller.revokeConsent(first);
        _assertDenied(CLINICIAN_B, RECORD, 0, first);
        require(controller.canRead(CLINICIAN_B, RECORD, 0, second));
        vm.prank(PATIENT);
        controller.revokeConsent(second);
        uint256 third = _grantConsent();
        require(third == second + 1 && controller.getConsent(first).revoked && controller.getConsent(second).revoked);
        _authorize(third, ACCESS_ID);
    }

    function testExistingConsentChecksCurrentPatientStatusAndRole() public {
        uint256 id = _grantConsent();
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, true);
        registry.revokeRole(registry.PATIENT_ROLE(), PATIENT);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
        registry.grantRole(registry.PATIENT_ROLE(), PATIENT);
        require(controller.canRead(CLINICIAN_B, RECORD, 0, id));
        registry.updateParticipant(PATIENT, bytes32(0), 1_100, true);
        vm.warp(1_100);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
    }

    function testExistingConsentChecksCurrentClinicianStatusRoleAndFacility() public {
        uint256 id = _grantConsent();
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, false);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, CREDENTIAL_EXPIRY, true);
        registry.revokeRole(registry.CLINICIAN_ROLE(), CLINICIAN_B);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
        registry.grantRole(registry.CLINICIAN_ROLE(), CLINICIAN_B);
        registry.setFacilityActive(FACILITY_B, false);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
        registry.setFacilityActive(FACILITY_B, true);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, 1_100, true);
        vm.warp(1_100);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
    }

    function testRecordDeactivationAndIssuerShutdownDenyExistingConsent() public {
        uint256 id = _grantConsent();
        registry.setFacilityActive(FACILITY_A, false);
        require(!controller.canRead(CLINICIAN_B, RECORD, 0, id));
        _expectIneligible(GATEWAY_A, registry.GATEWAY_ROLE());
        _authorize(id, ACCESS_ID);
        registry.setFacilityActive(FACILITY_A, true);
        require(controller.canRead(CLINICIAN_B, RECORD, 0, id));
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
    }

    function testInactiveRevokedExpiredAndReaffiliatedGatewayCannotAuthorize() public {
        uint256 id = _grantConsent();
        bytes32 role = registry.GATEWAY_ROLE();
        registry.updateParticipant(GATEWAY_A, FACILITY_A, CREDENTIAL_EXPIRY, false);
        _expectIneligible(GATEWAY_A, role);
        _authorize(id, ACCESS_ID);
        registry.updateParticipant(GATEWAY_A, FACILITY_A, CREDENTIAL_EXPIRY, true);
        registry.revokeRole(role, GATEWAY_A);
        _expectIneligible(GATEWAY_A, role);
        _authorize(id, ACCESS_ID);
        registry.grantRole(role, GATEWAY_A);
        registry.updateParticipant(GATEWAY_A, FACILITY_B, CREDENTIAL_EXPIRY, true);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.WrongFacility.selector, FACILITY_A, FACILITY_B));
        _authorize(id, ACCESS_ID);
        registry.updateParticipant(GATEWAY_A, FACILITY_A, 1_100, true);
        vm.warp(1_100);
        _expectIneligible(GATEWAY_A, role);
        _authorize(id, ACCESS_ID);
        // A consent query checks grant eligibility; caller/gateway eligibility is a separate transaction check.
        require(controller.canRead(CLINICIAN_B, RECORD, 0, id));
        registry.updateParticipant(GATEWAY_A, FACILITY_A, CREDENTIAL_EXPIRY, true);
        _authorize(id, ACCESS_ID);
    }

    function testUnknownRecordAuthorizationRejectsWithoutConsumingAccessId() public {
        uint256 id = _grantConsent();
        bytes32 missing = bytes32(uint256(99));
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordNotFound.selector, missing));
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(CLINICIAN_B, missing, 0, id, ACCESS_ID);
        _authorize(id, ACCESS_ID);
    }

    function testFuzzConsentExpiryQueryAndAuthorizationAgree(uint32 lifetime) public {
        uint64 expiry = 1_000 + uint64(lifetime) + 1;
        registry.updateParticipant(PATIENT, bytes32(0), type(uint64).max, true);
        registry.updateParticipant(CLINICIAN_B, FACILITY_B, type(uint64).max, true);
        registry.updateParticipant(GATEWAY_A, FACILITY_A, type(uint64).max, true);
        vm.prank(PATIENT);
        uint256 id = controller.grantConsent(CLINICIAN_B, RECORD, expiry);
        vm.warp(expiry - 1);
        require(controller.canRead(CLINICIAN_B, RECORD, 0, id));
        _authorize(id, keccak256("before-expiry"));
        vm.warp(expiry);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
        vm.warp(expiry + 1);
        _assertDenied(CLINICIAN_B, RECORD, 0, id);
    }

    function _expectClinicianGrantDenied(bytes32 role) private {
        _expectIneligible(CLINICIAN_B, role);
        vm.prank(PATIENT);
        controller.grantConsent(CLINICIAN_B, RECORD, 2_000);
    }

    function _authorize(uint256 id, bytes32 accessId) private {
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 0, id, accessId);
    }

    function _assertDenied(address clinician, bytes32 recordId, uint8 mode, uint256 id) private {
        require(!controller.canRead(clinician, recordId, mode, id), "query allowed denied access");
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.ReadAccessDenied.selector));
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(clinician, recordId, mode, id, ACCESS_ID);
    }
}
