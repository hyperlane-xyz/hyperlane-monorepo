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
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "../hooks/libs/StandardHookMetadata.sol";
import {IMessageHandler} from "../interfaces/cctp/IMessageHandler.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {MovableCollateralRouter, MovableCollateralRouterStorage} from "./libs/MovableCollateralRouter.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {AbstractPostDispatchHook} from "../hooks/libs/AbstractPostDispatchHook.sol";
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

// need intermediate contract to insert slots between TokenRouter and AbstractCcipReadIsm
abstract contract TokenBridgeCctpBaseStorage is TokenRouter {
    /// @dev This is used to enable storage layout backwards compatibility. It should not be read or written to.
    MovableCollateralRouterStorage private __MOVABLE_COLLATERAL_GAP;
}

struct Domain {
    uint32 hyperlane;
    uint32 circle;
}

// see ./CCTP.md for sequence diagrams of the destination chain control flow
abstract contract TokenBridgeCctpBase is
    TokenBridgeCctpBaseStorage,
    AbstractCcipReadIsm,
    AbstractPostDispatchHook
{
    using Message for bytes;
    using TypeCasts for bytes32;
    using SafeERC20 for IERC20;

    // using custom errors for bytecode size limitations
    // end users will not see these in their wallet (at config and process time)
    error InvalidCCTPVersion();
    error CircleDomainNotConfigured();
    error HyperlaneDomainNotConfigured();
    error InvalidTokenMessageRecipient();
    error InvalidCircleRecipient();
    error NotMessageTransmitter();
    error UnauthorizedCircleSender();
    error MessageNotDispatched();
    error InvalidBurnSender();
    error InvalidMintAmount();
    error InvalidMintRecipient();
    error InvalidMessageId();

    uint256 private constant _SCALE = 1;

    IERC20 public immutable wrappedToken;

    // @notice CCTP message transmitter contract
    IMessageTransmitter public immutable messageTransmitter;

    // @notice CCTP token messenger contract
    ITokenMessenger public immutable tokenMessenger;

    /// @notice Hyperlane domain => Domain struct.
    /// We use a struct to avoid ambiguity with domain 0 being unknown.
    mapping(uint32 hypDomain => Domain circleDomain)
        internal _hyperlaneDomainMap;

    /// @notice Circle domain => Domain struct.
    // We use a struct to avoid ambiguity with domain 0 being unknown.
    mapping(uint32 circleDomain => Domain hyperlaneDomain)
        internal _circleDomainMap;

    /// @notice Maps messageId to whether or not the message has been verified
    /// by the CCTP message transmitter
    mapping(bytes32 messageId => bool verified) public isVerified;

    /**
     * @notice Emitted when the Hyperlane domain to Circle domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param circleDomain The Circle domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 circleDomain);

    constructor(
        address _erc20,
        address _mailbox,
        IMessageTransmitter _messageTransmitter,
        ITokenMessenger _tokenMessenger
    ) TokenRouter(_SCALE, _mailbox) {
        if (_messageTransmitter.version() != _getCCTPVersion())
            revert InvalidCCTPVersion();
        messageTransmitter = _messageTransmitter;

        if (_tokenMessenger.messageBodyVersion() != _getCCTPVersion())
            revert InvalidCCTPVersion();
        tokenMessenger = _tokenMessenger;

        wrappedToken = IERC20(_erc20);

        _disableInitializers();
    }

    /**
     * @inheritdoc TokenRouter
     */
    function token() public view override returns (address) {
        return address(wrappedToken);
    }

    function initialize(
        address _hook,
        address _owner,
        string[] memory __urls
    ) external initializer {
        // ISM should not be set
        _MailboxClient_initialize({
            _hook: _hook,
            __interchainSecurityModule: address(0),
            _owner: _owner
        });

        // Setup urls for offchain lookup and do token approval
        setUrls(__urls);
        wrappedToken.approve(address(tokenMessenger), type(uint256).max);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to bridge the tokens via Circle.
     */
    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32 messageId) {
        // 1. Calculate the fee amounts, charge the sender and distribute to feeRecipient if necessary
        (
            uint256 externalFee,
            uint256 remainingNativeValue
        ) = _calculateFeesAndCharge({
                _destination: _destination,
                _recipient: _recipient,
                _amount: _amount,
                _msgValue: msg.value
            });

        // 2. Prepare the token message with the recipient, amount, and any additional metadata in overrides
        bytes32 ism = _mustHaveRemoteRouter(_destination);
        uint32 circleDomain = hyperlaneDomainToCircleDomain(_destination);
        uint256 burnAmount = _amount + externalFee;
        _bridgeViaCircle({
            _destination: circleDomain,
            _recipient: _recipient,
            _amount: burnAmount,
            _maxFee: externalFee,
            _ism: ism
        });

        bytes memory _message = TokenMessage.format(_recipient, burnAmount);
        // 3. Emit the SentTransferRemote event and 4. dispatch the message
        return
            _emitAndDispatch({
                _destination: _destination,
                _recipient: _recipient,
                _amount: _amount,
                _messageDispatchValue: remainingNativeValue,
                _tokenMessage: _message
            });
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
        _hyperlaneDomainMap[_hyperlaneDomain] = Domain(
            _hyperlaneDomain,
            _circleDomain
        );
        _circleDomainMap[_circleDomain] = Domain(
            _hyperlaneDomain,
            _circleDomain
        );

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
        Domain memory domain = _hyperlaneDomainMap[_hyperlaneDomain];
        if (domain.hyperlane != _hyperlaneDomain)
            revert CircleDomainNotConfigured();

        return domain.circle;
    }

    function circleDomainToHyperlaneDomain(
        uint32 _circleDomain
    ) public view returns (uint32) {
        Domain memory domain = _circleDomainMap[_circleDomain];
        if (domain.circle != _circleDomain)
            revert HyperlaneDomainNotConfigured();

        return domain.hyperlane;
    }

    function _getCCTPVersion() internal pure virtual returns (uint32);

    function _getCircleRecipient(
        bytes29 cctpMessage
    ) internal pure virtual returns (address);

    function _validateTokenMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal pure virtual;

    function _validateHookMessage(
        bytes calldata hyperlaneMessage,
        bytes29 cctpMessage
    ) internal pure virtual;

    function _sendMessageIdToIsm(
        uint32 destinationDomain,
        bytes32 ism,
        bytes32 messageId
    ) internal virtual;

    /**
     * @dev Verifies that the CCTP message matches the Hyperlane message.
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _hyperlaneMessage
    ) external returns (bool) {
        // check if hyperlane message has already been verified by CCTP
        if (isVerified[_hyperlaneMessage.id()]) {
            return true;
        }

        // decode return type of CctpService.getCCTPAttestation
        (bytes memory cctpMessageBytes, bytes memory attestation) = abi.decode(
            _metadata,
            (bytes, bytes)
        );

        bytes29 cctpMessage = TypedMemView.ref(cctpMessageBytes, 0);
        address circleRecipient = _getCircleRecipient(cctpMessage);
        // check if CCTP message is a USDC burn message
        if (circleRecipient == address(tokenMessenger)) {
            // prevent hyperlane message recipient configured with CCTP ISM
            // from verifying and handling token messages
            if (_hyperlaneMessage.recipientAddress() != address(this))
                revert InvalidTokenMessageRecipient();
            _validateTokenMessage(_hyperlaneMessage, cctpMessage);
        }
        // check if CCTP message is a GMP message to this contract
        else if (circleRecipient == address(this)) {
            _validateHookMessage(_hyperlaneMessage, cctpMessage);
        }
        // disallow other CCTP message destinations
        else {
            revert InvalidCircleRecipient();
        }

        // for GMP messages, this.verifiedMessages[hyperlaneMessage.id()] will be set
        // for token messages, hyperlaneMessage.body().amount() tokens will be delivered to hyperlaneMessage.body().recipient()
        return messageTransmitter.receiveMessage(cctpMessageBytes, attestation);
    }

    function _receiveMessageId(
        uint32 circleSource,
        bytes32 circleSender,
        bytes32 messageId
    ) internal returns (bool) {
        if (msg.sender != address(messageTransmitter))
            revert NotMessageTransmitter();

        // ensure that the message was sent from the hook on the origin chain
        uint32 origin = circleDomainToHyperlaneDomain(circleSource);
        if (_mustHaveRemoteRouter(origin) != circleSender)
            revert UnauthorizedCircleSender();

        isVerified[messageId] = true;

        return true;
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal pure override returns (bytes memory) {
        return abi.encodeCall(CctpService.getCCTPAttestation, (_message));
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.HookTypes.CCTP);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata /*metadata*/,
        bytes calldata /*message*/
    ) internal pure override returns (uint256) {
        return 0;
    }

    /// @inheritdoc AbstractPostDispatchHook
    /// @dev Mirrors the logic in AbstractMessageIdAuthHook._postDispatch
    // but using Router table instead of hook <> ISM coupling
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes32 id = message.id();
        if (!_isLatestDispatched(id)) revert MessageNotDispatched();

        uint32 destination = message.destination();
        bytes32 ism = _mustHaveRemoteRouter(destination);
        uint32 circleDestination = hyperlaneDomainToCircleDomain(destination);

        _sendMessageIdToIsm({
            destinationDomain: circleDestination,
            ism: ism,
            messageId: id
        });

        _refund({
            metadata: metadata,
            message: message,
            amount: address(this).balance
        });
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to transfer the tokens from the sender to this contract (like HypERC20Collateral).
     */
    function _transferFromSender(uint256 _amount) internal override {
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to not transfer the tokens to the recipient, as the CCTP transfer will do it.
     */
    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        // do not transfer to recipient as the CCTP transfer will do it
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to transfer fees directly from the router balance since CCTP handles token delivery.
     */
    function _transferFee(
        address _recipient,
        uint256 _amount
    ) internal override {
        wrappedToken.safeTransfer(_recipient, _amount);
    }

    function _bridgeViaCircle(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        uint256 _maxFee,
        bytes32 _ism
    ) internal virtual;
}
