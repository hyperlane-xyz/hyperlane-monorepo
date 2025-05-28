// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import "forge-std/StdCheats.sol";

import {MockToken} from "../../contracts/mock/MockToken.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {TokenBridgeCctp} from "../../contracts/token/TokenBridgeCctp.sol";
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
import {CctpMessage} from "../../contracts/libs/CctpMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";

contract TokenBridgeCctpTest is Test {
    using TypeCasts for address;
    using Message for bytes;

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

        TokenBridgeCctp originImplementation = new TokenBridgeCctp(
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

        tbOrigin = TokenBridgeCctp(address(proxyOrigin));

        TokenBridgeCctp destinationImplementation = new TokenBridgeCctp(
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

        tbDestination = TokenBridgeCctp(address(proxyDestination));

        _setupTokenBridgesCctp(tbOrigin, tbDestination);

        vm.deal(user, 1 ether);
    }

    function _encodeCctpMessage(
        uint64 nonce,
        uint32 sourceDomain,
        bytes memory body
    ) internal view returns (bytes memory) {
        return
            CctpMessage._formatMessage(
                version,
                sourceDomain,
                cctpDestination,
                nonce,
                address(tbOrigin).addressToBytes32(),
                address(tbDestination).addressToBytes32(),
                bytes32(0),
                body
            );
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

        uint64 cctpNonce = tokenMessengerOrigin.nextNonce();

        vm.expectCall(
            address(tokenMessengerOrigin),
            abi.encodeWithSelector(
                MockCircleTokenMessenger.depositForBurn.selector,
                amount,
                cctpDestination,
                user.addressToBytes32(),
                address(tokenOrigin)
            )
        );
        tbOrigin.transferRemote{value: quote[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );
    }

    function test_verify() public {
        Quote[] memory quote = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), quote[1].amount);

        uint64 cctpNonce = tokenMessengerOrigin.nextNonce();
        tbOrigin.transferRemote{value: quote[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );

        // Relayer role
        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);

        _expectOffChainLookUpRevert(message);
        tbDestination.getOffchainVerifyInfo(message);

        bytes memory cctpMessage = _encodeCctpMessage(
            cctpNonce,
            cctpOrigin,
            ""
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectCall(
            address(messageTransmitterDestination),
            abi.encodeWithSelector(
                MockCircleMessageTransmitter.receiveMessage.selector,
                cctpMessage,
                attestation
            )
        );
        assertEq(tbDestination.verify(metadata, message), true);
    }

    function test_verify_revertsWhen_invalidNonce() public {
        Quote[] memory quote = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), quote[1].amount);

        // invalid nonce := nextNonce + 1
        uint64 cctpNonce = tokenMessengerOrigin.nextNonce() + 1;
        tbOrigin.transferRemote{value: quote[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );
        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);

        bytes memory cctpMessage = _encodeCctpMessage(
            cctpNonce,
            cctpOrigin,
            ""
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid nonce"));
        tbDestination.verify(metadata, message);
    }

    function test_verify_revertsWhen_invalidSourceDomain() public {
        Quote[] memory quote = tbOrigin.quoteTransferRemote(
            destination,
            user.addressToBytes32(),
            amount
        );

        vm.startPrank(user);
        tokenOrigin.approve(address(tbOrigin), quote[1].amount);

        uint64 cctpNonce = tokenMessengerOrigin.nextNonce();
        tbOrigin.transferRemote{value: quote[0].amount}(
            destination,
            user.addressToBytes32(),
            amount
        );
        uint256 nonce = mailboxDestination.inboundProcessedNonce();
        bytes memory message = mailboxDestination.inboundMessages(nonce);

        // invalid source domain := destination
        bytes memory cctpMessage = _encodeCctpMessage(
            cctpNonce,
            cctpDestination,
            ""
        );
        bytes memory attestation = bytes("");
        bytes memory metadata = abi.encode(cctpMessage, attestation);

        vm.expectRevert(bytes("Invalid source domain"));
        tbDestination.verify(metadata, message);
    }

    function test_revertsWhen_versionIsNotSupported() public virtual {
        messageTransmitterOrigin.setVersion(CCTP_VERSION_1);
        MockCircleTokenMessengerV2 tokenMessengerV2 = new MockCircleTokenMessengerV2(
                tokenOrigin
            );

        vm.expectRevert(bytes("Invalid TokenMessenger CCTP version"));
        TokenBridgeCctp v1 = new TokenBridgeCctp(
            address(tokenOrigin),
            scale,
            address(mailboxOrigin),
            IMessageTransmitter(address(messageTransmitterOrigin)),
            ITokenMessenger(address(tokenMessengerV2))
        );

        messageTransmitterOrigin.setVersion(CCTP_VERSION_2);

        vm.expectRevert(bytes("Invalid messageTransmitter CCTP version"));
        v1 = new TokenBridgeCctp(
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
