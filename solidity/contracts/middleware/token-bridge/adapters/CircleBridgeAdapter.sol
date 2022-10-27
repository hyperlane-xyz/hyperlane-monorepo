// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../../Router.sol";

import {ICircleBridge} from "../interfaces/circle/ICircleBridge.sol";
import {ICircleMessageTransmitter} from "../interfaces/circle/ICircleMessageTransmitter.sol";
import {ITokenBridgeAdapter} from "../interfaces/ITokenBridgeAdapter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CircleBridgeAdapter is ITokenBridgeAdapter, Router {
    ICircleBridge public immutable circleBridge;
    ICircleMessageTransmitter public immutable circleMessageTransmitter;
    address public immutable tokenBridgeRouter;

    // Hyperlane domain => CircleDomainEntry
    // ATM, known Circle domains are Ethereum = 0 and Avalanche = 1.
    // Note this could result in ambiguity between the Circle domain being
    // Ethereum or unknown. TODO fix?
    mapping(uint32 => uint32) public hyperlaneDomainToCircleDomain;

    // Token symbol => address of token on local chain
    mapping(string => IERC20) public tokenSymbolToToken;

    // Local chain token address => token symbol
    mapping(address => string) public tokenToTokenSymbol;

    // Remote circle domain => nonce => whether or not it's been processed
    mapping(uint32 => mapping(uint64 => bool)) public originNonceProcessed;

    // Emits the nonce of the Circle message
    // TODO reconsider this
    event BridgedToken(uint64 nonce);

    event HyperlaneDomainToCircleDomainSet(
        uint32 indexed hyperlaneDomain,
        uint32 circleDomain
    );

    event TokenSet(address indexed token, string indexed tokenSymbol);

    modifier onlyTokenBridgeRouter() {
        require(msg.sender == tokenBridgeRouter, "!tokenBridgeRouter");
        _;
    }

    constructor(
        address _circleBridge,
        address _circleMessageTransmitter,
        address _tokenBridgeRouter
    ) {
        circleBridge = ICircleBridge(_circleBridge);
        circleMessageTransmitter = ICircleMessageTransmitter(
            _circleMessageTransmitter
        );
        tokenBridgeRouter = _tokenBridgeRouter;
    }

    function initialize(address _owner) public initializer {
        // Transfer ownership of the contract to deployer
        _transferOwnership(_owner);
        // Set the addresses for the ACM and IGP to address(0) - they aren't used
        _setAbacusConnectionManager(address(0));
        _setInterchainGasPaymaster(address(0));
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

        uint64 _nonce = circleBridge.depositForBurnWithCaller(
            _amount,
            _circleDomain,
            _remoteRouter, // Mint to the remote router
            _token,
            _remoteRouter // Only allow the remote router to mint
        );

        emit BridgedToken(_nonce);

        return abi.encode(_tokenSymbol, _nonce);
    }

    // Mints USDC to itself
    function receiveCircleMessage(
        bytes calldata _message,
        bytes calldata _attestation
    ) external {
        require(
            circleMessageTransmitter.receiveMessage(_message, _attestation),
            "!receive message"
        );

        uint32 _originCircleDomain = uint32(bytes4(_message[4:8]));
        uint64 _nonce = uint64(bytes8(_message[12:20]));

        // We can safely assume this was previously false if the above
        // receiveMessage was successful.
        originNonceProcessed[_originCircleDomain][_nonce] = true;
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

        require(
            originNonceProcessed[_originCircleDomain][_nonce],
            "token not bridged yet"
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

    function setToken(address _token, string calldata _tokenSymbol)
        external
        onlyOwner
    {
        // Unset any existing entries...
        address _existingToken = address(tokenSymbolToToken[_tokenSymbol]);
        if (_existingToken != address(0)) {
            tokenToTokenSymbol[_existingToken] = "";
        }

        string memory _existingSymbol = tokenToTokenSymbol[_token];
        if (bytes(_existingSymbol).length > 0) {
            tokenSymbolToToken[_existingSymbol] = IERC20(address(0));
        }

        tokenToTokenSymbol[_token] = _tokenSymbol;
        tokenSymbolToToken[_tokenSymbol] = IERC20(_token);

        emit TokenSet(_token, _tokenSymbol);
    }
}
