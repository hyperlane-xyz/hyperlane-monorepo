// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.24;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Quote} from "../interfaces/ITokenBridge.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {ReentrancyGuardTransient} from "../libs/ReentrancyGuardTransient.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

interface IFlashCcrRouter {
    function localDomain() external view returns (uint32);

    function token() external view returns (address);

    function quoteTransferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external view returns (Quote[] memory);

    function transferRemoteTo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _targetRouter
    ) external payable returns (bytes32);
}

interface IAaveV3FlashPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IUniswapV3FlashPool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function flash(
        address recipient,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external;
}

/**
 * @title FlashCcrRebalancer
 * @notice Atomically rebalances same-chain CrossCollateralRouter pools using a
 *         flashloan, a same-domain transferRemoteTo, and caller-supplied swap
 *         calldata.
 * @dev The contract is intentionally not a generic multicall surface. The only
 *      arbitrary call is one allowlisted swap target with bounded token input
 *      and an enforced output balance increase. It never receives approval from
 *      warp route adapters; it only deposits the borrowed token through
 *      transferRemoteTo and repays the flashloan before the transaction ends.
 */
contract FlashCcrRebalancer is
    Ownable,
    PackageVersioned,
    ReentrancyGuardTransient
{
    using Address for address;
    using SafeERC20 for IERC20;
    using TypeCasts for address;
    using TypeCasts for bytes32;

    enum FlashLoanProvider {
        AaveV3,
        UniswapV3
    }

    struct FlashLoanParams {
        FlashLoanProvider provider;
        address providerAddress;
        address token;
        uint256 amount;
    }

    struct CcrParams {
        address deficitRouter;
        address surplusRouter;
        bytes32 targetRouter;
        uint32 localDomain;
        uint256 amount;
        uint256 maxDeficitTokenDebit;
        uint256 minSurplusReceived;
    }

    struct SwapCall {
        address target;
        address allowanceTarget;
        address tokenIn;
        address tokenOut;
        uint256 amountInMax;
        uint256 minAmountOut;
        uint256 value;
        bytes data;
    }

    struct TopUpParams {
        address payer;
        uint256 maxSurplusTokenTopUp;
        uint256 maxDeficitTokenTopUp;
    }

    struct RebalanceParams {
        FlashLoanParams loan;
        CcrParams ccr;
        SwapCall swap;
        TopUpParams topUp;
        address refundTo;
        uint256 deadline;
    }

    error UnauthorizedRebalancer(address caller);
    error UnauthorizedFlashLoanProvider(
        FlashLoanProvider provider,
        address pool
    );
    error UnauthorizedSwapTarget(address target);
    error UnauthorizedAllowanceTarget(address target);
    error CallbackNotActive();
    error CallbackAlreadyEntered();
    error InvalidCallbackSender(address sender);
    error InvalidAaveInitiator(address initiator);
    error DeadlineExceeded(uint256 deadline);
    error InvalidRefundRecipient();
    error InvalidTopUpPayer();
    error InvalidRouterToken(address router, address expected, address actual);
    error InvalidLocalDomain(address router, uint32 expected, uint32 actual);
    error InvalidTargetRouter(bytes32 expected, bytes32 actual);
    error InvalidLoanAsset(address expected, address actual);
    error InvalidLoanAmount(uint256 expected, uint256 actual);
    error UnsupportedQuoteToken(address token, uint256 amount);
    error CcrDebitExceedsMax(uint256 debit, uint256 maxDebit);
    error InsufficientSurplusReceived(uint256 received, uint256 minimum);
    error TopUpLimitExceeded(address token, uint256 required, uint256 max);
    error InsufficientSwapOutput(uint256 received, uint256 minimum);
    error InsufficientRepayment(uint256 balance, uint256 debt);

    event RebalancerSet(address indexed rebalancer, bool allowed);
    event FlashLoanProviderSet(
        FlashLoanProvider indexed provider,
        address indexed pool,
        bool allowed
    );
    event SwapTargetSet(address indexed target, bool allowed);
    event AllowanceTargetSet(address indexed target, bool allowed);
    event FlashCcrRebalanceExecuted(
        FlashLoanProvider indexed provider,
        address indexed flashLoanProvider,
        address indexed deficitRouter,
        address surplusRouter,
        address deficitToken,
        address surplusToken,
        uint256 ccrAmount,
        uint256 flashDebt,
        uint256 surplusReceived,
        uint256 swapOutput
    );

    mapping(address rebalancer => bool allowed) public allowedRebalancers;
    mapping(FlashLoanProvider provider => mapping(address pool => bool allowed))
        public allowedFlashLoanProviders;
    mapping(address target => bool allowed) public allowedSwapTargets;
    mapping(address target => bool allowed) public allowedAllowanceTargets;

    bytes32 private activeParamsHash;
    FlashLoanProvider private activeProvider;
    address private activeFlashLoanProvider;
    bool private activeCallbackEntered;
    bool private activeCallbackConsumed;
    uint256 private activeSurplusTopUpPulled;

    constructor(address _owner) Ownable() {
        _transferOwnership(_owner);
    }

    receive() external payable {}

    function setRebalancer(
        address rebalancer,
        bool allowed
    ) external onlyOwner {
        allowedRebalancers[rebalancer] = allowed;
        emit RebalancerSet(rebalancer, allowed);
    }

    function setFlashLoanProvider(
        FlashLoanProvider provider,
        address pool,
        bool allowed
    ) external onlyOwner {
        allowedFlashLoanProviders[provider][pool] = allowed;
        emit FlashLoanProviderSet(provider, pool, allowed);
    }

    function setSwapTarget(address target, bool allowed) external onlyOwner {
        allowedSwapTargets[target] = allowed;
        emit SwapTargetSet(target, allowed);
    }

    function setAllowanceTarget(
        address target,
        bool allowed
    ) external onlyOwner {
        allowedAllowanceTargets[target] = allowed;
        emit AllowanceTargetSet(target, allowed);
    }

    function rebalance(
        RebalanceParams calldata params
    ) external payable nonReentrant {
        _validateEntry(params);
        bytes memory callbackData = abi.encode(params);
        _activate(params, callbackData);

        if (params.loan.provider == FlashLoanProvider.AaveV3) {
            IAaveV3FlashPool(params.loan.providerAddress).flashLoanSimple(
                address(this),
                params.loan.token,
                params.loan.amount,
                callbackData,
                0
            );
        } else {
            _startUniswapFlash(params, callbackData);
        }

        _clearAaveApproval(params);
        _refundTopUp(
            params.swap.tokenIn,
            params.topUp.payer,
            activeSurplusTopUpPulled
        );
        _clearActive();
        _refund(params.loan.token, params.refundTo);
        _refund(params.swap.tokenIn, params.refundTo);
        _refund(address(0), params.refundTo);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (initiator != address(this)) revert InvalidAaveInitiator(initiator);
        RebalanceParams memory decoded = _validateCallback(
            FlashLoanProvider.AaveV3,
            asset,
            amount,
            params
        );
        uint256 debt = amount + premium;
        _enterCallback();
        _executeAfterBorrow(decoded, debt, false);
        _exitCallback();
        return true;
    }

    function uniswapV3FlashCallback(
        uint256 fee0,
        uint256 fee1,
        bytes calldata params
    ) external {
        _validateRawCallback(FlashLoanProvider.UniswapV3, params);
        RebalanceParams memory decoded = abi.decode(params, (RebalanceParams));
        (address token0, address token1) = _uniswapPoolTokens(msg.sender);
        (address borrowedToken, uint256 fee) = decoded.loan.token == token0
            ? (token0, fee0)
            : (token1, fee1);

        _validateCallback(
            FlashLoanProvider.UniswapV3,
            borrowedToken,
            decoded.loan.amount,
            params
        );
        uint256 debt = decoded.loan.amount + fee;
        _enterCallback();
        _executeAfterBorrow(decoded, debt, true);
        _exitCallback();
    }

    function _validateEntry(RebalanceParams calldata params) internal view {
        if (!allowedRebalancers[msg.sender]) {
            revert UnauthorizedRebalancer(msg.sender);
        }
        if (params.deadline < block.timestamp) {
            revert DeadlineExceeded(params.deadline);
        }
        if (params.refundTo == address(0)) revert InvalidRefundRecipient();
        if (
            !allowedFlashLoanProviders[params.loan.provider][
                params.loan.providerAddress
            ]
        ) {
            revert UnauthorizedFlashLoanProvider(
                params.loan.provider,
                params.loan.providerAddress
            );
        }
        if (!allowedSwapTargets[params.swap.target]) {
            revert UnauthorizedSwapTarget(params.swap.target);
        }
        if (!allowedAllowanceTargets[params.swap.allowanceTarget]) {
            revert UnauthorizedAllowanceTarget(params.swap.allowanceTarget);
        }
        if (
            params.topUp.payer == address(0) &&
            (params.topUp.maxSurplusTokenTopUp > 0 ||
                params.topUp.maxDeficitTokenTopUp > 0)
        ) {
            revert InvalidTopUpPayer();
        }
    }

    function _activate(
        RebalanceParams calldata params,
        bytes memory callbackData
    ) internal {
        activeParamsHash = keccak256(callbackData);
        activeProvider = params.loan.provider;
        activeFlashLoanProvider = params.loan.providerAddress;
    }

    function _clearActive() internal {
        delete activeParamsHash;
        delete activeProvider;
        delete activeFlashLoanProvider;
        delete activeCallbackEntered;
        delete activeCallbackConsumed;
        delete activeSurplusTopUpPulled;
    }

    function _startUniswapFlash(
        RebalanceParams calldata params,
        bytes memory callbackData
    ) internal {
        (address token0, address token1) = _uniswapPoolTokens(
            params.loan.providerAddress
        );
        if (params.loan.token != token0 && params.loan.token != token1) {
            revert InvalidLoanAsset(params.loan.token, address(0));
        }
        uint256 amount0 = params.loan.token == token0 ? params.loan.amount : 0;
        uint256 amount1 = params.loan.token == token1 ? params.loan.amount : 0;
        IUniswapV3FlashPool(params.loan.providerAddress).flash(
            address(this),
            amount0,
            amount1,
            callbackData
        );
    }

    function _validateRawCallback(
        FlashLoanProvider provider,
        bytes calldata params
    ) internal view {
        if (activeParamsHash == bytes32(0)) revert CallbackNotActive();
        if (provider != activeProvider) revert CallbackNotActive();
        if (msg.sender != activeFlashLoanProvider) {
            revert InvalidCallbackSender(msg.sender);
        }
        if (keccak256(params) != activeParamsHash) revert CallbackNotActive();
    }

    function _enterCallback() internal {
        if (activeCallbackEntered || activeCallbackConsumed) {
            revert CallbackAlreadyEntered();
        }
        activeCallbackEntered = true;
        activeCallbackConsumed = true;
    }

    function _exitCallback() internal {
        activeCallbackEntered = false;
    }

    function _validateCallback(
        FlashLoanProvider provider,
        address asset,
        uint256 amount,
        bytes calldata params
    ) internal view returns (RebalanceParams memory decoded) {
        _validateRawCallback(provider, params);

        decoded = abi.decode(params, (RebalanceParams));
        if (asset != decoded.loan.token) {
            revert InvalidLoanAsset(decoded.loan.token, asset);
        }
        if (amount != decoded.loan.amount) {
            revert InvalidLoanAmount(decoded.loan.amount, amount);
        }
    }

    function _executeAfterBorrow(
        RebalanceParams memory params,
        uint256 debt,
        bool repayByTransfer
    ) internal {
        address deficitToken = _validateCcr(params);
        address surplusToken = IFlashCcrRouter(params.ccr.surplusRouter)
            .token();

        uint256 deficitTopUpUsed = _executeCcr(params, deficitToken);
        (uint256 surplusReceived, uint256 swapOutput) = _executeSwap(
            params,
            surplusToken,
            deficitToken
        );
        _repayOrApprove(
            params,
            debt,
            deficitTopUpUsed,
            repayByTransfer,
            deficitToken
        );

        emit FlashCcrRebalanceExecuted(
            params.loan.provider,
            params.loan.providerAddress,
            params.ccr.deficitRouter,
            params.ccr.surplusRouter,
            deficitToken,
            surplusToken,
            params.ccr.amount,
            debt,
            surplusReceived,
            swapOutput
        );
    }

    function _validateCcr(
        RebalanceParams memory params
    ) internal view returns (address deficitToken) {
        IFlashCcrRouter deficitRouter = IFlashCcrRouter(
            params.ccr.deficitRouter
        );
        IFlashCcrRouter surplusRouter = IFlashCcrRouter(
            params.ccr.surplusRouter
        );

        deficitToken = deficitRouter.token();
        if (deficitToken != params.loan.token) {
            revert InvalidRouterToken(
                params.ccr.deficitRouter,
                params.loan.token,
                deficitToken
            );
        }
        address surplusToken = surplusRouter.token();
        if (surplusToken != params.swap.tokenIn) {
            revert InvalidRouterToken(
                params.ccr.surplusRouter,
                params.swap.tokenIn,
                surplusToken
            );
        }
        if (params.swap.tokenOut != deficitToken) {
            revert InvalidLoanAsset(deficitToken, params.swap.tokenOut);
        }

        uint32 deficitDomain = deficitRouter.localDomain();
        if (deficitDomain != params.ccr.localDomain) {
            revert InvalidLocalDomain(
                params.ccr.deficitRouter,
                params.ccr.localDomain,
                deficitDomain
            );
        }
        uint32 surplusDomain = surplusRouter.localDomain();
        if (surplusDomain != params.ccr.localDomain) {
            revert InvalidLocalDomain(
                params.ccr.surplusRouter,
                params.ccr.localDomain,
                surplusDomain
            );
        }

        bytes32 expectedTarget = params.ccr.surplusRouter.addressToBytes32();
        if (expectedTarget != params.ccr.targetRouter) {
            revert InvalidTargetRouter(expectedTarget, params.ccr.targetRouter);
        }
    }

    function _executeCcr(
        RebalanceParams memory params,
        address deficitToken
    ) internal returns (uint256 deficitTopUpUsed) {
        uint256 debit = _quoteDeficitTokenDebit(params, deficitToken);
        if (debit > params.ccr.maxDeficitTokenDebit) {
            revert CcrDebitExceedsMax(debit, params.ccr.maxDeficitTokenDebit);
        }

        deficitTopUpUsed = _pullDeficitTopUpIfNeeded(
            params,
            debit,
            0,
            deficitToken
        );

        IERC20(deficitToken).forceApprove(params.ccr.deficitRouter, debit);
        uint256 surplusBefore = IERC20(params.swap.tokenIn).balanceOf(
            address(this)
        );
        IFlashCcrRouter(params.ccr.deficitRouter).transferRemoteTo(
            params.ccr.localDomain,
            address(this).addressToBytes32(),
            params.ccr.amount,
            params.ccr.targetRouter
        );
        IERC20(deficitToken).forceApprove(params.ccr.deficitRouter, 0);

        uint256 surplusReceived = IERC20(params.swap.tokenIn).balanceOf(
            address(this)
        ) - surplusBefore;
        if (surplusReceived < params.ccr.minSurplusReceived) {
            revert InsufficientSurplusReceived(
                surplusReceived,
                params.ccr.minSurplusReceived
            );
        }
    }

    function _quoteDeficitTokenDebit(
        RebalanceParams memory params,
        address deficitToken
    ) internal view returns (uint256 debit) {
        Quote[] memory quotes = IFlashCcrRouter(params.ccr.deficitRouter)
            .quoteTransferRemoteTo(
                params.ccr.localDomain,
                address(this).addressToBytes32(),
                params.ccr.amount,
                params.ccr.targetRouter
            );

        for (uint256 i = 0; i < quotes.length; i++) {
            if (quotes[i].amount == 0) continue;
            if (quotes[i].token != deficitToken) {
                revert UnsupportedQuoteToken(quotes[i].token, quotes[i].amount);
            }
            debit += quotes[i].amount;
        }
    }

    function _executeSwap(
        RebalanceParams memory params,
        address surplusToken,
        address deficitToken
    ) internal returns (uint256 surplusReceived, uint256 swapOutput) {
        surplusReceived = IERC20(surplusToken).balanceOf(address(this));
        if (surplusReceived < params.swap.amountInMax) {
            uint256 topUpAmount = params.swap.amountInMax - surplusReceived;
            _pullTopUp(
                surplusToken,
                params.topUp.payer,
                topUpAmount,
                params.topUp.maxSurplusTokenTopUp
            );
            activeSurplusTopUpPulled += topUpAmount;
        }

        IERC20(surplusToken).forceApprove(
            params.swap.allowanceTarget,
            params.swap.amountInMax
        );
        uint256 deficitBefore = IERC20(deficitToken).balanceOf(address(this));
        params.swap.target.functionCallWithValue(
            params.swap.data,
            params.swap.value
        );
        IERC20(surplusToken).forceApprove(params.swap.allowanceTarget, 0);

        swapOutput =
            IERC20(deficitToken).balanceOf(address(this)) -
            deficitBefore;
        if (swapOutput < params.swap.minAmountOut) {
            revert InsufficientSwapOutput(swapOutput, params.swap.minAmountOut);
        }
    }

    function _repayOrApprove(
        RebalanceParams memory params,
        uint256 debt,
        uint256 deficitTopUpUsed,
        bool repayByTransfer,
        address deficitToken
    ) internal {
        uint256 balance = IERC20(deficitToken).balanceOf(address(this));
        if (balance < debt) {
            _pullDeficitTopUpIfNeeded(
                params,
                debt,
                deficitTopUpUsed,
                deficitToken
            );
            balance = IERC20(deficitToken).balanceOf(address(this));
        }
        if (balance < debt) revert InsufficientRepayment(balance, debt);

        if (repayByTransfer) {
            IERC20(deficitToken).safeTransfer(
                params.loan.providerAddress,
                debt
            );
        } else {
            IERC20(deficitToken).forceApprove(
                params.loan.providerAddress,
                debt
            );
        }
    }

    function _pullDeficitTopUpIfNeeded(
        RebalanceParams memory params,
        uint256 requiredBalance,
        uint256 alreadyUsed,
        address deficitToken
    ) internal returns (uint256 totalUsed) {
        uint256 balance = IERC20(deficitToken).balanceOf(address(this));
        totalUsed = alreadyUsed;
        if (balance >= requiredBalance) return totalUsed;

        uint256 needed = requiredBalance - balance;
        uint256 remaining = params.topUp.maxDeficitTokenTopUp - alreadyUsed;
        _pullTopUp(deficitToken, params.topUp.payer, needed, remaining);
        totalUsed += needed;
    }

    function _pullTopUp(
        address token,
        address payer,
        uint256 amount,
        uint256 maxAmount
    ) internal {
        if (amount == 0) return;
        if (amount > maxAmount)
            revert TopUpLimitExceeded(token, amount, maxAmount);
        if (payer == address(0)) revert InvalidTopUpPayer();
        IERC20(token).safeTransferFrom(payer, address(this), amount);
    }

    function _clearAaveApproval(RebalanceParams calldata params) internal {
        if (params.loan.provider == FlashLoanProvider.AaveV3) {
            IERC20(params.loan.token).forceApprove(
                params.loan.providerAddress,
                0
            );
        }
    }

    function _refundTopUp(
        address token,
        address payer,
        uint256 maxAmount
    ) internal {
        if (maxAmount == 0) return;
        if (payer == address(0)) revert InvalidTopUpPayer();

        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 refundAmount = balance < maxAmount ? balance : maxAmount;
        if (refundAmount > 0) IERC20(token).safeTransfer(payer, refundAmount);
    }

    function _refund(address token, address recipient) internal {
        if (token == address(0)) {
            uint256 nativeBalance = address(this).balance;
            if (nativeBalance > 0)
                Address.sendValue(payable(recipient), nativeBalance);
            return;
        }
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) IERC20(token).safeTransfer(recipient, balance);
    }

    function _uniswapPoolTokens(
        address pool
    ) internal view returns (address token0, address token1) {
        token0 = IUniswapV3FlashPool(pool).token0();
        token1 = IUniswapV3FlashPool(pool).token1();
    }
}
