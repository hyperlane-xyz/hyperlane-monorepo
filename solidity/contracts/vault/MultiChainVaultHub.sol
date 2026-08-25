// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IMultiChainVaultHub} from "../interfaces/IMultiChainVaultHub.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {CrossChainVaultMessage} from "./libs/CrossChainVaultMessage.sol";

/**
 * @title MultiChainVaultHub
 * @notice Master Hub ERC-4626 Vault coordinating cross-chain liquidity, NAV aggregation,
 * portfolio drift calculation, and automated cross-chain rebalancing via Hyperlane.
 */
contract MultiChainVaultHub is
    ERC4626,
    Ownable,
    Pausable,
    ReentrancyGuard,
    IMultiChainVaultHub,
    IMessageRecipient
{
    using SafeERC20 for IERC20;
    using Math for uint256;

    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant RAY = 1e18;

    // Hyperlane configuration
    IMailbox public mailbox;
    uint32 public immutable localDomain;

    // Fee configuration
    uint256 public managementFeeBps; // e.g. 200 bps = 2% per annum
    uint256 public performanceFeeBps; // e.g. 1000 bps = 10% of profit above HWM
    address public feeRecipient;
    uint256 public lastFeeAccrualTimestamp;
    uint256 public highWaterMarkNavPerShare; // Scaled by RAY (1e18)

    // Drift and rebalancing parameters
    uint256 public driftThresholdBps; // e.g. 500 bps = 5%

    // Strategy registry
    mapping(uint32 => StrategyAllocation) public strategies;
    uint32[] public strategyDomains;
    mapping(uint32 => bool) public isStrategyRegistered;

    /**
     * @notice Constructor initializing the vault hub with fee parameters, Mailbox, and ERC-4626 token.
     */
    constructor(
        IERC20 _asset,
        string memory _name,
        string memory _symbol,
        address _mailbox,
        uint32 _localDomain,
        address _feeRecipient,
        uint256 _managementFeeBps,
        uint256 _performanceFeeBps,
        uint256 _driftThresholdBps
    )
        ERC20(_name, _symbol)
        ERC4626(_asset)
        Ownable(msg.sender)
    {
        require(_mailbox != address(0), "Invalid Mailbox address");
        require(_managementFeeBps <= 1000, "Management fee cannot exceed 10%");
        require(_performanceFeeBps <= 3000, "Performance fee cannot exceed 30%");
        require(_driftThresholdBps <= 5000, "Drift threshold cannot exceed 50%");

        mailbox = IMailbox(_mailbox);
        localDomain = _localDomain;
        feeRecipient = _feeRecipient;
        managementFeeBps = _managementFeeBps;
        performanceFeeBps = _performanceFeeBps;
        driftThresholdBps = _driftThresholdBps;

        lastFeeAccrualTimestamp = block.timestamp;
        highWaterMarkNavPerShare = RAY; // Initial HWM = 1.0 (in RAY)
    }

    /**
     * @dev Virtual offset mechanism: returns 3 to add virtual shares/assets in OpenZeppelin ERC-4626.
     * This defends against 1-wei share inflation / donation front-running attacks.
     */
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    /**
     * @notice Accrues management fees (per annum on total NAV) and performance fees (against High-Water Mark).
     */
    function accrueFees() public {
        uint256 elapsed = block.timestamp - lastFeeAccrualTimestamp;
        uint256 currentTotalNav = totalPortfolioNav();
        uint256 currentSupply = totalSupply();

        if (currentTotalNav > 0 && currentSupply > 0) {
            uint256 managementFeeAssets = 0;
            if (elapsed > 0 && managementFeeBps > 0 && feeRecipient != address(0)) {
                managementFeeAssets = (currentTotalNav * managementFeeBps * elapsed) / (SECONDS_PER_YEAR * BPS_DENOMINATOR);
            }

            uint256 performanceFeeAssets = 0;
            uint256 offsetMultiplier = 10 ** _decimalsOffset();
            // NAV per share scaled by RAY (1e18) taking virtual offset into account
            uint256 currentNavPerShare = (currentTotalNav * RAY * offsetMultiplier) / currentSupply;
            if (currentNavPerShare > highWaterMarkNavPerShare) {
                if (performanceFeeBps > 0 && feeRecipient != address(0)) {
                    uint256 profitPerShare = currentNavPerShare - highWaterMarkNavPerShare;
                    uint256 totalProfitAssets = (profitPerShare * currentSupply) / (RAY * offsetMultiplier);
                    performanceFeeAssets = (totalProfitAssets * performanceFeeBps) / BPS_DENOMINATOR;
                }
                highWaterMarkNavPerShare = currentNavPerShare;
            }

            uint256 totalFeeAssets = managementFeeAssets + performanceFeeAssets;
            if (totalFeeAssets > 0 && feeRecipient != address(0)) {
                uint256 feeShares = _convertToShares(totalFeeAssets, Math.Rounding.Floor);
                if (feeShares > 0) {
                    _mint(feeRecipient, feeShares);
                    emit FeesAccrued(
                        _convertToShares(managementFeeAssets, Math.Rounding.Floor),
                        _convertToShares(performanceFeeAssets, Math.Rounding.Floor),
                        block.timestamp
                    );
                }
            }
        }

        lastFeeAccrualTimestamp = block.timestamp;
    }

    /**
     * @notice Computes total portfolio NAV across Hub local assets and all spoke strategy reported NAVs.
     */
    function totalPortfolioNav() public view override returns (uint256) {
        uint256 totalNav = IERC20(asset()).balanceOf(address(this));
        uint256 length = strategyDomains.length;
        for (uint256 i = 0; i < length; i++) {
            uint32 domain = strategyDomains[i];
            totalNav += strategies[domain].lastReportedNav;
        }
        return totalNav;
    }

    /**
     * @notice ERC-4626 totalAssets override returning global aggregate NAV.
     */
    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        return totalPortfolioNav();
    }

    /**
     * @notice Limits maximum withdrawal to the physically available local liquidity in the Hub.
     */
    function maxWithdraw(address owner) public view override(ERC4626, IERC4626) returns (uint256) {
        uint256 ownerMax = super.maxWithdraw(owner);
        uint256 localBal = IERC20(asset()).balanceOf(address(this));
        return localBal < ownerMax ? localBal : ownerMax;
    }

    /**
     * @notice Limits maximum redemption to the physically available local liquidity in the Hub.
     */
    function maxRedeem(address owner) public view override(ERC4626, IERC4626) returns (uint256) {
        uint256 ownerMax = super.maxRedeem(owner);
        uint256 localBal = IERC20(asset()).balanceOf(address(this));
        uint256 localBalInShares = convertToShares(localBal);
        return localBalInShares < ownerMax ? localBalInShares : ownerMax;
    }

    /**
     * @notice Registers or updates a spoke strategy adapter and its target allocation weight.
     * @param domain Hyperlane domain ID of the spoke chain.
     * @param adapter Bytes32-formatted address of the spoke strategy adapter.
     * @param targetWeightBps Target allocation weight in basis points (total <= 10,000).
     */
    function setStrategy(
        uint32 domain,
        bytes32 adapter,
        uint256 targetWeightBps
    ) external override onlyOwner {
        require(domain != localDomain, "Cannot register local domain as spoke strategy");
        require(adapter != bytes32(0), "Invalid adapter address");

        // Validate total target weight across all strategies
        uint256 totalTargetWeight = targetWeightBps;
        uint256 length = strategyDomains.length;
        for (uint256 i = 0; i < length; i++) {
            uint32 d = strategyDomains[i];
            if (d != domain) {
                totalTargetWeight += strategies[d].targetWeightBps;
            }
        }
        require(totalTargetWeight <= BPS_DENOMINATOR, "Total target weight exceeds 10,000 bps");

        if (!isStrategyRegistered[domain]) {
            isStrategyRegistered[domain] = true;
            strategyDomains.push(domain);
            strategies[domain] = StrategyAllocation({
                domain: domain,
                adapter: adapter,
                targetWeightBps: targetWeightBps,
                currentAllocatedAssets: 0,
                lastReportedNav: 0,
                lastReportTimestamp: block.timestamp
            });
            emit StrategyAdded(domain, adapter, targetWeightBps);
        } else {
            strategies[domain].adapter = adapter;
            strategies[domain].targetWeightBps = targetWeightBps;
            emit StrategyUpdated(domain, targetWeightBps);
        }
    }

    /**
     * @notice Removes a spoke strategy from the registry.
     * @param domain Domain ID of the strategy to remove.
     */
    function removeStrategy(uint32 domain) external override onlyOwner {
        require(isStrategyRegistered[domain], "Strategy not registered");
        require(
            strategies[domain].lastReportedNav == 0 && strategies[domain].currentAllocatedAssets == 0,
            "Strategy has active NAV or allocated assets"
        );

        isStrategyRegistered[domain] = false;
        delete strategies[domain];

        uint256 length = strategyDomains.length;
        for (uint256 i = 0; i < length; i++) {
            if (strategyDomains[i] == domain) {
                strategyDomains[i] = strategyDomains[length - 1];
                strategyDomains.pop();
                break;
            }
        }

        emit StrategyRemoved(domain);
    }

    /**
     * @notice Computes maximum portfolio allocation drift against configured target weights.
     * @return maxDriftBps Maximum allocation drift in basis points.
     * @return needsRebalance True if maxDriftBps >= driftThresholdBps.
     */
    function calculateDrift() public view override returns (uint256 maxDriftBps, bool needsRebalance) {
        uint256 totalNav = totalPortfolioNav();
        uint256 length = strategyDomains.length;

        if (totalNav == 0 || length == 0) {
            return (0, false);
        }

        maxDriftBps = 0;
        for (uint256 i = 0; i < length; i++) {
            uint32 domain = strategyDomains[i];
            StrategyAllocation memory strat = strategies[domain];

            uint256 currentWeightBps = (strat.lastReportedNav * BPS_DENOMINATOR) / totalNav;
            uint256 drift = currentWeightBps > strat.targetWeightBps
                ? currentWeightBps - strat.targetWeightBps
                : strat.targetWeightBps - currentWeightBps;

            if (drift > maxDriftBps) {
                maxDriftBps = drift;
            }
        }

        needsRebalance = (maxDriftBps >= driftThresholdBps);
    }

    /**
     * @notice Dispatches cross-chain rebalance orders via Hyperlane Mailbox.
     * @param orders List of RebalanceOrder structs defining source, target, amount, slippage, and deadline.
     * @param gasQuote Gas fee to supply for each cross-chain Mailbox dispatch.
     */
    function triggerRebalance(
        RebalanceOrder[] calldata orders,
        uint256 gasQuote
    ) external payable override nonReentrant whenNotPaused {
        require(orders.length > 0, "No rebalance orders provided");
        accrueFees();

        uint256 totalRebalanced = 0;
        uint256 requiredMsgValue = 0;

        for (uint256 i = 0; i < orders.length; i++) {
            RebalanceOrder calldata order = orders[i];
            require(order.deadline >= block.timestamp, "Rebalance order expired: deadline passed");
            require(order.amount > 0, "Rebalance amount must be greater than zero");
            require(order.minAmountOut > 0, "minAmountOut must be greater than zero");

            // Process source domain
            if (order.sourceDomain == localDomain) {
                require(
                    IERC20(asset()).balanceOf(address(this)) >= order.amount,
                    "Insufficient Hub local assets for rebalance"
                );
            } else {
                require(isStrategyRegistered[order.sourceDomain], "Source strategy domain not registered");
                StrategyAllocation storage srcStrat = strategies[order.sourceDomain];
                require(srcStrat.lastReportedNav >= order.amount, "Source strategy NAV insufficient for rebalance");

                bytes memory withdrawMsg = CrossChainVaultMessage.encodeRebalanceExecute(
                    srcStrat.adapter,
                    order.amount,
                    order.minAmountOut,
                    order.deadline,
                    ""
                );

                mailbox.dispatch{value: gasQuote}(order.sourceDomain, srcStrat.adapter, withdrawMsg);
                requiredMsgValue += gasQuote;

                srcStrat.lastReportedNav -= order.amount;
                if (srcStrat.currentAllocatedAssets >= order.amount) {
                    srcStrat.currentAllocatedAssets -= order.amount;
                } else {
                    srcStrat.currentAllocatedAssets = 0;
                }
            }

            // Process target domain
            if (order.targetDomain == localDomain) {
                // Funds returned to Hub
            } else {
                require(isStrategyRegistered[order.targetDomain], "Target strategy domain not registered");
                StrategyAllocation storage dstStrat = strategies[order.targetDomain];

                bytes memory depositMsg = CrossChainVaultMessage.encodeDeposit(
                    dstStrat.adapter,
                    order.amount,
                    order.minAmountOut,
                    order.deadline,
                    ""
                );

                mailbox.dispatch{value: gasQuote}(order.targetDomain, dstStrat.adapter, depositMsg);
                requiredMsgValue += gasQuote;

                dstStrat.lastReportedNav += order.amount;
                dstStrat.currentAllocatedAssets += order.amount;
            }

            totalRebalanced += order.amount;
        }

        require(msg.value >= requiredMsgValue, "Insufficient msg.value for cross-chain gas fees");
        emit RebalanceTriggered(totalRebalanced, block.timestamp);
    }

    /**
     * @notice Two-layer authenticated entry point for incoming Hyperlane Mailbox messages.
     * @param _origin Origin domain ID where message was dispatched.
     * @param _sender Sender address (in bytes32) on the origin domain.
     * @param _message Encoded message payload.
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable override nonReentrant whenNotPaused {
        // Layer 1: Verify caller is the trusted Hyperlane Mailbox
        require(msg.sender == address(mailbox), "Unauthorized: caller is not Mailbox");

        // Layer 2: Verify sender is the registered spoke strategy adapter for the origin domain
        require(isStrategyRegistered[_origin], "Unauthorized: origin domain not registered");
        require(strategies[_origin].adapter == _sender, "Unauthorized: sender adapter mismatch");

        CrossChainVaultMessage.Message memory msgData = CrossChainVaultMessage.parse(_message);
        require(msgData.deadline >= block.timestamp, "Received message expired");

        if (msgData.msgType == CrossChainVaultMessage.TYPE_NAV_REPORT) {
            _updateStrategyNav(_origin, msgData.amount);
        }
    }

    /**
     * @notice Updates the reported NAV for a strategy domain.
     */
    function reportStrategyNav(uint32 domain, uint256 currentNav) external override {
        require(
            msg.sender == owner() || msg.sender == address(this) || msg.sender == address(mailbox),
            "Unauthorized NAV reporter"
        );
        require(isStrategyRegistered[domain], "Strategy domain not registered");
        _updateStrategyNav(domain, currentNav);
    }

    function _updateStrategyNav(uint32 domain, uint256 currentNav) internal {
        accrueFees();
        strategies[domain].lastReportedNav = currentNav;
        strategies[domain].lastReportTimestamp = block.timestamp;
        emit StrategyReportReceived(domain, currentNav, block.timestamp);
    }

    /**
     * @notice Returns strategy allocation details for a domain.
     */
    function getStrategy(uint32 domain) external view override returns (StrategyAllocation memory) {
        require(isStrategyRegistered[domain], "Strategy domain not registered");
        return strategies[domain];
    }

    /**
     * @notice Returns all registered strategy domain IDs.
     */
    function getStrategyDomains() external view override returns (uint32[] memory) {
        return strategyDomains;
    }

    // --- ERC-4626 Overrides with Fee Accrual and Pausability ---

    function deposit(uint256 assets, address receiver) public override(ERC4626, IERC4626) whenNotPaused nonReentrant returns (uint256) {
        accrueFees();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override(ERC4626, IERC4626) whenNotPaused nonReentrant returns (uint256) {
        accrueFees();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner) public override(ERC4626, IERC4626) whenNotPaused nonReentrant returns (uint256) {
        accrueFees();
        return super.withdraw(assets, receiver, owner);
    }

    function redeem(uint256 shares, address receiver, address owner) public override(ERC4626, IERC4626) whenNotPaused nonReentrant returns (uint256) {
        accrueFees();
        return super.redeem(shares, receiver, owner);
    }

    // --- Admin and Emergency Functions ---

    function pause() external onlyOwner {
        _pause();
        emit EmergencyPauseToggled(true);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit EmergencyPauseToggled(false);
    }

    function setDriftThresholdBps(uint256 _newThreshold) external onlyOwner {
        require(_newThreshold <= 5000, "Drift threshold cannot exceed 50%");
        emit DriftThresholdUpdated(driftThresholdBps, _newThreshold);
        driftThresholdBps = _newThreshold;
    }

    function setFeeConfig(
        uint256 _managementFeeBps,
        uint256 _performanceFeeBps,
        address _feeRecipient
    ) external onlyOwner {
        require(_managementFeeBps <= 1000, "Management fee cannot exceed 10%");
        require(_performanceFeeBps <= 3000, "Performance fee cannot exceed 30%");
        accrueFees();
        managementFeeBps = _managementFeeBps;
        performanceFeeBps = _performanceFeeBps;
        feeRecipient = _feeRecipient;
        emit FeeConfigUpdated(_managementFeeBps, _performanceFeeBps, _feeRecipient);
    }

    function setMailbox(address _mailbox) external onlyOwner {
        require(_mailbox != address(0), "Invalid Mailbox address");
        mailbox = IMailbox(_mailbox);
    }
}
