// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MedicalAccessController as Controller} from "../contracts/MedicalAccessController.sol";
import {ControllerFixture} from "./ControllerFixture.sol";

contract EmergencyReviewTest is ControllerFixture {
    bytes32 private constant REPORT = keccak256("synthetic-review");
    uint16 private constant MISUSE = type(uint16).max;

    event EmergencyClosed(uint256 indexed requestId, address indexed actor, uint16 closureCode, uint64 timestamp);
    event EmergencyReviewed(
        uint256 indexed requestId, address indexed auditor, Controller.ReviewVerdict verdict,
        bytes32 reportCommitment, uint64 timestamp
    );

    function setUp() public override {
        super.setUp();
        _registerRecord();
    }

    function testPatientClosureDeniesAuthorizationAndPreservesConsentAndGrantHistory() public {
        uint256 consent = _grantConsent();
        uint256 id = _activated();
        Controller.EmergencyRequest memory beforeClose = controller.getRequest(id);
        require(controller.canRead(CLINICIAN_B, RECORD, 1, id));
        vm.expectEmit(true, true, false, true, address(controller));
        emit EmergencyClosed(id, PATIENT, 7, 1_000);
        vm.prank(PATIENT);
        controller.closeEmergency(id, 7);
        beforeClose.status = Controller.RequestStatus.CLOSED;
        require(keccak256(abi.encode(beforeClose)) == keccak256(abi.encode(controller.getRequest(id))));
        require(controller.getRequestRecords(id)[0] == RECORD);
        _assertEmergencyDenied(id);
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 0, consent, REPORT);
        vm.expectRevert(abi.encodeWithSelector(Controller.RequestNotPending.selector, id));
        vm.prank(ORACLE_B);
        controller.resolveEmergency(id, true, beforeClose.requestHash, 1_000, 1_060);
    }

    function testOriginalPatientAndClinicianCanCloseAfterRoleRemovalAndExpiry() public {
        uint256 patientGrant = _activated();
        uint256 clinicianGrant = _activated();
        registry.revokeRole(registry.PATIENT_ROLE(), PATIENT);
        registry.revokeRole(registry.CLINICIAN_ROLE(), CLINICIAN_B);
        vm.warp(CREDENTIAL_EXPIRY);
        vm.prank(PATIENT);
        controller.closeEmergency(patientGrant, 1);
        vm.prank(CLINICIAN_B);
        controller.closeEmergency(clinicianGrant, 2);
        require(controller.getEffectiveStatus(patientGrant) == Controller.EffectiveStatus.CLOSED);
        require(controller.getEffectiveStatus(clinicianGrant) == Controller.EffectiveStatus.CLOSED);
    }

    function testOnlyAuthorizedActorsCanCloseAndMisuseCodeIsReserved() public {
        uint256 id = _activated();
        bytes32 auditorRole = registry.AUDITOR_ROLE();
        address[6] memory denied = [address(this), OUTSIDER, OTHER_PATIENT, CLINICIAN_A, GATEWAY_A, ORACLE_B];
        for (uint256 i; i < denied.length; ++i) {
            _expectIneligible(denied[i], auditorRole);
            vm.prank(denied[i]);
            controller.closeEmergency(id, 1);
        }
        vm.expectRevert(abi.encodeWithSelector(Controller.ReservedClosureCode.selector));
        vm.prank(PATIENT);
        controller.closeEmergency(id, MISUSE);
        registry.updateParticipant(AUDITOR, bytes32(0), 1_010, true);
        vm.warp(1_010);
        _expectIneligible(AUDITOR, auditorRole);
        vm.prank(AUDITOR);
        controller.closeEmergency(id, 1);
        registry.updateParticipant(AUDITOR, bytes32(0), CREDENTIAL_EXPIRY, true);
        vm.prank(AUDITOR);
        controller.closeEmergency(id, 1);
        _assertEmergencyDenied(id);
        _expectCloseDenied(id);
    }

    function testPendingAndRejectedCannotCloseOrBeReviewed() public {
        uint256 pending = _request();
        uint256 rejected = _request();
        _resolve(rejected, false);
        for (uint256 id = pending; id <= rejected; ++id) {
            _expectCloseDenied(id);
            vm.expectRevert(abi.encodeWithSelector(Controller.RequestNeverActivated.selector, id));
            _review(id, 0, REPORT);
        }
        vm.warp(1_000 + 24 hours);
        require(!controller.isReviewOverdue(pending));
        require(!controller.isReviewOverdue(rejected));
    }

    function testUnknownLifecycleIdsRevert() public {
        bytes memory errorData = abi.encodeWithSelector(Controller.RequestNotFound.selector, 9);
        vm.expectRevert(errorData);
        controller.closeEmergency(9, 1);
        vm.expectRevert(errorData);
        _review(9, 0, REPORT);
        vm.expectRevert(errorData);
        controller.isReviewOverdue(9);
    }

    function testValidReviewRecordsAuditAndLeavesGrantActive() public {
        uint256 id = _activated();
        vm.expectEmit(true, true, false, true, address(controller));
        emit EmergencyReviewed(id, AUDITOR, Controller.ReviewVerdict.VALID, REPORT, 1_000);
        _review(id, 0, REPORT);
        Controller.Review memory review = controller.getReview(id);
        require(review.exists && review.reviewer == AUDITOR && review.reportCommitment == REPORT);
        require(review.verdict == Controller.ReviewVerdict.VALID && review.reviewedAt == 1_000);
        require(controller.canRead(CLINICIAN_B, RECORD, 1, id));
        vm.expectRevert(abi.encodeWithSelector(Controller.ReviewAlreadySubmitted.selector, id));
        _review(id, 1, REPORT);
        vm.warp(1_000 + 24 hours);
        require(!controller.isReviewOverdue(id));
    }

    function testMisuseReviewClosesGrantAndEmitsBothEvents() public {
        uint256 id = _activated();
        require(controller.MISUSE_CLOSURE_CODE() == MISUSE);
        vm.expectEmit(true, true, false, true, address(controller));
        emit EmergencyClosed(id, AUDITOR, MISUSE, 1_000);
        vm.expectEmit(true, true, false, true, address(controller));
        emit EmergencyReviewed(id, AUDITOR, Controller.ReviewVerdict.SUSPECTED_MISUSE, REPORT, 1_000);
        _review(id, 1, REPORT);
        require(controller.getReview(id).verdict == Controller.ReviewVerdict.SUSPECTED_MISUSE);
        require(controller.getEffectiveStatus(id) == Controller.EffectiveStatus.CLOSED);
        _assertEmergencyDenied(id);
    }

    function testOverdueBoundaryUsesActivationAndAllowsLateReviewOfClosedGrant() public {
        uint256 id = _request();
        vm.warp(1_020);
        _resolve(id, true);
        vm.prank(PATIENT);
        controller.closeEmergency(id, 1);
        vm.warp(1_020 + 24 hours - 1);
        require(!controller.isReviewOverdue(id));
        vm.warp(1_020 + 24 hours);
        require(controller.isReviewOverdue(id) && !controller.getReview(id).exists);
        _review(id, 1, REPORT);
        require(controller.getEffectiveStatus(id) == Controller.EffectiveStatus.CLOSED);
        require(controller.getReview(id).reviewedAt == 1_020 + 24 hours);
        require(!controller.isReviewOverdue(id));
    }

    function testExpiredGrantCanBeReviewedOrExplicitlyClosed() public {
        uint256 valid = _activated();
        uint256 misuse = _activated();
        uint256 closing = _activated();
        vm.warp(1_060);
        require(controller.getEffectiveStatus(valid) == Controller.EffectiveStatus.EXPIRED);
        _review(valid, 0, REPORT);
        require(controller.getEffectiveStatus(valid) == Controller.EffectiveStatus.EXPIRED);
        _review(misuse, 1, REPORT);
        require(controller.getEffectiveStatus(misuse) == Controller.EffectiveStatus.CLOSED);
        vm.prank(CLINICIAN_B);
        controller.closeEmergency(closing, 1);
        require(controller.getEffectiveStatus(closing) == Controller.EffectiveStatus.CLOSED);
    }

    function testReviewRequiresEligibleAuditorAndForbidsSelfReview() public {
        uint256 id = _activated();
        bytes32 auditorRole = registry.AUDITOR_ROLE();
        _expectIneligible(OUTSIDER, auditorRole);
        vm.prank(OUTSIDER);
        controller.submitReview(id, 0, REPORT);
        registry.grantRole(auditorRole, CLINICIAN_B);
        vm.expectRevert(abi.encodeWithSelector(Controller.SelfReviewForbidden.selector, id));
        vm.prank(CLINICIAN_B);
        controller.submitReview(id, 0, REPORT);
        registry.revokeRole(auditorRole, AUDITOR);
        _expectIneligible(AUDITOR, auditorRole);
        _review(id, 0, REPORT);
        require(!controller.getReview(id).exists);
    }

    function testInvalidReviewLeavesGrantAndReviewUnchanged() public {
        uint256 id = _activated();
        vm.expectRevert(abi.encodeWithSelector(Controller.InvalidReviewVerdict.selector, uint8(2)));
        _review(id, 2, REPORT);
        vm.expectRevert(abi.encodeWithSelector(Controller.InvalidReportCommitment.selector));
        _review(id, 1, bytes32(0));
        require(!controller.getReview(id).exists);
        require(controller.canRead(CLINICIAN_B, RECORD, 1, id));
    }

    function _request() private returns (uint256) {
        bytes32[] memory scope = new bytes32[](1);
        scope[0] = RECORD;
        vm.prank(CLINICIAN_B);
        return controller.requestEmergency(PATIENT, scope, keccak256("encounter"), 1, REPORT, 60);
    }

    function _resolve(uint256 id, bool approved) private {
        bytes32 hash = controller.getRequest(id).requestHash;
        vm.prank(ORACLE_B);
        controller.resolveEmergency(id, approved, hash, uint64(block.timestamp), uint64(block.timestamp + 60));
    }

    function _activated() private returns (uint256 id) {
        id = _request();
        _resolve(id, true);
    }

    function _review(uint256 id, uint8 verdict, bytes32 commitment) private {
        vm.prank(AUDITOR);
        controller.submitReview(id, verdict, commitment);
    }

    function _expectCloseDenied(uint256 id) private {
        vm.expectRevert(abi.encodeWithSelector(Controller.RequestNotActive.selector, id));
        vm.prank(PATIENT);
        controller.closeEmergency(id, 1);
    }

    function _assertEmergencyDenied(uint256 id) private {
        require(!controller.canRead(CLINICIAN_B, RECORD, 1, id));
        vm.expectRevert(abi.encodeWithSelector(Controller.ReadAccessDenied.selector));
        vm.prank(GATEWAY_A);
        controller.authorizeAccess(CLINICIAN_B, RECORD, 1, id, REPORT);
    }
}
