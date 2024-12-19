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
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============
import {CrossChainEnabledOptimism} from "@openzeppelin/contracts/crosschain/optimism/CrossChainEnabledOptimism.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Optimistic ISM
 */
contract OptimisticIsm is IInterchainSecurityModule {
    using Message for bytes;

    mapping(bytes32 => uint48) public preverifiedMessages;

    event MessageQueued(bytes32 indexed messageId, uint48 readyAt);

    error MessageNotReadyUntil(uint48 readyAt);

    uint48 public immutable optimisticWindow;

    constructor(uint48 _optimisticWindow) {
        optimisticWindow = _optimisticWindow;
    }

    // ============ Constants ============
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    function verifyMessageId(bytes32 messageId) external {
        require(
            preverifiedMessages[messageId] == 0,
            "OptimisticIsm: message already preverified"
        );
        preverifiedMessages[messageId] = uint48(block.timestamp);
        emit MessageQueued(messageId, block.timestamp + optimisticWindow);
    }

    function verify(
        bytes calldata,
        bytes calldata message
    ) external view returns (bool) {
        uint48 timestamp = preverifiedMessages[message.id()];
        require(timestamp > 0, "OptimisticIsm: message not preverified");

        uint48 readyAt = timestamp + optimisticWindow;
        if (readyAt > block.timestamp) {
            revert MessageNotReadyUntil(readyAt);
        }
        return true;
    }
}
