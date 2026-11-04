// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ParticipantRegistry} from "../contracts/ParticipantRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

interface Vm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert(bytes calldata reason) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

contract ParticipantRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant FACILITY = keccak256("facility-a");
    bytes32 private constant OTHER = keccak256("facility-b");
    bytes32 private constant PATIENT = keccak256("PATIENT_ROLE");
    bytes32 private constant CLINICIAN = keccak256("CLINICIAN_ROLE");
    bytes32 private constant AUDITOR = keccak256("AUDITOR_ROLE");
    bytes32 private constant ORACLE = keccak256("ORACLE_ROLE");
    bytes32 private constant GATEWAY = keccak256("GATEWAY_ROLE");
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    uint64 private constant EXPIRY = 10_000;
    ParticipantRegistry private registry;

    event FacilityRegistered(bytes32 indexed facilityId, address indexed actor);
    event ParticipantRegistered(address indexed account, bytes32 indexed role, bytes32 indexed facilityId, uint64 validUntil, address actor);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    function setUp() public {
        vm.warp(1_000);
        registry = new ParticipantRegistry(address(this));
        registry.registerFacility(FACILITY);
    }

    function testExplicitAdminAndSeparateApplicationRoles() public {
        ParticipantRegistry separate = new ParticipantRegistry(ALICE);
        require(separate.hasRole(bytes32(0), ALICE));
        require(!separate.hasRole(bytes32(0), address(this)));
        require(!separate.isEligible(ALICE, PATIENT));
        require(!separate.isEligible(ALICE, bytes32(0)));
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ZeroAddress.selector));
        new ParticipantRegistry(address(0));
    }

    function testFacilityRegistrationAndUnknownIdentifiers() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit FacilityRegistered(OTHER, address(this));
        registry.registerFacility(OTHER);
        require(registry.getFacility(OTHER).exists && registry.getFacility(OTHER).active);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidFacility.selector, bytes32(0)));
        registry.registerFacility(bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.FacilityAlreadyExists.selector, FACILITY));
        registry.registerFacility(FACILITY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.FacilityNotFound.selector, keccak256("unknown")));
        registry.setFacilityActive(keccak256("unknown"), false);
    }

    function testAllRegistryMutationsRequireAdmin() public {
        registry.registerParticipant(ALICE, CLINICIAN, FACILITY, EXPIRY);
        bytes memory denied = abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, BOB, bytes32(0));
        vm.prank(BOB);
        vm.expectRevert(denied);
        registry.registerFacility(OTHER);
        vm.prank(BOB);
        vm.expectRevert(denied);
        registry.setFacilityActive(FACILITY, false);
        vm.prank(BOB);
        vm.expectRevert(denied);
        registry.registerParticipant(BOB, PATIENT, bytes32(0), EXPIRY);
        vm.prank(BOB);
        vm.expectRevert(denied);
        registry.updateParticipant(ALICE, FACILITY, EXPIRY, false);
        vm.prank(BOB);
        vm.expectRevert(denied);
        registry.grantRole(AUDITOR, ALICE);
        vm.prank(BOB);
        vm.expectRevert(denied);
        registry.revokeRole(CLINICIAN, ALICE);
    }

    function testPatientRegistrationWithoutFacilityAndEvent() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit ParticipantRegistered(ALICE, PATIENT, bytes32(0), EXPIRY, address(this));
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), EXPIRY);
        ParticipantRegistry.Participant memory participant = registry.getParticipant(ALICE);
        require(participant.exists && participant.active && participant.validUntil == EXPIRY);
        require(participant.facilityId == bytes32(0));
        require(registry.isEligible(ALICE, PATIENT));
        require(!registry.isEligible(ALICE, CLINICIAN));
    }

    function testRejectInvalidParticipantRegistration() public {
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ZeroAddress.selector));
        registry.registerParticipant(address(0), PATIENT, bytes32(0), EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidRole.selector, bytes32(0)));
        registry.registerParticipant(ALICE, bytes32(0), bytes32(0), EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidRole.selector, keccak256("unknown")));
        registry.registerParticipant(ALICE, keccak256("unknown"), bytes32(0), EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidValidity.selector, uint64(1_000)));
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), 1_000);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidValidity.selector, uint64(999)));
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), 999);
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ParticipantAlreadyExists.selector, ALICE));
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), EXPIRY);
    }

    function testOperationalRolesRequireRegisteredActiveFacility() public {
        bytes32[3] memory roles = [CLINICIAN, ORACLE, GATEWAY];
        for (uint256 i; i < roles.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidFacility.selector, bytes32(0)));
            registry.registerParticipant(ALICE, roles[i], bytes32(0), EXPIRY);
        }
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.FacilityNotFound.selector, OTHER));
        registry.registerParticipant(ALICE, CLINICIAN, OTHER, EXPIRY);
        registry.setFacilityActive(FACILITY, false);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.FacilityInactive.selector, FACILITY));
        registry.registerParticipant(ALICE, CLINICIAN, FACILITY, EXPIRY);
    }

    function testFacilityDeactivationBlocksAllAffiliatedOperationalRoles() public {
        registry.registerParticipant(ALICE, CLINICIAN, FACILITY, EXPIRY);
        registry.registerParticipant(BOB, ORACLE, FACILITY, EXPIRY);
        registry.grantRole(GATEWAY, BOB);
        registry.registerParticipant(address(0xC), PATIENT, FACILITY, EXPIRY);
        registry.setFacilityActive(FACILITY, false);
        require(!registry.isEligible(ALICE, CLINICIAN));
        require(!registry.isEligible(BOB, ORACLE) && !registry.isEligible(BOB, GATEWAY));
        require(registry.isEligible(address(0xC), PATIENT));
        registry.setFacilityActive(FACILITY, true);
        require(registry.isEligible(ALICE, CLINICIAN));
    }

    function testExpiryBoundaryAndRenewal() public {
        registry.registerParticipant(ALICE, CLINICIAN, FACILITY, EXPIRY);
        vm.warp(EXPIRY - 1);
        require(registry.isEligible(ALICE, CLINICIAN));
        vm.warp(EXPIRY);
        require(!registry.isEligible(ALICE, CLINICIAN));
        vm.warp(EXPIRY + 1);
        require(!registry.isEligible(ALICE, CLINICIAN));
        require(registry.hasRole(CLINICIAN, ALICE));
        registry.updateParticipant(ALICE, FACILITY, EXPIRY + 100, true);
        require(registry.isEligible(ALICE, CLINICIAN));
    }

    function testCredentialUpdatesPreserveIdentityAndValidateAffiliation() public {
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ParticipantNotFound.selector, ALICE));
        registry.updateParticipant(ALICE, FACILITY, EXPIRY, true);
        registry.registerParticipant(ALICE, CLINICIAN, FACILITY, EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidFacility.selector, bytes32(0)));
        registry.updateParticipant(ALICE, bytes32(0), EXPIRY, true);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.FacilityNotFound.selector, OTHER));
        registry.updateParticipant(ALICE, OTHER, EXPIRY, true);
        registry.registerFacility(OTHER);
        registry.updateParticipant(ALICE, OTHER, EXPIRY, false);
        require(!registry.isEligible(ALICE, CLINICIAN));
        require(registry.getParticipant(ALICE).exists && registry.hasRole(CLINICIAN, ALICE));
        require(registry.getParticipant(ALICE).facilityId == OTHER);
        registry.updateParticipant(ALICE, OTHER, EXPIRY, true);
        require(registry.isEligible(ALICE, CLINICIAN));
    }

    function testDeactivateExpiredAccountAtInactiveFacility() public {
        registry.registerParticipant(ALICE, CLINICIAN, FACILITY, EXPIRY);
        registry.setFacilityActive(FACILITY, false);
        vm.warp(EXPIRY);
        registry.updateParticipant(ALICE, FACILITY, EXPIRY, false);
        require(!registry.getParticipant(ALICE).active);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.FacilityInactive.selector, FACILITY));
        registry.updateParticipant(ALICE, FACILITY, EXPIRY + 100, true);
        registry.setFacilityActive(FACILITY, true);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidValidity.selector, EXPIRY));
        registry.updateParticipant(ALICE, FACILITY, EXPIRY, true);
    }

    function testGrantRoleCannotBypassOnboardingOrFacility() public {
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ParticipantNotFound.selector, ALICE));
        registry.grantRole(PATIENT, ALICE);
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidFacility.selector, bytes32(0)));
        registry.grantRole(CLINICIAN, ALICE);
        registry.updateParticipant(ALICE, FACILITY, EXPIRY, true);
        registry.grantRole(CLINICIAN, ALICE);
        require(registry.isEligible(ALICE, PATIENT) && registry.isEligible(ALICE, CLINICIAN));
    }

    function testClinicianAndServiceRolesAreIncompatibleInBothDirections() public {
        registry.registerParticipant(ALICE, CLINICIAN, FACILITY, EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.IncompatibleRoles.selector, ALICE));
        registry.grantRole(ORACLE, ALICE);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.IncompatibleRoles.selector, ALICE));
        registry.grantRole(GATEWAY, ALICE);
        registry.registerParticipant(BOB, ORACLE, FACILITY, EXPIRY);
        registry.grantRole(GATEWAY, BOB);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.IncompatibleRoles.selector, BOB));
        registry.grantRole(CLINICIAN, BOB);
        registry.revokeRole(ORACLE, BOB);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.IncompatibleRoles.selector, BOB));
        registry.grantRole(CLINICIAN, BOB);
        registry.revokeRole(GATEWAY, BOB);
        registry.grantRole(CLINICIAN, BOB);
        require(registry.isEligible(BOB, CLINICIAN));
    }

    function testRoleGrantRejectsInactiveExpiredUnknownAndZero() public {
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), EXPIRY);
        registry.updateParticipant(ALICE, bytes32(0), EXPIRY, false);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ParticipantInactive.selector, ALICE));
        registry.grantRole(AUDITOR, ALICE);
        registry.updateParticipant(ALICE, bytes32(0), EXPIRY, true);
        vm.warp(EXPIRY);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidValidity.selector, EXPIRY));
        registry.grantRole(AUDITOR, ALICE);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidRole.selector, keccak256("unknown")));
        registry.grantRole(keccak256("unknown"), ALICE);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ZeroAddress.selector));
        registry.grantRole(bytes32(0), address(0));
    }

    function testRoleRevocationAndSelfRenunciationRetainMetadata() public {
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), EXPIRY);
        registry.grantRole(AUDITOR, ALICE);
        vm.expectEmit(true, true, true, true, address(registry));
        emit RoleRevoked(AUDITOR, ALICE, address(this));
        registry.revokeRole(AUDITOR, ALICE);
        require(!registry.isEligible(ALICE, AUDITOR) && registry.isEligible(ALICE, PATIENT));
        vm.prank(ALICE);
        registry.renounceRole(PATIENT, ALICE);
        require(!registry.isEligible(ALICE, PATIENT) && registry.getParticipant(ALICE).exists);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ParticipantNotFound.selector, BOB));
        registry.revokeRole(PATIENT, BOB);
    }

    function testAdminManagementDoesNotRegisterPatient() public {
        registry.grantRole(bytes32(0), ALICE);
        require(registry.hasRole(bytes32(0), ALICE));
        require(!registry.getParticipant(ALICE).exists && !registry.isEligible(ALICE, PATIENT));
        registry.revokeRole(bytes32(0), ALICE);
        require(!registry.hasRole(bytes32(0), ALICE));
    }

    function testUnknownIdsReturnExistenceFalseAndNoEligibility() public view {
        require(!registry.getParticipant(ALICE).exists && !registry.getFacility(OTHER).exists);
        require(!registry.isEligible(ALICE, PATIENT) && !registry.isEligible(ALICE, keccak256("unknown")));
    }

    function testFuzzExclusiveCredentialExpiry(uint32 lifetime) public {
        uint64 expiry = uint64(block.timestamp) + uint64(lifetime) + 1;
        registry.registerParticipant(ALICE, PATIENT, bytes32(0), expiry);
        vm.warp(expiry - 1);
        require(registry.isEligible(ALICE, PATIENT));
        vm.warp(expiry);
        require(!registry.isEligible(ALICE, PATIENT));
    }
}
