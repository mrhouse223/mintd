// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// FarmRewards, a Synthetix-style staking rewards farm for mintd.fun.
///
/// Users stake an LP token (e.g. the USDT0/wgUSDT Uniswap V2 pair) and earn a
/// reward token ($MINTD) streamed linearly over a reward period. The owner
/// funds each period by transferring reward tokens to this contract and
/// calling notifyRewardAmount. Standard, widely-audited accounting model
/// (rewardPerTokenStored / userRewardPerTokenPaid).
/// ----------------------------------------------------------------------------

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract FarmRewards {
    IERC20F public immutable rewardsToken; // $MINTD
    IERC20F public immutable stakingToken; // LP token

    address public owner;
    uint256 public duration;          // reward period length in seconds
    uint256 public periodFinish;
    uint256 public rewardRate;        // reward tokens per second (1e18 units)
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 private unlocked = 1;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(uint256 reward, uint256 rate, uint256 periodFinish);

    modifier lock() {
        require(unlocked == 1, "reentrancy");
        unlocked = 0;
        _;
        unlocked = 1;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    constructor(address _rewardsToken, address _stakingToken, uint256 _duration) {
        require(_rewardsToken != address(0) && _stakingToken != address(0), "zero addr");
        require(_rewardsToken != _stakingToken, "same token");
        require(_duration >= 1 days && _duration <= 365 days, "bad duration");
        rewardsToken = IERC20F(_rewardsToken);
        stakingToken = IERC20F(_stakingToken);
        duration = _duration;
        owner = msg.sender;
    }

    // ----------------------------------------------------------------- views

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalSupply == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18) / totalSupply;
    }

    function earned(address account) public view returns (uint256) {
        return (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 + rewards[account];
    }

    function rewardForDuration() external view returns (uint256) {
        return rewardRate * duration;
    }

    // ------------------------------------------------------------------ user

    function stake(uint256 amount) external lock updateReward(msg.sender) {
        require(amount > 0, "zero stake");
        totalSupply += amount;
        balanceOf[msg.sender] += amount;
        require(stakingToken.transferFrom(msg.sender, address(this), amount), "stake xfer");
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public lock updateReward(msg.sender) {
        require(amount > 0, "zero withdraw");
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        require(stakingToken.transfer(msg.sender, amount), "withdraw xfer");
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public lock updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            require(rewardsToken.transfer(msg.sender, reward), "reward xfer");
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        withdraw(balanceOf[msg.sender]);
        getReward();
    }

    // ----------------------------------------------------------------- admin

    /// @notice Fund a reward period. Transfer the reward tokens to this
    /// contract FIRST, then call this with the amount. If a period is active,
    /// the leftover rolls into the new period.
    function notifyRewardAmount(uint256 reward) external onlyOwner updateReward(address(0)) {
        if (block.timestamp >= periodFinish) {
            rewardRate = reward / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (reward + leftover) / duration;
        }
        require(rewardRate > 0, "rate zero");
        // solvency check: contract must hold enough rewards for the full period
        require(rewardsToken.balanceOf(address(this)) >= rewardRate * duration, "underfunded");
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardAdded(reward, rewardRate, periodFinish);
    }

    /// @notice Change period length; only between periods.
    function setDuration(uint256 _duration) external onlyOwner {
        require(block.timestamp >= periodFinish, "period active");
        require(_duration >= 1 days && _duration <= 365 days, "bad duration");
        duration = _duration;
    }

    /// @notice Rescue tokens sent by mistake. Staked LP can never be touched.
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        require(token != address(stakingToken), "no staking token");
        IERC20F(token).transfer(owner, amount);
    }

    function transferOwnership(address _owner) external onlyOwner {
        require(_owner != address(0), "zero addr");
        owner = _owner;
    }
}
