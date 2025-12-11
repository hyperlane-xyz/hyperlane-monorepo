// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../../token/HypNative.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenRouter} from "../../token/libs/TokenRouter.sol";
import {Router} from "../../client/Router.sol";
import {IStandardBridge} from "../../interfaces/optimism/IStandardBridge.sol";
import {Quote, ITokenBridge} from "../../interfaces/ITokenBridge.sol";
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";
import {OPL2ToL1CcipReadIsm, OPL2ToL1V1CcipReadIsm, OPL2ToL1V2CcipReadIsm} from "../../isms/hook/OPL2ToL1CcipReadIsm.sol";
import {OPL2ToL1Withdrawal} from "../../libs/OPL2ToL1Withdrawal.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";
import {Message} from "../../libs/Message.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {NativeCollateral} from "../../token/libs/TokenCollateral.sol";
import {LpCollateralRouterStorage} from "../../token/libs/LpCollateralRouter.sol";

uint256 constant SCALE = 1;

contract OpL2NativeTokenBridge is TokenRouter {
    using TypeCasts for bytes32;
    using StandardHookMetadata for bytes;
    using Address for address payable;
    using Address for address;

    uint256 internal constant PROVE_WITHDRAWAL_GAS_LIMIT = 500_000;
    uint256 internal constant FINALIZE_WITHDRAWAL_GAS_LIMIT = 300_000;
    uint32 internal constant OP_MIN_GAS_LIMIT_ON_L1 = 50_000;

    // L2 bridge used to initiate the withdrawal
    IStandardBridge public immutable l2Bridge;

    /// @dev This is used to enable storage layout backwards compatibility. It should not be read or written to.
    LpCollateralRouterStorage private __LP_COLLATERAL_GAP;

    constructor(
        address _mailbox,
        address _l2Bridge
    ) TokenRouter(SCALE, _mailbox) {
        require(_l2Bridge.isContract(), "L2 bridge must be a contract");
        l2Bridge = IStandardBridge(payable(_l2Bridge));
    }

    function initialize(address _hook, address _owner) public initializer {
        // ISM should not be set (contract does not receive messages currently)
        _MailboxClient_initialize({
            _hook: _hook,
            __interchainSecurityModule: address(0),
            _owner: _owner
        });
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to use the L2 bridge for transferring native tokens and trigger two messages:
     * - Prove message with amount 0 to prove the withdrawal
     * - Finalize message with the actual amount to finalize the withdrawal
     * transferRemote typically has the dispatch of the message as the 4th and final step. However, in this case we want the Hyperlane messageId to be passed via the rollup bridge.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32) {
        // 1. No external fee calculation necessary
        require(
            _amount > 0,
            "OP L2 token bridge: amount must be greater than 0"
        );

        // 2. Prepare the "dispatch" of messages by actually dispatching the Hyperlane messages

        // Dispatch proof message (no token amount)
        bytes32 proveMessageId = _Router_dispatch({
            _destinationDomain: _destination,
            _value: msg.value - _amount,
            _messageBody: TokenMessage.format(_recipient, 0),
            _hookMetadata: _proveHookMetadata(),
            _hook: address(hook)
        });

        // Dispatch withdrawal message (token + fee)
        bytes32 withdrawMessageId = _Router_dispatch({
            _destinationDomain: _destination,
            _value: address(this).balance - _amount,
            _messageBody: TokenMessage.format(_recipient, _amount),
            _hookMetadata: _finalizeHookMetadata(),
            _hook: address(hook)
        });

        // include for legible error message
        require(
            address(this).balance >= _amount,
            "OP L2 token bridge: insufficient balance"
        );

        // 3. Emit event manually
        emit SentTransferRemote({
            destination: _destination,
            recipient: _recipient,
            amountOrId: _amount
        });

        // used for mapping withdrawal to hyperlane prove and finalize messages
        bytes memory extraData = OPL2ToL1Withdrawal.encodeData(
            proveMessageId,
            withdrawMessageId
        );

        // 4. "Dispatch" the message by calling the L2 bridge to transfer native tokens
        l2Bridge.bridgeETHTo{value: _amount}({
            _to: _recipient.bytes32ToAddress(),
            _minGasLimit: OP_MIN_GAS_LIMIT_ON_L1,
            _extraData: extraData
        });

        if (address(this).balance > 0) {
            payable(msg.sender).sendValue(address(this).balance);
        }

        return withdrawMessageId;
    }

    // needed for hook refunds
    receive() external payable {}

    /**
     * @inheritdoc Router
     */
    function handle(uint32, bytes32, bytes calldata) external payable override {
        revert("OP L2 token bridge should not receive messages");
    }

    /**
     * @inheritdoc TokenRouter
     */
    function token() public view override returns (address) {
        return address(0);
    }

    function _proveHookMetadata() internal view returns (bytes memory) {
        return
            StandardHookMetadata.format({
                _msgValue: 0,
                _gasLimit: PROVE_WITHDRAWAL_GAS_LIMIT,
                _refundAddress: address(this)
            });
    }

    function _finalizeHookMetadata() internal view returns (bytes memory) {
        return
            StandardHookMetadata.format({
                _msgValue: 0,
                _gasLimit: FINALIZE_WITHDRAWAL_GAS_LIMIT,
                _refundAddress: address(this)
            });
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to quote for two messages: prove and finalize.
     */
    function _quoteGasPayment(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view override returns (uint256) {
        bytes memory message = TokenMessage.format(_recipient, _amount);
        uint256 proveQuote = _Router_quoteDispatch({
            _destinationDomain: _destination,
            _messageBody: message,
            _hookMetadata: _proveHookMetadata(),
            _hook: address(hook)
        });
        uint256 finalizeQuote = _Router_quoteDispatch({
            _destinationDomain: _destination,
            _messageBody: message,
            _hookMetadata: _finalizeHookMetadata(),
            _hook: address(hook)
        });
        return proveQuote + finalizeQuote;
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferFromSender(uint256 _amount) internal override {
        NativeCollateral._transferFromSender(_amount);
    }

    /**
     * @inheritdoc TokenRouter
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        // should never be called
        assert(false);
    }
}

// need intermediate contract to insert slots between TokenRouter and OPL2ToL1CcipReadIsm
abstract contract OpTokenBridgeStorage is TokenRouter {
    /// @dev This is used to enable storage layout backwards compatibility. It should not be read or written to.
    LpCollateralRouterStorage private __LP_COLLATERAL_GAP;
}

abstract contract OpL1NativeTokenBridge is
    OpTokenBridgeStorage,
    OPL2ToL1CcipReadIsm
{
    using Message for bytes;
    using TokenMessage for bytes;

    function initialize(
        address _owner,
        string[] memory _urls
    ) public initializer {
        __Ownable_init();
        setUrls(_urls);
        // ISM should not be set (this contract uses itself as ISM)
        // hook should not be set (this contract does not send messages)
        _MailboxClient_initialize({
            _hook: address(0),
            __interchainSecurityModule: address(0),
            _owner: _owner
        });
    }

    function transferRemote(
        uint32,
        bytes32,
        uint256
    ) public payable override returns (bytes32) {
        revert("OP L1 token bridge should not send messages");
    }

    // see OpL2NativeTokenBridge._transferRemote prove message amount := 0
    function _isProve(
        bytes calldata _message
    ) internal pure override returns (bool) {
        return _message.body().amount() == 0;
    }

    function token() public view override returns (address) {
        return address(0);
    }

    function _transferFromSender(uint256 _amount) internal override {
        assert(false);
    }

    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        // do not transfer to recipient as the OP L1 bridge will do it
    }

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }
}

contract OpL1V1NativeTokenBridge is
    OpL1NativeTokenBridge,
    OPL2ToL1V1CcipReadIsm
{
    constructor(
        address _mailbox,
        address _opPortal
    ) TokenRouter(SCALE, _mailbox) OPL2ToL1CcipReadIsm(_opPortal) {}
}

contract OpL1V2NativeTokenBridge is
    OpL1NativeTokenBridge,
    OPL2ToL1V2CcipReadIsm
{
    constructor(
        address _mailbox,
        address _opPortal
    ) TokenRouter(SCALE, _mailbox) OPL2ToL1CcipReadIsm(_opPortal) {}
}
