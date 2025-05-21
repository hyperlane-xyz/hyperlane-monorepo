// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenRouter} from "./libs/TokenRouter.sol";
import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {IMessageTransmitter} from "./../interfaces/cctp/IMessageTransmitter.sol";
import {IInterchainSecurityModule} from "./../interfaces/IInterchainSecurityModule.sol";
import {AbstractCcipReadIsm} from "./../isms/ccip-read/AbstractCcipReadIsm.sol";
import {TypedMemView} from "./../libs/TypedMemView.sol";
import {ITokenMessenger} from "./../interfaces/cctp/ITokenMessenger.sol";

interface CctpService {
    function getCCTPAttestation(
        bytes calldata _message
    )
        external
        view
        returns (bytes memory cctpMessage, bytes memory attestation);
}

abstract contract TokenBridgeCctp is HypERC20Collateral, AbstractCcipReadIsm {
    // @notice CCTP message transmitter contract
    IMessageTransmitter public immutable messageTransmitter;

    // @notice CCTP token messenger contract
    address public immutable tokenMessenger;

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
        address _tokenMessenger
    ) HypERC20Collateral(_erc20, _scale, _mailbox) {
        require(
            _messageTransmitter.version() == _cctpVersion(),
            "Invalid messageTransmitter CCTP version"
        );
        messageTransmitter = _messageTransmitter;

        require(
            ITokenMessenger(_tokenMessenger).messageBodyVersion() ==
                _cctpVersion(),
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

    function verify(
        bytes calldata _metadata,
        bytes calldata /* _message */
    ) external returns (bool) {
        (bytes memory cctpMessage, bytes memory attestation) = abi.decode(
            _metadata,
            (bytes, bytes)
        );

        // Receive only if the nonce hasn't been used before
        if (messageTransmitter.usedNonces(_messageNonce(cctpMessage)) == 0) {
            messageTransmitter.receiveMessage(cctpMessage, attestation);
        }

        return true;
    }

    function _transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _value,
        bytes memory _hookMetadata,
        address _hook
    ) internal virtual override returns (bytes32 messageId) {
        messageId = super._transferRemote(
            _destination,
            _recipient,
            _amount,
            _value,
            _hookMetadata,
            _hook
        );

        uint32 circleDomain = hyperlaneDomainToCircleDomain(_destination);
        _cctpDepositForBurn(circleDomain, _recipient, _amount);
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

    function _messageNonce(
        bytes memory cctpMessage
    ) internal pure virtual returns (bytes32);

    function _cctpDepositForBurn(
        uint32 _circleDomain,
        bytes32 _recipient,
        uint256 _amount
    ) internal virtual;

    function _cctpVersion() internal pure virtual returns (uint32);
}

import {CctpMessage} from "../libs/CctpMessage.sol";

contract TokenBridgeCctpV1 is TokenBridgeCctp {
    using CctpMessage for bytes29;

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IMessageTransmitter _messageTransmitter,
        ITokenMessenger _tokenMessenger
    )
        TokenBridgeCctp(
            _erc20,
            _scale,
            _mailbox,
            _messageTransmitter,
            address(_tokenMessenger)
        )
    {}

    function _cctpVersion() internal pure override returns (uint32) {
        return 0;
    }

    function _messageNonce(
        bytes memory cctpMessage
    ) internal pure override returns (bytes32) {
        bytes29 originalMsg = TypedMemView.ref(cctpMessage, 0);
        uint64 nonceUint64 = originalMsg._nonce();
        uint32 sourceDomain = originalMsg._sourceDomain();

        return keccak256(abi.encodePacked(sourceDomain, nonceUint64));
    }

    function _cctpDepositForBurn(
        uint32 _circleDomain,
        bytes32 _recipient,
        uint256 _amount
    ) internal override {
        ITokenMessenger(tokenMessenger).depositForBurn(
            _amount,
            _circleDomain,
            _recipient,
            address(wrappedToken)
        );
    }
}

import {CctpMessageV2} from "../libs/CctpMessageV2.sol";
import {ITokenMessengerV2} from "../interfaces/cctp/ITokenMessengerV2.sol";

contract TokenBridgeCctpV2 is TokenBridgeCctp {
    using CctpMessageV2 for bytes29;

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IMessageTransmitter _messageTransmitter,
        ITokenMessengerV2 _tokenMessenger
    )
        TokenBridgeCctp(
            _erc20,
            _scale,
            _mailbox,
            _messageTransmitter,
            address(_tokenMessenger)
        )
    {}

    // @dev the minimum to consider it a Standard CCTP transfer (it applies to every network)
    // see https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/v2/MessageTransmitterV2.sol#L224-L244
    // and https://github.com/circlefin/evm-cctp-contracts/blob/release-2025-03-11T143015/src/v2/FinalityThresholds.sol#L21
    uint32 internal constant CCTP_V2_DEFAULT_MIN_FINALITY_THRESHOLD = 2000;

    // @dev required for CCTP v2
    uint256 internal constant CCTP_V2_DEFAULT_MAX_FEE = 0;

    function _cctpVersion() internal pure override returns (uint32) {
        return 1;
    }

    function _messageNonce(
        bytes memory cctpMessage
    ) internal pure override returns (bytes32) {
        bytes29 originalMsg = TypedMemView.ref(cctpMessage, 0);
        return originalMsg._getNonce();
    }

    function _cctpDepositForBurn(
        uint32 _circleDomain,
        bytes32 _recipient,
        uint256 _amount
    ) internal override {
        ITokenMessengerV2(address(tokenMessenger)).depositForBurn(
            _amount,
            _circleDomain,
            _recipient,
            address(wrappedToken),
            bytes32(0),
            CCTP_V2_DEFAULT_MAX_FEE,
            CCTP_V2_DEFAULT_MIN_FINALITY_THRESHOLD
        );
    }
}
