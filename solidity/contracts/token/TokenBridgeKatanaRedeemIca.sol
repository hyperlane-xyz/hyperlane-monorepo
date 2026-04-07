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
import {IOFT, SendParam, OFTReceipt, OFTLimit, OFTFeeDetail} from "./interfaces/layerzero/IOFT.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title TokenBridgeKatanaRedeemIca
 * @notice Katana-side bridge wrapper for the vbToken -> Ethereum helper flow.
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
 *      - The ICA poke redeems the exact delivered share amount, not the
 *        requested amount, so 8/18-decimal vbTokens remain compatible with
 *        LayerZero's 6-decimal shared format.
 * @dev Token support assumptions:
 *      - Fee-on-transfer tokens: NOT supported.
 *      - Rebasing tokens: NOT supported.
 *      - ERC-777 hooks/callbacks: NOT explicitly supported.
 */
contract TokenBridgeKatanaRedeemIca is ITokenBridge, PackageVersioned {
    using Quotes for Quote[];
    using SafeERC20 for IERC20;
    using TypeCasts for address;

    /// @notice Hardcoded Hyperlane domain for Ethereum on this route.
    uint32 public constant ETHEREUM_DOMAIN = 1;

    error TokenBridgeKatanaRedeemIca__InsufficientNativeFee(
        uint256 requiredFee,
        uint256 providedFee
    );
    error TokenBridgeKatanaRedeemIca__UnexpectedRecipient(
        bytes32 expectedRecipient,
        bytes32 actualRecipient
    );
    error TokenBridgeKatanaRedeemIca__UnsupportedDestination(
        uint32 destination
    );
    error TokenBridgeKatanaRedeemIca__ZeroAddress();
    error TokenBridgeKatanaRedeemIca__ZeroBeneficiary();
    error TokenBridgeKatanaRedeemIca__ZeroRedeemGasLimit();

    event SentTransferRemote(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 shareBridgeMessageId,
        bytes32 icaMessageId
    );

    /// @notice Generic OFT-backed transport used to move vbToken shares from Katana to Ethereum.
    TokenBridgeOft public immutable shareBridge;

    /// @notice Local Katana share token approved into `shareBridge` for outbound sends.
    IERC20 public immutable shareToken;

    /// @notice ICA router used to dispatch the follow-up redemption poke to Ethereum.
    IInterchainAccountRouter public immutable icaRouter;

    /// @notice Ethereum helper that receives bridged shares and exposes `redeem(shares)`.
    address public immutable ethereumVaultHelper;

    /// @notice Fixed Ethereum beneficiary expected by movable collateral config and helper redemption.
    address public immutable ethereumBeneficiary;

    /// @notice Gas limit used when quoting and dispatching the ICA redemption poke.
    uint256 public immutable redeemGasLimit;

    constructor(
        address _shareBridge,
        address _icaRouter,
        address _ethereumVaultHelper,
        address _ethereumBeneficiary,
        uint256 _redeemGasLimit
    ) {
        if (
            _shareBridge == address(0) ||
            _icaRouter == address(0) ||
            _ethereumVaultHelper == address(0)
        ) {
            revert TokenBridgeKatanaRedeemIca__ZeroAddress();
        }
        if (_ethereumBeneficiary == address(0)) {
            revert TokenBridgeKatanaRedeemIca__ZeroBeneficiary();
        }
        if (_redeemGasLimit == 0) {
            revert TokenBridgeKatanaRedeemIca__ZeroRedeemGasLimit();
        }

        TokenBridgeOft shareBridge_ = TokenBridgeOft(_shareBridge);
        shareBridge = shareBridge_;
        shareToken = IERC20(shareBridge_.token());
        icaRouter = IInterchainAccountRouter(_icaRouter);
        ethereumVaultHelper = _ethereumVaultHelper;
        ethereumBeneficiary = _ethereumBeneficiary;
        redeemGasLimit = _redeemGasLimit;

        shareToken.forceApprove(_shareBridge, type(uint256).max);
    }

    function token() public view returns (address) {
        return address(shareToken);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        _checkOutbound(_destination, _recipient);

        (
            uint256 shareBridgeNativeFee,
            uint256 shareAmount,

        ) = _quoteShareTransfer(
                _destination,
                ethereumVaultHelper.addressToBytes32(),
                _amount
            );
        uint256 nativeFee = shareBridgeNativeFee +
            icaRouter.quoteGasPayment(_destination, redeemGasLimit);

        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: nativeFee});
        quotes[1] = Quote({token: address(shareToken), amount: shareAmount});
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 messageId) {
        _checkOutbound(_destination, _recipient);

        (
            uint256 shareBridgeNativeFee,
            uint256 shareAmount,
            uint256 deliveredShareAmount
        ) = _quoteShareTransfer(
                _destination,
                ethereumVaultHelper.addressToBytes32(),
                _amount
            );
        uint256 icaFee = icaRouter.quoteGasPayment(
            _destination,
            redeemGasLimit
        );
        uint256 totalNativeFee = shareBridgeNativeFee + icaFee;

        if (msg.value < totalNativeFee) {
            revert TokenBridgeKatanaRedeemIca__InsufficientNativeFee(
                totalNativeFee,
                msg.value
            );
        }

        shareToken.safeTransferFrom(msg.sender, address(this), shareAmount);

        bytes32 shareBridgeMessageId = shareBridge.transferRemote{
            value: shareBridgeNativeFee
        }(_destination, ethereumVaultHelper.addressToBytes32(), _amount);

        // The ICA poke carries the exact amount that LayerZero reports will be
        // delivered to the helper, so dusty 8/18-decimal share tokens can be
        // redeemed without leaving stranded shares behind.
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            ethereumVaultHelper,
            0,
            abi.encodeCall(IKatanaVaultRedeemer.redeem, (deliveredShareAmount))
        );

        bytes32 icaMessageId = icaRouter.callRemote{value: icaFee}(
            _destination,
            calls,
            StandardHookMetadata.overrideGasLimit(redeemGasLimit)
        );

        uint256 excessNative = msg.value - totalNativeFee;
        if (excessNative > 0) {
            Address.sendValue(payable(msg.sender), excessNative);
        }

        emit SentTransferRemote(
            msg.sender,
            _destination,
            _recipient,
            _amount,
            shareBridgeMessageId,
            icaMessageId
        );

        return keccak256(abi.encode(shareBridgeMessageId, icaMessageId));
    }

    /// @dev Confirms the caller is using the route's fixed Ethereum domain and beneficiary.
    function _checkOutbound(
        uint32 _destination,
        bytes32 _recipient
    ) internal view {
        if (_destination != ETHEREUM_DOMAIN) {
            revert TokenBridgeKatanaRedeemIca__UnsupportedDestination(
                _destination
            );
        }
        bytes32 expectedRecipient = ethereumBeneficiary.addressToBytes32();
        if (_recipient != expectedRecipient) {
            revert TokenBridgeKatanaRedeemIca__UnexpectedRecipient(
                expectedRecipient,
                _recipient
            );
        }
    }

    function _quoteShareTransfer(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    )
        internal
        view
        returns (
            uint256 nativeFee,
            uint256 shareAmount,
            uint256 deliveredShareAmount
        )
    {
        Quote[] memory shareQuotes = shareBridge.quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );
        nativeFee = shareQuotes.extract(address(0));
        shareAmount = shareQuotes.extract(address(shareToken));

        SendParam memory sendParam = SendParam({
            dstEid: shareBridge.hyperlaneDomainToLzEid(_destination),
            to: _recipient,
            amountLD: shareAmount,
            minAmountLD: _removeDust(_amount),
            extraOptions: shareBridge.extraOptions(),
            composeMsg: "",
            oftCmd: ""
        });

        (
            ,
            OFTFeeDetail[] memory feeDetails,
            OFTReceipt memory receipt
        ) = shareBridge.oft().quoteOFT(sendParam);
        feeDetails;
        deliveredShareAmount = receipt.amountReceivedLD;
    }

    function _removeDust(uint256 _amount) internal view returns (uint256) {
        uint256 rate = shareBridge.decimalConversionRate();
        return (_amount / rate) * rate;
    }
}
