// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {IInterchainAccountRouter} from "../interfaces/IInterchainAccountRouter.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Quotes} from "./libs/Quotes.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {TokenBridgeOft} from "./TokenBridgeOft.sol";
import {IKatanaVaultRedeemer} from "./interfaces/IKatanaVaultRedeemer.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title TokenBridgeKatanaRedeemIca
 * @notice Katana-side bridge wrapper for the vbUSDC -> Ethereum helper flow.
 * @dev Uses an existing TokenBridgeOft instance for the share send and dispatches
 *      a Hyperlane ICA call that instructs the Ethereum helper to redeem.
 * @dev Alternatives considered:
 *      - A compose-aware OFT wrapper was rejected here to avoid specializing
 *        the generic TokenBridgeOft path just for Katana redemption.
 *      - Sending funds to the ICA itself was rejected; the share send goes
 *        directly to the Ethereum helper and the ICA only handles execution.
 *      - We accept the tradeoff that a manual permissionless redeem can make
 *        the ICA poke revert forever, because funds still settle to the fixed
 *        Ethereum beneficiary and the simpler route-specific model was preferred.
 */
contract TokenBridgeKatanaRedeemIca is ITokenBridge, Ownable, PackageVersioned {
    using Quotes for Quote[];
    using SafeERC20 for IERC20;
    using TypeCasts for address;

    error TokenBridgeKatanaRedeemIca__InsufficientNativeFee(uint256 requiredFee, uint256 providedFee);
    error TokenBridgeKatanaRedeemIca__UnexpectedRecipient(bytes32 expectedRecipient, bytes32 actualRecipient);
    error TokenBridgeKatanaRedeemIca__UnsupportedDestination(uint32 destination);
    error TokenBridgeKatanaRedeemIca__ZeroAddress();
    error TokenBridgeKatanaRedeemIca__ZeroBeneficiary();
    error TokenBridgeKatanaRedeemIca__ZeroGasLimit();

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 shareBridgeMessageId,
        bytes32 icaMessageId
    );
    event IcaGasLimitSet(uint256 gasLimit);

    /// @notice Generic OFT-backed transport used to move vbUSDC shares from Katana to Ethereum.
    TokenBridgeOft public immutable shareBridge;

    /// @notice Local Katana share token approved into `shareBridge` for outbound sends.
    IERC20 public immutable shareToken;

    /// @notice ICA router used to dispatch the follow-up redemption poke to Ethereum.
    IInterchainAccountRouter public immutable icaRouter;

    /// @notice Ethereum helper that receives bridged shares and exposes `redeem(shares)`.
    address public immutable ethereumVaultHelper;

    /// @notice Fixed Ethereum beneficiary expected by movable collateral config and helper redemption.
    address public immutable ethereumBeneficiary;

    /// @notice Hyperlane domain for Ethereum; this bridge only supports sends to this domain.
    uint32 public immutable ethereumDomain;

    /// @notice Gas limit used when quoting and dispatching the ICA redemption poke.
    uint256 public icaGasLimit;

    constructor(
        address _shareBridge,
        address _icaRouter,
        address _ethereumVaultHelper,
        address _ethereumBeneficiary,
        uint32 _ethereumDomain,
        uint256 _icaGasLimit,
        address _owner
    ) {
        if (
            _shareBridge == address(0) || _icaRouter == address(0) || _ethereumVaultHelper == address(0)
                || _owner == address(0)
        ) revert TokenBridgeKatanaRedeemIca__ZeroAddress();
        if (_ethereumBeneficiary == address(0)) {
            revert TokenBridgeKatanaRedeemIca__ZeroBeneficiary();
        }
        if (_icaGasLimit == 0) {
            revert TokenBridgeKatanaRedeemIca__ZeroGasLimit();
        }

        shareBridge = TokenBridgeOft(_shareBridge);
        shareToken = IERC20(TokenBridgeOft(_shareBridge).token());
        icaRouter = IInterchainAccountRouter(_icaRouter);
        ethereumVaultHelper = _ethereumVaultHelper;
        ethereumBeneficiary = _ethereumBeneficiary;
        ethereumDomain = _ethereumDomain;
        icaGasLimit = _icaGasLimit;

        shareToken.forceApprove(_shareBridge, type(uint256).max);
        _transferOwnership(_owner);
    }

    function token() public view returns (address) {
        return address(shareToken);
    }

    function setIcaGasLimit(uint256 _gasLimit) external onlyOwner {
        if (_gasLimit == 0) revert TokenBridgeKatanaRedeemIca__ZeroGasLimit();
        icaGasLimit = _gasLimit;
        emit IcaGasLimitSet(_gasLimit);
    }

    function quoteTransferRemote(uint32 _destination, bytes32 _recipient, uint256 _amount)
        external
        view
        override
        returns (Quote[] memory quotes)
    {
        _checkOutbound(_destination, _recipient);

        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(_destination, _helperRecipient(), _amount);
        uint256 nativeFee = shareQuotes.extract(address(0)) + icaRouter.quoteGasPayment(_destination, icaGasLimit);

        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: nativeFee});
        quotes[1] = Quote({token: address(shareToken), amount: shareQuotes.extract(address(shareToken))});
    }

    function transferRemote(uint32 _destination, bytes32 _recipient, uint256 _amount)
        external
        payable
        override
        returns (bytes32 messageId)
    {
        _checkOutbound(_destination, _recipient);

        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(_destination, _helperRecipient(), _amount);
        uint256 shareBridgeNativeFee = shareQuotes.extract(address(0));
        uint256 shareAmount = shareQuotes.extract(address(shareToken));
        uint256 icaFee = icaRouter.quoteGasPayment(_destination, icaGasLimit);
        uint256 totalNativeFee = shareBridgeNativeFee + icaFee;

        if (msg.value < totalNativeFee) {
            revert TokenBridgeKatanaRedeemIca__InsufficientNativeFee(totalNativeFee, msg.value);
        }

        shareToken.safeTransferFrom(msg.sender, address(this), shareAmount);

        bytes32 shareBridgeMessageId =
            shareBridge.transferRemote{value: shareBridgeNativeFee}(_destination, _helperRecipient(), _amount);

        // The ICA poke carries only the expected share amount. The helper uses
        // that value as a readiness gate and reverts until the share delivery arrives.
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(ethereumVaultHelper, 0, abi.encodeCall(IKatanaVaultRedeemer.redeem, (_amount)));

        bytes32 icaMessageId =
            icaRouter.callRemote{value: icaFee}(_destination, calls, StandardHookMetadata.overrideGasLimit(icaGasLimit));

        uint256 excessNative = msg.value - totalNativeFee;
        if (excessNative > 0) {
            Address.sendValue(payable(msg.sender), excessNative);
        }

        emit SentTransferRemote(_destination, _recipient, _amount, shareBridgeMessageId, icaMessageId);

        return keccak256(abi.encode(shareBridgeMessageId, icaMessageId));
    }

    function _checkOutbound(uint32 _destination, bytes32 _recipient) internal view {
        if (_destination != ethereumDomain) {
            revert TokenBridgeKatanaRedeemIca__UnsupportedDestination(_destination);
        }
        bytes32 expectedRecipient = ethereumBeneficiary.addressToBytes32();
        if (_recipient != expectedRecipient) {
            revert TokenBridgeKatanaRedeemIca__UnexpectedRecipient(expectedRecipient, _recipient);
        }
    }

    function _helperRecipient() internal view returns (bytes32) {
        return ethereumVaultHelper.addressToBytes32();
    }
}
