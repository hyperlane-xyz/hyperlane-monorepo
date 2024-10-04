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
 * @title LayerZeroV2Ism
 * @notice Uses LayerZero V2 deliver and verify a messages Id
 */
contract LayerZeroV2Ism is AbstractMessageIdAuthorizedIsm {
    using Message for bytes;
    using TypeCasts for bytes32;

    // Layerzero endpoint address
    address public immutable endpoint;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    // @dev the offset of msg.data where the function parameters (as bytes) begins. 4 bytes is always used when encoding the function selector
    uint8 constant FUNC_SELECTOR_OFFSET = 4;

    // @dev the offset of msg.data where Origin.sender begins. 32 is always used since calldata comes in 32 bytes.
    uint8 constant ORIGIN_SENDER_OFFSET = FUNC_SELECTOR_OFFSET + 32;

    // ============ Constructor ============
    constructor(address _endpoint) {
        require(
            _endpoint != address(0),
            "LayerZeroV2Ism: invalid authorized endpoint"
        );
        endpoint = _endpoint;
    }

    /**
     * @notice Entry point for receiving msg/packet from the LayerZero endpoint.
     * @param _lzMessage The payload of the received message.
     * @dev Authorization verification is done within preVerifyMessage() -> _isAuthorized()
     */
    function lzReceive(
        Origin calldata,
        bytes32,
        bytes calldata _lzMessage,
        address,
        bytes calldata
    ) external payable {
        preVerifyMessage(_messageId(_lzMessage), _msgValue(_lzMessage));
    }

    // ============ Internal function ============

    /**
     * @notice Slices the messageId from the message delivered from LayerZeroV2Hook
     * @dev message is created as abi.encodeCall(AbstractMessageIdAuthorizedIsm.preVerifyMessage, id)
     * @dev _message will be 36 bytes (4 bytes for function selector, and 32 bytes for messageId)
     */
    function _messageId(
        bytes calldata _message
    ) internal pure returns (bytes32) {
        return bytes32(_message[FUNC_SELECTOR_OFFSET:ORIGIN_SENDER_OFFSET]);
    }

    /**
     * @notice Slices the msgValue from the message delivered from LayerZeroV2Hook
     * @dev message is created as abi.encodeCall(AbstractMessageIdAuthorizedIsm.preVerifyMessage, (id,msgValue))
     * @dev _message will be 68 bytes (4 bytes for function selector, and 32 bytes for messageId, another 32 for msgValue)
     */
    function _msgValue(
        bytes calldata _message
    ) internal pure returns (uint256) {
        return uint256(bytes32(_message[ORIGIN_SENDER_OFFSET:]));
    }

    /**
     * @notice Validates criteria to verify a message
     * @dev this is called by AbstractMessageIdAuthorizedIsm.preVerifyMessage
     * @dev parses msg.value to get parameters from lzReceive()
     */
    function _isAuthorized() internal view override returns (bool) {
        require(_isAuthorizedHook(), "LayerZeroV2Ism: hook is not authorized");

        require(
            _isAuthorizedEndPoint(),
            "LayerZeroV2Ism: endpoint is not authorized"
        );

        return true;
    }

    /**
     * @notice check if origin.sender is the authorized hook
     */
    function _isAuthorizedHook() internal view returns (bool) {
        return bytes32(msg.data[ORIGIN_SENDER_OFFSET:]) == authorizedHook;
    }

    /**
     * @notice check if LayerZero endpoint is authorized
     */
    function _isAuthorizedEndPoint() internal view returns (bool) {
        return msg.sender == endpoint;
    }
}
