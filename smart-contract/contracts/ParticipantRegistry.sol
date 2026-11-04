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

    error ZeroAddress();
    error InvalidFacility(bytes32 facilityId);
    error FacilityAlreadyExists(bytes32 facilityId);
    error FacilityNotFound(bytes32 facilityId);
    error FacilityInactive(bytes32 facilityId);
    error ParticipantAlreadyExists(address account);
    error ParticipantNotFound(address account);
    error ParticipantInactive(address account);
    error InvalidValidity(uint64 validUntil);
    error InvalidRole(bytes32 role);
    error IncompatibleRoles(address account);

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

    constructor(address initialAdmin) {
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }

    function registerFacility(bytes32 facilityId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (facilityId == bytes32(0)) revert InvalidFacility(facilityId);
        if (facilities[facilityId].exists) revert FacilityAlreadyExists(facilityId);
        facilities[facilityId] = Facility({exists: true, active: true});
        emit FacilityRegistered(facilityId, _msgSender());
    }

    function setFacilityActive(bytes32 facilityId, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!facilities[facilityId].exists) revert FacilityNotFound(facilityId);
        facilities[facilityId].active = active;
        emit FacilityStatusChanged(facilityId, active, _msgSender());
    }

    function registerParticipant(address account, bytes32 role, bytes32 facilityId, uint64 validUntil)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (participants[account].exists) revert ParticipantAlreadyExists(account);
        if (!_isApplicationRole(role)) revert InvalidRole(role);
        _validateValidity(validUntil);
        _validateFacility(facilityId, _requiresFacility(role), true);
        participants[account] = Participant(true, facilityId, true, validUntil);
        _grantRole(role, account);
        emit ParticipantRegistered(account, role, facilityId, validUntil, _msgSender());
    }

    function updateParticipant(address account, bytes32 facilityId, uint64 validUntil, bool active)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Participant storage participant = participants[account];
        if (!participant.exists) revert ParticipantNotFound(account);
        bool needsFacility = hasRole(CLINICIAN_ROLE, account)
            || hasRole(ORACLE_ROLE, account) || hasRole(GATEWAY_ROLE, account);
        _validateFacility(facilityId, needsFacility, active);
        // Deactivation remains possible after credential expiry or facility shutdown.
        if (active) _validateValidity(validUntil);
        participant.facilityId = facilityId;
        participant.validUntil = validUntil;
        participant.active = active;
        emit ParticipantUpdated(account, facilityId, validUntil, active, _msgSender());
    }

    function isEligible(address account, bytes32 role) external view returns (bool) {
        if (!_isApplicationRole(role) || !hasRole(role, account)) return false;
        Participant memory participant = participants[account];
        if (!participant.exists || !participant.active || block.timestamp >= participant.validUntil) return false;
        if (_requiresFacility(role)) {
            Facility memory facility = facilities[participant.facilityId];
            return facility.exists && facility.active;
        }
        return true;
    }

    function getFacility(bytes32 facilityId) external view returns (Facility memory) {
        return facilities[facilityId];
    }

    function getParticipant(address account) external view returns (Participant memory) {
        return participants[account];
    }

    function revokeRole(bytes32 role, address account) public override onlyRole(getRoleAdmin(role)) {
        if (account == address(0)) revert ZeroAddress();
        if (role != DEFAULT_ADMIN_ROLE) {
            if (!_isApplicationRole(role)) revert InvalidRole(role);
            if (!participants[account].exists) revert ParticipantNotFound(account);
        }
        _revokeRole(role, account);
    }

    // Covers inherited grantRole as well as registration; neither can bypass these checks.
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (account == address(0)) revert ZeroAddress();
        if (role != DEFAULT_ADMIN_ROLE) {
            if (!_isApplicationRole(role)) revert InvalidRole(role);
            Participant memory participant = participants[account];
            if (!participant.exists) revert ParticipantNotFound(account);
            if (!participant.active) revert ParticipantInactive(account);
            _validateValidity(participant.validUntil);
            _validateFacility(participant.facilityId, _requiresFacility(role), true);
            if (
                (role == CLINICIAN_ROLE && (hasRole(ORACLE_ROLE, account) || hasRole(GATEWAY_ROLE, account)))
                || ((role == ORACLE_ROLE || role == GATEWAY_ROLE) && hasRole(CLINICIAN_ROLE, account))
            ) revert IncompatibleRoles(account);
        }
        return super._grantRole(role, account);
    }

    function _validateValidity(uint64 validUntil) private view {
        if (validUntil <= block.timestamp) revert InvalidValidity(validUntil);
    }

    function _validateFacility(bytes32 facilityId, bool required, bool mustBeActive) private view {
        if (facilityId == bytes32(0)) {
            if (required) revert InvalidFacility(facilityId);
            return;
        }
        Facility memory facility = facilities[facilityId];
        if (!facility.exists) revert FacilityNotFound(facilityId);
        if (mustBeActive && !facility.active) revert FacilityInactive(facilityId);
    }

    function _requiresFacility(bytes32 role) private pure returns (bool) {
        return role == CLINICIAN_ROLE || role == ORACLE_ROLE || role == GATEWAY_ROLE;
    }

    function _isApplicationRole(bytes32 role) private pure returns (bool) {
        return role == PATIENT_ROLE || role == CLINICIAN_ROLE || role == AUDITOR_ROLE
            || role == ORACLE_ROLE || role == GATEWAY_ROLE;
    }
}
