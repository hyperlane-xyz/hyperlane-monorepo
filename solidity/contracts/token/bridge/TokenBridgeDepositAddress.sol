// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge, Quote} from "../../interfaces/ITokenBridge.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableDomainSet} from "../../libs/EnumerableDomainSet.sol";

struct DestinationConfig {
    address depositAddress;
    uint256 feeBps;
}

/**
 * @title TokenBridgeDepositAddress
 * @notice Generic ITokenBridge adapter for deposit-address-based bridges.
 * @dev Bridges by transferring tokens to a configured deposit address on the origin chain.
 *      Settlement to the destination recipient happens offchain via the external issuer.
 *      Assumes standard ERC20 transfer semantics; native-token deposit lanes, fee-on-transfer,
 *      rebasing, and ERC-777-style callback tokens are unsupported.
 */
contract TokenBridgeDepositAddress is ITokenBridge, Ownable, PackageVersioned, EnumerableDomainSet {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    error InvalidToken(address token);
    error NativeFeeNotSupported(uint256 value);
    error DestinationNotConfigured(uint32 destination);
    error RecipientNotConfigured(uint32 destination, bytes32 recipient);
    error InvalidDepositAddress(uint32 destination, bytes32 recipient);
    error InvalidFeeBps(uint256 feeBps);

    event DestinationConfigured(
        uint32 indexed destination, address indexed depositAddress, bytes32 indexed recipient, uint256 feeBps
    );
    event DestinationRemoved(uint32 indexed destination, bytes32 indexed recipient);
    event SentTransferRemoteViaDepositAddress(
        uint32 indexed destination,
        bytes32 indexed recipient,
        address indexed depositAddress,
        uint256 amount,
        uint256 feeAmount,
        uint256 feeBps
    );

    IERC20 public immutable wrappedToken;

    mapping(uint32 destination => EnumerableSet.Bytes32Set recipients) private _configuredRecipients;
    mapping(uint32 destination => mapping(bytes32 recipient => DestinationConfig config)) private _destinationConfigs;

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
        returns (bytes32)
    {
        if (msg.value != 0) revert NativeFeeNotSupported(msg.value);

        DestinationConfig memory config = _getDestinationConfig(_destination, _recipient);
        uint256 feeAmount = _computeFee(_amount, config.feeBps);
        nonce++;

        uint256 grossAmount = _amount + feeAmount;
        wrappedToken.safeTransferFrom(msg.sender, config.depositAddress, grossAmount);

        emit SentTransferRemoteViaDepositAddress(
            _destination, _recipient, config.depositAddress, _amount, feeAmount, config.feeBps
        );

        return bytes32(0);
    }

    function setDestinationConfig(uint32 _destination, address _depositAddress, bytes32 _recipient, uint256 _feeBps)
        external
        onlyOwner
    {
        if (_depositAddress == address(0)) {
            revert InvalidDepositAddress(_destination, _recipient);
        }
        if (_feeBps > BPS_DENOMINATOR) {
            revert InvalidFeeBps(_feeBps);
        }

        _addDomain(_destination);
        _configuredRecipients[_destination].add(_recipient);
        _destinationConfigs[_destination][_recipient] =
            DestinationConfig({depositAddress: _depositAddress, feeBps: _feeBps});

        emit DestinationConfigured(_destination, _depositAddress, _recipient, _feeBps);
    }

    function removeDestinationConfig(uint32 _destination, bytes32 _recipient) external onlyOwner {
        if (!_containsDomain(_destination)) {
            revert DestinationNotConfigured(_destination);
        }
        if (!_configuredRecipients[_destination].remove(_recipient)) {
            revert RecipientNotConfigured(_destination, _recipient);
        }

        delete _destinationConfigs[_destination][_recipient];
        if (_configuredRecipients[_destination].length() == 0) {
            _removeDomain(_destination);
        }

        emit DestinationRemoved(_destination, _recipient);
    }

    function getDestinationConfig(uint32 _destination, bytes32 _recipient)
        external
        view
        returns (DestinationConfig memory)
    {
        return _getDestinationConfig(_destination, _recipient);
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
        uint32[] memory configuredDomains = _getDomains();
        uint256 domainLen = configuredDomains.length;
        uint256 configLen;
        for (uint256 i = 0; i < domainLen; i++) {
            configLen += _configuredRecipients[configuredDomains[i]].length();
        }

        domains = new uint32[](configLen);
        depositAddresses = new address[](configLen);
        recipients = new bytes32[](configLen);
        feeBpsValues = new uint256[](configLen);

        uint256 index;
        for (uint256 i = 0; i < domainLen; i++) {
            uint32 domain = configuredDomains[i];
            uint256 recipientLen = _configuredRecipients[domain].length();
            for (uint256 j = 0; j < recipientLen; j++) {
                bytes32 recipient = _configuredRecipients[domain].at(j);
                DestinationConfig memory config = _destinationConfigs[domain][recipient];
                domains[index] = domain;
                depositAddresses[index] = config.depositAddress;
                recipients[index] = recipient;
                feeBpsValues[index] = config.feeBps;
                index++;
            }
        }
    }

    function _computeFee(uint256 _amount, uint256 _feeBps) internal pure returns (uint256) {
        return (_amount * _feeBps) / BPS_DENOMINATOR;
    }

    function _getDestinationConfig(uint32 _destination, bytes32 _recipient)
        internal
        view
        returns (DestinationConfig memory config)
    {
        if (!_containsDomain(_destination)) {
            revert DestinationNotConfigured(_destination);
        }

        if (!_configuredRecipients[_destination].contains(_recipient)) {
            revert RecipientNotConfigured(_destination, _recipient);
        }

        config = _destinationConfigs[_destination][_recipient];
        if (config.depositAddress == address(0)) {
            revert InvalidDepositAddress(_destination, _recipient);
        }
    }
}
