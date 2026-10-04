// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";

/// @title AssetToken
/// @notice A simple permissioned security token (e.g. a tokenized bond or fund unit) used as
///         the "delivery" leg in DvP settlement against tokenized cash. Whole units only.
contract AssetToken is ERC20, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    IdentityRegistry public immutable registry;

    error NotAllowed(address account);

    constructor(string memory name_, string memory symbol_, IdentityRegistry registry_, address admin)
        ERC20(name_, symbol_)
    {
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ISSUER_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(address to, uint256 amount) external onlyRole(ISSUER_ROLE) {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && !registry.isAllowed(from)) revert NotAllowed(from);
        if (to != address(0) && !registry.isAllowed(to)) revert NotAllowed(to);
        super._update(from, to, value);
    }
}
