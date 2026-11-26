// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ParticipantRegistry} from "../contracts/ParticipantRegistry.sol";
import {MedicalAccessController} from "../contracts/MedicalAccessController.sol";
import {ControllerFixture} from "./ControllerFixture.sol";

contract MedicalAccessControllerTest is ControllerFixture {

    function testRegistryWiringAndPolicyConstants() public view {
        require(address(controller.registry()) == address(registry));
        require(controller.MAX_EMERGENCY_DURATION() == 15 minutes);
        require(controller.MAX_ATTESTATION_AGE() == 60 seconds);
        require(controller.REQUEST_TTL() == 120 seconds);
        require(controller.MAX_RECORDS() == 20);
        require(controller.REVIEW_TARGET() == 24 hours);
        require(controller.NORMAL_MODE() == 0 && controller.EMERGENCY_MODE() == 1);
    }

    function testRejectZeroOrNonContractRegistry() public {
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRegistry.selector));
        new MedicalAccessController(ParticipantRegistry(address(0)));
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.InvalidRegistry.selector));
        new MedicalAccessController(ParticipantRegistry(address(0xA11CE)));
    }

    function testUnknownMetadataIsExplicitlyAbsent() public view {
        require(!controller.getRecord(bytes32(0)).exists);
        require(!controller.getConsent(0).exists);
        require(!controller.getRequest(0).exists);
        require(!controller.getReview(0).exists);
    }

    function testAllUnfinishedAuthorizationAndMutationPathsRevert() public {
        bytes32 id = keccak256("synthetic-record");
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(controller.closeEmergency, (1, 1));
        calls[1] = abi.encodeCall(controller.submitReview, (1, 0, id));
        calls[2] = abi.encodeCall(controller.isReviewOverdue, (1));
        for (uint256 i; i < calls.length; ++i) {
            (bool success, bytes memory result) = address(controller).call(calls[i]);
            require(!success, "unfinished path succeeded");
            require(keccak256(result) == keccak256(abi.encodeWithSelector(MedicalAccessController.NotImplemented.selector)));
        }
    }
}
