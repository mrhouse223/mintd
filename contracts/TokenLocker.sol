// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title TokenLocker
/// @notice Lock any ERC-20 on Stable until a chosen unlock time. Anyone can
///         lock (devs locking team supply, LPs locking LP tokens, holders
///         proving diamond hands). Locks can only ever be withdrawn by their
///         owner after the unlock time; they can be extended, never shortened.
///         A small flat creation fee (native USDT0) goes to the platform.
interface IERC20L {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address f, address t, uint256 v) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

contract TokenLocker {
    struct Lock {
        address token;      // ERC-20 being locked
        address owner;      // who can withdraw / extend
        uint128 amount;     // amount locked (actual received, transfer-tax safe)
        uint64 unlockTime;  // withdrawable at/after this timestamp
        bool withdrawn;
    }

    Lock[] public locks;
    mapping(address => uint256[]) private _byOwner;
    mapping(address => uint256[]) private _byToken;
    mapping(address => uint256) public totalLocked; // per token, live amount

    address public owner;
    address public feeRecipient;
    uint256 public lockFee; // flat, in native USDT0

    uint256 private constant MAX_DURATION = 3650 days; // 10y hard cap
    bool private _entered;

    event Locked(uint256 indexed id, address indexed token, address indexed owner, uint256 amount, uint64 unlockTime);
    event Withdrawn(uint256 indexed id, address indexed token, address indexed owner, uint256 amount);
    event Extended(uint256 indexed id, uint64 newUnlockTime);

    modifier lockGuard() {
        require(!_entered, "reentrancy");
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address _feeRecipient, uint256 _lockFee) {
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        lockFee = _lockFee;
    }

    /// @notice Lock `amount` of `token` until `unlockTime`. Pays `lockFee` native.
    function lock(address token, uint256 amount, uint64 unlockTime) external payable lockGuard returns (uint256 id) {
        require(amount > 0, "zero amount");
        require(unlockTime > block.timestamp, "unlock in past");
        require(unlockTime <= block.timestamp + MAX_DURATION, "too long");
        require(msg.value == lockFee, "wrong fee");

        // transfer-tax safe: record what actually arrived
        uint256 before = IERC20L(token).balanceOf(address(this));
        require(IERC20L(token).transferFrom(msg.sender, address(this), amount), "transfer failed");
        uint256 received = IERC20L(token).balanceOf(address(this)) - before;
        require(received > 0, "nothing received");
        require(received <= type(uint128).max, "amount too large");

        id = locks.length;
        locks.push(Lock(token, msg.sender, uint128(received), unlockTime, false));
        _byOwner[msg.sender].push(id);
        _byToken[token].push(id);
        totalLocked[token] += received;

        if (lockFee > 0) {
            (bool ok, ) = feeRecipient.call{value: lockFee}("");
            require(ok, "fee transfer failed");
        }
        emit Locked(id, token, msg.sender, received, unlockTime);
    }

    /// @notice Withdraw a matured lock. Only the lock owner, only once.
    function withdraw(uint256 id) external lockGuard {
        Lock storage l = locks[id];
        require(msg.sender == l.owner, "not lock owner");
        require(!l.withdrawn, "already withdrawn");
        require(block.timestamp >= l.unlockTime, "still locked");
        l.withdrawn = true;
        totalLocked[l.token] -= l.amount;
        require(IERC20L(l.token).transfer(l.owner, l.amount), "transfer failed");
        emit Withdrawn(id, l.token, l.owner, l.amount);
    }

    /// @notice Push a lock's unlock time further out. Never shortens.
    function extend(uint256 id, uint64 newUnlockTime) external {
        Lock storage l = locks[id];
        require(msg.sender == l.owner, "not lock owner");
        require(!l.withdrawn, "already withdrawn");
        require(newUnlockTime > l.unlockTime, "can only extend");
        require(newUnlockTime <= block.timestamp + MAX_DURATION, "too long");
        l.unlockTime = newUnlockTime;
        emit Extended(id, newUnlockTime);
    }

    // ------------------------------------------------------------- views
    function lockCount() external view returns (uint256) { return locks.length; }
    function locksOf(address who) external view returns (uint256[] memory) { return _byOwner[who]; }
    function locksForToken(address token) external view returns (uint256[] memory) { return _byToken[token]; }

    // ------------------------------------------------------------- admin
    /// @dev Admin can only tune the flat fee and its destination. There is NO
    ///      admin path to locked tokens: no rescue, no sweep, no pause.
    function setFee(uint256 newFee, address newRecipient) external {
        require(msg.sender == owner, "not owner");
        require(newRecipient != address(0), "zero recipient");
        lockFee = newFee;
        feeRecipient = newRecipient;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "not owner");
        owner = newOwner;
    }
}
