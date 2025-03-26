// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";
import {ValueTransferBridgeNative} from "./ValueTransferBridgeNative.sol";
import {IStandardBridge} from "../interfaces/optimism/IStandardBridge.sol";

contract OPValueTransferBridgeNative is ValueTransferBridgeNative {
    using TypeCasts for bytes32;

    uint32 public immutable L1_DOMAIN;
    uint32 public constant L1_MIN_GAS_LIMIT = 50_000; // FIXME

    constructor(
        uint32 _l1Domain,
        address _l2Bridge,
        address _mailbox
    ) ValueTransferBridgeNative(_l2Bridge, _mailbox) {
        L1_DOMAIN = _l1Domain;
    }

    function _l2BridgeTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes memory _extraData
    ) internal override {
        require(_destination == L1_DOMAIN, "Invalid destination domain");

        IStandardBridge(payable(l2Bridge)).bridgeETHTo{value: _amount}(
            _recipient.bytes32ToAddress(),
            L1_MIN_GAS_LIMIT,
            _extraData
        );
    }
}
