// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IYieldStrategyAdapter} from "../interfaces/IYieldStrategyAdapter.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {IMessageRecipient} from "../interfaces/IMessageRecipient.sol";
import {CrossChainVaultMessage} from "./libs/CrossChainVaultMessage.sol";
import {TypeCasts} from "./libs/TypeCasts.sol";

/**
 * @title CrossChainStrategyAdapter
 * @notice Spoke chain adapter integrating local ERC-4626 yield protocols with Hyperlane cross-chain messaging.
 */
contract CrossChainStrategyAdapter is
    IYieldStrategyAdapter,
    IMessageRecipient,
    Ownable,
    Pausable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    IMailbox public mailbox;
    uint32 public immutable hubDomain;
    bytes32 public immutable hubVault;
    IERC20 public immutable underlyingAsset;
    IERC4626 public immutable yieldStrategy;

    constructor(
        address _mailbox,
        uint32 _hubDomain,
        bytes32 _hubVault,
        address _underlyingAsset,
        address _yieldStrategy,
        address _initialOwner
    ) Ownable(_initialOwner) {
        require(_mailbox != address(0), "Invalid Mailbox address");
        require(_hubVault != bytes32(0), "Invalid Hub vault identifier");
        require(_underlyingAsset != address(0), "Invalid underlying asset");
        require(_yieldStrategy != address(0), "Invalid yield strategy");

        mailbox = IMailbox(_mailbox);
        hubDomain = _hubDomain;
        hubVault = _hubVault;
        underlyingAsset = IERC20(_underlyingAsset);
        yieldStrategy = IERC4626(_yieldStrategy);
    }

    /**
     * @notice Authenticated entry point for incoming Hyperlane messages dispatched from Hub.
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) external payable override nonReentrant whenNotPaused {
        // Layer 1: Verify caller is Mailbox
        require(msg.sender == address(mailbox), "Unauthorized: caller is not Mailbox");

        // Layer 2: Verify origin domain and hub sender
        require(_origin == hubDomain, "Unauthorized: origin domain mismatch");
        require(_sender == hubVault, "Unauthorized: sender is not Hub vault");

        CrossChainVaultMessage.Message memory msgData = CrossChainVaultMessage.parse(_message);
        require(msgData.deadline >= block.timestamp, "Received message expired: deadline passed");

        if (msgData.msgType == CrossChainVaultMessage.TYPE_DEPOSIT) {
            _depositToYieldStrategy(msgData.amount, msgData.minAmountOut);
        } else if (
            msgData.msgType == CrossChainVaultMessage.TYPE_WITHDRAW ||
            msgData.msgType == CrossChainVaultMessage.TYPE_REBALANCE_EXECUTE
        ) {
            _withdrawFromYieldStrategy(msgData.amount, msgData.minAmountOut);
        } else if (msgData.msgType == CrossChainVaultMessage.TYPE_EMERGENCY_UNWIND) {
            _emergencyUnwind(msgData.minAmountOut);
        }
    }

    /**
     * @notice Deposits underlying asset into local yield strategy vault.
     */
    function depositToYieldStrategy(
        uint256 amount,
        uint256 minSharesOut
    ) public override nonReentrant whenNotPaused returns (uint256 shares) {
        return _depositToYieldStrategy(amount, minSharesOut);
    }

    function _depositToYieldStrategy(
        uint256 amount,
        uint256 minSharesOut
    ) internal returns (uint256 shares) {
        require(amount > 0, "Deposit amount must be greater than zero");
        require(underlyingAsset.balanceOf(address(this)) >= amount, "Insufficient underlying asset balance");

        underlyingAsset.forceApprove(address(yieldStrategy), amount);
        shares = yieldStrategy.deposit(amount, address(this));
        require(shares >= minSharesOut, "Slippage: minSharesOut condition violated");

        emit DepositExecuted(amount, shares);
    }

    /**
     * @notice Withdraws underlying assets from local yield strategy vault.
     */
    function withdrawFromYieldStrategy(
        uint256 amount,
        uint256 minAssetsOut
    ) public override nonReentrant whenNotPaused returns (uint256 assets) {
        return _withdrawFromYieldStrategy(amount, minAssetsOut);
    }

    function _withdrawFromYieldStrategy(
        uint256 amount,
        uint256 minAssetsOut
    ) internal returns (uint256 assets) {
        require(amount > 0, "Withdraw amount must be greater than zero");

        uint256 currentShares = yieldStrategy.balanceOf(address(this));
        uint256 currentNav = yieldStrategy.convertToAssets(currentShares);
        require(currentNav >= amount, "Insufficient strategy assets for withdrawal");

        uint256 sharesBurned = yieldStrategy.withdraw(amount, address(this), address(this));
        assets = amount;
        require(assets >= minAssetsOut, "Slippage: minAssetsOut condition violated");

        emit WithdrawExecuted(sharesBurned, assets);
    }

    /**
     * @notice Returns total NAV in terms of underlying asset (invested strategy shares + local uninvested tokens).
     */
    function getStrategyNav() public view override returns (uint256) {
        uint256 shares = yieldStrategy.balanceOf(address(this));
        uint256 investedAssets = yieldStrategy.convertToAssets(shares);
        uint256 idleAssets = underlyingAsset.balanceOf(address(this));
        return investedAssets + idleAssets;
    }

    /**
     * @notice Synchronizes local NAV telemetry back to the Hub vault via Hyperlane Mailbox.
     */
    function syncNavToHub(uint256 gasPayment) external payable override nonReentrant whenNotPaused {
        require(msg.value >= gasPayment, "Insufficient gas payment provided");
        uint256 currentNav = getStrategyNav();
        bytes memory navReport = CrossChainVaultMessage.encodeNavReport(
            TypeCasts.addressToBytes32(address(this)),
            currentNav,
            block.timestamp,
            ""
        );

        mailbox.dispatch{value: msg.value}(hubDomain, hubVault, navReport);
        emit NavSynchronized(currentNav, block.timestamp);
    }

    /**
     * @notice Emergency unwinding of all strategy positions.
     */
    function emergencyUnwind(uint256 minAssetsOut) public override nonReentrant {
        require(
            msg.sender == owner() || msg.sender == address(this) || msg.sender == address(mailbox),
            "Unauthorized emergency unwind caller"
        );
        _emergencyUnwind(minAssetsOut);
    }

    function _emergencyUnwind(uint256 minAssetsOut) internal {
        uint256 totalShares = yieldStrategy.balanceOf(address(this));
        uint256 assetsRecovered = 0;
        if (totalShares > 0) {
            assetsRecovered = yieldStrategy.redeem(totalShares, address(this), address(this));
            require(assetsRecovered >= minAssetsOut, "Slippage: emergency unwind minAssetsOut violated");
        }

        emit EmergencyUnwound(assetsRecovered);
    }

    /**
     * @notice Emergency token recovery for stuck tokens.
     */
    function recoverToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Cannot recover to zero address");
        IERC20(token).safeTransfer(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setMailbox(address _mailbox) external onlyOwner {
        require(_mailbox != address(0), "Invalid Mailbox address");
        mailbox = IMailbox(_mailbox);
    }
}
