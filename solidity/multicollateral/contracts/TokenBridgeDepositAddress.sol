// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge, Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";
import {PackageVersioned} from "@hyperlane-xyz/core/PackageVersioned.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

struct DestinationConfig {
    address depositAddress;
    bytes32 recipient;
    uint256 feeBps;
}

/**
 * @title TokenBridgeDepositAddress
 * @notice Generic ITokenBridge adapter for deposit-address-based bridges.
 * @dev Bridges by transferring tokens to a configured deposit address on the origin chain.
 *      Settlement to the destination recipient happens offchain via the external issuer.
 */
contract TokenBridgeDepositAddress is ITokenBridge, Ownable, PackageVersioned {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    uint256 internal constant MAX_BPS = 10_000;

    error InvalidToken(address token);
    error NativeFeeNotSupported(uint256 value);
    error DestinationNotConfigured(uint32 destination);
    error InvalidDepositAddress(uint32 destination);
    error InvalidFeeBps(uint256 feeBps);
    error UnexpectedRecipient(uint32 destination, bytes32 expectedRecipient, bytes32 actualRecipient);

    event DestinationConfigured(
        uint32 indexed destination, address indexed depositAddress, bytes32 indexed recipient, uint256 feeBps
    );
    event DestinationRemoved(uint32 indexed destination);
    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        address indexed depositAddress,
        uint256 amount,
        uint256 feeAmount,
        uint256 feeBps,
        bytes32 transferId
    );

    IERC20 public immutable wrappedToken;

    EnumerableSet.UintSet private _configuredDomains;
    mapping(uint32 destination => DestinationConfig config) private _destinationConfigs;

    uint256 public nonce;

    constructor(address _token, address _owner) {
        if (!Address.isContract(_token)) revert InvalidToken(_token);
        wrappedToken = IERC20(_token);
        _transferOwnership(_owner);
    }

    function token() public view returns (address) {
        return address(wrappedToken);
    }

    function quoteTransferRemote(uint32 _destination, bytes32 _recipient, uint256 _amount)
        external
        view
        override
        returns (Quote[] memory quotes)
    {
        DestinationConfig memory config = _getDestinationConfig(_destination, _recipient);
        uint256 feeAmount = _computeFee(_amount, config.feeBps);

        quotes = new Quote[](1);
        quotes[0] = Quote({token: address(wrappedToken), amount: _amount + feeAmount});
    }

    function transferRemote(uint32 _destination, bytes32 _recipient, uint256 _amount)
        external
        payable
        override
        returns (bytes32 transferId)
    {
        if (msg.value != 0) revert NativeFeeNotSupported(msg.value);

        DestinationConfig memory config = _getDestinationConfig(_destination, _recipient);
        uint256 feeAmount = _computeFee(_amount, config.feeBps);

        uint256 grossAmount = _amount + feeAmount;
        wrappedToken.safeTransferFrom(msg.sender, config.depositAddress, grossAmount);

        transferId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                nonce++,
                msg.sender,
                _destination,
                _recipient,
                _amount,
                feeAmount,
                config.feeBps,
                config.depositAddress
            )
        );

        emit SentTransferRemote(
            _destination, _recipient, config.depositAddress, _amount, feeAmount, config.feeBps, transferId
        );
    }

    function setDestinationConfig(uint32 _destination, address _depositAddress, bytes32 _recipient, uint256 _feeBps)
        external
        onlyOwner
    {
        if (_depositAddress == address(0)) {
            revert InvalidDepositAddress(_destination);
        }
        if (_feeBps > MAX_BPS) {
            revert InvalidFeeBps(_feeBps);
        }

        _configuredDomains.add(_destination);
        _destinationConfigs[_destination] =
            DestinationConfig({depositAddress: _depositAddress, recipient: _recipient, feeBps: _feeBps});

        emit DestinationConfigured(_destination, _depositAddress, _recipient, _feeBps);
    }

    function removeDestinationConfig(uint32 _destination) external onlyOwner {
        if (!_configuredDomains.remove(_destination)) {
            revert DestinationNotConfigured(_destination);
        }
        delete _destinationConfigs[_destination];
        emit DestinationRemoved(_destination);
    }

    function getDestinationConfig(uint32 _destination) external view returns (DestinationConfig memory) {
        if (!_configuredDomains.contains(_destination)) {
            revert DestinationNotConfigured(_destination);
        }
        return _destinationConfigs[_destination];
    }

    function getDomainConfigs()
        external
        view
        returns (
            uint32[] memory domains,
            address[] memory depositAddresses,
            bytes32[] memory recipients,
            uint256[] memory feeBpsValues
        )
    {
        uint256 len = _configuredDomains.length();
        domains = new uint32[](len);
        depositAddresses = new address[](len);
        recipients = new bytes32[](len);
        feeBpsValues = new uint256[](len);

        for (uint256 i = 0; i < len; i++) {
            uint32 domain = uint32(_configuredDomains.at(i));
            DestinationConfig memory config = _destinationConfigs[domain];
            domains[i] = domain;
            depositAddresses[i] = config.depositAddress;
            recipients[i] = config.recipient;
            feeBpsValues[i] = config.feeBps;
        }
    }

    function _computeFee(uint256 _amount, uint256 _feeBps) internal pure returns (uint256) {
        return (_amount * _feeBps) / MAX_BPS;
    }

    function _getDestinationConfig(uint32 _destination, bytes32 _recipient)
        internal
        view
        returns (DestinationConfig memory config)
    {
        if (!_configuredDomains.contains(_destination)) {
            revert DestinationNotConfigured(_destination);
        }

        config = _destinationConfigs[_destination];
        if (config.depositAddress == address(0)) {
            revert InvalidDepositAddress(_destination);
        }
        if (config.recipient != _recipient) {
            revert UnexpectedRecipient(_destination, config.recipient, _recipient);
        }
    }
}
