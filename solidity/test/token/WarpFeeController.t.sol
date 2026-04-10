// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {CallLib} from "../../contracts/middleware/libs/Call.sol";
import {ITokenBridge} from "../../contracts/interfaces/ITokenBridge.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {WarpFeeController, ITokenFeeClaim, ITokenFeeClaimWithToken, IRoutingFeeConfig} from "../../contracts/token/fees/WarpFeeController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ITokenRouterAdminConfig {
    function setFeeRecipient(address recipient) external;
}

contract MockIcaRouter {
    using TypeCasts for address;

    uint32 public lastDestination;
    bytes public lastHookMetadata;
    address public remoteIca = address(0x1111);
    bytes32 public nextMessageId = bytes32(uint256(0x1234));
    CallLib.Call[] internal lastCalls;

    function callRemote(
        uint32 _destination,
        CallLib.Call[] calldata _calls,
        bytes calldata _hookMetadata
    ) external payable returns (bytes32) {
        lastDestination = _destination;
        lastHookMetadata = _hookMetadata;
        delete lastCalls;
        for (uint256 i = 0; i < _calls.length; i++) {
            lastCalls.push(_calls[i]);
        }
        return nextMessageId;
    }

    function getRemoteInterchainAccount(
        uint32,
        address
    ) external view returns (address) {
        return remoteIca;
    }

    function lastCallsLength() external view returns (uint256) {
        return lastCalls.length;
    }

    function getLastCall(
        uint256 index
    ) external view returns (bytes32 to, uint256 value, bytes memory data) {
        CallLib.Call storage call = lastCalls[index];
        return (call.to, call.value, call.data);
    }
}

