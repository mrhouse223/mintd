// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title BondMarket
/// @notice Discounted, vesting token sales. A creator escrows tokens up front,
///         buyers pay USDT0 for them at a fixed price, and the tokens release
///         over a vesting period instead of hitting the pool at once.
///
/// WHY THE ESCROW COMES FIRST
/// The whole point is that the raise needs no trust. Tokens are in this contract
/// before a buyer can pay a cent, and the only route back out to the creator is
/// the UNSOLD remainder after the sale window closes. There is no admin path to
/// escrowed tokens and no path at all to a buyer's vested balance.
///
/// WHY NO USDT0 IS EVER HELD HERE
/// buy() forwards the fee and the creator's net in the same call. The contract
/// therefore custodies exactly one asset class, the escrowed tokens, which
/// removes an entire category of stuck-funds and accounting bugs. There is
/// deliberately no withdrawRaised().
///
/// WHY AN ALLOWLIST
/// An ERC-20 that taxes transfers, rebases, blacklists this contract, mints
/// fresh supply or pauses can all turn a funded bond into a permanent revert,
/// and buyers would have already paid. Launchpad coins cannot do any of it
/// (no owner, no mint, no hooks), so they are allowed by construction; anything
/// else is added by hand after being read on chain.
interface IERC20B {
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address f, address t, uint256 v) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}

