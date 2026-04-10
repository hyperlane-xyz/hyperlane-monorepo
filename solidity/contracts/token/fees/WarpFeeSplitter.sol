// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {PackageVersioned} from "../../PackageVersioned.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface ILpRouter {
    function donate(uint256 amount) external payable;
}

/**
 * @title WarpFeeSplitter
 * @notice Hub-chain recipient for swept warp fees. Protocol fees are paid immediately,
 * while LP fees are streamed into the hub router via donate() to reduce JIT LP capture.
 * @dev The splitter assumes plain ERC20/native route assets. Rebasing, fee-on-transfer,
 * and ERC777 route assets are unsupported.
 */
contract WarpFeeSplitter is Ownable, ReentrancyGuard, PackageVersioned {
    using Address for address payable;
    using SafeERC20 for IERC20;

    uint256 public constant BPS_SCALE = 10_000;

    struct Stream {
        uint256 remaining;
        uint256 lastUpdated;
        uint256 end;
    }

    address public hubRouter;
    uint256 public lpBps;
    address public protocolBeneficiary;
    uint256 public streamingPeriod;

    mapping(address token => Stream) public streams;

    event FeesNotified(
        address indexed token,
        uint256 amount,
        uint256 lpAmount,
        uint256 protocolAmount
    );
    event FeesDripped(address indexed token, uint256 amount);
    event HubRouterSet(address indexed operator, address indexed hubRouter);
    event LpBpsSet(address indexed operator, uint256 lpBps);
    event ProtocolBeneficiarySet(
        address indexed operator,
        address indexed protocolBeneficiary
    );
    event StreamingPeriodSet(address indexed operator, uint256 streamingPeriod);

    constructor(
        address _owner,
        address _hubRouter,
        uint256 _lpBps,
        address _protocolBeneficiary,
        uint256 _streamingPeriod
    ) Ownable() {
        require(_owner != address(0), "WarpFeeSplitter: owner zero");
        require(_hubRouter != address(0), "WarpFeeSplitter: hub router zero");
        require(
            _protocolBeneficiary != address(0),
            "WarpFeeSplitter: beneficiary zero"
        );
        require(_lpBps <= BPS_SCALE, "WarpFeeSplitter: lp bps too high");
        require(_streamingPeriod > 0, "WarpFeeSplitter: streaming period zero");

        hubRouter = _hubRouter;
        lpBps = _lpBps;
        protocolBeneficiary = _protocolBeneficiary;
        streamingPeriod = _streamingPeriod;
        _transferOwnership(_owner);
    }

    /**
     * @notice Splits newly received fees. Protocol share is transferred immediately;
     * LP share is added to the stream and can be donated over time via drip().
     */
    function notify(address token) external nonReentrant {
        _drip(token);

        Stream storage stream = streams[token];
        uint256 balance = _balance(token);
        require(
            balance >= stream.remaining,
            "WarpFeeSplitter: balance below stream"
        );

        uint256 amount = balance - stream.remaining;
        require(amount > 0, "WarpFeeSplitter: no new fees");

        uint256 lpAmount = (amount * lpBps) / BPS_SCALE;
        uint256 protocolAmount = amount - lpAmount;

        if (protocolAmount > 0) {
            _transfer(token, protocolBeneficiary, protocolAmount);
        }
        if (lpAmount > 0) {
            stream.remaining += lpAmount;
            stream.lastUpdated = block.timestamp;
            stream.end = block.timestamp + streamingPeriod;
        }

        emit FeesNotified(token, amount, lpAmount, protocolAmount);
    }

    /**
     * @notice Donates vested LP fees to the hub router.
     */
    function drip(address token) external nonReentrant {
        _drip(token);
    }

    function previewDrip(address token) public view returns (uint256) {
        Stream memory stream = streams[token];
        if (stream.remaining == 0 || block.timestamp <= stream.lastUpdated) {
            return 0;
        }
        if (block.timestamp >= stream.end) {
            return stream.remaining;
        }

        uint256 duration = stream.end - stream.lastUpdated;
        return
            (stream.remaining * (block.timestamp - stream.lastUpdated)) /
            duration;
    }

    function _drip(address token) internal {
        uint256 amount = previewDrip(token);
        if (amount == 0) {
            return;
        }

        Stream storage stream = streams[token];
        stream.remaining -= amount;
        stream.lastUpdated = block.timestamp;
        if (stream.remaining == 0) {
            stream.end = block.timestamp;
        }

        _donate(token, amount);
        emit FeesDripped(token, amount);
    }

    function _balance(address token) internal view returns (uint256) {
        return
            token == address(0)
                ? address(this).balance
                : IERC20(token).balanceOf(address(this));
    }

    function _donate(address token, uint256 amount) internal {
        if (token == address(0)) {
            ILpRouter(hubRouter).donate{value: amount}(amount);
        } else {
            IERC20(token).forceApprove(hubRouter, amount);
            ILpRouter(hubRouter).donate(amount);
            IERC20(token).forceApprove(hubRouter, 0);
        }
    }

    function _transfer(
        address token,
        address recipient,
        uint256 amount
    ) internal {
        if (token == address(0)) {
            payable(recipient).sendValue(amount);
        } else {
            IERC20(token).safeTransfer(recipient, amount);
        }
    }

    function setHubRouter(address _hubRouter) external onlyOwner {
        require(_hubRouter != address(0), "WarpFeeSplitter: hub router zero");
        hubRouter = _hubRouter;
        emit HubRouterSet(msg.sender, _hubRouter);
    }

    function setLpBps(uint256 _lpBps) external onlyOwner {
        require(_lpBps <= BPS_SCALE, "WarpFeeSplitter: lp bps too high");
        lpBps = _lpBps;
        emit LpBpsSet(msg.sender, _lpBps);
    }

    function setProtocolBeneficiary(
        address _protocolBeneficiary
    ) external onlyOwner {
        require(
            _protocolBeneficiary != address(0),
            "WarpFeeSplitter: beneficiary zero"
        );
        protocolBeneficiary = _protocolBeneficiary;
        emit ProtocolBeneficiarySet(msg.sender, _protocolBeneficiary);
    }

    function setStreamingPeriod(uint256 _streamingPeriod) external onlyOwner {
        require(_streamingPeriod > 0, "WarpFeeSplitter: streaming period zero");
        streamingPeriod = _streamingPeriod;
        emit StreamingPeriodSet(msg.sender, _streamingPeriod);
    }

    receive() external payable {}
}
