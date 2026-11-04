// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ParticipantRegistry} from "../contracts/ParticipantRegistry.sol";
import {MedicalAccessController} from "../contracts/MedicalAccessController.sol";
import {Vm} from "./ParticipantRegistry.t.sol";

contract MedicalAccessControllerTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ParticipantRegistry private registry;
    MedicalAccessController private controller;

    function setUp() public {
        registry = new ParticipantRegistry(address(this));
        controller = new MedicalAccessController(registry);
    }

    function testRegistryWiringAndPolicyConstants() public view {
        require(address(controller.registry()) == address(registry));
        require(controller.MAX_EMERGENCY_DURATION() == 15 minutes);
        require(controller.MAX_ATTESTATION_AGE() == 60 seconds);
        require(controller.REQUEST_TTL() == 120 seconds);
        require(controller.MAX_RECORDS() == 20);
        require(controller.REVIEW_TARGET() == 24 hours);
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
        bytes32[] memory recordIds = new bytes32[](1);
        recordIds[0] = id;
        bytes[] memory calls = new bytes[](12);
        calls[0] = abi.encodeCall(controller.registerRecord, (id, address(this), id, 1));
        calls[1] = abi.encodeCall(controller.deactivateRecord, (id));
        calls[2] = abi.encodeCall(controller.grantConsent, (address(this), id, 10_000));
        calls[3] = abi.encodeCall(controller.revokeConsent, (1));
        calls[4] = abi.encodeCall(controller.canRead, (address(this), id, 0, 1));
        calls[5] = abi.encodeCall(controller.authorizeAccess, (address(this), id, 0, 1, id));
        calls[6] = abi.encodeCall(controller.requestEmergency, (address(this), recordIds, id, 1, id, 60));
        calls[7] = abi.encodeCall(controller.resolveEmergency, (1, true, id, 1_000, 1_060));
        calls[8] = abi.encodeCall(controller.closeEmergency, (1, 1));
        calls[9] = abi.encodeCall(controller.submitReview, (1, 0, id));
        calls[10] = abi.encodeCall(controller.getEffectiveStatus, (1));
        calls[11] = abi.encodeCall(controller.isReviewOverdue, (1));
        for (uint256 i; i < calls.length; ++i) {
            (bool success, bytes memory result) = address(controller).call(calls[i]);
            require(!success, "unfinished path succeeded");
            require(keccak256(result) == keccak256(abi.encodeWithSelector(MedicalAccessController.NotImplemented.selector)));
        }
    }
}
