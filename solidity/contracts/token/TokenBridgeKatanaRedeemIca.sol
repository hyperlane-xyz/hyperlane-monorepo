// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge, Quote} from "../interfaces/ITokenBridge.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {PackageVersioned} from "../PackageVersioned.sol";
import {CallLib} from "../middleware/libs/Call.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {TokenBridgeOft} from "./TokenBridgeOft.sol";
import {IInterchainAccountRouter} from "../interfaces/IInterchainAccountRouter.sol";
import {IKatanaVaultRedeemer} from "./interfaces/IKatanaVaultRedeemer.sol";

/**
 * @title TokenBridgeKatanaRedeemIca
 * @notice Katana-side bridge wrapper for the vbUSDC -> Ethereum helper flow.
 * @dev Uses an existing TokenBridgeOft instance for the token send and dispatches
 *      a Hyperlane ICA call that instructs the Ethereum helper to redeem.
 */
contract TokenBridgeKatanaRedeemIca is
    ITokenBridge,
    Ownable,
    PackageVersioned
{
    using SafeERC20 for IERC20;
    using TypeCasts for address;

    error TokenBridgeKatanaRedeemIca__UnsupportedDestination(
        uint32 destination
    );
    error TokenBridgeKatanaRedeemIca__UnexpectedRecipient(
        bytes32 expectedRecipient,
        bytes32 actualRecipient
    );
    error TokenBridgeKatanaRedeemIca__ZeroAddress();
    error TokenBridgeKatanaRedeemIca__ZeroBeneficiary();
    error TokenBridgeKatanaRedeemIca__ZeroGasLimit();
    error TokenBridgeKatanaRedeemIca__MissingTokenQuote(address token);
    error TokenBridgeKatanaRedeemIca__InsufficientNativeFee(
        uint256 requiredFee,
        uint256 providedFee
    );

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 oftMessageId,
        bytes32 icaMessageId
    );
    event IcaGasLimitSet(uint256 gasLimit);

    TokenBridgeOft public immutable oftBridge;
    IERC20 public immutable wrappedToken;
    IInterchainAccountRouter public immutable icaRouter;
    address public immutable ethereumHelper;
    address public immutable beneficiary;
    uint32 public immutable ethereumDomain;

    uint256 public icaGasLimit;

    constructor(
        address _oftBridge,
        address _icaRouter,
        address _ethereumHelper,
        address _beneficiary,
        uint32 _ethereumDomain,
        uint256 _icaGasLimit,
        address _owner
    ) {
        if (
            _oftBridge == address(0) || _icaRouter == address(0)
                || _ethereumHelper == address(0) || _owner == address(0)
        ) revert TokenBridgeKatanaRedeemIca__ZeroAddress();
        if (_beneficiary == address(0)) {
            revert TokenBridgeKatanaRedeemIca__ZeroBeneficiary();
        }
        if (_icaGasLimit == 0) {
            revert TokenBridgeKatanaRedeemIca__ZeroGasLimit();
        }

        oftBridge = TokenBridgeOft(_oftBridge);
        wrappedToken = IERC20(TokenBridgeOft(_oftBridge).token());
        icaRouter = IInterchainAccountRouter(_icaRouter);
        ethereumHelper = _ethereumHelper;
        beneficiary = _beneficiary;
        ethereumDomain = _ethereumDomain;
        icaGasLimit = _icaGasLimit;

        wrappedToken.forceApprove(_oftBridge, type(uint256).max);
        _transferOwnership(_owner);
    }

    function token() public view returns (address) {
        return address(wrappedToken);
    }

    function setIcaGasLimit(uint256 _gasLimit) external onlyOwner {
        if (_gasLimit == 0) revert TokenBridgeKatanaRedeemIca__ZeroGasLimit();
        icaGasLimit = _gasLimit;
        emit IcaGasLimitSet(_gasLimit);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        _checkOutbound(_destination, _recipient);

        Quote[] memory oftQuotes =
            oftBridge.quoteTransferRemote(_destination, _helperRecipient(), _amount);
        uint256 icaFee = icaRouter.quoteGasPayment(_destination, icaGasLimit);

        quotes = _mergeNativeQuote(oftQuotes, icaFee);
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 messageId) {
        _checkOutbound(_destination, _recipient);

        Quote[] memory oftQuotes =
            oftBridge.quoteTransferRemote(_destination, _helperRecipient(), _amount);
        uint256 oftNativeFee = _extractQuoteAmount(oftQuotes, address(0));
        uint256 collateralFee =
            _extractQuoteAmount(oftQuotes, address(wrappedToken));
        uint256 icaFee = icaRouter.quoteGasPayment(_destination, icaGasLimit);
        uint256 totalNativeFee = oftNativeFee + icaFee;

        if (msg.value < totalNativeFee) {
            revert TokenBridgeKatanaRedeemIca__InsufficientNativeFee(
                totalNativeFee,
                msg.value
            );
        }

        wrappedToken.safeTransferFrom(msg.sender, address(this), collateralFee);

        bytes32 oftMessageId = oftBridge.transferRemote{value: oftNativeFee}(
            _destination,
            _helperRecipient(),
            _amount
        );

        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            ethereumHelper,
            0,
            abi.encodeCall(IKatanaVaultRedeemer.redeem, (_amount, _amount))
        );

        bytes32 icaMessageId = icaRouter.callRemote{value: icaFee}(
            _destination,
            calls,
            StandardHookMetadata.overrideGasLimit(icaGasLimit)
        );

        uint256 excessNative = msg.value - totalNativeFee;
        if (excessNative > 0) {
            Address.sendValue(payable(msg.sender), excessNative);
        }

        emit SentTransferRemote(
            _destination,
            _recipient,
            _amount,
            oftMessageId,
            icaMessageId
        );

        return keccak256(abi.encode(oftMessageId, icaMessageId));
    }

    function _checkOutbound(uint32 _destination, bytes32 _recipient)
        internal
        view
    {
        if (_destination != ethereumDomain) {
            revert TokenBridgeKatanaRedeemIca__UnsupportedDestination(
                _destination
            );
        }
        bytes32 expectedRecipient = beneficiary.addressToBytes32();
        if (_recipient != expectedRecipient) {
            revert TokenBridgeKatanaRedeemIca__UnexpectedRecipient(
                expectedRecipient,
                _recipient
            );
        }
    }

    function _helperRecipient() internal view returns (bytes32) {
        return ethereumHelper.addressToBytes32();
    }

    function _extractQuoteAmount(
        Quote[] memory _quotes,
        address _token
    ) internal pure returns (uint256 amount) {
        for (uint256 i = 0; i < _quotes.length; i += 1) {
            if (_quotes[i].token == _token) return _quotes[i].amount;
        }
        revert TokenBridgeKatanaRedeemIca__MissingTokenQuote(_token);
    }

    function _mergeNativeQuote(
        Quote[] memory _quotes,
        uint256 _additionalNativeFee
    ) internal pure returns (Quote[] memory mergedQuotes) {
        bool foundNative = false;
        for (uint256 i = 0; i < _quotes.length; i += 1) {
            if (_quotes[i].token == address(0)) {
                foundNative = true;
                break;
            }
        }

        uint256 mergedLength = foundNative ? _quotes.length : _quotes.length + 1;
        mergedQuotes = new Quote[](mergedLength);
        for (uint256 i = 0; i < _quotes.length; i += 1) {
            mergedQuotes[i] = _quotes[i];
            if (mergedQuotes[i].token == address(0)) {
                mergedQuotes[i].amount += _additionalNativeFee;
            }
        }

        if (!foundNative) {
            mergedQuotes[_quotes.length] =
                Quote({token: address(0), amount: _additionalNativeFee});
        }
    }
}
