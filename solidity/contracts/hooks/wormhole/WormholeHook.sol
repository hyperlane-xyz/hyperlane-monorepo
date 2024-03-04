// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "../../libs/Message.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";

// TODO: figure out whether it is possible to import this using Hardhat:
// https://github.com/wormhole-foundation/wormhole/blob/main/ethereum/contracts/interfaces/IWormhole.sol
interface IWormhole {
    function publishMessage(
        uint32 nonce,
        bytes memory payload,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence);
}

contract WormholeHook is IPostDispatchHook {
    using Message for bytes;

    IMailbox public immutable MAILBOX;
    IWormhole public WORMHOLE;

    constructor(address _wormhole, address _mailbox) {
        WORMHOLE = IWormhole(_wormhole);
        MAILBOX = IMailbox(_mailbox);
    }

    function hookType() external pure returns (uint8) {
        return uint8(IPostDispatchHook.Types.WORMHOLE);
    }

    function supportsMetadata(bytes calldata) external pure returns (bool) {
        return true;
    }

    function postDispatch(
        bytes calldata,
        bytes calldata message
    ) external payable {
        // ensure hook only dispatches messages that are dispatched by the mailbox
        bytes32 id = message.id();
        require(
            _isLatestDispatched(id),
            "message not dispatched by Hyperlane mailbox"
        );
        // use 0 nonce, _isLatestDispatched is sufficient check.
        // 201 consistency level iis safest as it ensures finality is reached before bridging.
        WORMHOLE.publishMessage{value: msg.value}(0, abi.encodePacked(id), 202);
    }

    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure returns (uint256) {
        return 0;
    }

    /**
     * @notice Helper function to check wether an ID is the latest dispatched by Mailbox
     * @param _id The id to check.
     * @return true if latest, false otherwise.
     */
    function _isLatestDispatched(bytes32 _id) internal view returns (bool) {
        return MAILBOX.latestDispatchedId() == _id;
    }
}
