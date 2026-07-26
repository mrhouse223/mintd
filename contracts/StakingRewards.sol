// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// ----------------------------------------------------------------------------
/// MintSwap Farm, a Synthetix-style staking rewards contract.
/// Stake MintSwap V2 LP tokens, earn $MINTD streamed linearly over a period.
/// The owner funds rewards and sets the duration; the owner can never touch
/// staked LP tokens.
/// ----------------------------------------------------------------------------

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract StakingRewards {
    IERC20F public immutable rewardsToken; // $MINTD
    IERC20F public immutable stakingToken; // MintSwap LP token

    address public owner;
    uint256 public periodFinish;
    uint256 public rewardRate;             // reward tokens per second (1e18 units)
    uint256 public rewardsDuration = 30 days;
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
    event RewardAdded(uint256 reward, uint256 duration);

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

    constructor(address _rewardsToken, address _stakingToken) {
        require(_rewardsToken != address(0) && _stakingToken != address(0), "zero addr");
        rewardsToken = IERC20F(_rewardsToken);
        stakingToken = IERC20F(_stakingToken);
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

    function getRewardForDuration() external view returns (uint256) {
        return rewardRate * rewardsDuration;
    }

    // ---------------------------------------------------------------- actions

    function stake(uint256 amount) external lock updateReward(msg.sender) {
        require(amount > 0, "zero stake");
        totalSupply += amount;
        balanceOf[msg.sender] += amount;
        require(stakingToken.transferFrom(msg.sender, address(this), amount), "stake transfer");
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) public lock updateReward(msg.sender) {
        require(amount > 0, "zero withdraw");
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        require(stakingToken.transfer(msg.sender, amount), "withdraw transfer");
        emit Withdrawn(msg.sender, amount);
    }

    function getReward() public lock updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            require(rewardsToken.transfer(msg.sender, reward), "reward transfer");
            emit RewardPaid(msg.sender, reward);
        }
    }

    function exit() external {
        withdraw(balanceOf[msg.sender]);
        getReward();
    }

    // ----------------------------------------------------------------- admin

    /// @notice Fund a reward period. Transfer the reward tokens to this
    /// contract FIRST, then call this. Rolls unspent rewards into the new
    /// period if one is still running.
    function notifyRewardAmount(uint256 reward) external onlyOwner updateReward(address(0)) {
        if (block.timestamp >= periodFinish) {
            rewardRate = reward / rewardsDuration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (reward + leftover) / rewardsDuration;
        }
        // solvency check: contract must hold enough rewards for the full period
        require(rewardRate <= rewardsToken.balanceOf(address(this)) / rewardsDuration, "reward > balance");
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(reward, rewardsDuration);
    }

    function setRewardsDuration(uint256 _duration) external onlyOwner {
        require(block.timestamp > periodFinish, "period active");
        require(_duration > 0, "zero duration");
        rewardsDuration = _duration;
    }

    /// @notice Rescue tokens sent here by mistake. Never the staked LP token.
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        require(token != address(stakingToken), "cannot touch stake");
        IERC20F(token).transfer(owner, amount);
    }

    function transferOwnership(address _owner) external onlyOwner {
        require(_owner != address(0), "zero addr");
        owner = _owner;
    }
}
