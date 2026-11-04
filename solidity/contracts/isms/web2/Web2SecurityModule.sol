// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IWeb2SecurityModule} from "../../interfaces/isms/IWeb2SecurityModule.sol";
import {Web2IsmMetadata} from "../libs/Web2IsmMetadata.sol";
import {Message} from "../../libs/Message.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

/**
 * @title Web2SecurityModule
 * @notice Interchain Security Module designed to authenticate Web2 API oracle responses
 * delivered to smart contracts via Hyperlane Mailboxes.
 * @dev Verifies that incoming messages originate from the designated Web2 domain,
 * match registered API endpoints (if enabled), contain fresh execution timestamps,
 * and carry m-of-n ECDSA signatures from authorized keepers / oracle signers.
 */
contract Web2SecurityModule is IWeb2SecurityModule, Ownable, PackageVersioned {
    using Message for bytes;
    using Web2IsmMetadata for bytes;

    // ============ Constants ============
    uint8 public constant override moduleType =
        uint8(IInterchainSecurityModule.Types.MESSAGE_ID_MULTISIG);

    // ============ Public Storage ============
    uint32 public override web2Domain;
    uint8 public override threshold;
    uint256 public override maxAttestationAge;
    bool public override requireEndpointAuthorization;

    address[] internal _signers;
    mapping(address => bool) internal _isSigner;
    mapping(bytes32 => bool) internal _authorizedEndpoints;

    // ============ Constructor ============
    /**
     * @notice Initializes the Web2SecurityModule.
     * @param _owner The contract owner.
     * @param _web2Domain The domain ID designating Web2 callers.
     * @param _initialSigners Array of authorized keeper/oracle signer addresses.
     * @param _threshold Required number of unique keeper signatures (m-of-n).
     * @param _maxAttestationAge Maximum age (in seconds) for attestation timestamps (0 to disable).
     * @param _requireEndpointAuth True if only whitelisted endpoint hashes can send responses.
     */
    constructor(
        address _owner,
        uint32 _web2Domain,
        address[] memory _initialSigners,
        uint8 _threshold,
        uint256 _maxAttestationAge,
        bool _requireEndpointAuth
    ) Ownable() {
        require(_owner != address(0), "Web2SecurityModule: invalid owner");
        web2Domain = _web2Domain;
        maxAttestationAge = _maxAttestationAge;
        requireEndpointAuthorization = _requireEndpointAuth;

        _setSignersAndThreshold(_initialSigners, _threshold);
        _transferOwnership(_owner);
    }

    // ============ External / Admin Functions ============

    /**
     * @notice Sets the designated Web2 domain ID.
     * @param _newDomain New domain ID.
     */
    function setWeb2Domain(uint32 _newDomain) external onlyOwner {
        uint32 old = web2Domain;
        web2Domain = _newDomain;
        emit Web2DomainUpdated(old, _newDomain);
    }

    /**
     * @notice Updates the maximum age of keeper attestations.
     * @param _newMaxAge Max age in seconds.
     */
    function setMaxAttestationAge(uint256 _newMaxAge) external onlyOwner {
        uint256 old = maxAttestationAge;
        maxAttestationAge = _newMaxAge;
        emit AttestationAgeLimitUpdated(old, _newMaxAge);
    }

    /**
     * @notice Toggles endpoint authorization enforcement.
     * @param _required True to restrict responses to registered endpoints.
     */
    function setRequireEndpointAuthorization(
        bool _required
    ) external onlyOwner {
        requireEndpointAuthorization = _required;
    }

    /**
     * @notice Registers an authorized API endpoint hash.
     * @param _endpointHash Hash of the API URL (keccak256(bytes(url))).
     */
    function registerEndpoint(bytes32 _endpointHash) external onlyOwner {
        _authorizedEndpoints[_endpointHash] = true;
        emit EndpointRegistered(_endpointHash);
    }

    /**
     * @notice Batch registers authorized endpoint hashes.
     * @param _endpointHashes Array of endpoint hashes.
     */
    function registerEndpoints(
        bytes32[] calldata _endpointHashes
    ) external onlyOwner {
        for (uint256 i = 0; i < _endpointHashes.length; i++) {
            _authorizedEndpoints[_endpointHashes[i]] = true;
            emit EndpointRegistered(_endpointHashes[i]);
        }
    }

    /**
     * @notice Unregisters an API endpoint hash.
     * @param _endpointHash Hash of the API URL.
     */
    function unregisterEndpoint(bytes32 _endpointHash) external onlyOwner {
        _authorizedEndpoints[_endpointHash] = false;
        emit EndpointUnregistered(_endpointHash);
    }

    /**
     * @notice Sets authorized keeper signers and threshold.
     * @param _newSigners New array of keeper signer addresses.
     * @param _threshold Required signatures threshold.
     */
    function setSignersAndThreshold(
        address[] calldata _newSigners,
        uint8 _threshold
    ) external onlyOwner {
        _setSignersAndThreshold(_newSigners, _threshold);
    }

    // ============ View Functions ============

    function signers() external view override returns (address[] memory) {
        return _signers;
    }

    function isAuthorizedSigner(
        address _signer
    ) external view override returns (bool) {
        return _isSigner[_signer];
    }

    function isAuthorizedEndpoint(
        bytes32 _endpointHash
    ) external view override returns (bool) {
        return _authorizedEndpoints[_endpointHash];
    }

    /**
     * @notice Computes the cryptographic digest expected to be signed by keepers.
     * @param _origin Origin domain of the message.
     * @param _sender Sender address/identifier on origin.
     * @param _recipient Recipient address on destination.
     * @param _messageId Unique Hyperlane message ID.
     * @param _endpointHash Hash of the API endpoint URL.
     * @param _timestamp Execution timestamp.
     * @param _requestId Unique request identifier.
     * @param _bodyHash Keccak256 hash of the message body.
     * @return Formatted EIP-191 Ethereum signed message digest.
     */
    function computeDigest(
        uint32 _origin,
        bytes32 _sender,
        bytes32 _recipient,
        bytes32 _messageId,
        bytes32 _endpointHash,
        uint64 _timestamp,
        bytes32 _requestId,
        bytes32 _bodyHash
    ) public pure returns (bytes32) {
        bytes32 hash = keccak256(
            abi.encode(
                _origin,
                _sender,
                _recipient,
                _messageId,
                _endpointHash,
                _timestamp,
                _requestId,
                _bodyHash
            )
        );
        return ECDSA.toEthSignedMessageHash(hash);
    }

    // ============ Verification ============

    /**
     * @inheritdoc IInterchainSecurityModule
     * @notice Verifies that the Web2 message is validly signed and authenticated.
     * @param _metadata Metadata containing timestamp, endpointHash, requestId, and keeper signatures.
     * @param _message Hyperlane formatted interchain message.
     * @return True if authentication succeeds.
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external view override returns (bool) {
        require(
            _message.origin() == web2Domain,
            "Web2SecurityModule: invalid origin domain"
        );

        if (requireEndpointAuthorization) {
            require(
                _authorizedEndpoints[_message.sender()],
                "Web2SecurityModule: unauthorized endpoint sender"
            );
        }

        (uint64 ts, bytes32 epHash) = _validateMetadata(
            _metadata,
            _message.sender()
        );

        require(
            _metadata.signatureCount() >= threshold && threshold > 0,
            "Web2SecurityModule: insufficient signatures"
        );

        bytes32 digest = _computeDigest(_metadata, _message, epHash, ts);

        _verifySignatures(_metadata, digest);

        return true;
    }

    // ============ Internal Functions ============

    function _computeDigest(
        bytes calldata _metadata,
        bytes calldata _message,
        bytes32 _endpointHash,
        uint64 _timestamp
    ) internal view returns (bytes32) {
        bytes32 hash = keccak256(
            abi.encode(
                web2Domain,
                _message.sender(),
                _message.recipient(),
                _message.id(),
                _endpointHash,
                _timestamp,
                _metadata.requestId(),
                keccak256(_message.body())
            )
        );
        return ECDSA.toEthSignedMessageHash(hash);
    }

    function _validateMetadata(
        bytes calldata _metadata,
        bytes32 _sender
    ) internal view returns (uint64 ts, bytes32 epHash) {
        epHash = _metadata.endpointHash();
        require(
            _sender == epHash,
            "Web2SecurityModule: sender mismatch with metadata endpoint"
        );

        ts = _metadata.timestamp();
        if (maxAttestationAge > 0) {
            require(
                block.timestamp >= ts,
                "Web2SecurityModule: future timestamp"
            );
            require(
                block.timestamp - ts <= maxAttestationAge,
                "Web2SecurityModule: attestation expired"
            );
        }
    }

    function _verifySignatures(
        bytes calldata _metadata,
        bytes32 _digest
    ) internal view {
        address prevSigner = address(0);
        for (uint256 i = 0; i < threshold; i++) {
            address signer = ECDSA.recover(_digest, _metadata.signatureAt(i));
            require(_isSigner[signer], "Web2SecurityModule: invalid signer");
            require(
                signer > prevSigner,
                "Web2SecurityModule: signatures must be strictly ascending and unique"
            );
            prevSigner = signer;
        }
    }

    function _setSignersAndThreshold(
        address[] memory _newSigners,
        uint8 _threshold
    ) internal {
        require(_threshold > 0, "Web2SecurityModule: threshold must be > 0");
        require(
            _newSigners.length >= _threshold,
            "Web2SecurityModule: signers count < threshold"
        );

        // Clear previous signers mapping
        for (uint256 i = 0; i < _signers.length; i++) {
            _isSigner[_signers[i]] = false;
        }

        _signers = new address[](_newSigners.length);
        address prevSigner = address(0);
        for (uint256 i = 0; i < _newSigners.length; i++) {
            address s = _newSigners[i];
            require(
                s != address(0),
                "Web2SecurityModule: invalid signer address"
            );
            require(
                s > prevSigner,
                "Web2SecurityModule: signers must be unique and in ascending order"
            );
            _signers[i] = s;
            _isSigner[s] = true;
            prevSigner = s;
        }

        threshold = _threshold;
        emit SignersUpdated(_signers, _threshold);
    }
}
