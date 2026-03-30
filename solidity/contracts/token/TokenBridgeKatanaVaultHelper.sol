// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {Quotes} from "./libs/Quotes.sol";
import {TokenBridgeOft} from "./TokenBridgeOft.sol";
import {IKatanaVaultRedeemer} from "./interfaces/IKatanaVaultRedeemer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title TokenBridgeKatanaVaultHelper
 * @notice Ethereum-side helper for the Katana USDC/vbUSDC bridge flow.
 * @dev Outbound transfers pull the local asset, mint the exact vault shares
 *      required for the LayerZero send, then hand transport to an existing
 *      TokenBridgeOft. Inbound redemptions are permissionless and always pay
 *      the fixed Ethereum beneficiary.
 * @dev Alternatives considered:
 *      - AggLayer-specific bridging was rejected because Katana already exposes
 *        the vault-share + LayerZero OFT path we need.
 *      - A bespoke composer/OFT integration was rejected in favor of direct
 *        IERC4626 minting plus TokenBridgeOft so we can reuse existing quote,
 *        fee, and Hyperlane-domain-to-LayerZero-EID logic.
 *      - A dynamic redeem beneficiary was rejected for now in favor of a
 *        route-specific fixed beneficiary to keep the reasoning and config
 *        surface smaller.
 *      - An ICA-owned balance on Ethereum was rejected; this helper holds the
 *        inbound shares directly and the ICA only needs to poke redemption.
 * @dev Token support assumptions:
 *      - Fee-on-transfer tokens: NOT supported.
 *      - Rebasing tokens: NOT supported.
 *      - ERC-777 hooks/callbacks: NOT explicitly supported.
 */
