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
import {IPolygonMessageHook} from "../interfaces/hooks/IPolygonMessageHook.sol";
import {PolygonISM} from "../isms/native/PolygonISM.sol";

// ============ External Imports ============
import {FxBaseRootTunnel} from "@maticnetwork/fx-portal/contracts/tunnel/FxBaseRootTunnel.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

contract PolygonMessageHook is IPolygonMessageHook, FxBaseRootTunnel {
    // ============ Constants ============

    // Polygon ISM to verify messages
    PolygonISM public immutable ism;
    // Domain of chain on which the polygon ISM is deployed
    uint32 public immutable destinationDomain;

    // ============ Constructor ============

    /**
     * @notice MessageDispatcherPolygon constructor.
     * @param _destinationDomain Domain of the chain on which the polygon ISM is deployed.
     * @param _checkpointManager Address of the root chain manager contract on L1.
     * @param _fxRoot Address of the state sender contract on L1.
     * @param _ism Address of the polygon ISM.
     */
    constructor(
        uint32 _destinationDomain,
        address _checkpointManager,
        address _fxRoot,
        address _ism
    ) FxBaseRootTunnel(_checkpointManager, _fxRoot) {
        require(
            _destinationDomain != 0,
            "PolygonHook: invalid destination domain"
        );

        destinationDomain = _destinationDomain;
        ism = PolygonISM(_onlyContract(_ism, "polygonISM"));
    }

    // ============ External Functions ============

    /**
     * @notice Hook to inform the polygon ISM of messages published through.
     * @dev anyone can call this function, that's why we to send msg.sender
     * @param _destination The destination domain of the message.
     * @param _messageId The message ID.
     * @return gasOverhead The gas overhead for the function call on L2.
     */
    function postDispatch(uint32 _destination, bytes32 _messageId)
        external
        payable
        override
        returns (uint256)
    {
        require(
            _destination == destinationDomain,
            "PolygonHook: invalid destination domain"
        );
        require(address(ism) != address(0), "PolygonHook: PolygonISM not set");

        bytes memory _payload = abi.encode(msg.sender, _messageId);

        _sendMessageToChild(_payload);

        emit PolygonMessagePublished(msg.sender, _messageId);

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

    function _onlyContract(address _contract, string memory _type)
        internal
        view
        returns (address)
    {
        require(
            Address.isContract(_contract),
            string.concat("PolygonHook: invalid ", _type)
        );
        return _contract;
    }
}
