// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenRouter} from "../token/libs/TokenRouter.sol";

/**
 * @title NetFlowRateLimited
 * @notice Token bucket for local collateral net outflow.
 * @dev Capacity is derived from local collateral TVL. Consumes represent local
 * collateral leaving the router. Credits represent local collateral entering it.
 *
 * @dev TVL is assumed to change only via Hyperlane operations (inbound process /
 * outbound dispatch), each of which touches the bucket. Under this assumption,
 * `maxCapacity()` evolves only across bucket touches, and the
 * `min(filledLevel, capacity)` clamp in `calculateCurrentLevel` is defensive
 * (it only fires under externally-driven TVL changes, which are out of scope
 * for warp routes). Donations to the router are tolerated but only grow TVL,
 * never shrink it.
 *
 * @dev Intended usage: routes whose `_message.body().amount()` is denominated
 * in the same units as `localCollateral()` — namely HypERC20, HypERC20Collateral,
 * HypNative, and HypERC4626Collateral (shares-on-shares). NOT for HypXERC20 /
 * HypXERC20Lockbox / HypFiatToken: those mint/burn external tokens so
 * `balanceOf(router) == 0` and capacity collapses; they have their own bridge-
 * level rate limits.
 *
 * @dev Intended usage: composed under an authenticating ISM (e.g. AggregationIsm
 * with MultisigIsm). `verify()` here authenticates flow only — composition
 * with a signature-validating ISM is the responsibility of the deployer.
 */
contract NetFlowRateLimited {
    enum TvlSource {
        BALANCE,
        TOTAL_SUPPLY
    }

    uint256 public constant DURATION = 1 days;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    address public immutable token;
    address public immutable collateral;
    uint256 public immutable maxFlowBps;
    TvlSource public immutable tvlSource;

    uint256 public filledLevel;
    uint256 public lastUpdated;
    bool public isInitialized;

    event ConsumedNetFlow(uint256 filledLevel, uint256 lastUpdated);
    event CreditedNetFlow(uint256 filledLevel, uint256 lastUpdated);

    constructor(address _router, uint256 _maxFlowBps) {
        require(_router != address(0), "InvalidRouter");
        // Bps == 10_000 is degenerate: in the synthetic-outbound case the router
        // burns sender supply before `_postDispatch` runs, so `totalSupply()`
        // (and hence capacity) collapses to (pre-burn − amount), gating the
        // dispatch on filledLevel without any usable headroom.
        require(_maxFlowBps < BPS_DENOMINATOR, "InvalidMaxFlowBps");

        address _token = TokenRouter(_router).token();
        token = _token;
        collateral = _router;
        maxFlowBps = _maxFlowBps;
        tvlSource = _token == _router
            ? TvlSource.TOTAL_SUPPLY
            : TvlSource.BALANCE;
    }

    function localCollateral() public view returns (uint256) {
        if (tvlSource == TvlSource.TOTAL_SUPPLY) {
            return IERC20(token).totalSupply();
        }

        if (token == address(0)) {
            return collateral.balance;
        }
        return IERC20(token).balanceOf(collateral);
    }

    function maxCapacity() public view returns (uint256) {
        return (localCollateral() * maxFlowBps) / BPS_DENOMINATOR;
    }

    function calculateCurrentLevel() public view returns (uint256) {
        uint256 capacity = maxCapacity();

        if (!isInitialized) {
            return capacity;
        }

        uint256 baseLevel = filledLevel > capacity ? capacity : filledLevel;
        if (block.timestamp > lastUpdated + DURATION) {
            return capacity;
        }

        uint256 elapsed = block.timestamp - lastUpdated;
        uint256 replenishedLevel = baseLevel +
            ((elapsed * capacity) / DURATION);

        return replenishedLevel > capacity ? capacity : replenishedLevel;
    }

    function _validateAndConsumeNetFlow(
        uint256 _amount
    ) internal returns (uint256) {
        uint256 adjustedFilledLevel = calculateCurrentLevel();
        require(_amount <= adjustedFilledLevel, "RateLimitExceeded");

        uint256 _filledLevel = adjustedFilledLevel - _amount;
        filledLevel = _filledLevel;
        lastUpdated = block.timestamp;
        isInitialized = true;

        emit ConsumedNetFlow(filledLevel, lastUpdated);

        return _filledLevel;
    }

    function _creditNetFlow(uint256 _amount) internal returns (uint256) {
        uint256 capacity = maxCapacity();
        uint256 adjustedFilledLevel = calculateCurrentLevel() + _amount;
        uint256 _filledLevel = adjustedFilledLevel > capacity
            ? capacity
            : adjustedFilledLevel;

        filledLevel = _filledLevel;
        lastUpdated = block.timestamp;
        isInitialized = true;

        emit CreditedNetFlow(filledLevel, lastUpdated);

        return _filledLevel;
    }
}
