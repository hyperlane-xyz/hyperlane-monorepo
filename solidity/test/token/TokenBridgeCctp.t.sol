// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import "forge-std/StdCheats.sol";

import {MockToken} from "../../contracts/mock/MockToken.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TokenBridgeCctp, TokenBridgeCctpV1, TokenBridgeCctpV2} from "../../contracts/token/TokenBridgeCctp.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {MockCircleMessageTransmitter} from "../../contracts/mock/MockCircleMessageTransmitter.sol";
import {MockCircleTokenMessenger, MockCircleTokenMessengerV2} from "../../contracts/mock/MockCircleTokenMessenger.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";
import {IMessageTransmitter} from "../../contracts/interfaces/cctp/IMessageTransmitter.sol";
import {ITokenMessenger} from "../../contracts/interfaces/cctp/ITokenMessenger.sol";
import {ITokenMessengerV2} from "../../contracts/interfaces/cctp/ITokenMessengerV2.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {console} from "forge-std/console.sol";

contract TokenBridgeCctpV1Test is Test {
    using TypeCasts for address;

    uint32 internal constant CCTP_VERSION_1 = 0;
    uint32 internal constant CCTP_VERSION_2 = 1;

    uint256 internal constant scale = 1;
    uint32 internal constant origin = 1;
    uint32 internal constant destination = 2;
    uint32 internal constant cctpOrigin = 0;
    uint32 internal constant cctpDestination = 2;
    uint256 internal constant gasLimit = 250_000;

    TestInterchainGasPaymaster internal igpOrigin;
    TestInterchainGasPaymaster internal igpDestination;
    TokenBridgeCctp internal tbOrigin;
    TokenBridgeCctp internal tbDestination;

    address internal proxyAdmin;
    address internal evil = makeAddr("evil");
    string[] internal urls;

    MockToken internal tokenOrigin;
    MockToken internal tokenDestination;

    uint32 internal version = 0; // CCTPv1
    uint256 internal amount = 1_000_000; // 1 USDC
    address internal user = address(11);
    uint256 internal balance = 10_000_000; // 10 USDC
    bytes internal ccipReadData =
        vm.parseBytes(
            "0x0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000000f800000000000000000000000200000000000000000000000000000000000000009f3b8679c73c2fef8b59b4f3444d4e156fb70aa50000000000000000000000009f3b8679c73c2fef8b59b4f3444d4e156fb70aa50000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c7d4b196cb0c7b01d743fbc6116a902379c7238000000000000000000000000f84d371a90b2c406e54c9ec59dc4ee5850f413cf0000000000000000000000000000000000000000000000000000000000002b5d000000000000000000000000ab226edcc20404d3c6d5e22dbc8debc7e2f3bc4900000000000000000000000000000000000000000000000000000000000000000000000000000082b06c59ea018589d6f9c384ead63e2f90520f469a6d583ae295c9e0f75c3870756392ae6800ab32024214880870352d6319df2e8873aef5c45926111566e49f791b039de23de4e9430be20d75ec4794e2c30fef46296890f2be811427b165a19f677a8ee190f8e45a2dc3e01f0c6dc3a5a0ec6a5af9780fd5c48a81a1488d22fb701b000000000000000000000000000000000000000000000000000000000000"
        );

    MockMailbox internal mailboxOrigin;
    MockMailbox internal mailboxDestination;
    MockHyperlaneEnvironment internal environment;
    MockCircleTokenMessenger internal tokenMessengerOrigin;
    MockCircleMessageTransmitter internal messageTransmitterOrigin;
    MockCircleTokenMessenger internal tokenMessengerDestination;
    MockCircleMessageTransmitter internal messageTransmitterDestination;

    function setUp() public virtual {
        urls = new string[](1);
        urls[0] = "https://ccip-read-gateway.io";

        proxyAdmin = makeAddr("proxyAdmin");

        environment = new MockHyperlaneEnvironment(origin, destination);
        mailboxOrigin = environment.mailboxes(origin);
        mailboxDestination = environment.mailboxes(destination);

        igpOrigin = new TestInterchainGasPaymaster();
        igpDestination = new TestInterchainGasPaymaster();

        mailboxOrigin.setDefaultHook(address(igpOrigin));
        mailboxOrigin.setDefaultHook(address(igpDestination));

        tokenOrigin = new MockToken();
        tokenDestination = new MockToken();

        tokenOrigin.mint(user, balance);

        messageTransmitterOrigin = new MockCircleMessageTransmitter(
            tokenOrigin
        );
        tokenMessengerOrigin = new MockCircleTokenMessenger(tokenOrigin);

        messageTransmitterDestination = new MockCircleMessageTransmitter(
            tokenDestination
        );
        tokenMessengerDestination = new MockCircleTokenMessenger(
            tokenDestination
        );

        TokenBridgeCctpV1 originImplementation = new TokenBridgeCctpV1(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessenger(address(tokenMessengerOrigin))
        );

        TransparentUpgradeableProxy proxyOrigin = new TransparentUpgradeableProxy(
                address(originImplementation),
                proxyAdmin,
                abi.encodeWithSelector(
                    TokenBridgeCctp.initialize.selector,
                    address(0),
                    address(this),
                    urls
                )
            );

        tbOrigin = TokenBridgeCctpV1(address(proxyOrigin));

        TokenBridgeCctpV1 destinationImplementation = new TokenBridgeCctpV1(
            address(tokenDestination),
            scale,
            address(mailboxDestination),
            IMessageTransmitter(address(messageTransmitterDestination)),
            ITokenMessenger(address(tokenMessengerDestination))
        );

        TransparentUpgradeableProxy proxyDestination = new TransparentUpgradeableProxy(
                address(destinationImplementation),
                proxyAdmin,
                abi.encodeWithSelector(
                    TokenBridgeCctp.initialize.selector,
                    address(0),
                    address(this),
                    urls
                )
            );

        tbDestination = TokenBridgeCctpV1(address(proxyDestination));

        _setupTokenBridgesCctp(tbOrigin, tbDestination);

        vm.deal(user, 1 ether);
    }

    function test_setUrls_revertsWhen_callerIsNotTheOwner() public {
        address evil = makeAddr("evil");

        vm.prank(evil);
        _expectCallerIsNotTheOwnerRevert();
        tbOrigin.setUrls(urls);
    }

    function test_addDomain_revertsWhen_callerIsNotTheOwner() public {
        vm.prank(evil);
        _expectCallerIsNotTheOwnerRevert();
        tbOrigin.addDomain(destination, cctpDestination);
    }

    function test_quoteTransferRemote_getCorrectQuote() public {
        Quote[] memory quotes = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[1].token, address(tokenOrigin));
    }

    function test_transferRemoteCctp() public {
        Quote[] memory quote = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), quote[1].amount);

        tbOrigin.transferRemote{value: quote[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );

        vm.expectRevert();
        environment.processNextPendingMessage();

        // Relayer role
        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);

        _expectOffChainLookUpRevert(message);
        tbDestination.getOffchainVerifyInfo(message);

        bytes32 nonceId = messageTransmitterDestination.hashSourceAndNonce(
            tbDestination.hyperlaneDomainToCircleDomain(origin),
            tokenMessengerDestination.nextNonce()
        );

        messageTransmitterDestination.process(nonceId, user, amount);

        vm.expectEmit(address(tbDestination));
        emit TokenRouter.ReceivedTransferRemote(
            origin,
            user.addressToBytes32(),
            amount
        );
        tbDestination.verify(ccipReadData, message);

        uint256 tokenBalance = tokenDestination.balanceOf(user);
        assertEq(tokenBalance, amount);
    }

    function test_revertsWhen_versionIsNotSupported() public virtual {
        messageTransmitterOrigin.setVersion(CCTP_VERSION_1);
        MockCircleTokenMessengerV2 tokenMessengerV2 = new MockCircleTokenMessengerV2(
                tokenOrigin
            );

        vm.expectRevert(bytes("Invalid TokenMessenger CCTP version"));
        TokenBridgeCctpV1 v1 = new TokenBridgeCctpV1(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessenger(address(tokenMessengerV2))
        );

        messageTransmitterOrigin.setVersion(CCTP_VERSION_2);

        vm.expectRevert(bytes("Invalid messageTransmitter CCTP version"));
        v1 = new TokenBridgeCctpV1(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessenger(address(tokenMessengerOrigin))
        );
    }

    function _expectOffChainLookUpRevert(bytes memory message) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                ICcipReadIsm.OffchainLookup.selector,
                address(tbDestination),
                urls,
                abi.encodeWithSignature("getCCTPAttestation(bytes)", message),
                tbDestination.verify.selector,
                message
            )
        );
    }

    function _expectCallerIsNotTheOwnerRevert() internal {
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
    }

    function _setupTokenBridgesCctp(
        TokenBridgeCctp _tbOrigin,
        TokenBridgeCctp _tbDestination
    ) internal {
        _tbOrigin.setUrls(urls);
        _tbOrigin.addDomain(destination, cctpDestination);
        _tbOrigin.enrollRemoteRouter(
            destination,
            address(_tbDestination).addressToBytes32()
        );
        _tbOrigin.setDestinationGas(destination, gasLimit);

        _tbDestination.setUrls(urls);
        _tbDestination.addDomain(origin, cctpOrigin);
        _tbDestination.enrollRemoteRouter(
            origin,
            address(_tbOrigin).addressToBytes32()
        );
        _tbDestination.setDestinationGas(origin, gasLimit);
    }

    function test_hyperlaneDomainToCircleDomain(
        uint32 unconfiguredHyperlaneDomain,
        uint32 circleDomain
    ) public {
        // Assumptions for fuzzing: ensure the domain is truly unconfigured and not zero.
        vm.assume(unconfiguredHyperlaneDomain != 0);
        vm.assume(unconfiguredHyperlaneDomain != origin);
        vm.assume(unconfiguredHyperlaneDomain != destination);

        vm.expectRevert(bytes("Circle domain not configured"));
        tbOrigin.hyperlaneDomainToCircleDomain(unconfiguredHyperlaneDomain);

        // covers the case where circleDomain is 0
        tbOrigin.addDomain(unconfiguredHyperlaneDomain, circleDomain);
        assertEq(
            tbOrigin.hyperlaneDomainToCircleDomain(unconfiguredHyperlaneDomain),
            circleDomain
        );
    }
}