contract TokenBridgeKatanaVaultHelper is ITokenBridge, IKatanaVaultRedeemer, PackageVersioned {
    using Quotes for Quote[];
    using SafeERC20 for IERC20;

    /// @notice Hardcoded Hyperlane domain for Katana on this route.
    uint32 public constant KATANA_DOMAIN = 747474;

    error TokenBridgeKatanaVaultHelper__InsufficientNativeFee(uint256 requiredFee, uint256 providedFee);
    error TokenBridgeKatanaVaultHelper__InsufficientShares(uint256 expectedShares, uint256 actualShares);
    error TokenBridgeKatanaVaultHelper__UnexpectedDecimalConversionRate(uint256 actualRate);
    error TokenBridgeKatanaVaultHelper__InvalidShareBridgeToken(address expectedToken, address actualToken);
    error TokenBridgeKatanaVaultHelper__UnexpectedRecipient(bytes32 expectedRecipient, bytes32 actualRecipient);
    error TokenBridgeKatanaVaultHelper__UnsupportedDestination(uint32 destination);
    error TokenBridgeKatanaVaultHelper__ZeroKatanaBeneficiary();
    error TokenBridgeKatanaVaultHelper__ZeroShareQuote(uint256 amount);
    error TokenBridgeKatanaVaultHelper__ZeroAddress();

    event TransferRemoteInitiated(
        uint32 indexed destination, bytes32 indexed recipient, uint256 shares, uint256 assetsIn, bytes32 messageId
    );
    event RedemptionCompleted(address indexed redeemer, uint256 shares, uint256 assetsOut);

    /// @notice Local ERC4626 share vault. For Katana this is the Ethereum vbUSDC vault.
    IERC4626 public immutable shareVault;

    /// @notice Local underlying asset deposited into `shareVault`. For Katana this is USDC.
    IERC20 public immutable assetToken;

    /// @notice Existing OFT-backed bridge that transports vault shares to Katana.
    TokenBridgeOft public immutable shareBridge;

    /// @notice Fixed Katana beneficiary that receives bridged vault shares.
    bytes32 public immutable katanaBeneficiary;

    /// @notice Fixed Ethereum beneficiary that receives local assets after redemption.
    address public immutable ethereumBeneficiary;

    constructor(address _shareVault, address _shareBridge, bytes32 _katanaBeneficiary, address _ethereumBeneficiary) {
        if (_shareVault == address(0) || _shareBridge == address(0) || _ethereumBeneficiary == address(0)) {
            revert TokenBridgeKatanaVaultHelper__ZeroAddress();
        }
        if (_katanaBeneficiary == bytes32(0)) revert TokenBridgeKatanaVaultHelper__ZeroKatanaBeneficiary();

        TokenBridgeOft shareBridge_ = TokenBridgeOft(_shareBridge);
        address shareToken = shareBridge_.token();
        if (shareToken != _shareVault) {
            revert TokenBridgeKatanaVaultHelper__InvalidShareBridgeToken(_shareVault, shareToken);
        }
        uint256 decimalConversionRate = shareBridge_.decimalConversionRate();
        if (decimalConversionRate != 1) {
            revert TokenBridgeKatanaVaultHelper__UnexpectedDecimalConversionRate(decimalConversionRate);
        }

        shareVault = IERC4626(_shareVault);
        assetToken = IERC20(IERC4626(_shareVault).asset());
        shareBridge = shareBridge_;
        katanaBeneficiary = _katanaBeneficiary;
        ethereumBeneficiary = _ethereumBeneficiary;

        assetToken.forceApprove(_shareVault, type(uint256).max);
        IERC20(_shareVault).forceApprove(_shareBridge, type(uint256).max);
    }

    function token() public view returns (address) {
        return address(assetToken);
    }

    function quoteTransferRemote(uint32 _destination, bytes32 _recipient, uint256 _amount)
        external
        view
        override
        returns (Quote[] memory quotes)
    {
        _checkOutbound(_destination, _recipient);

        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(_destination, _recipient, _amount);
        uint256 requiredShares = shareQuotes.extract(address(shareVault));
        if (requiredShares == 0) revert TokenBridgeKatanaVaultHelper__ZeroShareQuote(_amount);
        uint256 requiredAssets = shareVault.previewMint(requiredShares);

        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: shareQuotes.extract(address(0))});
        quotes[1] = Quote({token: address(assetToken), amount: requiredAssets});
    }

    function transferRemote(uint32 _destination, bytes32 _recipient, uint256 _amount)
        external
        payable
        override
        returns (bytes32 messageId)
    {
        _checkOutbound(_destination, _recipient);

        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(_destination, _recipient, _amount);
        uint256 nativeFee = shareQuotes.extract(address(0));
        uint256 requiredShares = shareQuotes.extract(address(shareVault));
        if (requiredShares == 0) revert TokenBridgeKatanaVaultHelper__ZeroShareQuote(_amount);
        uint256 maxAssetsIn = shareVault.previewMint(requiredShares);

        if (msg.value < nativeFee) {
            revert TokenBridgeKatanaVaultHelper__InsufficientNativeFee(nativeFee, msg.value);
        }

        assetToken.safeTransferFrom(msg.sender, address(this), maxAssetsIn);
        uint256 assetsIn = shareVault.mint(requiredShares, address(this));
        uint256 assetRefund = maxAssetsIn - assetsIn;
        if (assetRefund > 0) assetToken.safeTransfer(msg.sender, assetRefund);

        messageId = shareBridge.transferRemote{value: nativeFee}(_destination, _recipient, _amount);

        uint256 excessNative = msg.value - nativeFee;
        if (excessNative > 0) {
            Address.sendValue(payable(msg.sender), excessNative);
        }

        emit TransferRemoteInitiated(_destination, _recipient, _amount, assetsIn, messageId);
    }

    /// @notice Redeems inbound shares to the fixed Ethereum beneficiary.
    /// @dev `_shares` serves as the readiness gate for the ICA poke:
    ///      the call reverts until this helper holds at least that many shares.
    function redeem(uint256 _shares) external override returns (uint256 assetsOut) {
        uint256 balance = shareVault.balanceOf(address(this));
        if (balance < _shares) {
            revert TokenBridgeKatanaVaultHelper__InsufficientShares(_shares, balance);
        }

        assetsOut = shareVault.redeem(_shares, ethereumBeneficiary, address(this));

        emit RedemptionCompleted(msg.sender, _shares, assetsOut);
    }

    function _checkOutbound(uint32 _destination, bytes32 _recipient) internal view {
        if (_destination != KATANA_DOMAIN) {
            revert TokenBridgeKatanaVaultHelper__UnsupportedDestination(_destination);
        }
        if (_recipient != katanaBeneficiary) {
            revert TokenBridgeKatanaVaultHelper__UnexpectedRecipient(katanaBeneficiary, _recipient);
        }
    }
}
