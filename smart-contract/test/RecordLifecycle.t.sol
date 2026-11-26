// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MedicalAccessController} from "../contracts/MedicalAccessController.sol";
import {ControllerFixture} from "./ControllerFixture.sol";

contract RecordLifecycleTest is ControllerFixture {
    function testRegistersMetadataAndEmitsIssuingFacility() public {
        vm.expectEmit(true, true, true, true, address(controller));
        emit RecordRegistered(RECORD, PATIENT, FACILITY_A, CIPHERTEXT_HASH);
        _registerRecord();
        MedicalAccessController.MedicalRecord memory record = controller.getRecord(RECORD);
        require(record.exists && record.active);
        require(record.patient == PATIENT && record.facilityId == FACILITY_A);
        require(record.ciphertextHash == CIPHERTEXT_HASH && record.categoryCode == 1);
    }

    function testDerivesFacilityForEachGatewayAndRetainsCategory() public {
        vm.prank(GATEWAY_B);
        controller.registerRecord(RECORD, OTHER_PATIENT, CIPHERTEXT_HASH, type(uint16).max);
        MedicalAccessController.MedicalRecord memory record = controller.getRecord(RECORD);
        require(record.patient == OTHER_PATIENT && record.facilityId == FACILITY_B);
        require(record.categoryCode == type(uint16).max);
    }

    function testAllNonGatewayRolesCannotMutateRecords() public {
        _registerRecord();
        address[7] memory callers = [address(this), PATIENT, CLINICIAN_A, ORACLE_A, AUDITOR, OUTSIDER, address(0)];
        bytes32 gatewayRole = registry.GATEWAY_ROLE();
        for (uint256 i; i < callers.length; ++i) {
            _expectIneligible(callers[i], gatewayRole);
            vm.prank(callers[i]);
            controller.registerRecord(bytes32(uint256(11)), PATIENT, CIPHERTEXT_HASH, 1);
            _expectIneligible(callers[i], gatewayRole);
            vm.prank(callers[i]);
            controller.deactivateRecord(RECORD);
        }
        require(controller.getRecord(RECORD).active);
        require(!controller.getRecord(bytes32(uint256(11))).exists);
    }

    function testRejectsZeroRecordAndCiphertextHashWithoutWritingMetadata() public {
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRecordId.selector));
        vm.prank(GATEWAY_A);
        controller.registerRecord(bytes32(0), PATIENT, CIPHERTEXT_HASH, 1);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidCiphertextHash.selector));
        vm.prank(GATEWAY_A);
        controller.registerRecord(RECORD, PATIENT, bytes32(0), 1);
        require(!controller.getRecord(bytes32(0)).exists && !controller.getRecord(RECORD).exists);
    }

    function testRejectsDuplicateAcrossFacilitiesAndAfterDeactivation() public {
        _registerRecord();
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordAlreadyExists.selector, RECORD));
        vm.prank(GATEWAY_B);
        controller.registerRecord(RECORD, OTHER_PATIENT, keccak256("replacement"), 2);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordAlreadyExists.selector, RECORD));
        vm.prank(GATEWAY_A);
        controller.registerRecord(RECORD, OTHER_PATIENT, keccak256("replacement"), 2);
        MedicalAccessController.MedicalRecord memory record = controller.getRecord(RECORD);
        require(record.patient == PATIENT && record.facilityId == FACILITY_A && !record.active);
        require(record.ciphertextHash == CIPHERTEXT_HASH && record.categoryCode == 1);
    }

    function testRejectsUnregisteredZeroAndWrongRolePatients() public {
        address[4] memory invalidPatients = [OUTSIDER, address(0), CLINICIAN_A, address(this)];
        bytes32 patientRole = registry.PATIENT_ROLE();
        for (uint256 i; i < invalidPatients.length; ++i) {
            _expectIneligible(invalidPatients[i], patientRole);
            vm.prank(GATEWAY_A);
            controller.registerRecord(RECORD, invalidPatients[i], CIPHERTEXT_HASH, 1);
        }
        require(!controller.getRecord(RECORD).exists);
    }

    function testRejectsInactiveRevokedAndExpiredPatientCredentials() public {
        bytes32 patientRole = registry.PATIENT_ROLE();
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        _expectIneligible(PATIENT, patientRole);
        vm.prank(GATEWAY_A);
        controller.registerRecord(RECORD, PATIENT, CIPHERTEXT_HASH, 1);
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, true);
        registry.revokeRole(patientRole, PATIENT);
        _expectIneligible(PATIENT, patientRole);
        vm.prank(GATEWAY_A);
        controller.registerRecord(RECORD, PATIENT, CIPHERTEXT_HASH, 1);
        registry.grantRole(patientRole, PATIENT);
        registry.updateParticipant(PATIENT, bytes32(0), 1_100, true);
        vm.warp(1_100);
        _expectIneligible(PATIENT, patientRole);
        vm.prank(GATEWAY_A);
        controller.registerRecord(RECORD, PATIENT, CIPHERTEXT_HASH, 1);
        require(!controller.getRecord(RECORD).exists);
    }

    function testInactiveRevokedAndExpiredGatewayCannotMutate() public {
        _registerRecord();
        registry.updateParticipant(GATEWAY_A, FACILITY_A, CREDENTIAL_EXPIRY, false);
        _assertGatewayDenied();
        registry.updateParticipant(GATEWAY_A, FACILITY_A, CREDENTIAL_EXPIRY, true);
        registry.revokeRole(registry.GATEWAY_ROLE(), GATEWAY_A);
        _assertGatewayDenied();
        registry.grantRole(registry.GATEWAY_ROLE(), GATEWAY_A);
        registry.updateParticipant(GATEWAY_A, FACILITY_A, 1_100, true);
        vm.warp(1_100);
        _assertGatewayDenied();
        vm.warp(1_101);
        _assertGatewayDenied();
        require(controller.getRecord(RECORD).active);
    }

    function testInactiveFacilityBlocksRegistrationAndDeactivation() public {
        _registerRecord();
        registry.setFacilityActive(FACILITY_A, false);
        _assertGatewayDenied();
        registry.setFacilityActive(FACILITY_A, true);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        require(!controller.getRecord(RECORD).active);
    }

    function testDeactivationPreservesMetadataAndEmitsEvent() public {
        _registerRecord();
        MedicalAccessController.MedicalRecord memory beforeRecord = controller.getRecord(RECORD);
        vm.expectEmit(true, true, true, true, address(controller));
        emit RecordDeactivated(RECORD, PATIENT, FACILITY_A);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        MedicalAccessController.MedicalRecord memory afterRecord = controller.getRecord(RECORD);
        require(afterRecord.exists && !afterRecord.active);
        require(afterRecord.patient == beforeRecord.patient && afterRecord.facilityId == beforeRecord.facilityId);
        require(afterRecord.ciphertextHash == beforeRecord.ciphertextHash && afterRecord.categoryCode == beforeRecord.categoryCode);
    }

    function testWrongFacilityAndReaffiliatedGatewayCannotDeactivate() public {
        _registerRecord();
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.WrongFacility.selector, FACILITY_A, FACILITY_B));
        vm.prank(GATEWAY_B);
        controller.deactivateRecord(RECORD);
        registry.updateParticipant(GATEWAY_A, FACILITY_B, CREDENTIAL_EXPIRY, true);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.WrongFacility.selector, FACILITY_A, FACILITY_B));
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        require(controller.getRecord(RECORD).active && controller.getRecord(RECORD).facilityId == FACILITY_A);
    }

    function testAnotherEligibleGatewayOfIssuerCanDeactivate() public {
        _registerRecord();
        registry.registerParticipant(OUTSIDER, registry.GATEWAY_ROLE(), FACILITY_A, CREDENTIAL_EXPIRY);
        vm.prank(OUTSIDER);
        controller.deactivateRecord(RECORD);
        require(!controller.getRecord(RECORD).active);
    }

    function testRejectsUnknownAndAlreadyInactiveRecords() public {
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordNotFound.selector, RECORD));
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        _registerRecord();
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.RecordInactive.selector, RECORD));
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
    }

    function testPatientDeactivationDoesNotBlockRecordCleanup() public {
        _registerRecord();
        registry.updateParticipant(PATIENT, bytes32(0), CREDENTIAL_EXPIRY, false);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        require(!controller.getRecord(RECORD).active);
    }

    function testFuzzGatewayCredentialExpiryBoundary(uint32 lifetime) public {
        uint64 expiry = 1_000 + uint64(lifetime) + 1;
        registry.updateParticipant(GATEWAY_A, FACILITY_A, expiry, true);
        // Keep the patient eligible throughout this gateway-specific boundary test.
        registry.updateParticipant(PATIENT, bytes32(0), type(uint64).max, true);
        vm.warp(expiry - 1);
        _registerRecord();
        vm.warp(expiry);
        _assertGatewayDenied();
        registry.updateParticipant(GATEWAY_A, FACILITY_A, expiry + 1, true);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        require(!controller.getRecord(RECORD).active);
    }

    function _assertGatewayDenied() private {
        bytes32 gatewayRole = registry.GATEWAY_ROLE();
        _expectIneligible(GATEWAY_A, gatewayRole);
        vm.prank(GATEWAY_A);
        controller.registerRecord(bytes32(uint256(11)), PATIENT, CIPHERTEXT_HASH, 1);
        _expectIneligible(GATEWAY_A, gatewayRole);
        vm.prank(GATEWAY_A);
        controller.deactivateRecord(RECORD);
        require(!controller.getRecord(bytes32(uint256(11))).exists);
    }
}
