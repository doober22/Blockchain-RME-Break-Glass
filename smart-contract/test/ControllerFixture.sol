// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ParticipantRegistry} from "../contracts/ParticipantRegistry.sol";
import {MedicalAccessController} from "../contracts/MedicalAccessController.sol";
import {Vm} from "./ParticipantRegistry.t.sol";

/// @dev Shared synthetic consortium fixture for controller policy tests.
abstract contract ControllerFixture {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 internal constant FACILITY_A = bytes32(uint256(1));
    bytes32 internal constant FACILITY_B = bytes32(uint256(2));
    bytes32 internal constant RECORD = bytes32(uint256(10));
    bytes32 internal constant CIPHERTEXT_HASH = keccak256("synthetic-ciphertext");
    uint64 internal constant CREDENTIAL_EXPIRY = 100_000;
    address internal constant PATIENT = address(0x100);
    address internal constant OTHER_PATIENT = address(0x101);
    address internal constant CLINICIAN_A = address(0x200);
    address internal constant CLINICIAN_B = address(0x201);
    address internal constant GATEWAY_A = address(0x300);
    address internal constant GATEWAY_B = address(0x301);
    address internal constant ORACLE_A = address(0x400);
    address internal constant ORACLE_B = address(0x401);
    address internal constant AUDITOR = address(0x500);
    address internal constant OUTSIDER = address(0x600);
    ParticipantRegistry internal registry;
    MedicalAccessController internal controller;

    event RecordRegistered(
        bytes32 indexed recordId, address indexed patient, bytes32 indexed facilityId, bytes32 ciphertextHash
    );
    event RecordDeactivated(bytes32 indexed recordId, address indexed patient, bytes32 indexed facilityId);

    function setUp() public virtual {
        vm.warp(1_000);
        registry = new ParticipantRegistry(address(this));
        controller = new MedicalAccessController(registry);
        registry.registerFacility(FACILITY_A);
        registry.registerFacility(FACILITY_B);
        registry.registerParticipant(PATIENT, registry.PATIENT_ROLE(), bytes32(0), CREDENTIAL_EXPIRY);
        registry.registerParticipant(OTHER_PATIENT, registry.PATIENT_ROLE(), bytes32(0), CREDENTIAL_EXPIRY);
        registry.registerParticipant(CLINICIAN_A, registry.CLINICIAN_ROLE(), FACILITY_A, CREDENTIAL_EXPIRY);
        registry.registerParticipant(CLINICIAN_B, registry.CLINICIAN_ROLE(), FACILITY_B, CREDENTIAL_EXPIRY);
        registry.registerParticipant(GATEWAY_A, registry.GATEWAY_ROLE(), FACILITY_A, CREDENTIAL_EXPIRY);
        registry.registerParticipant(GATEWAY_B, registry.GATEWAY_ROLE(), FACILITY_B, CREDENTIAL_EXPIRY);
        registry.registerParticipant(ORACLE_A, registry.ORACLE_ROLE(), FACILITY_A, CREDENTIAL_EXPIRY);
        registry.registerParticipant(ORACLE_B, registry.ORACLE_ROLE(), FACILITY_B, CREDENTIAL_EXPIRY);
        registry.registerParticipant(AUDITOR, registry.AUDITOR_ROLE(), bytes32(0), CREDENTIAL_EXPIRY);
    }

    function _registerRecord() internal {
        vm.prank(GATEWAY_A);
        controller.registerRecord(RECORD, PATIENT, CIPHERTEXT_HASH, 1);
    }

    function _expectIneligible(address account, bytes32 role) internal {
        vm.expectRevert(abi.encodeWithSelector(MedicalAccessController.IneligibleParticipant.selector, account, role));
    }
}
