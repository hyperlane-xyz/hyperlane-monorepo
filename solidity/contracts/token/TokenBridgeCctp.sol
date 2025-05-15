// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TypeCasts} from "../libs/TypeCasts.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {CctpMessage} from "../libs/CctpMessage.sol";
import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {ITokenMessenger} from "../interfaces/cctp/ITokenMessenger.sol";
import {IMessageTransmitter} from "../interfaces/cctp/IMessageTransmitter.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {AbstractCcipReadIsm} from "../isms/ccip-read/AbstractCcipReadIsm.sol";

abstract contract TokenBridgeCctp is
    ITokenBridge,
    HypERC20Collateral,
    AbstractCcipReadIsm
{
    uint32 internal constant CCTP_VERSION_1 = 0;
    uint32 internal constant CCTP_VERSION_2 = 1;

    // @notice CCTP message transmitter contract
    IMessageTransmitter public immutable messageTransmitter;

    // @notice CCIP-read URLs
    string[] public urls;

    /// @notice Hyperlane domain => Circle domain.
    /// ATM, known Circle domains are Ethereum = 0, Avalanche = 1, Optimism = 2, Arbitrum = 3.
    /// Note this could result in ambiguity between the Circle domain being
    /// Ethereum or unknown.
    mapping(uint32 => uint32) public hyperlaneDomainToCircleDomain;

    /**
     * @notice Emitted when the Hyperlane domain to Circle domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param circleDomain The Circle domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 circleDomain);

    /**
     * @notice Emitted when new CCIP-read urls are being set
     */
    event UrlsChanged(string[] newUrls);

    /**
     * @notice Raised when the version in use by the TokenMessenger
     * is not recognized
     */
    error UnsupportedCCTPVersion(uint32 wrongVersion);

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox,
        IMessageTransmitter _messageTransmitter
    ) HypERC20Collateral(_erc20, _scale, _mailbox) {
        interchainSecurityModule = IInterchainSecurityModule(address(this));
        messageTransmitter = _messageTransmitter;
    }

    /**
     * @notice Adds a new mapping between a Hyperlane domain and a Circle domain.
     * @param _urls URLs to be added
     */
    function setUrls(string[] memory _urls) external onlyOwner {
        urls = _urls;

        emit UrlsChanged(_urls);
    }

    /**
     * @notice Adds a new mapping between a Hyperlane domain and a Circle domain.
     * @param _hyperlaneDomain The Hyperlane domain.
     * @param _circleDomain The Circle domain.
     */
    function addDomain(
        uint32 _hyperlaneDomain,
        uint32 _circleDomain
    ) external onlyOwner {
        hyperlaneDomainToCircleDomain[_hyperlaneDomain] = _circleDomain;

        emit DomainAdded(_hyperlaneDomain, _circleDomain);
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    )
        external
        payable
        override(ITokenBridge, TokenRouter)
        returns (bytes32 messageId)
    {
        messageId = TokenRouter._transferRemote(
            _destination,
            _recipient,
            _amount,
            msg.value
        );

        // Has to be called after _transferRemote
        // in order for _transferFromSender to be
        // executed first
        _cctpDepositForBurn(_destination, _amount);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 /* _recipient */,
        uint256 /* _amount */
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote(address(0), quoteGasPayment(_destination));
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        revert OffchainLookup(
            address(this),
            urls,
            abi.encodeWithSignature("getCCTPAttestation(bytes)", _message),
            this.process.selector,
            _message
        );
    }

    /// @dev called by the relayer when the off-chain data is ready
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
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
        if (!_isMessageReceived(cctpMessage)) {
            messageTransmitter.receiveMessage(cctpMessage, attestation);
        }

        return true;
    }

    function _isMessageReceived(
        bytes memory cctpMessage
    ) internal view virtual returns (bool) {}

    /**
     * @notice Specify which CCTP version to use by
     * implementing this method
     */
    function _cctpDepositForBurn(
        uint32 _destination,
        uint256 _amount
    ) internal virtual {}
}
