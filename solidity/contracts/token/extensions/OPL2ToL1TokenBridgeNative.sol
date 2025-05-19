// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../../token/HypNative.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenRouter} from "../../token/libs/TokenRouter.sol";
import {IStandardBridge} from "../../interfaces/optimism/IStandardBridge.sol";
import {Quote, ITokenBridge} from "../../interfaces/ITokenBridge.sol";
import {StandardHookMetadata} from "../../hooks/libs/StandardHookMetadata.sol";
import {OPL2ToL1CcipReadIsm, OPL2ToL1V1CcipReadIsm, OPL2ToL1V2CcipReadIsm} from "../../isms/hook/OPL2ToL1CcipReadIsm.sol";
import {TokenMessage} from "../../token/libs/TokenMessage.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

uint256 constant SCALE = 1;

contract OpL2NativeTokenBridge is HypNative {
    using TypeCasts for bytes32;

    uint256 internal constant PROVE_WITHDRAWAL_GAS_LIMIT = 500_000;
    uint256 internal constant FINALIZE_WITHDRAWAL_GAS_LIMIT = 300_000;
    uint32 internal constant OP_MIN_GAS_LIMIT_ON_L1 = 50_000;

    // L2 bridge used to initiate the withdrawal
    IStandardBridge public immutable l2Bridge;

    constructor(
        address _mailbox,
        address _l2Bridge
    ) HypNative(SCALE, _mailbox) {
        l2Bridge = IStandardBridge(payable(_l2Bridge));
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual override returns (bytes32) {
        // refund first message fees to address(this) to cover second message
        bytes32 proveMessageId = super._transferRemote(
            _destination,
            _recipient,
            0,
            _value,
            StandardHookMetadata.format({
                _msgValue: 0,
                _gasLimit: PROVE_WITHDRAWAL_GAS_LIMIT,
                _refundAddress: address(this)
            }),
            _hook
        );

        address refundAddress = StandardHookMetadata.getRefundAddress(
            _hookMetadata
        );

        uint256 feeBalance = address(this).balance - _amount;
        bytes32 withdrawMessageId = super._transferRemote(
            _destination,
            _recipient,
            _amount,
            feeBalance,
            StandardHookMetadata.format({
                _msgValue: 0,
                _gasLimit: FINALIZE_WITHDRAWAL_GAS_LIMIT,
                _refundAddress: refundAddress
            }),
            _hook
        );

        l2Bridge.bridgeETHTo{value: _amount}(
            _recipient.bytes32ToAddress(),
            OP_MIN_GAS_LIMIT_ON_L1,
            abi.encode(proveMessageId, withdrawMessageId)
        );

        return withdrawMessageId;
    }

    function handle(uint32, bytes32, bytes calldata) external payable override {
        revert("OP L2 token bridge should not receive messages");
    }
}

abstract contract OpL1NativeTokenBridge is HypNative, OPL2ToL1CcipReadIsm {
    using TokenMessage for bytes;

    function _transferRemote(
        uint32,
        bytes32,
        uint256,
        uint256,
        bytes memory,
        address
    ) internal override returns (bytes32 messageId) {
        revert("OP L1 token bridge should not send messages");
    }

    // see OpL2NativeTokenBridge._transferRemote prove message amount := 0
    function _isProve(
        bytes calldata _message
    ) internal pure override returns (bool) {
        return _message.amount() == 0;
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata metadata
    ) internal override {
        // do not transfer to recipient as the OP L1 bridge will do it
    }
}

contract OpL1V1NativeTokenBridge is
    OpL1NativeTokenBridge,
    OPL2ToL1V1CcipReadIsm
{
    constructor(
        address _mailbox,
        address _opPortal,
        string[] memory _urls
    ) HypNative(SCALE, _mailbox) OPL2ToL1CcipReadIsm(_opPortal, _urls) {}

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }
}

contract OpL1V2NativeTokenBridge is
    OpL1NativeTokenBridge,
    OPL2ToL1V2CcipReadIsm
{
    constructor(
        address _mailbox,
        address _opPortal,
        string[] memory _urls
    ) HypNative(SCALE, _mailbox) OPL2ToL1CcipReadIsm(_opPortal, _urls) {}

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }
}
