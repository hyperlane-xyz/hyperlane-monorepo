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
import {CctpMessage, BurnMessage} from "../libs/CctpMessage.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {IMessageHandler} from "../interfaces/cctp/IMessageHandler.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

interface CctpService {
    function getCCTPAttestation(
        bytes calldata _message
    )
        external
        view
        returns (bytes memory cctpMessage, bytes memory attestation);
}

abstract contract TokenBridgeCctpBase is
    HypERC20Collateral,
    AbstractCcipReadIsm,
    IPostDispatchHook
{
    using Message for bytes;
    using TypeCasts for bytes32;

    // @notice CCTP message transmitter contract
    address public immutable messageTransmitter;

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
        address _messageTransmitter,
        address _tokenMessenger
    ) HypERC20Collateral(_erc20, _scale, _mailbox) {
        require(
            IMessageTransmitter(_messageTransmitter).version() ==
                _getCCTPVersion(),
            "Invalid messageTransmitter CCTP version"
        );
        messageTransmitter = _messageTransmitter;

        require(
            ITokenMessenger(_tokenMessenger).messageBodyVersion() ==
                _getCCTPVersion(),
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

    function initialize(
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) public override {
        revert("Only TokenBridgeCctp.initialize() may be called");
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

    function _getCCTPVersion() internal pure virtual returns (uint32);
    function _getCircleRecipient(
        bytes29 cctpMessage
    ) internal view virtual returns (address);
    function _getCircleSource(
        bytes29 cctpMessage
    ) internal view virtual returns (uint32);
    function _getCircleNonce(
        bytes29 cctpMessage
    ) internal view virtual returns (bytes32);
    function _validateTokenMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal view virtual;
    function _validateHookMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal view virtual;
    function _sendCircleMessage(
        uint32 destinationDomain,
        bytes32 recipientAndCaller,
        bytes memory messageBody
    ) internal virtual;

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

        uint32 origin = _hyperlaneMessage.origin();
        uint32 sourceDomain = _getCircleSource(originalMsg);
        require(
            sourceDomain == hyperlaneDomainToCircleDomain(origin),
            "Invalid source domain"
        );

        address circleRecipient = _getCircleRecipient(originalMsg);
        if (circleRecipient == address(tokenMessenger)) {
            _validateTokenMessage(_hyperlaneMessage, originalMsg);
        } else if (circleRecipient == address(this)) {
            _validateHookMessage(_hyperlaneMessage, originalMsg);
        } else {
            revert("Invalid circle recipient");
        }

        bytes32 nonce = _getCircleNonce(originalMsg);
        if (IMessageTransmitter(messageTransmitter).usedNonces(nonce) == 0) {
            IMessageTransmitter(messageTransmitter).receiveMessage(
                cctpMessage,
                attestation
            );
        }

        return true;
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.CCTP);
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(
        bytes calldata metadata
    ) public pure override returns (bool) {
        return true;
    }

    /// @inheritdoc IPostDispatchHook
    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure override returns (uint256) {
        return 0;
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata /*metadata*/,
        bytes calldata message
    ) external payable override {
        bytes32 id = message.id();
        require(_isLatestDispatched(id), "Message not dispatched");

        uint32 destination = message.destination();
        bytes32 ism = _mustHaveRemoteRouter(destination);
        uint32 circleDestination = hyperlaneDomainToCircleDomain(destination);
        _sendCircleMessage(circleDestination, ism, abi.encode(id));
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal pure override returns (bytes memory) {
        return abi.encodeCall(CctpService.getCCTPAttestation, (_message));
    }

    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        // do not transfer to recipient as the CCTP transfer will do it
    }
}