contract TokenBridgeCctpV2Test is TokenBridgeCctpV1Test {
    MockCircleTokenMessengerV2 internal tokenMessengerOriginV2;
    MockCircleTokenMessengerV2 internal tokenMessengerDestinationV2;

    function setUp() public override {
        super.setUp();

        tokenMessengerOriginV2 = new MockCircleTokenMessengerV2(tokenOrigin);
        tokenMessengerDestinationV2 = new MockCircleTokenMessengerV2(
            tokenDestination
        );

        messageTransmitterOrigin.setVersion(1);
        messageTransmitterDestination.setVersion(1);

        TokenBridgeCctpV2 originImplementation = new TokenBridgeCctpV2(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessengerV2(address(tokenMessengerOriginV2))
        );

        TransparentUpgradeableProxy proxyOrigin = new TransparentUpgradeableProxy(
                address(originImplementation),
                proxyAdmin,
                abi.encodeWithSelector(
                    TokenBridgeCctp.initialize.selector,
                    address(0),
                    address(this),
                    urls
                )
            );

        tbOrigin = TokenBridgeCctpV2(address(proxyOrigin));

        TokenBridgeCctpV2 destinationImplementation = new TokenBridgeCctpV2(
            address(tokenDestination),
            scale,
            address(mailboxDestination),
            IMessageTransmitter(address(messageTransmitterDestination)),
            ITokenMessengerV2(address(tokenMessengerDestinationV2))
        );

        TransparentUpgradeableProxy proxyDestination = new TransparentUpgradeableProxy(
                address(destinationImplementation),
                proxyAdmin,
                abi.encodeWithSelector(
                    TokenBridgeCctp.initialize.selector,
                    address(0),
                    address(this),
                    urls
                )
            );

        tbDestination = TokenBridgeCctpV2(address(proxyDestination));

        _setupTokenBridgesCctp(tbOrigin, tbDestination);
    }

    function test_revertsWhen_versionIsNotSupported() public override {
        messageTransmitterOrigin.setVersion(CCTP_VERSION_2);

        vm.expectRevert(bytes("Invalid TokenMessenger CCTP version"));
        TokenBridgeCctpV2 v2 = new TokenBridgeCctpV2(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessengerV2(address(tokenMessengerOrigin))
        );

        messageTransmitterOrigin.setVersion(CCTP_VERSION_1);

        vm.expectRevert(bytes("Invalid messageTransmitter CCTP version"));
        v2 = new TokenBridgeCctpV2(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessengerV2(address(tokenMessengerOriginV2))
        );
    }
}
