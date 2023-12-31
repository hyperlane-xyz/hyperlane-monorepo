// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../../libs/Message.sol";
import {TypeCasts} from "../../../libs/TypeCasts.sol";
import {AbstractMessageIdAuthorizedIsm} from "../AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============
import {Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

/**
 * @title OPStackIsm
 * @notice Uses the native Optimism bridge to verify interchain messages.
 */
contract LayerZeroV2Ism is AbstractMessageIdAuthorizedIsm {
    using Message for bytes;

    // Layerzero endpoint address
    address public immutable endpoint;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    // ============ Constructor ============
    constructor(address _endpoint) {
        require(
            _endpoint != address(0),
            "LayerZeroV2Ism: invalid authorized endpoint"
        );
        endpoint = _endpoint;
    }

    /**
     * @dev Entry point for receiving msg/packet from the LayerZero endpoint.
     * @param _origin The origin information containing the source endpoint and sender address.
     *  - srcEid: The source chain endpoint ID.
     *  - sender: The sender address on the src chain.
     *  - nonce: The nonce of the message.
     * @param _message The payload of the received message.
     *
     */
    function lzReceive(
        Origin calldata _origin,
        bytes32,
        bytes calldata _message,
        address,
        bytes calldata
    ) external payable {
        // Only if endpoint caller and authorized hook sender
        require(
            _isAuthorizedEndPoint(msg.sender),
            "LayerZeroV2Ism: endpoint is not authorized"
        );
        require(
            _isAuthorizedHook(_origin.sender),
            "LayerZeroV2Ism: hook is not authorized"
        );
        require(
            _isMessageVerifySelector(_message),
            "LayerZeroV2Ism: message payload is incorrect"
        );

        // call verifyMessageId(messageId)
        (bool success, ) = address(this).call{value: msg.value}(_message);
        require(success, "LayerZeroV2Ism: verifyMessageId call failed");
    }

    // ============ Internal function ============

    /**
     * @notice check if endpoint authorized
     */
    function _isAuthorizedEndPoint(
        address _endpoint
    ) internal view returns (bool) {
        return _endpoint == endpoint;
    }

    /**
     * @notice check if hook authorized
     */
    function _isAuthorizedHook(bytes32 hook) internal view returns (bool) {
        return hook == authorizedHook;
    }

    /**
     * @notice check if the expected payload is the verifyMessageId selector, which is created in the authorized Hook
     */
    function _isMessageVerifySelector(
        bytes calldata message
    ) internal pure returns (bool) {
        return
            keccak256(abi.encode(bytes4(message))) ==
            keccak256(
                abi.encode(
                    AbstractMessageIdAuthorizedIsm.verifyMessageId.selector
                )
            );
    }

    /**
     * @notice Check if sender is this contract
     */
    function _isAuthorized() internal view override returns (bool) {
        return msg.sender == address(this);
    }
}