contract BondMarket {
    struct Bond {
        address token;         // what is being sold
        address creator;       // who escrowed it, and who gets the net raise
        uint128 escrowed;      // tokens actually received, transfer-tax safe
        uint128 sold;          // tokens allocated to buyers so far
        uint128 price;         // quote units (6-dec) per 1e18 tokens
        uint128 walletCap;     // max tokens one address may buy, 0 = uncapped
        uint64  saleStart;
        uint64  saleEnd;
        uint32  vestDuration;  // seconds over which a purchase releases
        uint32  vestStep;      // 0/1 = per-second, 600 = every 10 minutes
        uint16  feeBps;        // snapshotted at create, see setParams
        bool    reclaimed;
    }

    struct Position {
        uint128 total;   // tokens owed to this buyer on this bond
        uint128 claimed; // tokens already taken
        uint128 bought;  // lifetime purchased, only ever grows, caps are on this
        uint64  start;   // vesting clock, set at purchase
    }

    Bond[] public bonds;
    mapping(uint256 => mapping(address => Position)) public positions;
    mapping(address => uint256[]) private _byCreator;
    mapping(address => uint256[]) private _byToken;

    /// Live escrow per token. Lets a deposit measure its own delta even when
    /// several bonds on the same token share this contract's balance.
    mapping(address => uint256) public heldOf;

    address public immutable usdt0;
    address[] public pads;          // launchpad tokens are allowed implicitly
    mapping(address => bool) public allowed; // everything else, set by hand

    address public owner;
    address public feeRecipient;
    uint256 public feeBps;          // taken from the buyer's payment
    uint256 public createFee;       // flat, native, anti-spam
    bool public paused;             // blocks create and buy, never claim

    uint256 public constant MAX_FEE_BPS = 300;
    uint256 private constant MAX_VEST = 3650 days;
    uint256 private constant MAX_SALE = 365 days;

    bool private _entered;

    event BondCreated(uint256 indexed id, address indexed token, address indexed creator,
                      uint256 escrowed, uint256 price, uint64 saleStart, uint64 saleEnd,
                      uint32 vestDuration, uint32 vestStep);
    event Bought(uint256 indexed id, address indexed buyer, uint256 paid, uint256 fee, uint256 tokens);
    event Claimed(uint256 indexed id, address indexed buyer, uint256 tokens);
    event Reclaimed(uint256 indexed id, address indexed creator, uint256 tokens);
    event AllowSet(address indexed token, bool ok);
    event PadAdded(address indexed pad);
    event ParamsSet(uint256 feeBps, uint256 createFee, address feeRecipient);
    event PausedSet(bool paused);

    modifier guard() {
        require(!_entered, "reentrancy");
        _entered = true;
        _;
        _entered = false;
    }
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _usdt0, address _feeRecipient, uint256 _feeBps, uint256 _createFee, address[] memory _pads) {
        require(_usdt0 != address(0) && _feeRecipient != address(0), "zero");
        require(_feeBps <= MAX_FEE_BPS, "fee too high");
        usdt0 = _usdt0;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        createFee = _createFee;
        pads = _pads;
        owner = msg.sender;
    }

    // ------------------------------------------------------------- allowlist

    /// @notice Whether `token` may be bonded. Launchpad coins qualify on their
    ///         own; everything else has to be listed explicitly.
    function isAllowed(address token) public view returns (bool) {
        // An unknown key makes a pad's launches() getter return a ZERO struct,
        // whose first word equals address(0), so the check below would say yes
        // to the zero address. create() would still fail on the balanceOf, but
        // anything reading this as "is this a launchpad token" would be wrong.
        if (token == address(0)) return false;
        if (allowed[token]) return true;
        for (uint256 i = 0; i < pads.length; i++) {
            // Low-level because the two pads return DIFFERENT launches() structs
            // (the old one has no `quote` field), so no single interface decodes
            // both. Only the first word is read, and `token` is the first member
            // on either, so this is shape-independent.
            (bool ok, bytes memory data) =
                pads[i].staticcall(abi.encodeWithSignature("launches(address)", token));
            if (ok && data.length >= 32 && address(uint160(uint256(bytes32(data)))) == token) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- create

    /// @notice Escrow `amount` of `token` and open a bond for it.
    /// @param price quote units (6-dec USDT0) per 1e18 tokens. Absolute, so no
    ///        oracle is read here or later: a manipulated spot price cannot
    ///        change what a bond costs once it exists.
    /// The sale window is a DELAY and a DURATION, not two absolute timestamps.
    /// A caller passing absolute times has to know the chain's clock, and any
    /// skew between reading it and being mined silently puts the window in the
    /// past. Relative arguments cannot be stale by construction.
    function create(
        address token,
        uint256 amount,
        uint128 price,
        uint32 startDelay,
        uint32 saleDuration,
        uint32 vestDuration,
        uint32 vestStep,
        uint128 walletCap
    ) external payable guard returns (uint256 id) {
        require(!paused, "paused");
        require(isAllowed(token), "token not allowed");
        require(amount > 0, "zero amount");
        require(price > 0, "zero price");
        require(msg.value == createFee, "wrong fee");
        require(saleDuration > 0 && saleDuration <= MAX_SALE, "bad window");
        require(startDelay <= MAX_SALE, "start too far");
        require(vestDuration > 0 && vestDuration <= MAX_VEST, "bad vest");
        require(vestStep <= vestDuration, "step > duration");
        uint64 saleStart = uint64(block.timestamp) + startDelay;
        uint64 saleEnd = saleStart + saleDuration;

        // Measured, never assumed. A token that takes a cut on transfer would
        // otherwise leave the bond promising more than it holds, and the
        // shortfall would only surface when the last buyer failed to claim.
        uint256 before = IERC20B(token).balanceOf(address(this));
        require(IERC20B(token).transferFrom(msg.sender, address(this), amount), "escrow failed");
        uint256 got = IERC20B(token).balanceOf(address(this)) - before;
        require(got > 0, "received nothing");
        require(got <= type(uint128).max, "too large");
        heldOf[token] += got;

        id = bonds.length;
        bonds.push(Bond({
            token: token, creator: msg.sender, escrowed: uint128(got), sold: 0,
            price: price, walletCap: walletCap, saleStart: saleStart, saleEnd: saleEnd,
            vestDuration: vestDuration, vestStep: vestStep, feeBps: uint16(feeBps), reclaimed: false
        }));
        _byCreator[msg.sender].push(id);
        _byToken[token].push(id);

        if (createFee > 0) {
            (bool s, ) = payable(feeRecipient).call{value: msg.value}("");
            require(s, "fee send");
        }
        emit BondCreated(id, token, msg.sender, got, price, saleStart, saleEnd, vestDuration, vestStep);
    }

    // ------------------------------------------------------------------- buy

    /// @notice Pay `quoteIn` USDT0 for a vesting claim on bond `id`.
    ///
    /// The fee comes OUT of `quoteIn` rather than being added on top, so the
    /// figure the page advertises is the figure that leaves the buyer's wallet,
    /// and the discount quoted is the discount received. Tokens are priced on
    /// the full payment; the creator nets the rest.
    function buy(uint256 id, uint256 quoteIn, uint256 minTokens) external guard returns (uint256 tokensOut) {
        require(!paused, "paused");
        Bond storage b = bonds[id];
        require(block.timestamp >= b.saleStart, "not open");
        require(block.timestamp < b.saleEnd, "closed");
        require(quoteIn > 0, "zero");

        tokensOut = (quoteIn * 1e18) / b.price;
        require(tokensOut > 0, "dust");
        require(tokensOut >= minTokens, "slippage");
        require(b.sold + tokensOut <= b.escrowed, "sold out");

        Position storage p = positions[id][msg.sender];
        // Capped on LIFETIME purchases, not on the live position. Capping the
        // position would let a buyer claim, shrink it, and buy the cap again.
        if (b.walletCap > 0) require(p.bought + tokensOut <= b.walletCap, "wallet cap");

        // A second purchase on the same bond settles whatever has vested and
        // restarts the schedule on the combined remainder. Tokens are conserved
        // either way; what it costs is that buying again pushes back the tail of
        // the earlier purchase, which is why the UI should say so rather than
        // hide it.
        uint256 settle = 0;
        if (p.total > 0) {
            uint256 v = _vested(b, p);
            settle = v - p.claimed;
            p.total = uint128(uint256(p.total) - v);
            p.claimed = 0;
        }
        p.total += uint128(tokensOut);
        p.bought += uint128(tokensOut);
        p.start = uint64(block.timestamp);
        b.sold += uint128(tokensOut);

        // The bond's OWN rate, not the live one. A creator who opened a raise
        // expecting to net 99% must not be moved to 97% by a setParams call
        // made after buyers were already looking at the terms.
        uint256 fee = (quoteIn * b.feeBps) / 10000;
        require(IERC20B(usdt0).transferFrom(msg.sender, feeRecipient, fee), "fee xfer");
        require(IERC20B(usdt0).transferFrom(msg.sender, b.creator, quoteIn - fee), "pay xfer");
        emit Bought(id, msg.sender, quoteIn, fee, tokensOut);

        // Last, after every storage write, so a token with a transfer hook
        // re-entering finds the books already settled.
        if (settle > 0) {
            heldOf[b.token] -= settle;
            require(IERC20B(b.token).transfer(msg.sender, settle), "settle failed");
            emit Claimed(id, msg.sender, settle);
        }
    }

    // ----------------------------------------------------------------- claim

    /// @notice Tokens released to `buyer` so far but not yet taken.
    function claimable(uint256 id, address buyer) public view returns (uint256) {
        Bond storage b = bonds[id];
        Position storage p = positions[id][buyer];
        if (p.total == 0) return 0;
        return _vested(b, p) - p.claimed;
    }

    /// @notice Take everything released so far.
    ///
    /// Never blocked by pause: a buyer has already paid, and their schedule is
    /// not the protocol's to interrupt.
    function claim(uint256 id) external guard returns (uint256 amount) {
        Bond storage b = bonds[id];
        Position storage p = positions[id][msg.sender];
        require(p.total > 0, "nothing");
        amount = _vested(b, p) - p.claimed;
        require(amount > 0, "not vested");
        p.claimed += uint128(amount);
        heldOf[b.token] -= amount;
        require(IERC20B(b.token).transfer(msg.sender, amount), "payout failed");
        emit Claimed(id, msg.sender, amount);
    }

    /// Cumulative, never incremental. `total * elapsed / duration` recomputed
    /// from scratch each time is what makes claiming once and claiming every
    /// block pay the same total: an incremental version divides on every call
    /// and loses a wei each time, which strands dust forever.
    function _vested(Bond storage b, Position storage p) internal view returns (uint256) {
        if (block.timestamp <= p.start) return 0;
        uint256 elapsed = block.timestamp - p.start;
        // Stepped mode holds the released amount flat between ticks. Same curve,
        // sampled: the 10-minute option is this with step = 600.
        if (b.vestStep > 1) elapsed = (elapsed / b.vestStep) * b.vestStep;
        if (elapsed >= b.vestDuration) return p.total;
        return (uint256(p.total) * elapsed) / b.vestDuration;
    }

    // --------------------------------------------------------------- reclaim

    /// @notice Return the UNSOLD remainder to the creator once the window has
    ///         closed. Sold tokens are never reachable from here.
    function reclaim(uint256 id) external guard returns (uint256 amount) {
        Bond storage b = bonds[id];
        require(msg.sender == b.creator, "not creator");
        require(block.timestamp >= b.saleEnd, "sale open");
        require(!b.reclaimed, "done");
        b.reclaimed = true;
        amount = b.escrowed - b.sold;
        require(amount > 0, "nothing unsold");
        heldOf[b.token] -= amount;
        require(IERC20B(b.token).transfer(b.creator, amount), "reclaim failed");
        emit Reclaimed(id, b.creator, amount);
    }

    // ----------------------------------------------------------------- views

    function bondCount() external view returns (uint256) { return bonds.length; }
    function byCreator(address a) external view returns (uint256[] memory) { return _byCreator[a]; }
    function byToken(address t) external view returns (uint256[] memory) { return _byToken[t]; }
    function padCount() external view returns (uint256) { return pads.length; }

    /// @notice Everything a bond card needs, in one call.
    function view_(uint256 id, address buyer)
        external view
        returns (Bond memory b, uint256 remaining, uint256 owed, Position memory p)
    {
        b = bonds[id];
        remaining = b.reclaimed ? 0 : b.escrowed - b.sold;
        p = positions[id][buyer];
        owed = claimable(id, buyer);
    }

    // ----------------------------------------------------------------- admin

    function setAllowed(address token, bool ok) external onlyOwner {
        allowed[token] = ok;
        emit AllowSet(token, ok);
    }
    function addPad(address p) external onlyOwner { require(p != address(0), "zero"); pads.push(p); emit PadAdded(p); }

    /// Bounded so a compromised owner cannot turn the fee into a confiscation.
    /// Existing bonds are unaffected in their pricing; the fee applies to buys
    /// made after the change, which is why the cap matters.
    function setParams(uint256 _feeBps, uint256 _createFee, address _feeRecipient) external onlyOwner {
        require(_feeBps <= MAX_FEE_BPS, "fee too high");
        require(_feeRecipient != address(0), "zero");
        feeBps = _feeBps;
        createFee = _createFee;
        feeRecipient = _feeRecipient;
        emit ParamsSet(_feeBps, _createFee, _feeRecipient);
    }
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    function transferOwnership(address n) external onlyOwner { require(n != address(0), "zero"); owner = n; }
}
