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

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ArbSys} from "@arbitrum/nitro-contracts/src/precompiles/ArbSys.sol";

/**
 * @title ArbL2ToL1Hook
 * @notice Message hook to inform the ArbL2ToL1iSM of messages published through
 * the native Arbitrum bridge.
 * @notice This works only for L2 -> L1 messages and has the 7 day delay as specified by the ArbSys contract.
 */
contract ArbL2ToL1Hook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;

    // ============ Events ============

    // emitted when the Merkle tree state in bridge state is updated
    event ArbSysMerkleTreeUpdated(uint256 size, uint256 leaf);

    // ============ Constants ============

    // precompile contract on L2 for sending messages to L1
    ArbSys public immutable arbSys;

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
}
