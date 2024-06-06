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
import {AbstractPostDispatchHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {Mailbox} from "../Mailbox.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {MailboxClient} from "../client/MailboxClient.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ArbSys} from "@arbitrum/nitro-contracts/src/precompiles/ArbSys.sol";

/**
 * @title ArbL2ToL1Hook
 * @notice Message hook to inform the ArbL2ToL1iSM of messages published through
 * the native Arbitrum bridge.
 * @notice This works only for L2 -> L1 messages and has the 7 day delay as specified by the ArbSys contract.
 */
contract ArbL2ToL1Hook is AbstractPostDispatchHook, MailboxClient {
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // ============ Events ============

    // emitted when the Merkle tree state in bridge state is updated
    event ArbSysMerkleTreeUpdated(uint256 size, uint256 leaf);

    // ============ Constants ============

    // left-padded address for ISM to verify messages
    bytes32 public immutable remoteMailbox;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;
    // precompile contract on L2 for sending messages to L1
    ArbSys public immutable arbSys;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _remoteMailbox,
        address _arbSys
    ) MailboxClient(_mailbox) {
        require(
            _destinationDomain != 0,
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        remoteMailbox = _remoteMailbox;
        destinationDomain = _destinationDomain;

        require(Address.isContract(_arbSys), "ArbL2ToL1Hook: invalid ArbSys");
        arbSys = ArbSys(_arbSys);
    }

    // ============ Internal functions ============
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0; // gas subsidized by the L2
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.ARBITRUM_L2_TO_L1_HOOK);
    }

    // ============ Internal functions ============

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes32 id = message.id();
        require(
            _isLatestDispatched(id),
            "ArbL2ToL1Hook: message not latest dispatched"
        );
        require(
            message.destination() == destinationDomain,
            "ArbL2ToL1Hook: invalid destination domain"
        );

        bytes memory payload = abi.encodeCall(
            Mailbox.process,
            (metadata, message)
        );

        arbSys.sendTxToL1(TypeCasts.bytes32ToAddress(remoteMailbox), payload);
    }
}
