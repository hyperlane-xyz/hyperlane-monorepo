// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {TokenRouter} from "../contracts/token/libs/TokenRouter.sol";
import {Quote} from "../contracts/interfaces/ITokenBridge.sol";
import {TokenBridgeCctp} from "../contracts/token/TokenBridgeCctp.sol";
import {TokenBridgeCctpV1} from "../contracts/token/extensions/TokenBridgeCctpV1.sol";
import {TokenBridgeCctpV2} from "../contracts/token/extensions/TokenBridgeCctpV2.sol";
import {ITokenMessenger} from "../contracts/interfaces/cctp/ITokenMessenger.sol";
import {ITokenMessengerV2} from "../contracts/interfaces/cctp/ITokenMessengerV2.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IMessageTransmitter} from "../contracts/interfaces/cctp/IMessageTransmitter.sol";
import {CctpMessageV2} from "../contracts/libs/CctpMessageV2.sol";
import {TypedMemView} from "../contracts/libs/TypedMemView.sol";

import {console} from "forge-std/console.sol";

contract TokenBridgeCctpScript is Script {
    using TypeCasts for address;

    uint32 constant CCTP_VERSION_1 = 0;
    uint32 constant CCTP_VERSION_2 = 1;

    uint256 ORIGIN = vm.envUint("DOMAIN_ORIGIN");
    uint256 DESTINATION = vm.envUint("DOMAIN_DESTINATION");
    uint256 CCTP_ORIGIN = vm.envUint("DOMAIN_CCTP_ORIGIN");
    uint256 CCTP_DESTINATION = vm.envUint("DOMAIN_CCTP_DESTINATION");

    uint256 REMOTE_GAS_LIMIT = 200_000;

    uint32 origin = uint32(ORIGIN);
    uint32 destination = uint32(DESTINATION);
    uint32 cctpOrigin = uint32(CCTP_ORIGIN);
    uint32 cctpDestination = uint32(CCTP_DESTINATION);

    address mailboxOrigin = vm.envAddress("MAILBOX_ORIGIN");
    address mailboxDestination = vm.envAddress("MAILBOX_DESTINATION");

    address igpOrigin = vm.envAddress("IGP_ORIGIN");
    address igpDestination = vm.envAddress("IGP_DESTINATION");

    address tokenOrigin = vm.envAddress("TOKEN_ORIGIN");
    address tokenMessengerOrigin = vm.envAddress("TOKEN_MESSENGER_ORIGIN");
    address messageTransmitterOrigin =
        vm.envAddress("MESSAGE_TRANSMITTER_ORIGIN");

    address tokenDestination = vm.envAddress("TOKEN_DESTINATION");
    address tokenMessengerDestination =
        vm.envAddress("TOKEN_MESSENGER_DESTINATION");
    address messageTransmitterDestination =
        vm.envAddress("MESSAGE_TRANSMITTER_DESTINATION");

    string[] urls = vm.envString("CCIP_READ_URLS", ",");

    error UnsupportedVersion(uint32 version);

    function enrollCctpRouter(
        address payable vtb,
        uint32 domain,
        address router
    ) public {
        vm.startBroadcast();
        TokenRouter(vtb).enrollRemoteRouter(domain, router.addressToBytes32());
    }

    function transferRemoteCctp(
        address _vtb,
        uint32 domain,
        address recipient,
        uint256 amount
    ) public {
        vm.startBroadcast();
        TokenBridgeCctp vtb = TokenBridgeCctp(_vtb);
        Quote[] memory quote = vtb.quoteTransferRemote(
            domain,
            recipient.addressToBytes32(),
            amount
        );

        require(quote.length > 0, "Invalid quote length");

        IERC20 token = vtb.wrappedToken();
        token.approve(_vtb, amount);

        vtb.transferRemote{value: quote[0].amount}(
            domain,
            recipient.addressToBytes32(),
            amount
        );
    }

    function addDomain(
        address _tokenBridge,
        uint32 hypDomain,
        uint32 cctpDomain
    ) public {
        vm.startBroadcast();
        TokenBridgeCctp tokenBridge = TokenBridgeCctp(_tokenBridge);
        tokenBridge.addDomain(hypDomain, cctpDomain);
    }

    function deployOrigin(address vtbRemote) public {
        vm.startBroadcast();
        uint256 scale = 1;
        uint32 version = ITokenMessenger(tokenMessengerOrigin)
            .messageBodyVersion();

        TokenBridgeCctp vtb;
        if (version == CCTP_VERSION_1) {
            vtb = TokenBridgeCctp(
                address(
                    new TokenBridgeCctpV1(
                        tokenOrigin,
                        scale,
                        mailboxOrigin,
                        IMessageTransmitter(messageTransmitterOrigin),
                        ITokenMessenger(tokenMessengerOrigin),
                        urls
                    )
                )
            );
        } else if (version == CCTP_VERSION_2) {
            vtb = TokenBridgeCctp(
                address(
                    new TokenBridgeCctpV2(
                        tokenOrigin,
                        scale,
                        mailboxOrigin,
                        IMessageTransmitter(messageTransmitterOrigin),
                        ITokenMessengerV2(tokenMessengerOrigin),
                        urls
                    )
                )
            );
        } else {
            revert UnsupportedVersion(version);
        }

        vtb.setUrls(urls);
        vtb.addDomain(destination, cctpDestination);
        vtb.setDestinationGas(destination, REMOTE_GAS_LIMIT);
        vtb.enrollRemoteRouter(destination, vtbRemote.addressToBytes32());

        console.log("vtb  @", address(vtb));
    }

    function deployDestination() public {
        vm.startBroadcast();
        uint256 scale = 1;
        uint32 version = ITokenMessenger(tokenMessengerOrigin)
            .messageBodyVersion();

        TokenBridgeCctp vtb;
        if (version == CCTP_VERSION_1) {
            vtb = TokenBridgeCctp(
                address(
                    new TokenBridgeCctpV1(
                        tokenDestination,
                        scale,
                        mailboxDestination,
                        IMessageTransmitter(messageTransmitterDestination),
                        ITokenMessenger(tokenMessengerDestination),
                        urls
                    )
                )
            );
        } else if (version == CCTP_VERSION_2) {
            vtb = TokenBridgeCctp(
                address(
                    new TokenBridgeCctpV2(
                        tokenDestination,
                        scale,
                        mailboxDestination,
                        IMessageTransmitter(messageTransmitterDestination),
                        ITokenMessengerV2(tokenMessengerDestination),
                        urls
                    )
                )
            );
        } else {
            revert UnsupportedVersion(version);
        }

        vtb.setUrls(urls);
        vtb.addDomain(origin, cctpOrigin);
        vtb.setDestinationGas(origin, REMOTE_GAS_LIMIT);

        console.log("vtb @", address(vtb));
        console.log(
            "(Reminder: enroll the remote router after calling deployOrigin())"
        );
    }
}