contract MockLpRouter {
    using SafeERC20 for IERC20;

    address public immutable token;
    uint256 public totalDonations;

    constructor(address _token) {
        token = _token;
    }

    function donate(uint256 amount) external payable {
        if (token == address(0)) {
            require(msg.value == amount, "MockLpRouter: bad value");
        } else {
            require(msg.value == 0, "MockLpRouter: unexpected value");
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
        totalDonations += amount;
    }
}

contract WarpFeeControllerTest is Test {
    using TypeCasts for address;
    using TypeCasts for bytes32;

    uint32 internal constant HUB_DOMAIN = 1;
    uint32 internal constant REMOTE_DOMAIN = 2;
    uint256 internal constant AMOUNT = 100e18;
    uint256 internal constant PAYMENT_AMOUNT = 101e18;

    address internal owner = address(0xA11CE);
    address internal feeManager = address(0xB0B);
    address internal protocolBeneficiary = address(0xCAFE);
    address internal feeContract = address(0xFEE);
    address internal remoteRouter = address(0xBEEF);

    MockIcaRouter internal icaRouter;
    ERC20Test internal token;
    MockLpRouter internal lpRouter;
    WarpFeeController internal controller;

    function setUp() public {
        icaRouter = new MockIcaRouter();
        token = new ERC20Test("Test Token", "TST", 0, 18);
        lpRouter = new MockLpRouter(address(token));
        controller = new WarpFeeController(
            owner,
            address(icaRouter),
            HUB_DOMAIN,
            address(lpRouter),
            2_500,
            protocolBeneficiary,
            feeManager
        );
    }

    function testCollectBuildsErc20Calls() public {
        bytes memory hookMetadata = hex"1234";

        bytes32 messageId = controller.collect(
            REMOTE_DOMAIN,
            feeContract,
            address(token),
            remoteRouter,
            AMOUNT,
            PAYMENT_AMOUNT,
            false,
            hookMetadata
        );

        assertEq(messageId, icaRouter.nextMessageId());
        assertEq(icaRouter.lastDestination(), REMOTE_DOMAIN);
        assertEq(icaRouter.lastHookMetadata(), hookMetadata);
        assertEq(icaRouter.lastCallsLength(), 5);

        (bytes32 to, uint256 value, bytes memory data) = icaRouter.getLastCall(
            0
        );
        assertEq(to.bytes32ToAddress(), feeContract);
        assertEq(value, 0);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(
                    ITokenFeeClaim.claim.selector,
                    icaRouter.remoteIca()
                )
            )
        );

        (to, value, data) = icaRouter.getLastCall(1);
        assertEq(to.bytes32ToAddress(), address(token));
        assertEq(value, 0);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(IERC20.approve.selector, remoteRouter, 0)
            )
        );

        (to, value, data) = icaRouter.getLastCall(2);
        assertEq(to.bytes32ToAddress(), address(token));
        assertEq(value, 0);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(
                    IERC20.approve.selector,
                    remoteRouter,
                    PAYMENT_AMOUNT
                )
            )
        );

        (to, value, data) = icaRouter.getLastCall(3);
        assertEq(to.bytes32ToAddress(), remoteRouter);
        assertEq(value, 0);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(
                    ITokenBridge.transferRemote.selector,
                    HUB_DOMAIN,
                    address(controller).addressToBytes32(),
                    AMOUNT
                )
            )
        );

        (to, value, data) = icaRouter.getLastCall(4);
        assertEq(to.bytes32ToAddress(), address(token));
        assertEq(value, 0);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(IERC20.approve.selector, remoteRouter, 0)
            )
        );
    }

    function testCollectBuildsErc20CallsForRepeatedCollects() public {
        controller.collect(
            REMOTE_DOMAIN,
            feeContract,
            address(token),
            remoteRouter,
            AMOUNT,
            PAYMENT_AMOUNT,
            false,
            bytes("")
        );
        controller.collect(
            REMOTE_DOMAIN,
            feeContract,
            address(token),
            remoteRouter,
            AMOUNT,
            PAYMENT_AMOUNT + 1,
            false,
            bytes("")
        );

        assertEq(icaRouter.lastCallsLength(), 5);

        (, , bytes memory data) = icaRouter.getLastCall(1);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(IERC20.approve.selector, remoteRouter, 0)
            )
        );

        (, , data) = icaRouter.getLastCall(2);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(
                    IERC20.approve.selector,
                    remoteRouter,
                    PAYMENT_AMOUNT + 1
                )
            )
        );

        (, , data) = icaRouter.getLastCall(4);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(IERC20.approve.selector, remoteRouter, 0)
            )
        );
    }

    function testCollectBuildsTokenClaimCall() public {
        controller.collect(
            REMOTE_DOMAIN,
            feeContract,
            address(token),
            remoteRouter,
            AMOUNT,
            PAYMENT_AMOUNT,
            true,
            bytes("")
        );

        (, , bytes memory data) = icaRouter.getLastCall(0);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(
                    ITokenFeeClaimWithToken.claim.selector,
                    icaRouter.remoteIca(),
                    address(token)
                )
            )
        );
    }

    function testCollectBuildsNativeCalls() public {
        controller.collect(
            REMOTE_DOMAIN,
            feeContract,
            address(0),
            remoteRouter,
            AMOUNT,
            PAYMENT_AMOUNT,
            false,
            bytes("")
        );

        assertEq(icaRouter.lastCallsLength(), 2);

        (bytes32 to, uint256 value, bytes memory data) = icaRouter.getLastCall(
            1
        );
        assertEq(to.bytes32ToAddress(), remoteRouter);
        assertEq(value, PAYMENT_AMOUNT);
        assertEq(
            keccak256(data),
            keccak256(
                abi.encodeWithSelector(
                    ITokenBridge.transferRemote.selector,
                    HUB_DOMAIN,
                    address(controller).addressToBytes32(),
                    AMOUNT
                )
            )
        );
    }

    function testConstructorRejectsBadConfig() public {
        vm.expectRevert(bytes("WarpFeeController: owner zero"));
        new WarpFeeController(
            address(0),
            address(icaRouter),
            HUB_DOMAIN,
            address(lpRouter),
            2_500,
            protocolBeneficiary,
            feeManager
        );

        vm.expectRevert(bytes("WarpFeeController: ICA zero"));
        new WarpFeeController(
            owner,
            address(0),
            HUB_DOMAIN,
            address(lpRouter),
            2_500,
            protocolBeneficiary,
            feeManager
        );

        vm.expectRevert(bytes("WarpFeeController: hub router zero"));
        new WarpFeeController(
            owner,
            address(icaRouter),
            HUB_DOMAIN,
            address(0),
            2_500,
            protocolBeneficiary,
            feeManager
        );

        vm.expectRevert(bytes("WarpFeeController: beneficiary zero"));
        new WarpFeeController(
            owner,
            address(icaRouter),
            HUB_DOMAIN,
            address(lpRouter),
            2_500,
            address(0),
            feeManager
        );

        vm.expectRevert(bytes("WarpFeeController: lp bps too high"));
        new WarpFeeController(
            owner,
            address(icaRouter),
            HUB_DOMAIN,
            address(lpRouter),
            10_001,
            protocolBeneficiary,
            feeManager
        );

        vm.expectRevert(bytes("WarpFeeController: fee manager zero"));
        new WarpFeeController(
            owner,
            address(icaRouter),
            HUB_DOMAIN,
            address(lpRouter),
            2_500,
            protocolBeneficiary,
            address(0)
        );
    }

    function testCollectRejectsBadConfig() public {
        vm.expectRevert(bytes("WarpFeeController: fee contract zero"));
        controller.collect(
            REMOTE_DOMAIN,
            address(0),
            address(token),
            remoteRouter,
            AMOUNT,
            PAYMENT_AMOUNT,
            false,
            bytes("")
        );

        vm.expectRevert(bytes("WarpFeeController: remote router zero"));
        controller.collect(
            REMOTE_DOMAIN,
            feeContract,
            address(token),
            address(0),
            AMOUNT,
            PAYMENT_AMOUNT,
            false,
            bytes("")
        );

        vm.expectRevert(bytes("WarpFeeController: payment too low"));
        controller.collect(
            REMOTE_DOMAIN,
            feeContract,
            address(token),
            remoteRouter,
            PAYMENT_AMOUNT,
            AMOUNT,
            false,
            bytes("")
        );
    }

    function testDispatchFeeUpdateOnlyFeeManager() public {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            feeContract,
            0,
            abi.encodeWithSelector(
                IRoutingFeeConfig.setFeeContract.selector,
                REMOTE_DOMAIN,
                address(0x1234)
            )
        );

        vm.expectRevert(bytes("WarpFeeController: !feeManager"));
        controller.dispatchFeeUpdate(REMOTE_DOMAIN, calls, bytes(""));

        vm.prank(feeManager);
        controller.dispatchFeeUpdate(REMOTE_DOMAIN, calls, bytes(""));
        assertEq(icaRouter.lastDestination(), REMOTE_DOMAIN);
        assertEq(icaRouter.lastCallsLength(), 1);
    }

    function testDispatchFeeUpdateRejectsUnknownSelector() public {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(feeContract, 0, hex"deadbeef");

        vm.prank(feeManager);
        vm.expectRevert(bytes("WarpFeeController: selector not allowed"));
        controller.dispatchFeeUpdate(REMOTE_DOMAIN, calls, bytes(""));
    }

    function testDispatchFeeUpdateRejectsRouterAdminSelector() public {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            feeContract,
            0,
            abi.encodeWithSelector(
                ITokenRouterAdminConfig.setFeeRecipient.selector,
                address(0x1234)
            )
        );

        vm.prank(feeManager);
        vm.expectRevert(bytes("WarpFeeController: selector not allowed"));
        controller.dispatchFeeUpdate(REMOTE_DOMAIN, calls, bytes(""));
    }

    function testDispatchFeeUpdateRejectsMissingSelector() public {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(feeContract, 0, hex"deadbe");

        vm.prank(feeManager);
        vm.expectRevert(bytes("WarpFeeController: missing selector"));
        controller.dispatchFeeUpdate(REMOTE_DOMAIN, calls, bytes(""));
    }

    function testDispatchFeeUpdateRejectsCallValue() public {
        CallLib.Call[] memory calls = new CallLib.Call[](1);
        calls[0] = CallLib.build(
            feeContract,
            1,
            abi.encodeWithSelector(
                IRoutingFeeConfig.setFeeContract.selector,
                REMOTE_DOMAIN,
                address(0x1234)
            )
        );

        vm.prank(feeManager);
        vm.expectRevert(bytes("WarpFeeController: value not allowed"));
        controller.dispatchFeeUpdate(REMOTE_DOMAIN, calls, bytes(""));
    }

    function testOwnerSetters() public {
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        controller.setLpBps(1);

        vm.startPrank(owner);
        vm.expectRevert(bytes("WarpFeeController: hub router zero"));
        controller.setHubRouter(address(0));
        vm.expectRevert(bytes("WarpFeeController: lp bps too high"));
        controller.setLpBps(10_001);
        vm.expectRevert(bytes("WarpFeeController: beneficiary zero"));
        controller.setProtocolBeneficiary(address(0));
        vm.expectRevert(bytes("WarpFeeController: fee manager zero"));
        controller.setFeeManager(address(0));

        controller.setLpBps(5_000);
        controller.setProtocolBeneficiary(address(0xDAD));
        controller.setFeeManager(address(0xF00D));
        controller.setHubRouter(address(0xFACADE));
        vm.stopPrank();

        assertEq(controller.lpBps(), 5_000);
        assertEq(controller.protocolBeneficiary(), address(0xDAD));
        assertEq(controller.feeManager(), address(0xF00D));
        assertEq(controller.hubRouter(), address(0xFACADE));
    }

    function testDistributeErc20OnlyProtocol() public {
        vm.prank(owner);
        controller.setLpBps(0);
        token.mintTo(address(controller), 10_000);

        controller.distribute(address(token));

        assertEq(lpRouter.totalDonations(), 0);
        assertEq(token.balanceOf(protocolBeneficiary), 10_000);
        assertEq(token.balanceOf(address(controller)), 0);
    }

    function testDistributeErc20OnlyLp() public {
        vm.startPrank(owner);
        controller.setLpBps(10_000);
        vm.stopPrank();
        token.mintTo(address(controller), 10_000);

        controller.distribute(address(token));

        assertEq(lpRouter.totalDonations(), 10_000);
        assertEq(token.balanceOf(address(lpRouter)), 10_000);
        assertEq(token.balanceOf(protocolBeneficiary), 0);
        assertEq(token.balanceOf(address(controller)), 0);
    }

    function testDistributeErc20SplitsAndDonates() public {
        token.mintTo(address(controller), 10_000);

        controller.distribute(address(token));

        assertEq(lpRouter.totalDonations(), 2_500);
        assertEq(token.balanceOf(address(lpRouter)), 2_500);
        assertEq(token.balanceOf(protocolBeneficiary), 7_500);
        assertEq(token.balanceOf(address(controller)), 0);
    }

    function testDistributeNativeSplitsAndDonates() public {
        MockLpRouter nativeLpRouter = new MockLpRouter(address(0));
        vm.prank(owner);
        controller.setHubRouter(address(nativeLpRouter));
        vm.deal(address(controller), 10_000);

        controller.distribute(address(0));

        assertEq(nativeLpRouter.totalDonations(), 2_500);
        assertEq(address(nativeLpRouter).balance, 2_500);
        assertEq(protocolBeneficiary.balance, 7_500);
        assertEq(address(controller).balance, 0);
    }
}
