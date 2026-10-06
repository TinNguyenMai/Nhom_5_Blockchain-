// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Bounded batch double auction with pay-as-ask pricing.
/// @dev Wh and micro-SLC/Wh are integers. Delivery attestations trust the coordinator;
/// hashes bind evidence but do not authenticate sensors. This remains a demo-credit market.
contract EnergyMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum Side { Sell, Buy }
    enum Basis { Esp32Forecast, DemoCounterparty, SimulatedForecast, Esp32Telemetry }
    enum Mode { Replay, Live }
    enum BuyerCategory { Ordinary, Hospital, Kindergarten, SpecialHousehold }
    enum TradeStatus { Pending, Confirmed, Expired }
    struct Round {
        bytes32 key;
        uint64 closesAt;
        bool settled;
        Mode mode;
        uint64 confirmationDeadline;
    }
    struct Order {
        address trader;
        Side side;
        Basis basis;
        uint64 quantityWh;
        uint64 remainingWh;
        uint64 price;
        uint256 locked;
        bytes32 sourceId;
        bytes32 dataHash;
        bool cancelled;
        uint256 collateral;
        BuyerCategory buyerCategory;
    }
    struct Trade {
        uint32 buyIndex;
        uint32 sellIndex;
        uint64 quantityWh;
        uint64 price;
        uint256 cost;
        uint256 buyerCollateral;
        uint256 sellerCollateral;
        uint64 deliveredWh;
        bytes32 evidenceHash;
        TradeStatus status;
    }
    struct Reputation {
        uint16 score;
        uint256 ordersPlaced;
        uint256 ordersCancelled;
        uint256 successfulTrades;
        uint256 violations;
        uint256 expiredTrades;
        uint256 deliveredWh;
    }

    uint256 public constant MAX_ORDERS = 32;
    uint256 public constant MARKET_VERSION = 2;
    uint64 public constant MAX_QUANTITY_WH = 1_000_000_000;
    uint64 public constant MAX_PRICE = 1_000_000_000_000;
    uint64 public constant CONFIRMATION_WINDOW = 1 days;
    uint16 public constant SUCCESS_REWARD = 2;
    uint16 public constant VIOLATION_PENALTY = 20;
    IERC20 public immutable token;
    address public immutable coordinator;
    bytes32 public immutable deploymentId;
    uint256 public roundCount;
    mapping(address => bool) public participants;
    mapping(uint256 => Round) public rounds;
    mapping(bytes32 => uint256) public roundByKey;
    mapping(address => mapping(bytes32 => bool)) public sourceUsed;
    mapping(uint256 => mapping(address => bool)) public hasOrder;
    mapping(uint256 => Order[]) private books;
    mapping(uint256 => Trade[]) private fills;
    mapping(address => Reputation) public reputations;
    // Includes unclosed orders and matched trades awaiting confirmation, across all rounds.
    mapping(address => uint256) public activeQuantityWh;
    mapping(address => BuyerCategory) public buyerCategories;
    mapping(bytes32 => bool) public evidenceUsed;

    event RoundOpened(uint256 indexed roundId, bytes32 indexed key, uint64 closesAt, Mode mode);
    event OrderPlaced(uint256 indexed roundId, uint256 indexed orderIndex, address indexed trader,
                      Side side, uint64 quantityWh, uint64 price, Basis basis, bytes32 sourceId, bytes32 dataHash);
    event OrderCancelled(uint256 indexed roundId, uint256 indexed orderIndex);
    event TradeExecuted(uint256 indexed roundId, address indexed buyer, address indexed seller,
                        uint64 quantityWh, uint64 price, uint256 cost);
    event Refunded(uint256 indexed roundId, address indexed trader, uint256 amount);
    event RoundSettled(uint256 indexed roundId, uint256 tradeCount);
    event BuyerCategoryUpdated(address indexed trader, BuyerCategory category, bytes32 verificationHash);
    event ReputationUpdated(address indexed trader, uint16 score, bool violation);
    event TradeConfirmed(uint256 indexed roundId, uint256 indexed tradeIndex, uint64 deliveredWh,
                         uint256 paid, uint256 penalty, bytes32 evidenceHash);
    event TradeExpired(uint256 indexed roundId, uint256 indexed tradeIndex);
    event EscrowLocked(uint256 indexed roundId, address indexed trader, uint256 payment, uint256 collateral);

    error Unauthorized();
    error InvalidInput();
    error UnknownRound();
    error Closed();
    error TooEarly();
    error AlreadySettled();
    error Duplicate();
    error BookFull();
    error QuantityLimit();
    error AlreadyResolved();
    error ConfirmationExpired();

    constructor(IERC20 token_, address[] memory participants_, bytes32 deploymentId_) {
        if (address(token_).code.length == 0 || deploymentId_ == bytes32(0) ||
            participants_.length < 2 || participants_.length > MAX_ORDERS) revert InvalidInput();
        token = token_;
        coordinator = msg.sender;
        deploymentId = deploymentId_;
        for (uint256 i; i < participants_.length; ++i) {
            if (participants_[i] == address(0) || participants[participants_[i]]) revert InvalidInput();
            participants[participants_[i]] = true;
            reputations[participants_[i]].score = 100;
        }
    }

    function openRound(bytes32 key, uint64 biddingSeconds, Mode mode) external returns (uint256 id) {
        if (msg.sender != coordinator) revert Unauthorized();
        if (key == bytes32(0) || biddingSeconds < 2 || biddingSeconds > 3600) revert InvalidInput();
        if (roundByKey[key] != 0) revert Duplicate();
        id = ++roundCount;
        uint64 closesAt = uint64(block.timestamp) + biddingSeconds;
        rounds[id] = Round(key, closesAt, false, mode, closesAt + CONFIRMATION_WINDOW);
        roundByKey[key] = id;
        emit RoundOpened(id, key, rounds[id].closesAt, mode);
    }

    /// Only the coordinator can register a verified institution or special household.
    /// All non-ordinary categories have equal priority; orders snapshot this category.
    function setBuyerCategory(address trader, BuyerCategory category, bytes32 verificationHash) external {
        if (msg.sender != coordinator) revert Unauthorized();
        if (!participants[trader] || verificationHash == bytes32(0)) revert InvalidInput();
        buyerCategories[trader] = category;
        emit BuyerCategoryUpdated(trader, category, verificationHash);
    }

    function quantityLimitWh(address trader) public view returns (uint64) {
        if (!participants[trader]) return 0;
        uint16 score = reputations[trader].score;
        return score >= 80 ? MAX_QUANTITY_WH : score >= 50 ? MAX_QUANTITY_WH / 2 : MAX_QUANTITY_WH / 10;
    }

    function collateralBps(address trader) public view returns (uint16) {
        if (!participants[trader]) return 0;
        uint16 score = reputations[trader].score;
        return score >= 80 ? 0 : score >= 50 ? 1000 : 2500;
    }

    function quoteOrder(address trader, Side side, uint64 quantityWh, uint64 price)
        public view returns (uint256 payment, uint256 collateral)
    {
        if (!participants[trader] || quantityWh == 0 || quantityWh > MAX_QUANTITY_WH ||
            price == 0 || price > MAX_PRICE) revert InvalidInput();
        uint256 value = uint256(quantityWh) * price;
        payment = side == Side.Buy ? value : 0;
        // Round up so tiny orders cannot bypass collateral requirements.
        collateral = (value * collateralBps(trader) + 9999) / 10000;
    }

    function placeOrder(uint256 id, Side side, uint64 quantityWh, uint64 price,
                        Basis basis, bytes32 sourceId, bytes32 dataHash) external nonReentrant {
        if (!participants[msg.sender]) revert Unauthorized();
        Round storage r = _round(id);
        if (r.settled || block.timestamp >= r.closesAt) revert Closed();
        if (quantityWh == 0 || quantityWh > MAX_QUANTITY_WH || price == 0 || price > MAX_PRICE ||
            sourceId == bytes32(0) || dataHash == bytes32(0)) revert InvalidInput();
        if (hasOrder[id][msg.sender] || sourceUsed[msg.sender][sourceId]) revert Duplicate();
        if (books[id].length >= MAX_ORDERS) revert BookFull();
        if (activeQuantityWh[msg.sender] + quantityWh > quantityLimitWh(msg.sender)) revert QuantityLimit();
        hasOrder[id][msg.sender] = true;
        sourceUsed[msg.sender][sourceId] = true; // Even cancellation cannot replay the source.
        (uint256 locked, uint256 collateral) = quoteOrder(msg.sender, side, quantityWh, price);
        activeQuantityWh[msg.sender] += quantityWh;
        reputations[msg.sender].ordersPlaced++;
        books[id].push(Order(msg.sender, side, basis, quantityWh, quantityWh, price,
                             locked, sourceId, dataHash, false, collateral, buyerCategories[msg.sender]));
        if (locked + collateral > 0) token.safeTransferFrom(msg.sender, address(this), locked + collateral);
        emit EscrowLocked(id, msg.sender, locked, collateral);
        emit OrderPlaced(id, books[id].length - 1, msg.sender, side, quantityWh, price, basis, sourceId, dataHash);
    }

    function cancelOrder(uint256 id, uint256 index) external nonReentrant {
        Round storage r = _round(id);
        if (r.settled || block.timestamp >= r.closesAt) revert Closed();
        if (index >= books[id].length) revert InvalidInput();
        Order storage o = books[id][index];
        if (o.trader != msg.sender) revert Unauthorized();
        if (o.cancelled) revert Duplicate();
        o.cancelled = true;
        activeQuantityWh[o.trader] -= o.remainingWh;
        reputations[o.trader].ordersCancelled++;
        o.remainingWh = 0;
        _refund(id, o);
        emit OrderCancelled(id, index);
    }

    /// Anyone can clear after deadline, including when the coordinator is offline.
    /// Equal bids prefer verified priority buyers, then earlier insertion index.
    /// Matching alone never pays a seller. Matched escrow awaits delivery confirmation.
    function settle(uint256 id) external nonReentrant {
        Round storage r = _round(id);
        if (r.settled) revert AlreadySettled();
        if (block.timestamp < r.closesAt) revert TooEarly();
        r.settled = true;
        Order[] storage book = books[id];
        while (true) {
            uint256 buy = type(uint256).max;
            uint256 sell = type(uint256).max;
            for (uint256 i; i < book.length; ++i) {
                Order storage o = book[i];
                if (o.remainingWh == 0) continue;
                if (o.side == Side.Buy) {
                    if (buy == type(uint256).max || o.price > book[buy].price ||
                        (o.price == book[buy].price && o.buyerCategory != BuyerCategory.Ordinary &&
                         book[buy].buyerCategory == BuyerCategory.Ordinary)) buy = i;
                } else {
                    if (sell == type(uint256).max || o.price < book[sell].price) sell = i;
                }
            }
            if (buy == type(uint256).max || sell == type(uint256).max || book[buy].price < book[sell].price) break;
            Order storage b = book[buy];
            Order storage s = book[sell];
            uint64 quantity = b.remainingWh < s.remainingWh ? b.remainingWh : s.remainingWh;
            uint256 cost = uint256(quantity) * s.price;
            _lockTrade(id, buy, sell, quantity, cost);
            emit TradeExecuted(id, b.trader, s.trader, quantity, s.price, cost);
        }
        for (uint256 i; i < book.length; ++i) {
            activeQuantityWh[book[i].trader] -= book[i].remainingWh;
            _refund(id, book[i]);
        }
        emit RoundSettled(id, fills[id].length);
    }

    function _lockTrade(uint256 id, uint256 buy, uint256 sell, uint64 quantity, uint256 cost) private {
        Order storage b = books[id][buy];
        Order storage s = books[id][sell];
        uint256 bc = b.collateral * quantity / b.remainingWh;
        uint256 sc = s.collateral * quantity / s.remainingWh;
        b.collateral -= bc;
        s.collateral -= sc;
        b.remainingWh -= quantity;
        s.remainingWh -= quantity;
        b.locked -= cost;
        fills[id].push(Trade(uint32(buy), uint32(sell), quantity, s.price, cost, bc, sc,
                             0, bytes32(0), TradeStatus.Pending));
    }

    /// Attest measured delivery, never just a forecast. Under-delivery refunds the
    /// unfulfilled payment, reduces seller reputation and slashes proportional collateral.
    function confirmTrade(uint256 id, uint256 index, uint64 deliveredWh, bytes32 evidenceHash)
        external nonReentrant
    {
        if (msg.sender != coordinator) revert Unauthorized();
        Round storage r = _round(id);
        Trade storage t = _pendingTrade(id, index);
        if (block.timestamp >= r.confirmationDeadline) revert ConfirmationExpired();
        if (deliveredWh > t.quantityWh || evidenceHash == bytes32(0)) revert InvalidInput();
        if (evidenceUsed[evidenceHash]) revert Duplicate();
        evidenceUsed[evidenceHash] = true;
        t.status = TradeStatus.Confirmed;
        t.deliveredWh = deliveredWh;
        t.evidenceHash = evidenceHash;
        address buyer = books[id][t.buyIndex].trader;
        address seller = books[id][t.sellIndex].trader;
        _releaseQuantity(buyer, seller, t.quantityWh);
        uint256 paid = uint256(deliveredWh) * t.price;
        uint256 penalty = t.sellerCollateral * (t.quantityWh - deliveredWh) / t.quantityWh;
        reputations[buyer].deliveredWh += deliveredWh;
        reputations[seller].deliveredWh += deliveredWh;
        if (deliveredWh == t.quantityWh) {
            _recordOutcome(buyer, false);
            _recordOutcome(seller, false);
        } else {
            _recordOutcome(seller, true);
        }
        _transfer(seller, paid + t.sellerCollateral - penalty);
        _transfer(buyer, t.cost - paid + t.buyerCollateral + penalty);
        emit TradeConfirmed(id, index, deliveredWh, paid, penalty, evidenceHash);
    }

    /// Oracle downtime must not freeze funds or count as proven household misconduct.
    function expireTrade(uint256 id, uint256 index) external nonReentrant {
        Round storage r = _round(id);
        Trade storage t = _pendingTrade(id, index);
        if (block.timestamp < r.confirmationDeadline) revert TooEarly();
        t.status = TradeStatus.Expired;
        address buyer = books[id][t.buyIndex].trader;
        address seller = books[id][t.sellIndex].trader;
        _releaseQuantity(buyer, seller, t.quantityWh);
        reputations[buyer].expiredTrades++;
        reputations[seller].expiredTrades++;
        _transfer(buyer, t.cost + t.buyerCollateral);
        _transfer(seller, t.sellerCollateral);
        emit TradeExpired(id, index);
    }

    function _pendingTrade(uint256 id, uint256 index) private view returns (Trade storage t) {
        if (!rounds[id].settled || index >= fills[id].length) revert InvalidInput();
        t = fills[id][index];
        if (t.status != TradeStatus.Pending) revert AlreadyResolved();
    }

    function _releaseQuantity(address buyer, address seller, uint64 quantity) private {
        activeQuantityWh[buyer] -= quantity;
        activeQuantityWh[seller] -= quantity;
    }

    function _recordOutcome(address trader, bool violation) private {
        Reputation storage rep = reputations[trader];
        if (violation) {
            rep.violations++;
            rep.score = rep.score > VIOLATION_PENALTY ? rep.score - VIOLATION_PENALTY : 0;
        } else {
            rep.successfulTrades++;
            rep.score = rep.score + SUCCESS_REWARD > 100 ? 100 : rep.score + SUCCESS_REWARD;
        }
        emit ReputationUpdated(trader, rep.score, violation);
    }

    function _transfer(address trader, uint256 amount) private {
        if (amount > 0) token.safeTransfer(trader, amount);
    }

    function getOrders(uint256 id) external view returns (Order[] memory) { _round(id); return books[id]; }
    function getTrades(uint256 id) external view returns (Trade[] memory) { _round(id); return fills[id]; }

    function _round(uint256 id) private view returns (Round storage r) {
        r = rounds[id];
        if (r.key == bytes32(0)) revert UnknownRound();
    }

    function _refund(uint256 id, Order storage o) private {
        uint256 amount = o.locked + o.collateral;
        if (amount == 0) return;
        o.locked = 0;
        o.collateral = 0;
        token.safeTransfer(o.trader, amount);
        emit Refunded(id, o.trader, amount);
    }
}
