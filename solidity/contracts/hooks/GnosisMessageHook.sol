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
import {IGnosisMessageHook} from "../interfaces/hooks/IGnosisMessageHook.sol";
import {IForeignAMB} from "../interfaces/hooks/vendor/IAMB.sol";
import {GnosisISM} from "../isms/native/GnosisISM.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ArbitrumMessageHook
 * @notice Message hook to inform the Arbitrum ISM of messages published through
 * the native Arbitrum bridge.
 */
contract GnosisMessageHook is IGnosisMessageHook, Ownable {
    // ============ Constants ============

    // Domain of chain on which the arbitrum ISM is deployed
    uint32 public immutable destinationDomain;
    // Arbitrum ISM to verify messages
    GnosisISM public immutable ism;
    // Gnosis's foreign bridge used to send messages from L1 -> L2
    IForeignAMB public immutable amb;

    // ============ Public Storage ============

    // Gas limit for L2 execution (storage write)
    uint128 public constant GAS_LIMIT = 26_000;
    // Gas price for L2 - currently 0.1 gwei
    uint128 public maxGasPrice = 1e8;

    // ============ Constructor ============

    constructor(
        uint32 _destinationDomain,
        address _foreignAMB,
        address _ism
    ) {
        require(
            _destinationDomain != 0,
            "GnosisHook: invalid destination domain"
        );
        destinationDomain = _destinationDomain;

        amb = IForeignAMB(_onlyContract(_foreignAMB, "AMB"));
        ism = GnosisISM(_onlyContract(_ism, "ISM"));
    }

    // ============ External Functions ============

    /**
     * @notice Hook to inform the Arbitrum ISM of messages published through.
     * @notice anyone can call this function, that's why we to send msg.sender
     * @notice you can send value by overpaying postDispatch <totalGasCost
     * @param _destinationDomain The destination domain of the message.
     * @param _messageId The message ID.
     * @return gasOverhead The gas overhead for the function call on L2.
     */
    function postDispatch(uint32 _destinationDomain, bytes32 _messageId)
        external
        payable
        override
        returns (uint256)
    {
        require(
            _destinationDomain == destinationDomain,
            "GnosisHook: invalid destination domain"
        );

        bytes memory _payload = abi.encodeCall(
            ism.receiveFromHook,
            (msg.sender, _messageId)
        );

        amb.requireToPassMessage(address(ism), _payload, GAS_LIMIT);

        emit GnosisMessagePublished(msg.sender, _messageId);

        return 0;
    }

    // ============ Internal Functions ============

    function _onlyContract(address _contract, string memory _type)
        internal
        view
        returns (address)
    {
        require(
            Address.isContract(_contract),
            string.concat("GnosisHook: invalid ", _type)
        );
        return _contract;
    }
}
