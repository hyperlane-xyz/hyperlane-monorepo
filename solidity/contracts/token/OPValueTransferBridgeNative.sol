// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {ValueTransferBridgeNative} from "./ValueTransferBridgeNative.sol";
import {IStandardBridge} from "../interfaces/optimism/IStandardBridge.sol";
import {Quotes} from "../interfaces/IValueTransferBridge.sol";

contract OPValueTransferBridgeNative is ValueTransferBridgeNative {
    using TypeCasts for bytes32;

    uint32 public constant L1_MIN_GAS_LIMIT = 50_000; // FIXME
    uint32 constant HOOK_METADATA_GAS_LIMIT = 450_000;

    // L2 bridge used to initiate the withdrawal
    address public immutable l2Bridge;
    // L1 domain where the withdrawal will be finalized
    uint32 public immutable l1Domain;

    constructor(
        uint32 _l1Domain,
        address _l2Bridge,
        address _mailbox
    ) ValueTransferBridgeNative(_mailbox) {
        l1Domain = _l1Domain;
        l2Bridge = _l2Bridge;
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quotes[] memory quotes) {
        bytes memory hookMetadata = StandardHookMetadata.overrideGasLimit(
            HOOK_METADATA_GAS_LIMIT
        );

        bytes memory tokenMessage = TokenMessage.format(
            _recipient,
            _amount,
            bytes("") // metadata
        );

        quotes = new Quotes[](1);
        quotes[0] = Quotes(
            address(0),
            _Router_quoteDispatch(
                l1Domain,
                tokenMessage,
                hookMetadata,
                address(hook)
            )
        );
    }

    function _transferFromSender(
        uint256 _amountOrId
    ) internal override returns (bytes memory metadata) {
        bytes32 remoteRouter = _mustHaveRemoteRouter(l1Domain);
        bytes memory extraData = bytes("");
        IStandardBridge(payable(l2Bridge)).bridgeETHTo{value: _amountOrId}(
            remoteRouter.bytes32ToAddress(),
            L1_MIN_GAS_LIMIT,
            extraData
        );
    }
}
