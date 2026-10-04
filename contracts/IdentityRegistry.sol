// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title IdentityRegistry
/// @notice Simulated KYC / participant directory for the tokenized cash ledger.
///         Every address that holds or receives cash must be registered and active here.
///         Smart contracts that custody cash (escrow, PBM, DvP) are registered as SYSTEM.
/// @dev    Prototype only: on a real network this would be backed by verifiable credentials
///         or an attestation service rather than a single registrar role.
contract IdentityRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    enum Kind {
        NONE,
        ISSUER,
        BANK,
        CORPORATE,
        INDIVIDUAL,
        MERCHANT,
        SYSTEM
    }

    struct Participant {
        Kind kind;
        uint8 tier; // KYC tier: drives the holding limit for individuals
        bool active;
        string name;
    }

    mapping(address => Participant) private _participants;
    address[] private _directory;

    /// @notice Maximum cash balance an INDIVIDUAL in a given tier may hold (0 = unlimited).
    mapping(uint8 => uint256) public tierHoldingLimit;

    event ParticipantRegistered(address indexed account, Kind kind, uint8 tier, string name);
    event ParticipantUpdated(address indexed account, Kind kind, uint8 tier, bool active);
    event TierLimitSet(uint8 indexed tier, uint256 limit);

    error AlreadyRegistered(address account);
    error NotRegistered(address account);
    error InvalidKind();
    error ZeroAddress();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    function register(address account, Kind kind, uint8 tier, string calldata name)
        external
        onlyRole(REGISTRAR_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (kind == Kind.NONE) revert InvalidKind();
        if (_participants[account].kind != Kind.NONE) revert AlreadyRegistered(account);
        _participants[account] = Participant(kind, tier, true, name);
        _directory.push(account);
        emit ParticipantRegistered(account, kind, tier, name);
    }

    function update(address account, Kind kind, uint8 tier, bool active) external onlyRole(REGISTRAR_ROLE) {
        Participant storage p = _participants[account];
        if (p.kind == Kind.NONE) revert NotRegistered(account);
        if (kind == Kind.NONE) revert InvalidKind();
        p.kind = kind;
        p.tier = tier;
        p.active = active;
        emit ParticipantUpdated(account, kind, tier, active);
    }

    function setTierHoldingLimit(uint8 tier, uint256 limit) external onlyRole(REGISTRAR_ROLE) {
        tierHoldingLimit[tier] = limit;
        emit TierLimitSet(tier, limit);
    }

    // --- Views ---

    function isAllowed(address account) external view returns (bool) {
        Participant storage p = _participants[account];
        return p.kind != Kind.NONE && p.active;
    }

    /// @notice Holding limit for `account` (0 = unlimited). Only INDIVIDUALs are capped.
    function holdingLimitOf(address account) external view returns (uint256) {
        Participant storage p = _participants[account];
        if (p.kind != Kind.INDIVIDUAL) return 0;
        return tierHoldingLimit[p.tier];
    }

    function participant(address account) external view returns (Participant memory) {
        return _participants[account];
    }

    function kindOf(address account) external view returns (Kind) {
        return _participants[account].kind;
    }

    function participantCount() external view returns (uint256) {
        return _directory.length;
    }

    function participantAt(uint256 index) external view returns (address) {
        return _directory[index];
    }
}
