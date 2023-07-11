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
import {IMessageHook} from "../interfaces/hooks/IMessageHook.sol";
import {OptimismISM} from "../isms/hook/optimism/OptimismISM.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OptimismMessageHook
 * @notice Message hook to inform the Optimism ISM of messages published through
 * the native Optimism bridge.
 */
contract OptimismMessageHook is IMessageHook {
    using TypeCasts for address;
    // ============ Constants ============

    // Domain of chain on which the optimism ISM is deployed
    uint32 public immutable destinationDomain;
    // Messenger used to send messages from L1 -> L2
    ICrossDomainMessenger public immutable l1Messenger;
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
     * @dev anyone can call this function, that's why we need to send msg.sender
     * @param _destination The destination domain of the message.
     * @param _messageId The message ID.
     * @return gasOverhead The gas overhead for the function call on L2.
     */
    function postDispatch(uint32 _destination, bytes32 _messageId)
        public
        payable
        override
        returns (uint256)
    {
        require(msg.value == 0, "OptimismHook: no value allowed");
        require(
            _destination == destinationDomain,
            "OptimismHook: invalid destination domain"
        );

        bytes memory _payload = abi.encodeCall(
            OptimismISM.verifyMessageId,
            (msg.sender.addressToBytes32(), _messageId)
        );

        l1Messenger.sendMessage(ism, _payload, GAS_LIMIT);

        // calling the verifyMessageId function is ~25k gas but we get 1.92m gas from Optimism
        return 0;
    }
}
