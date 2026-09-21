// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.20;

import {MockLayerZeroEndpointV2} from "./MockLayerZeroEndpointV2.sol";

contract MockLayerZeroReceiveUln {
    MockLayerZeroEndpointV2 public immutable endpoint;
    bool public ready = true;

    constructor(address _endpointAddress) {
        endpoint = MockLayerZeroEndpointV2(_endpointAddress);
    }

    function setReady(bool _ready) external {
        ready = _ready;
    }

    function commitVerification(
        bytes calldata packetHeader,
        bytes32 payloadHash
    ) external {
        require(ready, "DVNs pending");
        require(packetHeader.length == 81, "header");
        uint64 nonce;
        uint32 sourceEndpointId;
        bytes32 sender;
        address receiver;
        assembly ("memory-safe") {
            nonce := shr(192, calldataload(add(packetHeader.offset, 1)))
            sourceEndpointId := shr(
                224,
                calldataload(add(packetHeader.offset, 9))
            )
            sender := calldataload(add(packetHeader.offset, 13))
            receiver := calldataload(add(packetHeader.offset, 49))
        }
        endpoint.mockVerify(
            receiver,
            sourceEndpointId,
            sender,
            nonce,
            payloadHash
        );
    }
}
