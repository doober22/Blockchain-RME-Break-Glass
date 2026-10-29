// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract ParticipantRegistry is AccessControl {
    bytes32 public constant PATIENT_ROLE = keccak256("PATIENT_ROLE");
    bytes32 public constant CLINICIAN_ROLE = keccak256("CLINICIAN_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant GATEWAY_ROLE = keccak256("GATEWAY_ROLE");

    struct Facility {
        bool exists;
        bool active;
    }

    struct Participant {
        bool exists;
        bytes32 facilityId;
        bool active;
        uint64 validUntil;
    }

    mapping(bytes32 => Facility) private facilities;
    mapping(address => Participant) private participants;

    error NotImplemented();

    event FacilityRegistered(bytes32 indexed facilityId, address indexed actor);
    event FacilityStatusChanged(bytes32 indexed facilityId, bool active, address indexed actor);
    event ParticipantRegistered(
        address indexed account, bytes32 indexed role, bytes32 indexed facilityId,
        uint64 validUntil, address actor
    );
    event ParticipantUpdated(
        address indexed account, bytes32 indexed facilityId, uint64 validUntil,
        bool active, address indexed actor
    );

// function blm diimplemen (semua)
    constructor(address initialAdmin) {
        revert NotImplemented();
    }

    function registerFacility(bytes32 facilityId) external pure {
        revert NotImplemented();
    }

    function setFacilityActive(bytes32 facilityId, bool active) external pure {
        revert NotImplemented();
    }

    function registerParticipant(address account, bytes32 role, bytes32 facilityId, uint64 validUntil) external pure {
        revert NotImplemented();
    }


    function updateParticipant(address account, bytes32 facilityId, uint64 validUntil, bool active) external pure {
        revert NotImplemented();
    }


    function isEligible(address account, bytes32 role) external pure returns (bool) {
        revert NotImplemented();
    }

    function getFacility(bytes32 facilityId) external pure returns (Facility memory) {
        revert NotImplemented();
    }

    function getParticipant(address account) external pure returns (Participant memory) {
        revert NotImplemented();
    }

    function grantRole(bytes32 role, address account) public pure override {
        revert NotImplemented();
    }

    function revokeRole(bytes32 role, address account) public pure override {
        revert NotImplemented();
    }
}
