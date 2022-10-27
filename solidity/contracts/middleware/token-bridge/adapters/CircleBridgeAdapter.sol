pragma solidity ^0.8.13;

import {ICircleBridge} from "../interfaces/circle/ICircleBridge.sol";
import {ICircleMessageTransmitter} from "../interfaces/circle/ICircleMessageTransmitter.sol";
import {ITokenBridgeAdapter} from "../interfaces/ITokenBridgeAdapter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CircleBridgeAdapter is ITokenBridgeAdapter {
    ICircleBridge public immutable circleBridge;

    ICircleMessageTransmitter public immutable circleMessageTransmitter;

    // Hyperlane domain => router address as a bytes32
    mapping(uint32 => bytes32) public circleBridgeAdapterRouters;

    // Hyperlane domain => CircleDomainEntry
    // Known Circle domains are Ethereum = 0 and Avalanche = 1.
    // Note this could result in ambiguity between the Circle domain being
    // Ethereum or unknown. TODO fix?
    mapping(uint32 => uint32) public hyperlaneDomainToCircleDomain;

    // Remote circle domain => nonce => whether or not it's been processed
    mapping(uint32 => mapping(uint64 => bool)) public originNonceProcessed;

    // Token symbol => address of token on local chain
    mapping(string => IERC20) public tokenSymbolToToken;

    // Local chain token address => token symbol
    mapping(address => string) public tokenToTokenSymbol;

    address public tokenBridgeRouter;

    // Emits the nonce of the Circle message
    // TODO reconsider this
    event BridgedToken(uint64 nonce);

    modifier onlyTokenBridgeRouter() {
        require(msg.sender == tokenBridgeRouter, "!tokenBridgeRouter");
        _;
    }

    constructor(address _circleBridge, address _circleMessageTransmitter) {
        circleBridge = ICircleBridge(_circleBridge);
        circleMessageTransmitter = ICircleMessageTransmitter(
            _circleMessageTransmitter
        );
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
        bytes32 _remoteRouter = circleBridgeAdapterRouters[_destinationDomain];
        require(_remoteRouter != bytes32(0), "!remote router");

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
}
