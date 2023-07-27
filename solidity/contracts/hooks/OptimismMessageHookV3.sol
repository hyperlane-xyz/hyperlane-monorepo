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
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {OptimismISM} from "../isms/hook/OptimismISM.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";

// ============ External Imports ============
import {L1CrossDomainMessenger} from "@eth-optimism/contracts-bedrock/contracts/L1/L1CrossDomainMessenger.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OptimismMessageHook
 * @notice Message hook to inform the Optimism ISM of messages published through
 * the native Optimism bridge.
 */
contract OptimismMessageHook is IPostDispatchHook {
    using Message for bytes;
    using TypeCasts for address;

    // ============ Constants ============

    // Domain of chain on which the optimism ISM is deployed
    uint32 public immutable destinationDomain;
    // Messenger used to send messages from L1 -> L2
    L1CrossDomainMessenger public immutable l1Messenger;
    // address for Optimism ISM to verify messages
    address public immutable ism;
    // Gas limit for sending messages to L2
    // First 1.92e6 gas is provided by Optimism, see more here:
    // https://community.optimism.io/docs/developers/bridge/messaging/#for-l1-%E2%87%92-l2-transactions
    uint32 internal constant GAS_LIMIT = 1_920_000;

    // ============ Constructor ============

    constructor(
        uint32 _destinationDomain,
        address _messenger,
        address _ism
    ) {
        require(
            _destinationDomain != 0,
            "OptimismHook: invalid destination domain"
        );
        require(_ism != address(0), "OptimismHook: invalid ISM");
        destinationDomain = _destinationDomain;

        require(
            Address.isContract(_messenger),
            "OptimismHook: invalid messenger"
        );
        l1Messenger = ICrossDomainMessenger(_messenger);
        ism = _ism;
    }

    // ============ External Functions ============

    /**
     * @notice Hook to inform the optimism ISM of messages published through.
     * @param metadata The metadata for the hook caller (unused)
     * @param message The message being dispatched
     */
    function postDispatch(
        bytes calldata, /*metadata*/
        bytes calldata message
    ) external payable override {
        bytes32 messageId = message.id();

        require(
            message.destination() == destinationDomain,
            "OptimismHook: invalid destination domain"
        );

        bytes memory payload = abi.encodeCall(
            OptimismISM.verifyMessageId,
            (msg.sender.addressToBytes32(), messageId)
        );

        l1Messenger.sendMessage{value: msg.value}(ism, payload, GAS_LIMIT);
    }
}
