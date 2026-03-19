// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "@hyperlane-xyz/core/interfaces/IInterchainSecurityModule.sol";
import {Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";
import {AbstractCcipReadIsm} from "@hyperlane-xyz/core/isms/ccip-read/AbstractCcipReadIsm.sol";
import {Message} from "@hyperlane-xyz/core/libs/Message.sol";
import {TypeCasts} from "@hyperlane-xyz/core/libs/TypeCasts.sol";
import {TokenMessage} from "@hyperlane-xyz/core/token/libs/TokenMessage.sol";
import {TokenRouter} from "@hyperlane-xyz/core/token/libs/TokenRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IAggLayerBridge} from "./interfaces/IAggLayerBridge.sol";
import {IVaultBridgeToken} from "./interfaces/IVaultBridgeToken.sol";

interface AggLayerService {
    function getAggLayerClaimMetadata(
        bytes calldata _message
    ) external view returns (bytes memory);
}

contract TokenBridgeAggLayer is TokenRouter, AbstractCcipReadIsm {
    using Address for address payable;
    using Message for bytes;
    using SafeERC20 for IERC20;
    using TokenMessage for bytes;
    using TypeCasts for address;
    using TypeCasts for bytes32;

    struct RemoteBridgeConfig {
        uint32 agglayerNetworkId;
        address remoteToken;
        bool forceUpdateGlobalExitRoot;
    }

    struct ClaimMetadata {
        bytes32[32] smtProofLocalExitRoot;
        bytes32[32] smtProofRollupExitRoot;
        uint256 globalIndex;
        bytes32 mainnetExitRoot;
        bytes32 rollupExitRoot;
        bytes metadata;
    }

    error InvalidLocalToken(address token);
    error InvalidAgglayerBridge(address bridge);
    error InvalidVaultBridgeToken(address vaultBridgeToken);
    error InvalidRemoteToken(uint32 domain);
    error RemoteConfigNotFound(uint32 domain);
    error UnsupportedHandle();
    error UnsupportedVerify();

    event RemoteBridgeConfigSet(
        uint32 indexed domain,
        uint32 indexed agglayerNetworkId,
        address indexed remoteToken,
        bool forceUpdateGlobalExitRoot
    );
    event RemoteBridgeConfigRemoved(uint32 indexed domain);

    IERC20 public immutable localToken;
    IAggLayerBridge public immutable agglayerBridge;
    IVaultBridgeToken public immutable vaultBridgeToken;
    uint32 public immutable localAgglayerNetworkId;
    bool public immutable redeemsOnHandle;

    mapping(uint32 => RemoteBridgeConfig) public remoteBridgeConfigs;
    mapping(bytes32 => bool) public isVerified;

    constructor(
        address _localToken,
        address _mailbox,
        address _agglayerBridge,
        address _vaultBridgeToken
    ) TokenRouter(1, 1, _mailbox) {
        if (_localToken == address(0) || _localToken.code.length == 0) {
            revert InvalidLocalToken(_localToken);
        }
        if (_agglayerBridge == address(0) || _agglayerBridge.code.length == 0) {
            revert InvalidAgglayerBridge(_agglayerBridge);
        }

        localToken = IERC20(_localToken);
        agglayerBridge = IAggLayerBridge(_agglayerBridge);
        localAgglayerNetworkId = IAggLayerBridge(_agglayerBridge).networkID();

        if (_vaultBridgeToken != address(0)) {
            if (_vaultBridgeToken.code.length == 0) {
                revert InvalidVaultBridgeToken(_vaultBridgeToken);
            }
            vaultBridgeToken = IVaultBridgeToken(_vaultBridgeToken);
            redeemsOnHandle = true;
        } else {
            redeemsOnHandle = false;
        }

        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _owner,
        string[] memory __urls
    ) external initializer {
        __Ownable_init();
        setHook(_hook);
        setInterchainSecurityModule(address(0));
        setUrls(__urls);

        if (redeemsOnHandle) {
            localToken.forceApprove(
                address(vaultBridgeToken),
                type(uint256).max
            );
        } else {
            localToken.forceApprove(address(agglayerBridge), type(uint256).max);
        }

        _transferOwnership(_owner);
    }

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    function token() public view override returns (address) {
        return address(localToken);
    }

    function setRemoteBridgeConfig(
        uint32 _domain,
        uint32 _agglayerNetworkId,
        address _remoteToken,
        bool _forceUpdateGlobalExitRoot
    ) external onlyOwner {
        if (_remoteToken == address(0)) revert InvalidRemoteToken(_domain);

        remoteBridgeConfigs[_domain] = RemoteBridgeConfig({
            agglayerNetworkId: _agglayerNetworkId,
            remoteToken: _remoteToken,
            forceUpdateGlobalExitRoot: _forceUpdateGlobalExitRoot
        });

        emit RemoteBridgeConfigSet(
            _domain,
            _agglayerNetworkId,
            _remoteToken,
            _forceUpdateGlobalExitRoot
        );
    }

    function removeRemoteBridgeConfig(uint32 _domain) external onlyOwner {
        delete remoteBridgeConfigs[_domain];
        emit RemoteBridgeConfigRemoved(_domain);
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        _mustHaveRemoteConfig(_destination);

        address _feeToken = feeToken();
        uint256 dispatchFee = redeemsOnHandle
            ? 0
            : _quoteGasPayment(_destination, _recipient, _amount, _feeToken);

        if (_feeToken == address(0)) {
            quotes = new Quote[](2);
            quotes[0] = Quote({token: address(0), amount: dispatchFee});
            quotes[1] = Quote({token: token(), amount: _amount});
        } else {
            quotes = new Quote[](2);
            quotes[0] = Quote({token: _feeToken, amount: dispatchFee});
            quotes[1] = Quote({token: token(), amount: _amount});
        }
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32 messageId) {
        RemoteBridgeConfig memory cfg = _mustHaveRemoteConfig(_destination);

        if (redeemsOnHandle) {
            return
                _transferRemoteDirect(_destination, _recipient, _amount, cfg);
        }

        address _feeHook = feeHook();
        address _feeToken = feeToken();
        (, uint256 remainingNativeValue) = _calculateFeesAndCharge(
            _destination,
            _recipient,
            _amount,
            msg.value,
            _feeHook
        );

        address remoteRouter = _mustHaveRemoteRouter(_destination)
            .bytes32ToAddress();

        agglayerBridge.bridgeAsset(
            cfg.agglayerNetworkId,
            remoteRouter,
            _amount,
            address(localToken),
            cfg.forceUpdateGlobalExitRoot,
            ""
        );

        bytes memory _tokenMessage = TokenMessage.format(_recipient, _amount);
        messageId = _emitAndDispatch(
            _destination,
            _recipient,
            _amount,
            remainingNativeValue,
            _tokenMessage,
            _feeToken
        );
    }

    function _transferRemoteDirect(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        RemoteBridgeConfig memory _cfg
    ) internal returns (bytes32) {
        _transferFromSender(_amount);
        vaultBridgeToken.depositAndBridge(
            _amount,
            _recipient.bytes32ToAddress(),
            _cfg.agglayerNetworkId,
            _cfg.forceUpdateGlobalExitRoot
        );

        emit SentTransferRemote(_destination, _recipient, _amount);

        if (msg.value > 0) {
            payable(msg.sender).sendValue(msg.value);
        }

        return bytes32(0);
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        if (!redeemsOnHandle) revert UnsupportedVerify();
        bytes32 messageId = _message.id();
        if (isVerified[messageId]) {
            return true;
        }

        ClaimMetadata memory claim = abi.decode(_metadata, (ClaimMetadata));
        _claimBridgedAsset(claim, _message.body().amount());

        isVerified[messageId] = true;
        return true;
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal view override returns (bytes memory) {
        return
            abi.encodeCall(
                AggLayerService.getAggLayerClaimMetadata,
                (_message)
            );
    }

    function _transferFromSender(uint256 _amount) internal override {
        localToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        localToken.safeTransfer(_recipient, _amount);
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal override {
        if (!redeemsOnHandle) revert UnsupportedHandle();
        bytes32 recipient = TokenMessage.recipient(_message);
        uint256 amount = TokenMessage.amount(_message);

        emit ReceivedTransferRemote(_origin, recipient, amount);
        vaultBridgeToken.redeem(
            amount,
            recipient.bytes32ToAddress(),
            address(this)
        );
    }

    function _mustHaveRemoteConfig(
        uint32 _domain
    ) internal view returns (RemoteBridgeConfig memory) {
        RemoteBridgeConfig memory cfg = remoteBridgeConfigs[_domain];
        if (cfg.remoteToken == address(0)) revert RemoteConfigNotFound(_domain);
        return cfg;
    }

    function _claimBridgedAsset(
        ClaimMetadata memory _claim,
        uint256 _amount
    ) internal {
        agglayerBridge.claimAsset(
            _claim.smtProofLocalExitRoot,
            _claim.smtProofRollupExitRoot,
            _claim.globalIndex,
            _claim.mainnetExitRoot,
            _claim.rollupExitRoot,
            localAgglayerNetworkId,
            address(vaultBridgeToken),
            localAgglayerNetworkId,
            address(this),
            _amount,
            _claim.metadata
        );
    }
}
