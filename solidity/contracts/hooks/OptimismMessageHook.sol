// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IOptimismMessageHook} from "../interfaces/hooks/IOptimismMessageHook.sol";
import {OptimismISM} from "../isms/native/OptimismISM.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";

/**
 * @title OptimismMessageHook
 * @notice Message hook to inform the Optimism ISM of messages published through
 * the native Optimism bridge.
 */
contract OptimismMessageHook is IOptimismMessageHook {
    // ============ Constants ============

    // Domain of chain on which the optimism ISM is deployed
    uint32 public immutable destinationDomain;
    // Messenger used to send messages from L1 -> L2
    ICrossDomainMessenger public immutable l1Messenger;
    // Optimism ISM to verify messages
    OptimismISM public immutable ism;
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
            _messenger != address(0),
            "OptimismHook: invalid messenger address"
        );
        require(_ism != address(0), "OptimismHook: invalid ism address");

        destinationDomain = _destinationDomain;
        l1Messenger = ICrossDomainMessenger(_messenger);
        ism = OptimismISM(_ism);
    }

    // ============ External Functions ============

    /**
     * @notice Hook to inform the optimism ISM of messages published through.
     * @dev anyone can call this function, that's why we to send msg.sender
     * @param _destination The destination domain of the message.
     * @param _messageId The message ID.
     * @return gasOverhead The gas overhead for the function call on L2.
     */
    function postDispatch(uint32 _destination, bytes32 _messageId)
        external
        override
        returns (uint256)
    {
        require(
            _destination == destinationDomain,
            "OptimismHook: invalid destination domain"
        );

        bytes memory _payload = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (msg.sender, _messageId)
        );

        l1Messenger.sendMessage(address(ism), _payload, GAS_LIMIT);

        emit OptimismMessagePublished(msg.sender, _messageId);

        // calling the receiveFromHook function is ~25k gas but we get 1.92m gas from Optimism
        return 0;
    }
}
