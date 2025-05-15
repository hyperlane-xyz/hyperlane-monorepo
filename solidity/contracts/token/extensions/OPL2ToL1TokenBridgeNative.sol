// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../../token/HypNative.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {TokenRouter} from "../../token/libs/TokenRouter.sol";
import {IStandardBridge} from "../../interfaces/optimism/IStandardBridge.sol";
import {Quote, ITokenBridge} from "../../interfaces/ITokenBridge.sol";

contract OPL2ToL1TokenBridgeNative is ITokenBridge, HypNative {
    using TypeCasts for bytes32;

    uint256 public constant FINALIZE_WITHDRAWAL_GAS_LIMIT = 300_000;
    uint32 public constant OP_MIN_GAS_LIMIT_ON_L1 = 50_000;
    address payable public constant OP_MESSAGE_PASSER =
        payable(0x4200000000000000000000000000000000000016);

    // L2 bridge used to initiate the withdrawal
    IStandardBridge public immutable l2Bridge;
    // L1 domain where the withdrawal will be finalized
    uint32 public immutable l1Domain;

    constructor(
        uint256 _scale,
        address _mailbox,
        uint32 _l1Domain,
        address _l2Bridge
    ) HypNative(_scale, _mailbox) {
        l1Domain = _l1Domain;
        l2Bridge = IStandardBridge(payable(_l2Bridge));
        _setDestinationGas(_l1Domain, FINALIZE_WITHDRAWAL_GAS_LIMIT);
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual override returns (bytes32 messageId) {
        messageId = super._transferRemote(
            _destination,
            _recipient,
            _amount,
            _value,
            _hookMetadata,
            _hook
        );

        l2Bridge.bridgeETHTo{value: _amount}(
            _recipient.bytes32ToAddress(),
            OP_MIN_GAS_LIMIT_ON_L1,
            bytes("") // extraData
        );
    }
}
