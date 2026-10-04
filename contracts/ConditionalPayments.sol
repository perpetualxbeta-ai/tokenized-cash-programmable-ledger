// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ConditionalPayments
/// @notice Multi-milestone escrow for tokenized cash. Evolution of the single-milestone ETH
///         FreelanceMilestoneEscrow POC, fixing its known gaps:
///           - many escrows in one contract (escrowId), not one deployment per deal
///           - exact stored amounts, never `balanceOf(this)` (no leakage of stray funds)
///           - a deadline after which the payer can reclaim unreleased milestones
///           - an optional arbiter and a dispute flag
///           - pull payments: settlement credits a claimable balance, so a frozen or
///             misbehaving recipient can never block the escrow from settling
contract ConditionalPayments is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum MilestoneState {
        PENDING,
        RELEASED,
        REFUNDED
    }

    struct Escrow {
        address payer;
        address payee;
        address arbiter; // address(0) = no arbiter
        uint64 deadline;
        bool disputed;
        uint256 total;
        bytes32 ref;
    }

    IERC20 public immutable cash;

    uint256 public escrowCount;
    mapping(uint256 => Escrow) private _escrows;
    mapping(uint256 => uint256[]) private _amounts;
    mapping(uint256 => MilestoneState[]) private _states;

    /// @notice Cash settled to an account but not yet withdrawn.
    mapping(address => uint256) public claimable;

    /// @notice Sum of all PENDING milestone amounts across all escrows.
    uint256 public totalLocked;
    /// @notice Sum of all claimable balances.
    uint256 public totalClaimable;

    event EscrowCreated(
        uint256 indexed id, address indexed payer, address indexed payee, address arbiter, uint256 total, uint64 deadline, bytes32 ref
    );
    event MilestoneReleased(uint256 indexed id, uint256 indexed index, address by, uint256 amount);
    event MilestoneRefunded(uint256 indexed id, uint256 indexed index, address by, uint256 amount);
    event Disputed(uint256 indexed id, address by);
    event Reclaimed(uint256 indexed id, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);

    error Unauthorized();
    error InvalidMilestone();
    error NotPending();
    error NoMilestones();
    error ZeroAmount();
    error InvalidParty();
    error DeadlineInPast();
    error DeadlineNotReached();
    error EscrowDisputed();
    error NoArbiter();
    error NothingToWithdraw();

    constructor(IERC20 cash_) {
        cash = cash_;
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @notice Lock cash for `payee`, split into milestones. Caller must `approve` the total first.
    function create(address payee, address arbiter, uint64 deadline, uint256[] calldata amounts, bytes32 ref)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (payee == address(0) || payee == msg.sender) revert InvalidParty();
        if (arbiter == msg.sender || arbiter == payee) revert InvalidParty();
        if (deadline <= block.timestamp) revert DeadlineInPast();
        if (amounts.length == 0) revert NoMilestones();

        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            if (amounts[i] == 0) revert ZeroAmount();
            total += amounts[i];
        }

        id = ++escrowCount;
        _escrows[id] = Escrow(msg.sender, payee, arbiter, deadline, false, total, ref);
        _amounts[id] = amounts;
        for (uint256 i; i < amounts.length; ++i) {
            _states[id].push(MilestoneState.PENDING);
        }
        totalLocked += total;

        cash.safeTransferFrom(msg.sender, address(this), total);
        emit EscrowCreated(id, msg.sender, payee, arbiter, total, deadline, ref);
    }

    /// @notice Pay out a milestone. Payer (if not disputed) or arbiter.
    function release(uint256 id, uint256 index) external {
        Escrow storage e = _escrows[id];
        bool isArbiter = msg.sender == e.arbiter && e.arbiter != address(0);
        if (msg.sender != e.payer && !isArbiter) revert Unauthorized();
        if (e.disputed && !isArbiter) revert EscrowDisputed();
        uint256 amount = _settle(id, index, MilestoneState.RELEASED);
        _credit(e.payee, amount);
        emit MilestoneReleased(id, index, msg.sender, amount);
    }

    /// @notice Return a milestone to the payer. Payee (voluntary) or arbiter.
    function refund(uint256 id, uint256 index) external {
        Escrow storage e = _escrows[id];
        bool isArbiter = msg.sender == e.arbiter && e.arbiter != address(0);
        if (msg.sender != e.payee && !isArbiter) revert Unauthorized();
        uint256 amount = _settle(id, index, MilestoneState.REFUNDED);
        _credit(e.payer, amount);
        emit MilestoneRefunded(id, index, msg.sender, amount);
    }

    /// @notice Either party freezes unilateral action; only the arbiter can settle afterwards.
    function dispute(uint256 id) external {
        Escrow storage e = _escrows[id];
        if (msg.sender != e.payer && msg.sender != e.payee) revert Unauthorized();
        if (e.arbiter == address(0)) revert NoArbiter();
        e.disputed = true;
        emit Disputed(id, msg.sender);
    }

    /// @notice After the deadline, the payer takes back every still-pending milestone
    ///         (fixes the original POC's "freelancer disappears, funds locked forever" gap).
    function reclaimAfterDeadline(uint256 id) external {
        Escrow storage e = _escrows[id];
        if (msg.sender != e.payer) revert Unauthorized();
        if (block.timestamp < e.deadline) revert DeadlineNotReached();
        if (e.disputed) revert EscrowDisputed();

        uint256 amount;
        MilestoneState[] storage states = _states[id];
        for (uint256 i; i < states.length; ++i) {
            if (states[i] == MilestoneState.PENDING) {
                states[i] = MilestoneState.REFUNDED;
                amount += _amounts[id][i];
            }
        }
        if (amount == 0) revert NotPending();
        totalLocked -= amount;
        _credit(e.payer, amount);
        emit Reclaimed(id, amount);
    }

    /// @notice Pull settled cash to your own account.
    function withdraw() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        cash.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getEscrow(uint256 id)
        external
        view
        returns (Escrow memory escrow, uint256[] memory amounts, MilestoneState[] memory states)
    {
        return (_escrows[id], _amounts[id], _states[id]);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _settle(uint256 id, uint256 index, MilestoneState to) private returns (uint256 amount) {
        MilestoneState[] storage states = _states[id];
        if (index >= states.length) revert InvalidMilestone();
        if (states[index] != MilestoneState.PENDING) revert NotPending();
        states[index] = to;
        amount = _amounts[id][index];
        totalLocked -= amount;
    }

    function _credit(address account, uint256 amount) private {
        claimable[account] += amount;
        totalClaimable += amount;
    }
}
