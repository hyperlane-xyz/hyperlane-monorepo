// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "../../middleware/libs/Call.sol";
import {ITokenBridge} from "../../interfaces/ITokenBridge.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IInterchainAccountRouterLike {
    function callRemote(
        uint32 _destination,
        CallLib.Call[] calldata _calls,
        bytes calldata _hookMetadata
    ) external payable returns (bytes32);

    function getRemoteInterchainAccount(
        uint32 _destination,
        address _owner
    ) external view returns (address);
}

interface ITokenFeeClaim {
    function claim(address beneficiary) external;
}

interface ITokenFeeClaimWithToken {
    function claim(address beneficiary, address token) external;
}

interface IRoutingFeeConfig {
    function setFeeContract(uint32 destination, address feeContract) external;
}

interface ICrossCollateralRoutingFeeConfig {
    function setCrossCollateralRouterFeeContracts(
        uint32[] calldata destinations,
        bytes32[] calldata targetRouters,
        address[] calldata _feeContracts
    ) external;
}

interface ITokenBridgeCctpV2FeeConfig {
    function setMaxFeePpm(uint256 _maxFeePpm) external;
}

interface IEverclearTokenBridgeFeeConfig {
    function setFeeParams(
        uint32 _destination,
        uint256 _fee,
        uint256 _deadline,
        bytes calldata _sig
    ) external;
}

interface ILpRouter {
    function donate(uint256 amount) external payable;
}

/**
 * @title WarpFeeController
 * @notice EVM-only MVP controller for collecting warp route fees to the hub and splitting them.
 * @dev Native collection assumes the claimed native balance in the remote ICA is at least `paymentAmount`.
 * ERC20 collection approves `paymentAmount`, allowing transferRemote to charge configured token fees.
 * Caller-supplied collection targets are an MVP tradeoff; the controller-owned remote ICA should
 * not custody unrelated assets. Rebasing, fee-on-transfer, and ERC777 route assets are unsupported.
 */
