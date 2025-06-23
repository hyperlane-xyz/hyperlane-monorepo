// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../../token/HypNative.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenRouter} from "../../token/libs/TokenRouter.sol";
import {IStandardBridge} from "../../interfaces/optimism/IStandardBridge.sol";
import {Quote, ITokenBridge} from "../../interfaces/ITokenBridge.sol";
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";
import {OPL2ToL1CcipReadIsm, OPL2ToL1V1CcipReadIsm, OPL2ToL1V2CcipReadIsm} from "../../isms/hook/OPL2ToL1CcipReadIsm.sol";
import {OPL2ToL1Withdrawal} from "../../libs/OPL2ToL1Withdrawal.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";
import {Message} from "../../libs/Message.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

uint256 constant SCALE = 1;

contract OpL2NativeTokenBridge is HypNative {
    using TypeCasts for bytes32;
    using StandardHookMetadata for bytes;
    using Address for address payable;
    using Address for address;

    uint256 internal constant PROVE_WITHDRAWAL_GAS_LIMIT = 500_000;
    uint256 internal constant FINALIZE_WITHDRAWAL_GAS_LIMIT = 300_000;
    uint32 internal constant OP_MIN_GAS_LIMIT_ON_L1 = 50_000;

    // L2 bridge used to initiate the withdrawal
    IStandardBridge public immutable l2Bridge;

    constructor(
        address _mailbox,
        address _l2Bridge
    ) HypNative(SCALE, _mailbox) {
        require(_l2Bridge.isContract(), "L2 bridge must be a contract");
        l2Bridge = IStandardBridge(payable(_l2Bridge));
    }

    function initialize(
        address _hook,
        address _owner
    ) public virtual initializer {
        // ISM should not be set (contract does not receive messages currently)
        _MailboxClient_initialize(_hook, address(0), _owner);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view virtual override returns (Quote[] memory quotes) {
        bytes memory message = TokenMessage.format(_recipient, _amount);
        uint256 proveQuote = _Router_quoteDispatch(
            _destination,
            message,
            _proveHookMetadata(),
            address(hook)
        );
        uint256 finalizeQuote = _Router_quoteDispatch(
            _destination,
            message,
            _finalizeHookMetadata(),
            address(hook)
        );
        quotes = new Quote[](1);
        quotes[0] = Quote({
            token: address(0),
            amount: proveQuote + finalizeQuote + _amount
        });
    }

    function _proveHookMetadata() internal view virtual returns (bytes memory) {
        return
            StandardHookMetadata.format({
                _msgValue: 0,
                _gasLimit: PROVE_WITHDRAWAL_GAS_LIMIT,
                _refundAddress: address(this)
            });
    }

    function _finalizeHookMetadata()
        internal
        view
        virtual
        returns (bytes memory)
    {
        return
            StandardHookMetadata.format({
                _msgValue: 0,
                _gasLimit: FINALIZE_WITHDRAWAL_GAS_LIMIT,
                _refundAddress: address(this)
            });
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual override returns (bytes32) {
        require(
            _amount > 0,
            "OP L2 token bridge: amount must be greater than 0"
        );

        // refund first message fees to address(this) to cover second message
        bytes32 proveMessageId = super._transferRemote(
            _destination,
            _recipient,
            0,
            _proveHookMetadata(),
            _hook
        );

        bytes32 withdrawMessageId = super._transferRemote(
            _destination,
            _recipient,
            _amount,
            _finalizeHookMetadata(),
            _hook
        );

        // include for legible error message
        _transferFromSender(_amount);

        // used for mapping withdrawal to hyperlane prove and finalize messages
        bytes memory extraData = OPL2ToL1Withdrawal.encodeData(
            proveMessageId,
            withdrawMessageId
        );
        l2Bridge.bridgeETHTo{value: _amount}(
            _recipient.bytes32ToAddress(),
            OP_MIN_GAS_LIMIT_ON_L1,
            extraData
        );

        if (address(this).balance > 0) {
            address refundAddress = _hookMetadata.getRefundAddress(msg.sender);
            require(
                refundAddress != address(0),
                "OP L2 token bridge: refund address is 0"
            );
            payable(refundAddress).sendValue(address(this).balance);
        }

        return withdrawMessageId;
    }

    function handle(uint32, bytes32, bytes calldata) external payable override {
        revert("OP L2 token bridge should not receive messages");
    }
}

abstract contract OpL1NativeTokenBridge is HypNative, OPL2ToL1CcipReadIsm {
    using Message for bytes;
    using TokenMessage for bytes;

    function initialize(
        address _owner,
        string[] memory _urls
    ) public virtual initializer {
        __Ownable_init();
        setUrls(_urls);
        // ISM should not be set (this contract uses itself as ISM)
        // hook should not be set (this contract does not send messages)
        _MailboxClient_initialize(address(0), address(0), _owner);
    }

    function _transferRemote(
        uint32,
        bytes32,
        uint256,
        bytes memory,
        address
    ) internal override returns (bytes32) {
        revert("OP L1 token bridge should not send messages");
    }

    // see OpL2NativeTokenBridge._transferRemote prove message amount := 0
    function _isProve(
        bytes calldata _message
    ) internal pure override returns (bool) {
        return _message.body().amount() == 0;
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata metadata
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
    ) HypNative(SCALE, _mailbox) OPL2ToL1CcipReadIsm(_opPortal) {}
}

contract OpL1V2NativeTokenBridge is
    OpL1NativeTokenBridge,
    OPL2ToL1V2CcipReadIsm
{
    constructor(
        address _mailbox,
        address _opPortal
    ) HypNative(SCALE, _mailbox) OPL2ToL1CcipReadIsm(_opPortal) {}
}
