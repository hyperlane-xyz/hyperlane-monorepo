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
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";
import {FungibleTokenRouter} from "./libs/FungibleTokenRouter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface CctpService {
    function getCCTPAttestation(
        bytes calldata _message
    )
        external
        view
        returns (bytes memory cctpMessage, bytes memory attestation);
}

// TokenMessage.metadata := uint8 cctpNonce
uint256 constant CCTP_TOKEN_BRIDGE_MESSAGE_LEN = TokenMessage.METADATA_OFFSET +
    8;

// @dev Supports only CCTP V1
contract TokenBridgeCctp is
    MovableCollateralRouter,
    AbstractCcipReadIsm,
    IPostDispatchHook,
    IMessageHandler
{
    using CctpMessage for bytes29;
    using BurnMessage for bytes29;
    using TypedMemView for bytes29;

    using Message for bytes;
    using TypeCasts for bytes32;
    using SafeERC20 for IERC20;

    IERC20 public immutable wrappedToken;

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
    ) FungibleTokenRouter(_scale, _mailbox) {
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

        wrappedToken = IERC20(_erc20);

        _disableInitializers();
    }

    function token() public view virtual override returns (address) {
        return address(wrappedToken);
    }

    function initialize(
        address _hook,
        address _owner,
        string[] memory __urls
    ) external virtual initializer {
        // ISM should not be set
        _MailboxClient_initialize(_hook, address(0), _owner);

        // Setup urls for offchain lookup and do token approval
        setUrls(__urls);
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
        (bytes memory cctpMessageBytes, bytes memory attestation) = abi.decode(
            _metadata,
            (bytes, bytes)
        );

        bytes29 cctpMessage = TypedMemView.ref(cctpMessageBytes, 0);

        // check if CCTP message source matches the hyperlane message origin
        uint32 origin = _hyperlaneMessage.origin();
        uint32 sourceDomain = cctpMessage._sourceDomain();
        require(
            sourceDomain == hyperlaneDomainToCircleDomain(origin),
            "Invalid source domain"
        );

        uint64 sourceNonce = cctpMessage._nonce();

        address cctpMessageRecipient = cctpMessage
            ._recipient()
            .bytes32ToAddress();
        // check if CCTP message is a USDC burn message
        if (cctpMessageRecipient == address(tokenMessenger)) {
            bytes29 burnMessage = cctpMessage._messageBody();

            // check that burner matches the sender of the hyperlane message (token router)
            bytes32 circleBurnSender = burnMessage._getMessageSender();
            require(
                circleBurnSender == _hyperlaneMessage.sender(),
                "Invalid burn sender"
            );

            _validateTokenMessage(
                _hyperlaneMessage.body(),
                sourceNonce,
                burnMessage
            );
            // check if CCTP message is a GMP message to this contract
        } else if (cctpMessageRecipient == address(this)) {
            // check that sender matches the origin router
            bytes32 cctpMessageSender = cctpMessage._sender();
            require(
                cctpMessageSender == _mustHaveRemoteRouter(origin),
                "Invalid circle sender"
            );

            // check that the body matches the hyperlane message ID
            bytes32 circleMessageId = cctpMessage._messageBody().index(0, 32);
            require(
                circleMessageId == _hyperlaneMessage.id(),
                "Invalid message id"
            );
            // do not allow other CCTP message types
        } else {
            revert("Invalid circle recipient");
        }

        // Receive only if the nonce hasn't been used before
        bytes32 sourceAndNonceHash = keccak256(
            abi.encodePacked(sourceDomain, sourceNonce)
        );
        if (messageTransmitter.usedNonces(sourceAndNonceHash) == 0) {
            require(
                messageTransmitter.receiveMessage(
                    cctpMessageBytes,
                    attestation
                ),
                "Failed to receive message"
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
        require(_isLatestDispatched(message.id()), "Message not dispatched");

        uint32 destination = message.destination();
        bytes32 ism = _mustHaveRemoteRouter(destination);
        uint32 circleDestination = hyperlaneDomainToCircleDomain(destination);

        messageTransmitter.sendMessageWithCaller({
            destinationDomain: circleDestination,
            // recipient must be this implementation with `handleReceiveMessage`
            recipient: ism,
            // enforces that only the enrolled ISM's verify() can deliver the CCTP message
            destinationCaller: ism,
            messageBody: abi.encode(message.id())
        });
    }

    /// @inheritdoc IMessageHandler
    function handleReceiveMessage(
        uint32 /*sourceDomain*/,
        bytes32 /*sender*/,
        bytes calldata /*body*/
    ) external override returns (bool) {
        return msg.sender == address(messageTransmitter);
    }

    function _validateMessageLength(bytes memory _tokenMessage) internal pure {
        require(
            _tokenMessage.length == CCTP_TOKEN_BRIDGE_MESSAGE_LEN,
            "Invalid message body length"
        );
    }

    // @dev Validates that the CCTP message nonce and burn message fields match the hyperlane token router message
    function _validateTokenMessage(
        bytes calldata tokenMessage,
        uint64 circleNonce,
        bytes29 circleBody
    ) internal pure {
        circleBody._validateBurnMessageFormat();
        _validateMessageLength(tokenMessage);

        require(
            uint64(bytes8(TokenMessage.metadata(tokenMessage))) == circleNonce,
            "Invalid nonce"
        );

        require(
            TokenMessage.amount(tokenMessage) == circleBody._getAmount(),
            "Invalid mint amount"
        );

        require(
            TokenMessage.recipient(tokenMessage) ==
                circleBody._getMintRecipient(),
            "Invalid mint recipient"
        );
    }

    // @dev Copied from HypERC20Collateral._transferFromSender
    function _transferFromSender(uint256 _amount) internal virtual override {
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    function _beforeDispatch(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    )
        internal
        virtual
        override
        returns (uint256 dispatchValue, bytes memory message)
    {
        dispatchValue = _chargeSender(_destination, _recipient, _amount);

        uint32 circleDomain = hyperlaneDomainToCircleDomain(_destination);
        uint64 nonce = tokenMessenger.depositForBurn(
            _amount,
            circleDomain,
            _recipient,
            address(wrappedToken)
        );

        message = TokenMessage.format(
            _recipient,
            _outboundAmount(_amount),
            abi.encodePacked(nonce)
        );
        _validateMessageLength(message);
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
