// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

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

import {TypeCasts} from "../libs/TypeCasts.sol";
import {FraudType, FraudMessage, Attribution} from "../libs/FraudMessage.sol";
import {AttributeCheckpointFraud} from "../AttributeCheckpointFraud.sol";
import {GasRouter} from "../client/GasRouter.sol";

contract FraudProofRouter is GasRouter {
    // ===================== State Variables =======================

    AttributeCheckpointFraud public immutable attributeCheckpointFraud;

    // store origin => signer => merkleTree => digest => {timestamp, fraudType}
    mapping(uint32 origin => mapping(bytes32 signer => mapping(bytes32 merkleTree => mapping(bytes32 digest => Attribution))))
        public fraudAttributions;

    // ===================== Events =======================

    event FraudProofSent(
        address indexed signer,
        bytes32 indexed digest,
        FraudType fraudType,
        uint48 timestamp,
        bytes32 indexed messageId
    );

    // ===================== Constructor =======================

    /**
     * @notice Initializes the FraudProofRouter with the mailbox address and AttributeCheckpointFraud contract.
     * @param _mailbox The address of the mailbox contract.
     * @param _attributeCheckpointFraud The address of the AttributeCheckpointFraud contract.
     */
    constructor(
        address _mailbox,
        address _attributeCheckpointFraud
    ) GasRouter(_mailbox) {
        require(
            _attributeCheckpointFraud != address(0),
            "Invalid AttributeCheckpointFraud address"
        );
        attributeCheckpointFraud = AttributeCheckpointFraud(
            _attributeCheckpointFraud
        );
    }

    /**
     * @notice Sends a fraud proof attribution.
     * @param _signer The address of the signer attributed with fraud.
     * @param _digest The digest associated with the fraud.
     * @param _fraudType The type of fraud.
     */
    function sendFraudProof(
        uint32 _destination,
        address _signer,
        bytes32 _merkleTree,
        bytes32 _digest,
        FraudType _fraudType
    ) external onlyOwner {
        Attribution memory attribution = attributeCheckpointFraud.attributions(
            _signer,
            _digest
        );

        require(attribution.timestamp != 0, "Attribution does not exist");

        bytes memory encodedMessage = FraudMessage.encode(
            TypeCasts.addressToBytes32(_signer),
            _merkleTree,
            _digest,
            attribution
        );

        bytes32 messageId = _dispatchFraudProof(_destination, encodedMessage);

        emit FraudProofSent(
            _signer,
            _digest,
            _fraudType,
            attribution.timestamp,
            messageId
        );
    }

    function _handle(
        uint32 _origin,
        bytes32,
        /*_sender*/ bytes calldata _message
    ) internal override onlyMailbox {
        (
            bytes32 signer,
            bytes32 merkleTree,
            bytes32 digest,
            Attribution memory attribution
        ) = FraudMessage.decode(_message);

        fraudAttributions[_origin][signer][merkleTree][digest] = attribution;
    }

    // ===================== Internal Functions =======================

    /**
     * @notice Dispatches the encoded fraud proof message using the Router.
     * @param _body The ABI-encoded fraud proof message.
     * @return The ID of the dispatched message.
     */
    function _dispatchFraudProof(
        uint32 _destination,
        bytes memory _body
    ) internal returns (bytes32) {
        bytes32 _router = routers(_destination);

        require(_router != bytes32(0), "Remote router not enrolled");

        bytes32 messageId = mailbox.dispatch{value: msg.value}(
            _destination,
            _router,
            _body,
            "",
            hook
        );

        return messageId;
    }
}
