// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IOptimismMessageHook} from "../interfaces/hooks/IOptimismMessageHook.sol";
import {OptimismISM} from "../isms/native/OptimismISM.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

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
    ICrossDomainMessenger public immutable l1messenger;
    // Gas limit for sending messages to L2
    // First 1.92e6 gas is provided by Optimism, see more here:
    // https://community.optimism.io/docs/developers/bridge/messaging/#for-l1-%E2%87%92-l2-transactions
    uint32 internal constant GAS_LIMIT = 1_920_000;

    // ============ Public Storage ============

    // Optimism ISM to verify messages
    OptimismISM public ism;

    // ============ Constructor ============

    constructor(uint32 _destinationDomain, ICrossDomainMessenger _messenger) {
        destinationDomain = _destinationDomain;
        l1messenger = _messenger;
    }

    // ============ External Functions ============

    /**
     * @notice Sets the optimism ISM you want to use to verify messages.
     * @param _ism The address of the optimism ISM.
     */
    function setOptimismISM(address _ism) external {
        require(address(ism) == address(0), "OptimismHook: ism already set");
        ism = OptimismISM(_ism);
    }

    /**
     * @notice Hook to inform the optimism ISM of messages published through.
     * @notice anyone can call this function, that's why we to send msg.sender
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
        require(
            address(ism) != address(0),
            "OptimismHook: OptimismISM not set"
        );

        bytes memory _payload = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (_messageId, msg.sender)
        );

        l1messenger.sendMessage(address(ism), _payload, GAS_LIMIT);

        emit OptimismMessagePublished(address(ism), msg.sender, _messageId);

        // calling the receiveFromHook function is ~25k gas but we get 1.92m gas from Optimism
        return 0;
    }
}
