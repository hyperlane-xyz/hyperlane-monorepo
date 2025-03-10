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
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IRouterClient} from "@chainlink/contracts-ccip/src/v0.8/ccip/interfaces/IRouterClient.sol";
import {Client} from "@chainlink/contracts-ccip/src/v0.8/ccip/libraries/Client.sol";
import {CCIPReceiver} from "@chainlink/contracts-ccip/src/v0.8/ccip/applications/CCIPReceiver.sol";

/**
 * @title CCIPIsm
 * @notice Uses CCIP hook to verify interchain messages.
 */
contract CCIPIsm is AbstractMessageIdAuthorizedIsm, CCIPReceiver {
    using TypeCasts for bytes32;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    uint64 public immutable ccipOrigin;

    // ============ Storage ============
    constructor(
        address _ccipRouter,
        uint64 _ccipOrigin
    ) CCIPReceiver(_ccipRouter) {
        ccipOrigin = _ccipOrigin;
    }

    // ============ Internal functions ============
    function _ccipReceive(
        Client.Any2EVMMessage memory any2EvmMessage
    ) internal override {
        require(
            ccipOrigin == any2EvmMessage.sourceChainSelector,
            "Unauthorized origin"
        );

        bytes32 sender = abi.decode(any2EvmMessage.sender, (bytes32));
        require(sender == authorizedHook, "Unauthorized hook");

        bytes32 messageId = abi.decode(any2EvmMessage.data, (bytes32));
        preVerifyMessage(messageId, 0);
    }

    function _isAuthorized() internal view override returns (bool) {
        return msg.sender == getRouter();
    }
}
