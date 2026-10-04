// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PurposeBoundMoney
/// @notice Programmable vouchers backed 1:1 by locked tokenized cash, in the spirit of
///         purpose-bound money (PBM) designs: a sponsor (e.g. a government agency or employer)
///         funds a program, recipients can only spend it at approved merchants before expiry,
///         and the merchant receives ordinary cash. Unspent value returns to the sponsor.
///
///         The underlying cash is never re-minted: the wrapper only adds spending rules.
contract PurposeBoundMoney is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Program {
        address sponsor;
        uint64 expiry;
        bool reclaimed;
        uint256 outstanding; // issued and not yet spent or reclaimed
        string name;
    }

    IERC20 public immutable cash;

    uint256 public programCount;
    mapping(uint256 => Program) private _programs;
    mapping(uint256 => mapping(address => bool)) public isApprovedMerchant;
    mapping(uint256 => mapping(address => uint256)) public balanceOf;

    /// @notice Sum of `outstanding` across all programs; always <= cash held by this contract.
    uint256 public totalOutstanding;

    event ProgramCreated(uint256 indexed id, address indexed sponsor, string name, uint64 expiry);
    event MerchantSet(uint256 indexed id, address indexed merchant, bool approved);
    event VouchersIssued(uint256 indexed id, address indexed recipient, uint256 amount);
    event VoucherSpent(uint256 indexed id, address indexed holder, address indexed merchant, uint256 amount, bytes32 ref);
    event ProgramReclaimed(uint256 indexed id, uint256 amount);

    error Unauthorized();
    error Expired();
    error NotExpired();
    error MerchantNotApproved(address merchant);
    error InsufficientVoucherBalance(uint256 balance, uint256 amount);
    error LengthMismatch();
    error ZeroAmount();
    error AlreadyReclaimed();
    error ExpiryInPast();

    constructor(IERC20 cash_) {
        cash = cash_;
    }

    modifier onlySponsor(uint256 id) {
        if (msg.sender != _programs[id].sponsor) revert Unauthorized();
        _;
    }

    function createProgram(string calldata name, uint64 expiry, address[] calldata merchants)
        external
        returns (uint256 id)
    {
        if (expiry <= block.timestamp) revert ExpiryInPast();
        id = ++programCount;
        _programs[id] = Program(msg.sender, expiry, false, 0, name);
        emit ProgramCreated(id, msg.sender, name, expiry);
        for (uint256 i; i < merchants.length; ++i) {
            isApprovedMerchant[id][merchants[i]] = true;
            emit MerchantSet(id, merchants[i], true);
        }
    }

    function setMerchant(uint256 id, address merchant, bool approved) external onlySponsor(id) {
        isApprovedMerchant[id][merchant] = approved;
        emit MerchantSet(id, merchant, approved);
    }

    /// @notice Fund vouchers for many recipients. Sponsor must `approve` the sum first.
    function issue(uint256 id, address[] calldata recipients, uint256[] calldata amounts)
        external
        onlySponsor(id)
        nonReentrant
    {
        if (recipients.length != amounts.length) revert LengthMismatch();
        Program storage p = _programs[id];
        if (block.timestamp >= p.expiry) revert Expired();

        uint256 total;
        for (uint256 i; i < recipients.length; ++i) {
            if (amounts[i] == 0) revert ZeroAmount();
            balanceOf[id][recipients[i]] += amounts[i];
            total += amounts[i];
            emit VouchersIssued(id, recipients[i], amounts[i]);
        }
        p.outstanding += total;
        totalOutstanding += total;
        cash.safeTransferFrom(msg.sender, address(this), total);
    }

    /// @notice Spend vouchers at an approved merchant. The merchant receives plain cash.
    function spend(uint256 id, address merchant, uint256 amount, bytes32 ref) external nonReentrant {
        Program storage p = _programs[id];
        if (block.timestamp >= p.expiry) revert Expired();
        if (!isApprovedMerchant[id][merchant]) revert MerchantNotApproved(merchant);
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[id][msg.sender];
        if (bal < amount) revert InsufficientVoucherBalance(bal, amount);

        balanceOf[id][msg.sender] = bal - amount;
        p.outstanding -= amount;
        totalOutstanding -= amount;
        cash.safeTransfer(merchant, amount);
        emit VoucherSpent(id, msg.sender, merchant, amount, ref);
    }

    /// @notice After expiry, the sponsor recovers every unspent voucher in one call.
    function reclaimExpired(uint256 id) external onlySponsor(id) nonReentrant {
        Program storage p = _programs[id];
        if (block.timestamp < p.expiry) revert NotExpired();
        if (p.reclaimed) revert AlreadyReclaimed();
        p.reclaimed = true;
        uint256 amount = p.outstanding;
        p.outstanding = 0;
        totalOutstanding -= amount;
        if (amount > 0) cash.safeTransfer(p.sponsor, amount);
        emit ProgramReclaimed(id, amount);
    }

    function getProgram(uint256 id) external view returns (Program memory) {
        return _programs[id];
    }

    /// @notice Spendable balance (0 once the program has expired).
    function spendableBalance(uint256 id, address holder) external view returns (uint256) {
        if (block.timestamp >= _programs[id].expiry) return 0;
        return balanceOf[id][holder];
    }
}
