// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title DvPSettlement
/// @notice Atomic delivery-versus-payment: an asset token moves seller -> buyer and tokenized
///         cash moves buyer -> seller in the same transaction, or neither moves. This removes
///         principal (Herstatt-style) settlement risk between the two legs.
///
///         Flow: either party proposes a trade (implicitly affirming it); the counterparty
///         affirms by calling `settle`. Both parties pre-approve this contract on their token.
///         Nothing is custodied: if either leg fails (balance, allowance, compliance), the
///         whole settlement reverts.
contract DvPSettlement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        NONE,
        PROPOSED,
        SETTLED,
        CANCELLED
    }

    struct Trade {
        address seller;
        address buyer;
        IERC20 asset;
        uint256 assetAmount;
        uint256 cashAmount;
        uint64 deadline;
        address proposer;
        Status status;
        bytes32 ref;
    }

    IERC20 public immutable cash;

    uint256 public tradeCount;
    mapping(uint256 => Trade) private _trades;

    event TradeProposed(
        uint256 indexed id, address indexed seller, address indexed buyer, address asset, uint256 assetAmount, uint256 cashAmount, bytes32 ref
    );
    event TradeSettled(uint256 indexed id);
    event TradeCancelled(uint256 indexed id);

    error Unauthorized();
    error InvalidStatus();
    error Expired();
    error InvalidTrade();

    constructor(IERC20 cash_) {
        cash = cash_;
    }

    function propose(
        address seller,
        address buyer,
        IERC20 asset,
        uint256 assetAmount,
        uint256 cashAmount,
        uint64 deadline,
        bytes32 ref
    ) external returns (uint256 id) {
        if (msg.sender != seller && msg.sender != buyer) revert Unauthorized();
        if (seller == buyer || assetAmount == 0 || cashAmount == 0) revert InvalidTrade();
        if (deadline <= block.timestamp) revert Expired();

        id = ++tradeCount;
        _trades[id] = Trade(seller, buyer, asset, assetAmount, cashAmount, deadline, msg.sender, Status.PROPOSED, ref);
        emit TradeProposed(id, seller, buyer, address(asset), assetAmount, cashAmount, ref);
    }

    /// @notice Counterparty affirms and both legs settle atomically.
    function settle(uint256 id) external nonReentrant {
        Trade storage t = _trades[id];
        if (t.status != Status.PROPOSED) revert InvalidStatus();
        if (block.timestamp >= t.deadline) revert Expired();
        address counterparty = t.proposer == t.seller ? t.buyer : t.seller;
        if (msg.sender != counterparty) revert Unauthorized();

        t.status = Status.SETTLED;
        t.asset.safeTransferFrom(t.seller, t.buyer, t.assetAmount); // delivery
        cash.safeTransferFrom(t.buyer, t.seller, t.cashAmount); // payment
        emit TradeSettled(id);
    }

    function cancel(uint256 id) external {
        Trade storage t = _trades[id];
        if (t.status != Status.PROPOSED) revert InvalidStatus();
        if (msg.sender != t.seller && msg.sender != t.buyer) revert Unauthorized();
        t.status = Status.CANCELLED;
        emit TradeCancelled(id);
    }

    function getTrade(uint256 id) external view returns (Trade memory) {
        return _trades[id];
    }
}
