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
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {ArbSys} from "@arbitrum/nitro-contracts/src/precompiles/ArbSys.sol";

/**
 * @title OPStackHook
 * @notice Message hook to inform the OPStackIsm of messages published through
 * the native OPStack bridge.
 * @notice This works only for L1 -> L2 messages.
 */
contract ArbL2ToL1Hook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;

    event ArbSysMerkleTreeUpdated(uint256 size, uint256 leaf);

    // ============ Constants ============

    ArbSys public immutable arbSys;

    // NodeInterface public immutable arbitrumNodeInterface;

    // Gas limit for sending messages to L2
    // First 1.92e6 gas is provided by Optimism, see more here:
    // https://community.optimism.io/docs/developers/bridge/messaging/#for-l1-%E2%87%92-l2-transactions
    uint32 internal constant GAS_LIMIT = 1_920_000;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _arbSys
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        require(Address.isContract(_arbSys), "OPStackHook: invalid messenger");
        arbSys = ArbSys(_arbSys);
    }

    // ============ Internal functions ============
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0; // gas subsidized by the L2
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata,
        bytes memory payload
    ) internal override {
        uint256 leadNum = arbSys.sendTxToL1(
            TypeCasts.bytes32ToAddress(ism),
            payload
        );

        // TODO: if too expensive, remove this
        (uint256 size, , ) = arbSys.sendMerkleTreeState();

        emit ArbSysMerkleTreeUpdated(size, leadNum);
    }

    // function getOutboxProof(uint64 size, uint64 leaf)
    //     external
    //     view
    //     returns (bytes32 send, bytes32 root, bytes32[] memory proof)
    // {}
}