contract WarpFeeController is Ownable, ReentrancyGuard, PackageVersioned {
    using Address for address payable;
    using SafeERC20 for IERC20;
    using TypeCasts for address;

    uint256 public constant BPS_SCALE = 10_000;

    IInterchainAccountRouterLike public immutable icaRouter;
    uint32 public immutable hubDomain;

    address public hubRouter;
    uint256 public lpBps;
    address public protocolBeneficiary;
    address public feeManager;

    event Collected(
        uint32 indexed remoteDomain,
        address indexed feeContract,
        address indexed token,
        address remoteRouter,
        uint256 amount,
        uint256 paymentAmount,
        bool tokenClaim,
        bytes32 messageId
    );
    event FeeUpdateDispatched(
        uint32 indexed remoteDomain,
        bytes32 indexed messageId
    );
    event Distributed(
        address indexed token,
        uint256 lpAmount,
        uint256 protocolAmount
    );
    event HubRouterSet(address indexed operator, address indexed hubRouter);
    event LpBpsSet(address indexed operator, uint256 lpBps);
    event ProtocolBeneficiarySet(
        address indexed operator,
        address indexed protocolBeneficiary
    );
    event FeeManagerSet(address indexed operator, address indexed feeManager);

    modifier onlyFeeManager() {
        require(msg.sender == feeManager, "WarpFeeController: !feeManager");
        _;
    }

    constructor(
        address _owner,
        address _icaRouter,
        uint32 _hubDomain,
        address _hubRouter,
        uint256 _lpBps,
        address _protocolBeneficiary,
        address _feeManager
    ) Ownable() {
        require(_owner != address(0), "WarpFeeController: owner zero");
        require(_icaRouter != address(0), "WarpFeeController: ICA zero");
        require(_hubRouter != address(0), "WarpFeeController: hub router zero");
        require(
            _protocolBeneficiary != address(0),
            "WarpFeeController: beneficiary zero"
        );
        require(_lpBps <= BPS_SCALE, "WarpFeeController: lp bps too high");
        require(
            _feeManager != address(0),
            "WarpFeeController: fee manager zero"
        );

        icaRouter = IInterchainAccountRouterLike(_icaRouter);
        hubDomain = _hubDomain;
        hubRouter = _hubRouter;
        lpBps = _lpBps;
        protocolBeneficiary = _protocolBeneficiary;
        feeManager = _feeManager;
        _transferOwnership(_owner);
    }

    function collect(
        uint32 remoteDomain,
        address feeContract,
        address token,
        address remoteRouter,
        uint256 amount,
        uint256 paymentAmount,
        bool tokenClaim,
        bytes calldata hookMetadata
    ) external payable returns (bytes32 messageId) {
        require(
            feeContract != address(0),
            "WarpFeeController: fee contract zero"
        );
        require(
            remoteRouter != address(0),
            "WarpFeeController: remote router zero"
        );
        require(paymentAmount >= amount, "WarpFeeController: payment too low");

        address remoteIca = icaRouter.getRemoteInterchainAccount(
            remoteDomain,
            address(this)
        );
        CallLib.Call[] memory calls = token == address(0)
            ? _buildNativeCollectCalls(
                feeContract,
                remoteIca,
                remoteRouter,
                amount,
                paymentAmount,
                tokenClaim
            )
            : _buildErc20CollectCalls(
                feeContract,
                remoteIca,
                token,
                remoteRouter,
                amount,
                paymentAmount,
                tokenClaim
            );

        messageId = icaRouter.callRemote{value: msg.value}(
            remoteDomain,
            calls,
            hookMetadata
        );

        emit Collected(
            remoteDomain,
            feeContract,
            token,
            remoteRouter,
            amount,
            paymentAmount,
            tokenClaim,
            messageId
        );
    }

    function _buildClaimCall(
        address feeContract,
        address remoteIca,
        address token,
        bool tokenClaim
    ) internal pure returns (CallLib.Call memory) {
        return
            CallLib.build(
                feeContract,
                0,
                tokenClaim
                    ? abi.encodeWithSelector(
                        ITokenFeeClaimWithToken.claim.selector,
                        remoteIca,
                        token
                    )
                    : abi.encodeWithSelector(
                        ITokenFeeClaim.claim.selector,
                        remoteIca
                    )
            );
    }

    function _buildNativeCollectCalls(
        address feeContract,
        address remoteIca,
        address remoteRouter,
        uint256 amount,
        uint256 paymentAmount,
        bool tokenClaim
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](2);
        calls[0] = _buildClaimCall(
            feeContract,
            remoteIca,
            address(0),
            tokenClaim
        );
        calls[1] = CallLib.build(
            remoteRouter,
            paymentAmount,
            abi.encodeWithSelector(
                ITokenBridge.transferRemote.selector,
                hubDomain,
                address(this).addressToBytes32(),
                amount
            )
        );
    }

    function _buildErc20CollectCalls(
        address feeContract,
        address remoteIca,
        address token,
        address remoteRouter,
        uint256 amount,
        uint256 paymentAmount,
        bool tokenClaim
    ) internal view returns (CallLib.Call[] memory calls) {
        calls = new CallLib.Call[](5);
        calls[0] = _buildClaimCall(feeContract, remoteIca, token, tokenClaim);
        calls[1] = CallLib.build(
            token,
            0,
            abi.encodeWithSelector(IERC20.approve.selector, remoteRouter, 0)
        );
        calls[2] = CallLib.build(
            token,
            0,
            abi.encodeWithSelector(
                IERC20.approve.selector,
                remoteRouter,
                paymentAmount
            )
        );
        calls[3] = CallLib.build(
            remoteRouter,
            0,
            abi.encodeWithSelector(
                ITokenBridge.transferRemote.selector,
                hubDomain,
                address(this).addressToBytes32(),
                amount
            )
        );
        calls[4] = CallLib.build(
            token,
            0,
            abi.encodeWithSelector(IERC20.approve.selector, remoteRouter, 0)
        );
    }

    function dispatchFeeUpdate(
        uint32 remoteDomain,
        CallLib.Call[] calldata calls,
        bytes calldata hookMetadata
    ) external payable onlyFeeManager returns (bytes32 messageId) {
        for (uint256 i = 0; i < calls.length; i++) {
            require(
                calls[i].value == 0,
                "WarpFeeController: value not allowed"
            );
            require(
                _isAllowedFeeUpdateSelector(calls[i].data),
                "WarpFeeController: selector not allowed"
            );
        }
        messageId = icaRouter.callRemote{value: msg.value}(
            remoteDomain,
            calls,
            hookMetadata
        );
        emit FeeUpdateDispatched(remoteDomain, messageId);
    }

    function _isAllowedFeeUpdateSelector(
        bytes calldata data
    ) internal pure returns (bool) {
        require(data.length >= 4, "WarpFeeController: missing selector");

        bytes4 selector = bytes4(data[:4]);

        return
            selector == IRoutingFeeConfig.setFeeContract.selector ||
            selector ==
            ICrossCollateralRoutingFeeConfig
                .setCrossCollateralRouterFeeContracts
                .selector ||
            selector == ITokenBridgeCctpV2FeeConfig.setMaxFeePpm.selector ||
            selector == IEverclearTokenBridgeFeeConfig.setFeeParams.selector;
    }

    function distribute(address token) external nonReentrant {
        uint256 balance = token == address(0)
            ? address(this).balance
            : IERC20(token).balanceOf(address(this));
        uint256 lpAmount = (balance * lpBps) / BPS_SCALE;
        uint256 protocolAmount = balance - lpAmount;

        protocolAmount = token == address(0)
            ? _distributeNative(lpAmount, protocolAmount)
            : _distributeErc20(token, lpAmount, protocolAmount);

        emit Distributed(token, lpAmount, protocolAmount);
    }

    function _distributeNative(
        uint256 lpAmount,
        uint256 _protocolAmount
    ) internal returns (uint256 protocolAmount) {
        protocolAmount = _protocolAmount;
        if (lpAmount > 0) {
            ILpRouter(hubRouter).donate{value: lpAmount}(lpAmount);
        }

        if (protocolAmount > 0) {
            payable(protocolBeneficiary).sendValue(protocolAmount);
        }
    }

    function _distributeErc20(
        address token,
        uint256 lpAmount,
        uint256 _protocolAmount
    ) internal returns (uint256 protocolAmount) {
        protocolAmount = _protocolAmount;
        if (lpAmount > 0) {
            IERC20(token).forceApprove(hubRouter, lpAmount);
            ILpRouter(hubRouter).donate(lpAmount);
            IERC20(token).forceApprove(hubRouter, 0);
        }

        if (protocolAmount > 0) {
            IERC20(token).safeTransfer(protocolBeneficiary, protocolAmount);
        }
    }

    function setHubRouter(address _hubRouter) external onlyOwner {
        require(_hubRouter != address(0), "WarpFeeController: hub router zero");
        hubRouter = _hubRouter;
        emit HubRouterSet(msg.sender, _hubRouter);
    }

    function setLpBps(uint256 _lpBps) external onlyOwner {
        require(_lpBps <= BPS_SCALE, "WarpFeeController: lp bps too high");
        lpBps = _lpBps;
        emit LpBpsSet(msg.sender, _lpBps);
    }

    function setProtocolBeneficiary(
        address _protocolBeneficiary
    ) external onlyOwner {
        require(
            _protocolBeneficiary != address(0),
            "WarpFeeController: beneficiary zero"
        );
        protocolBeneficiary = _protocolBeneficiary;
        emit ProtocolBeneficiarySet(msg.sender, _protocolBeneficiary);
    }

    function setFeeManager(address _feeManager) external onlyOwner {
        require(
            _feeManager != address(0),
            "WarpFeeController: fee manager zero"
        );
        feeManager = _feeManager;
        emit FeeManagerSet(msg.sender, _feeManager);
    }

    receive() external payable {}
}
