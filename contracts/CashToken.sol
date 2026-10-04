// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title CashToken
/// @notice Tokenized cash: a fully-backed, permissioned ERC-20 representing a liability of the
///         issuer (a central bank, commercial bank or e-money issuer). 2 decimals, like fiat cents.
///
///         Ledger rules enforced on every movement (in `_update`):
///           - ledger not paused
///           - sender and receiver are registered, active participants (IdentityRegistry)
///           - neither side is frozen (except compliance force-transfers out of a frozen account)
///           - receiver stays within its KYC-tier holding limit
///         Issuance rule: totalSupply can never exceed the issuer's attested reserves.
contract CashToken is ERC20, AccessControl, Pausable {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IdentityRegistry public immutable registry;

    /// @notice Off-chain reserves (in token units) the issuer attests back the supply.
    uint256 public attestedReserves;

    mapping(address => bool) public frozen;

    bool private _forcing;

    event Issued(address indexed to, uint256 amount, bytes32 indexed ref);
    event Redeemed(address indexed from, uint256 amount, bytes32 indexed ref);
    event ReservesAttested(uint256 reserves, uint256 totalSupply);
    event Payment(address indexed from, address indexed to, uint256 amount, bytes32 indexed ref);
    event AccountFrozen(address indexed account, bytes32 reason);
    event AccountUnfrozen(address indexed account);
    event ForcedTransfer(address indexed from, address indexed to, uint256 amount, bytes32 reason);

    error NotAllowed(address account);
    error AccountIsFrozen(address account);
    error HoldingLimitExceeded(address account, uint256 limit, uint256 newBalance);
    error InsufficientReserves(uint256 reserves, uint256 supplyAfter);
    error ReservesBelowSupply(uint256 reserves, uint256 supply);
    error ZeroAmount();

    constructor(string memory name_, string memory symbol_, IdentityRegistry registry_, address admin)
        ERC20(name_, symbol_)
    {
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
        _grantRole(COMPLIANCE_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) {
        return 2;
    }

    // ---------------------------------------------------------------------
    // Issuance & redemption
    // ---------------------------------------------------------------------

    /// @notice Issuer attests the off-chain reserves backing the token. Cannot drop below supply.
    function attestReserves(uint256 reserves) external onlyRole(ISSUER_ROLE) {
        if (reserves < totalSupply()) revert ReservesBelowSupply(reserves, totalSupply());
        attestedReserves = reserves;
        emit ReservesAttested(reserves, totalSupply());
    }

    /// @notice Issue new cash against a fiat deposit (e.g. a bank tops up its account).
    function mint(address to, uint256 amount, bytes32 ref) external onlyRole(ISSUER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        uint256 supplyAfter = totalSupply() + amount;
        if (supplyAfter > attestedReserves) revert InsufficientReserves(attestedReserves, supplyAfter);
        _mint(to, amount);
        emit Issued(to, amount, ref);
    }

    /// @notice Holder redeems cash back to fiat. Tokens are burned; the issuer pays out off-chain
    ///         and then lowers its attested reserves.
    function redeem(uint256 amount, bytes32 ref) external {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        emit Redeemed(msg.sender, amount, ref);
    }

    /// @notice Supply / reserves, in basis points. 10000 = exactly fully backed.
    function backingRatioBps() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return type(uint256).max;
        return (attestedReserves * 10_000) / supply;
    }

    // ---------------------------------------------------------------------
    // Payments
    // ---------------------------------------------------------------------

    /// @notice Transfer with a payment reference (invoice id, purpose code...), so the ledger
    ///         reads like a bank statement.
    function pay(address to, uint256 amount, bytes32 ref) external returns (bool) {
        _transfer(msg.sender, to, amount);
        emit Payment(msg.sender, to, amount, ref);
        return true;
    }

    // ---------------------------------------------------------------------
    // Compliance controls
    // ---------------------------------------------------------------------

    function freeze(address account, bytes32 reason) external onlyRole(COMPLIANCE_ROLE) {
        frozen[account] = true;
        emit AccountFrozen(account, reason);
    }

    function unfreeze(address account) external onlyRole(COMPLIANCE_ROLE) {
        frozen[account] = false;
        emit AccountUnfrozen(account);
    }

    /// @notice Court order / sanctions action: move funds out of an account, even if frozen.
    function forceTransfer(address from, address to, uint256 amount, bytes32 reason)
        external
        onlyRole(COMPLIANCE_ROLE)
    {
        _forcing = true;
        _transfer(from, to, amount);
        _forcing = false;
        emit ForcedTransfer(from, to, amount, reason);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Ledger rules
    // ---------------------------------------------------------------------

    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        if (from != address(0)) {
            if (!_forcing) {
                if (frozen[from]) revert AccountIsFrozen(from);
                if (!registry.isAllowed(from)) revert NotAllowed(from);
            }
        }
        if (to != address(0)) {
            if (frozen[to]) revert AccountIsFrozen(to);
            if (!registry.isAllowed(to)) revert NotAllowed(to);
        }

        super._update(from, to, value);

        if (to != address(0) && from != to) {
            uint256 limit = registry.holdingLimitOf(to);
            if (limit != 0 && balanceOf(to) > limit) {
                revert HoldingLimitExceeded(to, limit, balanceOf(to));
            }
        }
    }
}
