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

import {TypeCasts} from "../libs/TypeCasts.sol";
import {FraudType, FraudMessage, Attribution} from "../libs/FraudMessage.sol";
import {AttributeCheckpointFraud} from "../AttributeCheckpointFraud.sol";
import {GasRouter} from "../client/GasRouter.sol";

contract FraudProofRouter is GasRouter {
    // ===================== State Variables =======================

    // The AttributeCheckpointFraud contract to obtain the attributions from
    AttributeCheckpointFraud public immutable attributeCheckpointFraud;

    // Mapping to store the fraud attributions for a given origin, signer, and digest for easy access for client contracts to aide slashing
    mapping(uint32 origin => mapping(address signer => mapping(bytes32 digest => Attribution)))
        public fraudAttributions;

    // ===================== Events =======================

    event FraudProofSent(
        address indexed signer,
        bytes32 indexed digest,
        Attribution attribution
    );

    event LocalFraudProofReceived(
        address indexed signer,
        bytes32 indexed digest,
        Attribution attribution
    );

    event FraudProofReceived(
        uint32 indexed origin,
        address indexed signer,
        bytes32 indexed digest,
        Attribution attribution
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
        hook = mailbox.defaultHook();
    }

    /**
     * @notice Sends a fraud proof attribution.
     * @param _signer The address of the signer attributed with fraud.
     * @param _digest The digest associated with the fraud.
     * @return The message ID of the sent fraud proof.
     */
    function sendFraudProof(
        uint32 _destination,
        address _signer,
        bytes32 _digest
    ) external returns (bytes32) {
        Attribution memory attribution = attributeCheckpointFraud.attributions(
            _signer,
            _digest
        );

        require(attribution.timestamp != 0, "Attribution does not exist");

        if (_destination == mailbox.localDomain()) {
            fraudAttributions[_destination][_signer][_digest] = attribution;

            emit LocalFraudProofReceived(_signer, _digest, attribution);

            return bytes32(0);
        } else {
            bytes memory encodedMessage = FraudMessage.encode(
                _signer,
                _digest,
                attribution
            );

            emit FraudProofSent(_signer, _digest, attribution);

            return
                _Router_dispatch(
                    _destination,
                    0,
                    encodedMessage,
                    "",
                    address(hook)
                );
        }
    }

    /**
     * @notice Handles by decoding the inbound fraud proof message.
     * @param _origin The origin domain of the fraud proof.
     * @param _message The encoded fraud proof message.
     */
    function _handle(
        uint32 _origin,
        bytes32,
        /*_sender*/
        bytes calldata _message
    ) internal override {
        (
            address signer,
            bytes32 digest,
            Attribution memory attribution
        ) = FraudMessage.decode(_message);

        fraudAttributions[_origin][signer][digest] = attribution;

        emit FraudProofReceived(_origin, signer, digest, attribution);
    }
}
