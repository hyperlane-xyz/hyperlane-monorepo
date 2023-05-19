// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IPolygonMessageHook} from "../interfaces/hooks/IPolygonMessageHook.sol";
import {PolygonISM} from "../isms/native/PolygonISM.sol";

// ============ External Imports ============
import {FxBaseRootTunnel} from "fx-portal/contracts/tunnel/FxBaseRootTunnel.sol";

contract PolygonMessageHook is IPolygonMessageHook, FxBaseRootTunnel {
    // ============ Constants ============

    // Domain of chain on which the optimism ISM is deployed
    uint32 public immutable destinationDomain;

    // ============ Public Storage ============

    // Polygon ISM to verify messages
    PolygonISM public ism;

    // ============ Constructor ============

    /**
     * @notice MessageDispatcherPolygon constructor.
     * @param _checkpointManager Address of the root chain manager contract on L1
     * @param _fxRoot Address of the state sender contract on L1
     * @param _destinationDomain domain of the chain on which the polygon ISM is deployed
     */
    constructor(
        address _checkpointManager,
        address _fxRoot,
        uint32 _destinationDomain
    ) FxBaseRootTunnel(_checkpointManager, _fxRoot) {
        require(
            _destinationDomain != 0,
            "PolygonHook: destinationDomain cannot be 0"
        );
        destinationDomain = _destinationDomain;
    }

    // ============ External Functions ============

    /**
     * @notice Sets the optimism ISM you want to use to verify messages.
     * @param _ism The address of the optimism ISM.
     */
    function setPolygonISM(address _ism) external {
        require(address(ism) == address(0), "PolygonHook: ism already set");
        ism = PolygonISM(_ism);
        setFxChildTunnel(_ism);
    }

    /**
     * @notice Hook to inform the polygon ISM of messages published through.
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
            "PolygonHook: invalid destination domain"
        );
        require(address(ism) != address(0), "PolygonHook: PolygonISM not set");

        bytes memory _payload = abi.encode(_messageId, msg.sender);

        _sendMessageToChild(_payload);

        emit PolygonMessagePublished(address(ism), msg.sender, _messageId);

        return 0;
    }

    // ============ Internal Functions ============

    /**
     * @inheritdoc FxBaseRootTunnel
     * @dev Need to be inheritable from FxBaseRootTunnel for receiving and executing messages from Polygon.
     *      But not actually used.
     */
    function _processMessageFromChild(bytes memory data) internal override {
        // pass
    }
}
