// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITokenBridge, Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IAggLayerBridge} from "./interfaces/IAggLayerBridge.sol";

/**
 * @title AggLayerTokenBridge
 * @notice Lightweight ITokenBridge adapter that routes ERC20 transfers through AggLayer's Unified Bridge.
 * @dev Designed for MovableCollateralRouter path1 usage (`rebalance`).
 */
contract AggLayerTokenBridge is ITokenBridge, Ownable {
    using SafeERC20 for IERC20;

    struct FeeConfig {
        uint256 nativeFee;
        uint256 tokenFee;
    }

    IERC20 public immutable token;
    IAggLayerBridge public immutable agglayerBridge;

    bool public forceUpdateGlobalExitRoot;

    // Hyperlane domain -> AggLayer network id
    mapping(uint32 => uint32) public destinationNetworkByDomain;
    mapping(uint32 => bool) public destinationDomainConfigured;
    mapping(uint32 => FeeConfig) public feeConfigByDomain;

    event DestinationDomainConfigured(
        uint32 indexed domain,
        uint32 indexed destinationNetwork
    );
    event DestinationDomainRemoved(uint32 indexed domain);
    event FeeConfigSet(
        uint32 indexed domain,
        uint256 nativeFee,
        uint256 tokenFee
    );
    event ForceUpdateGlobalExitRootSet(bool forceUpdateGlobalExitRoot);
    event TransferRemoteDispatched(
        bytes32 indexed transferId,
        uint32 indexed domain,
        uint32 indexed destinationNetwork,
        bytes32 recipient,
        uint256 amount,
        uint256 nativeFee,
        uint256 tokenFee
    );

    error DestinationDomainNotConfigured(uint32 domain);
    error InvalidRecipient(bytes32 recipient);
    error NativeFeeMismatch(uint256 expected, uint256 supplied);

    constructor(
        address _token,
        address _agglayerBridge,
        address _owner,
        bool _forceUpdateGlobalExitRoot
    ) {
        token = IERC20(_token);
        agglayerBridge = IAggLayerBridge(_agglayerBridge);
        forceUpdateGlobalExitRoot = _forceUpdateGlobalExitRoot;
        _transferOwnership(_owner);
    }

    function setDestinationDomain(
        uint32 _domain,
        uint32 _destinationNetwork
    ) external onlyOwner {
        destinationNetworkByDomain[_domain] = _destinationNetwork;
        destinationDomainConfigured[_domain] = true;
        emit DestinationDomainConfigured(_domain, _destinationNetwork);
    }

    function removeDestinationDomain(uint32 _domain) external onlyOwner {
        delete destinationNetworkByDomain[_domain];
        delete destinationDomainConfigured[_domain];
        emit DestinationDomainRemoved(_domain);
    }

    function setFeeConfig(
        uint32 _domain,
        uint256 _nativeFee,
        uint256 _tokenFee
    ) external onlyOwner {
        feeConfigByDomain[_domain] = FeeConfig({
            nativeFee: _nativeFee,
            tokenFee: _tokenFee
        });
        emit FeeConfigSet(_domain, _nativeFee, _tokenFee);
    }

    function setForceUpdateGlobalExitRoot(bool _force) external onlyOwner {
        forceUpdateGlobalExitRoot = _force;
        emit ForceUpdateGlobalExitRootSet(_force);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        if (!destinationDomainConfigured[_destination]) {
            revert DestinationDomainNotConfigured(_destination);
        }

        FeeConfig memory cfg = feeConfigByDomain[_destination];

        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: cfg.nativeFee});
        quotes[1] = Quote({
            token: address(token),
            amount: _amount + cfg.tokenFee
        });
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32 transferId) {
        if (!destinationDomainConfigured[_destination]) {
            revert DestinationDomainNotConfigured(_destination);
        }

        address recipient = _recipientAddress(_recipient);
        FeeConfig memory cfg = feeConfigByDomain[_destination];
        if (msg.value != cfg.nativeFee) {
            revert NativeFeeMismatch(cfg.nativeFee, msg.value);
        }

        // Pull bridged amount + bridge token fee from caller.
        token.safeTransferFrom(
            msg.sender,
            address(this),
            _amount + cfg.tokenFee
        );

        // Bridge only the requested amount; tokenFee is retained in this adapter.
        token.forceApprove(address(agglayerBridge), 0);
        token.forceApprove(address(agglayerBridge), _amount);

        uint32 destinationNetwork = destinationNetworkByDomain[_destination];
        agglayerBridge.bridgeAsset{value: cfg.nativeFee}(
            destinationNetwork,
            recipient,
            _amount,
            address(token),
            forceUpdateGlobalExitRoot,
            bytes("")
        );

        transferId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                _destination,
                destinationNetwork,
                _recipient,
                _amount,
                cfg.nativeFee,
                cfg.tokenFee,
                block.number
            )
        );

        emit TransferRemoteDispatched(
            transferId,
            _destination,
            destinationNetwork,
            _recipient,
            _amount,
            cfg.nativeFee,
            cfg.tokenFee
        );
    }

    function _recipientAddress(
        bytes32 _recipient
    ) internal pure returns (address) {
        address recipient = address(uint160(uint256(_recipient)));
        if (bytes32(uint256(uint160(recipient))) != _recipient) {
            revert InvalidRecipient(_recipient);
        }
        return recipient;
    }
}
