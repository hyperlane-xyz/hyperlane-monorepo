// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {Mailbox} from "../../contracts/Mailbox.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {XERC20LockboxTest, XERC20Test, FiatTokenTest, ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

import {Router} from "../../contracts/client/Router.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";

import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {FeeTokenRouter, Quotes} from "contracts/token/libs/FeeTokenRouter.sol";

contract MockFeeTokenRouter is FeeTokenRouter {
    ERC20Test immutable primaryToken;

    constructor(
        address _mailbox,
        ERC20Test _primaryToken
    ) FeeTokenRouter(_mailbox) {
        primaryToken = _primaryToken;
    }

    function quoteExternalFees(
        uint32 destination,
        bytes32 recipient,
        uint256 amountOut
    ) public view override returns (Quotes[] memory quotes) {
        Quotes[] memory quotes = new Quotes[](1);
        quotes[0] = Quotes({token: address(primaryToken), amount: 1e18});
        return quotes;
    }

    function balanceOf(
        address _account
    ) external view override returns (uint256) {
        return primaryToken.balanceOf(_account);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
        primaryToken.transferFrom(msg.sender, address(this), _amount);
        return bytes(""); // no metadata
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata // no metadata
    ) internal virtual override {
        primaryToken.transfer(_recipient, _amount);
    }
}

contract FeeTokenRouterTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;
    using Message for bytes;

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal REQUIRED_VALUE; // initialized in setUp
    uint256 internal constant GAS_LIMIT = 10_000;
    string internal constant NAME = "HyperlaneInu";
    string internal constant SYMBOL = "HYP";
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant CAROL = address(0x3);
    address internal constant DANIEL = address(0x4);
    address internal constant PROXY_ADMIN = address(0x37);

    ERC20Test internal primaryToken;
    HypERC20 internal remoteToken;
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;
    TestInterchainGasPaymaster internal igp;

    FeeTokenRouter myRouter;

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    event Transfer(address indexed from, address indexed to, uint256 value);

    event ReceivedTransferRemote(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amount
    );

    function setUp() public virtual {
        localMailbox = new MockMailbox(ORIGIN);
        remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        remoteMailbox.addRemoteMailbox(ORIGIN, localMailbox);

        primaryToken = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);

        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        REQUIRED_VALUE = noopHook.quoteDispatch("", "");

        HypERC20 implementation = new HypERC20(
            DECIMALS,
            SCALE,
            address(remoteMailbox)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                TOTAL_SUPPLY,
                NAME,
                SYMBOL,
                address(noopHook),
                address(igp),
                address(this)
            )
        );
        remoteToken = HypERC20(address(proxy));
        igp = new TestInterchainGasPaymaster();
        vm.deal(ALICE, 125000);

        myRouter = new MockFeeTokenRouter(address(localMailbox), primaryToken);
        myRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
    }

    function _mintAndApprove(uint256 _amount, address _account) internal {
        primaryToken.mint(_amount);
        primaryToken.approve(_account, _amount);
    }

    function testCanChargeFees() public {
        vm.startPrank(ALICE);
        _mintAndApprove(2e18, address(myRouter));
        myRouter.transferRemote(DESTINATION, ALICE.addressToBytes32(), 1e18);
        assertEq(primaryToken.balanceOf(ALICE), 0); // 1e18 for quote plus 1e18 for transfer
        vm.stopPrank();
    }
}
