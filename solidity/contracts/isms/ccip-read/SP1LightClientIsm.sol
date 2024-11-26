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
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ISP1LightClient} from "../../interfaces/ISP1LightClient.sol";

// ============ Internal Imports ============

import {AbstractCcipReadIsm} from "./AbstractCcipReadIsm.sol";
import {Message} from "../../libs/Message.sol";
import {Mailbox} from "../../Mailbox.sol";
import {DispatchedHook} from "../../hooks/DispatchedHook.sol";
import {StorageProof} from "../../libs/StateProofHelpers.sol";
import {ISuccinctProofsService} from "../../interfaces/ccip-gateways/ISuccinctProofsService.sol";
import {StorageProofIsm} from "./StorageProofIsm.sol";

/**
 * @title SP1LightClientIsm
 * @notice Uses Succinct to verify that a message was delivered via a Hyperlane Mailbox and tracked by DispatchedHook
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

    function getHeadStateSlot() public view override returns (uint256) {
        return ISP1LightClient(lightClient).head();
    }

    /**
     * @notice Reverts with the data needed to query Succinct for header proofs
     * @dev See https://eips.ethereum.org/EIPS/eip-3668 for more information
     * @param _message encoded Message that will be included in offchain query
     *
     * @dev In the future, check if fees have been paid before request a proof from Succinct.
     * For now this feature is not complete according to the Succinct team.
     */
    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup(
            address(this),
            offchainUrls,
            abi.encodeWithSelector(
                ISuccinctProofsService.getProofs.selector,
                address(dispatchedHook),
                dispatchedSlotKey(_message.nonce()),
                getHeadStateSlot()
            ),
            StorageProofIsm.process.selector,
            _message
        );
    }
}
