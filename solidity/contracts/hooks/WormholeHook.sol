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
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {Message} from "../libs/Message.sol";
import {IWormhole} from "../interfaces/IWormhole.sol";

/**
 * @title WormholeHook
 * @notice Publishes the Hyperlane message id to the Wormhole guardian network
 * so a WormholeIsm on the destination can verify the resulting VAA.
 * @dev Consistency level controls how long guardians wait before attesting
 * (e.g. 200 = instant, 201 = safe, 202 = finalized on supported chains).
 */
contract WormholeHook is AbstractMessageIdAuthHook {
    using Message for bytes;

    IWormhole public immutable wormhole;
    uint8 public immutable consistencyLevel;

    constructor(
        address _wormhole,
        uint8 _consistencyLevel,
        address _mailbox,
        uint32 _destination,
        bytes32 _ism
    ) AbstractMessageIdAuthHook(_mailbox, _destination, _ism) {
        require(_wormhole != address(0), "WormholeHook: invalid wormhole");
        wormhole = IWormhole(_wormhole);
        consistencyLevel = _consistencyLevel;
    }

    // ============ Internal functions ============

    function _quoteDispatch(
        bytes calldata /*metadata*/,
        bytes calldata /*message*/
    ) internal view override returns (uint256) {
        return wormhole.messageFee();
    }

    function _sendMessageId(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) internal override {
        wormhole.publishMessage{value: wormhole.messageFee()}(
            0,
            abi.encode(message.id()),
            consistencyLevel
        );
    }
}
