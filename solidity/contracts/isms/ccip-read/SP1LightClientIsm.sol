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

// ============ External Imports ============
import {ISP1LightClient} from "../../interfaces/ISP1LightClient.sol";

// ============ Internal Imports ============
import {StorageProofIsm} from "./StorageProofIsm.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title SP1LightClientIsm
 * @notice Uses Succinct SP1 / Telepathy light client to verify that a message was dispatched via a Hyperlane Mailbox and tracked by DispatchedHook
 */
contract SP1LightClientIsm is StorageProofIsm {
    using Message for bytes;

    /**
     * @notice Gets the current head state root from Succinct LightClient
     */
    function getHeadStateRoot() public view override returns (bytes32) {
        return
            ISP1LightClient(lightClient).executionStateRoots(
                ISP1LightClient(lightClient).head()
            );
    }

    /**
     * @notice Gets the current head state slot from Succinct LightClient
     */
    function getHeadStateSlot() public view override returns (uint256) {
        return ISP1LightClient(lightClient).head();
    }
}
