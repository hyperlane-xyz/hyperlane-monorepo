// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../../Router.sol";

import {ICircleBridge} from "../interfaces/circle/ICircleBridge.sol";
import {ICircleMessageTransmitter} from "../interfaces/circle/ICircleMessageTransmitter.sol";
import {ITokenBridgeAdapter} from "../interfaces/ITokenBridgeAdapter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CircleBridgeAdapter is ITokenBridgeAdapter, Router {
    /// @notice The CircleBridge contract.
    ICircleBridge public circleBridge;

    /// @notice The Circle MessageTransmitter contract.
    ICircleMessageTransmitter public circleMessageTransmitter;

    /// @notice The TokenBridgeRouter contract.
    address public tokenBridgeRouter;

    /// @notice Hyperlane domain => CircleDomainEntry.
    /// ATM, known Circle domains are Ethereum = 0 and Avalanche = 1.
    /// Note this could result in ambiguity between the Circle domain being
    /// Ethereum or unknown. TODO fix?
    mapping(uint32 => uint32) public hyperlaneDomainToCircleDomain;

    /// @notice Token symbol => address of token on local chain.
    mapping(string => IERC20) public tokenSymbolToToken;

    /// @notice Local chain token address => token symbol.
    mapping(address => string) public tokenToTokenSymbol;

    // Emits the nonce of the Circle message

    /**
     * @notice Emits the nonce of the Circle message when a token is bridged.
     * @param nonce The nonce of the Circle message.
     */
    event BridgedToken(uint64 nonce);

    /**
     * @notice Emitted when the Hyperlane domain to Circle domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param circleDomain The Circle domain.
     */
    event HyperlaneDomainToCircleDomainSet(
        uint32 indexed hyperlaneDomain,
        uint32 circleDomain
    );

    /**
     * @notice Emitted when a local token and its token symbol have been added.
     */
    event TokenAndTokenSymbolAdded(
        address indexed token,
        string indexed tokenSymbol
    );

    /**
     * @notice Emitted when a local token and its token symbol have been removed.
     */
    event TokenAndTokenSymbolRemoved(
        address indexed token,
        string indexed tokenSymbol
    );

    modifier onlyTokenBridgeRouter() {
        require(msg.sender == tokenBridgeRouter, "!tokenBridgeRouter");
        _;
    }

    /**
     * @param _owner The new owner.
     * @param _circleBridge The CircleBridge contract.
     * @param _circleMessageTransmitter The Circle MessageTransmitter contract.
     * @param _tokenBridgeRouter The TokenBridgeRouter contract.
     */
    function initialize(
        address _owner,
        address _circleBridge,
        address _circleMessageTransmitter,
        address _tokenBridgeRouter
    ) public initializer {
        // Transfer ownership of the contract to deployer
        _transferOwnership(_owner);

        // Set the addresses for the ACM and IGP to address(0) - they aren't used.
        _setAbacusConnectionManager(address(0));
        _setInterchainGasPaymaster(address(0));

        circleBridge = ICircleBridge(_circleBridge);
        circleMessageTransmitter = ICircleMessageTransmitter(
            _circleMessageTransmitter
        );
        tokenBridgeRouter = _tokenBridgeRouter;
    }

    function bridgeToken(
        uint32 _destinationDomain,
        bytes32, // _recipientAddress, unused
        address _token,
        uint256 _amount
    ) external onlyTokenBridgeRouter returns (bytes memory) {
        string memory _tokenSymbol = tokenToTokenSymbol[_token];
        require(bytes(_tokenSymbol).length > 0, "unknown token");

        uint32 _circleDomain = hyperlaneDomainToCircleDomain[
            _destinationDomain
        ];
        bytes32 _remoteRouter = routers[_destinationDomain];
        require(_remoteRouter != bytes32(0), "!remote router");

        // Approve the token to Circle. We assume that the TokenBridgeRouter
        // has already transferred the token to this contract.
        require(
            IERC20(_token).approve(address(circleBridge), _amount),
            "!approval"
        );

        uint64 _nonce = circleBridge.depositForBurn(
            _amount,
            _circleDomain,
            _remoteRouter, // Mint to the remote router
            _token
        );

        emit BridgedToken(_nonce);

        return abi.encode(_tokenSymbol, _nonce);
    }

    // Returns the token and amount sent
    function sendBridgedTokens(
        uint32 _originDomain, // Hyperlane domain
        address _recipient,
        bytes calldata _adapterData, // The adapter data from the message
        uint256 _amount
    ) external onlyTokenBridgeRouter returns (address, uint256) {
        // The origin Circle domain
        uint32 _originCircleDomain = hyperlaneDomainToCircleDomain[
            _originDomain
        ];
        // Get the token symbol and nonce of the transfer from the _adapterData
        (string memory _tokenSymbol, uint64 _nonce) = abi.decode(
            _adapterData,
            (string, uint64)
        );

        // Require the circle message to have been processed
        bytes32 _nonceId = _circleNonceId(_originCircleDomain, _nonce);
        require(
            circleMessageTransmitter.usedNonces(_nonceId),
            "Circle message not processed yet"
        );

        IERC20 _token = tokenSymbolToToken[_tokenSymbol];
        require(address(_token) != address(0), "unknown token symbol");

        // Transfer the token out to the recipient
        // TODO: use safeTransfer
        // Circle doesn't charge any fee, so we can safely transfer out the
        // exact amount that was bridged over.
        require(_token.transfer(_recipient, _amount), "!transfer out");

        return (address(_token), _amount);
    }

    // This contract is only a Router to be aware of remote router addresses,
    // and doesn't actually send/handle Hyperlane messages directly
    function _handle(
        uint32, // origin
        bytes32, // sender
        bytes calldata // message
    ) internal pure override {
        revert("No messages expected");
    }

    function setHyperlaneDomainToCircleDomain(
        uint32 _hyperlaneDomain,
        uint32 _circleDomain
    ) external onlyOwner {
        hyperlaneDomainToCircleDomain[_hyperlaneDomain] = _circleDomain;

        emit HyperlaneDomainToCircleDomainSet(_hyperlaneDomain, _circleDomain);
    }

    function addTokenAndTokenSymbol(
        address _token,
        string calldata _tokenSymbol
    ) external onlyOwner {
        require(
            _token != address(0) && bytes(_tokenSymbol).length > 0,
            "Cannot add default values"
        );

        // Require the token and token symbol to be unset.
        address _existingToken = address(tokenSymbolToToken[_tokenSymbol]);
        require(_existingToken == address(0), "token symbol already has token");

        string memory _existingSymbol = tokenToTokenSymbol[_token];
        require(
            bytes(_existingSymbol).length == 0,
            "token already has token symbol"
        );

        tokenToTokenSymbol[_token] = _tokenSymbol;
        tokenSymbolToToken[_tokenSymbol] = IERC20(_token);

        emit TokenAndTokenSymbolAdded(_token, _tokenSymbol);
    }

    function removeTokenAndTokenSymbol(
        address _token,
        string calldata _tokenSymbol
    ) external onlyOwner {
        // Require the provided token and token symbols match what's in storage.
        address _existingToken = address(tokenSymbolToToken[_tokenSymbol]);
        require(_existingToken == _token, "Token mismatch");

        string memory _existingSymbol = tokenToTokenSymbol[_token];
        require(
            keccak256(bytes(_existingSymbol)) == keccak256(bytes(_tokenSymbol)),
            "Token symbol mismatch"
        );

        // Delete them from storage.
        delete tokenSymbolToToken[_tokenSymbol];
        delete tokenToTokenSymbol[_token];

        emit TokenAndTokenSymbolRemoved(_token, _tokenSymbol);
    }

    /**
     * @notice Gets the Circle nonce ID by hashing _originCircleDomain and _nonce.
     * @param _originCircleDomain Domain of chain where the transfer originated
     * @param _nonce The unique identifier for the message from source to
              destination
     * @return hash of source and nonce
     */
    function _circleNonceId(uint32 _originCircleDomain, uint64 _nonce)
        internal
        pure
        returns (bytes32)
    {
        // The hash is of a uint256 nonce, not a uint64 one.
        return
            keccak256(abi.encodePacked(_originCircleDomain, uint256(_nonce)));
    }
}
