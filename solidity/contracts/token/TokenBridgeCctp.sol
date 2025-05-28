// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {IMessageTransmitter} from "./../interfaces/cctp/IMessageTransmitter.sol";
import {IInterchainSecurityModule} from "./../interfaces/IInterchainSecurityModule.sol";
import {AbstractCcipReadIsm} from "./../isms/ccip-read/AbstractCcipReadIsm.sol";
import {TypedMemView} from "./../libs/TypedMemView.sol";
import {ITokenMessenger} from "./../interfaces/cctp/ITokenMessenger.sol";
import {Message} from "./../libs/Message.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {CctpMessage} from "../libs/CctpMessage.sol";

interface CctpService {
    function getCCTPAttestation(
        bytes calldata _message
    )
        external
        view
        returns (bytes memory cctpMessage, bytes memory attestation);
}

// @dev Supports only CCTP V1
contract TokenBridgeCctp is HypERC20Collateral, AbstractCcipReadIsm {
    using CctpMessage for bytes29;
    using Message for bytes;
    using TokenMessage for bytes;

    uint32 internal constant CCTP_VERSION = 0;

    // @notice CCTP message transmitter contract
    IMessageTransmitter public immutable messageTransmitter;

    // @notice CCTP token messenger contract
    ITokenMessenger public immutable tokenMessenger;

    struct Domain {
        uint32 hyperlane;
        uint32 circle;
    }

    /// @notice Hyperlane domain => Circle domain.
    /// We use a struct to avoid ambiguity with domain 0 being unknown.
    mapping(uint32 hypDomain => Domain circleDomain) internal _domainMap;

    /**
     * @notice Emitted when the Hyperlane domain to Circle domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param circleDomain The Circle domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 circleDomain);

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IMessageTransmitter _messageTransmitter,
        ITokenMessenger _tokenMessenger
    ) HypERC20Collateral(_erc20, _scale, _mailbox) {
        require(
            _messageTransmitter.version() == CCTP_VERSION,
            "Invalid messageTransmitter CCTP version"
        );
        messageTransmitter = _messageTransmitter;

        require(
            _tokenMessenger.messageBodyVersion() == CCTP_VERSION,
            "Invalid TokenMessenger CCTP version"
        );
        tokenMessenger = _tokenMessenger;

        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _owner,
        string[] memory __urls
    ) external virtual initializer {
        __Ownable_init();
        setUrls(__urls);
        // ISM should not be set
        _MailboxClient_initialize(_hook, address(0), _owner);
        wrappedToken.approve(address(tokenMessenger), type(uint256).max);
    }

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    /**
     * @notice Adds a new mapping between a Hyperlane domain and a Circle domain.
     * @param _hyperlaneDomain The Hyperlane domain.
     * @param _circleDomain The Circle domain.
     */
    function addDomain(
        uint32 _hyperlaneDomain,
        uint32 _circleDomain
    ) public onlyOwner {
        _domainMap[_hyperlaneDomain] = Domain(_hyperlaneDomain, _circleDomain);

        emit DomainAdded(_hyperlaneDomain, _circleDomain);
    }

    function addDomains(Domain[] memory domains) external onlyOwner {
        for (uint32 i = 0; i < domains.length; i++) {
            addDomain(domains[i].hyperlane, domains[i].circle);
        }
    }

    function hyperlaneDomainToCircleDomain(
        uint32 _hyperlaneDomain
    ) public view returns (uint32) {
        Domain memory domain = _domainMap[_hyperlaneDomain];
        require(
            domain.hyperlane == _hyperlaneDomain,
            "Circle domain not configured"
        );

        return domain.circle;
    }

    // @dev Enforces that the CCTP message source domain and nonce matches the Hyperlane message origin and nonce.
    function verify(
        bytes calldata _metadata,
        bytes calldata _hyperlaneMessage
    ) external returns (bool) {
        // decode return type of CctpService.getCCTPAttestation
        (bytes memory cctpMessage, bytes memory attestation) = abi.decode(
            _metadata,
            (bytes, bytes)
        );

        bytes29 originalMsg = TypedMemView.ref(cctpMessage, 0);

        uint32 sourceDomain = originalMsg._sourceDomain();
        require(
            sourceDomain ==
                hyperlaneDomainToCircleDomain(_hyperlaneMessage.origin()),
            "Invalid source domain"
        );

        uint64 sourceNonce = originalMsg._nonce();
        require(
            sourceNonce == uint64(bytes8(_hyperlaneMessage.body().metadata())),
            "Invalid nonce"
        );

        // Receive only if the nonce hasn't been used before
        bytes32 sourceAndNonceHash = keccak256(
            abi.encodePacked(sourceDomain, sourceNonce)
        );
        if (messageTransmitter.usedNonces(sourceAndNonceHash) == 0) {
            messageTransmitter.receiveMessage(cctpMessage, attestation);
        }

        return true;
    }

    function _transferFromSender(
        uint256 _amountOrId
    ) internal virtual override returns (bytes memory metadata) {
        HypERC20Collateral._transferFromSender(_amountOrId);

        // decode transferRemote(uint32, bytes32, uint256,...) calldata
        (uint32 destination, bytes32 recipient, uint256 amount) = abi.decode(
            msg.data[4:],
            (uint32, bytes32, uint256)
        );

        uint32 circleDomain = hyperlaneDomainToCircleDomain(destination);
        uint64 nonce = ITokenMessenger(tokenMessenger).depositForBurn(
            amount,
            circleDomain,
            recipient,
            address(wrappedToken)
        );

        return abi.encodePacked(nonce);
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal pure override returns (bytes memory) {
        return abi.encodeCall(CctpService.getCCTPAttestation, (_message));
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata metadata
    ) internal override {
        // do not transfer to recipient as the CCTP transfer will do it
    }
}
