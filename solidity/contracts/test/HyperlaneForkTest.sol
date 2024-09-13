// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IMailbox} from "../../contracts/interfaces/IMailbox.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";

import {Message} from "../../contracts/libs/Message.sol";

import {ForkTestMailbox} from "../../contracts/test/ForkTestMailbox.sol";

contract HyperlaneForkTest is Test {
    using stdJson for string;
    using Strings for string;

    using Message for bytes;

    mapping(uint32 originDomain => mapping(uint32 destinationDomain => uint32 inboundProcessedNonce))
        public inboundProcessedNonces;
    mapping(uint32 originDomain => mapping(uint32 destinationDomain => bytes[] messages))
        public messages;

    mapping(uint32 domain => uint256 forkId) public domain2fork;
    mapping(uint32 domain => address mailbox) public domain2mailbox;
    mapping(uint32 domain => address defaultIsm) public domain2ism;
    mapping(uint256 chainId => uint32 domain) public chain2domain;

    constructor() {
        string memory root = _registryUri();
        Vm.DirEntry[] memory entries = vm.readDir(
            string.concat(root, "/dist/chains")
        );
        for (uint256 i; i < entries.length; i++) {
            if (!entries[i].isDir) continue;

            string memory path = entries[i].path;
            string memory metadata = vm.readFile(
                string.concat(path, "/metadata.json")
            );
            if (!(metadata.readString(".protocol").equal("ethereum"))) {
                continue;
            }

            string memory addressesPath = string.concat(
                path,
                "/addresses.json"
            );
            if (!vm.isFile(addressesPath)) {
                continue;
            }
            string memory addresses = vm.readFile(addressesPath);

            uint32 domainId = uint32(metadata.readUint(".domainId"));
            address mailbox = addresses.readAddress(".mailbox");
            uint256 chainId = metadata.readUint(".chainId");

            domain2mailbox[domainId] = mailbox;
            chain2domain[chainId] = domainId;
        }
    }

    /// @notice This is the most likely location for the registry package, but inheriting contracts
    ///         may override if needed.
    function _registryUri() internal view virtual returns (string memory) {
        return
            string.concat(
                vm.projectRoot(),
                "/node_modules/@hyperlane-xyz/registry"
            );
    }

    function setUpMailbox(uint256 forkId) internal {
        vm.selectFork(forkId);
        address mailbox = domain2mailbox[chain2domain[block.chainid]];
        setUpMailbox(forkId, mailbox);
    }

    function setUpMailbox(uint256 forkId, address mailbox) internal {
        IMailbox _mailbox = IMailbox(mailbox);
        uint32 domain = _mailbox.localDomain();
        address defaultIsm = address(_mailbox.defaultIsm());

        domain2fork[domain] = forkId;
        domain2ism[domain] = defaultIsm;

        ForkTestMailbox _testMailbox = new ForkTestMailbox(
            domain,
            address(this)
        );
        vm.etch(mailbox, address(_testMailbox).code);
        vm.mockCall(
            defaultIsm,
            abi.encodeWithSelector(IInterchainSecurityModule.verify.selector),
            abi.encode(true)
        );
    }

    function addInboundMessage(bytes calldata message) external {
        messages[message.origin()][message.destination()].push(message);
    }

    function processNextInboundMessage(
        uint32 origin,
        uint32 destination
    ) public {
        uint256 nonce = inboundProcessedNonces[origin][destination];
        inboundProcessedNonces[origin][destination]++;
        this._process(messages[origin][destination][nonce]);
    }

    function _process(bytes calldata message) public {
        vm.selectFork(domain2fork[message.destination()]);
        IMailbox(domain2mailbox[message.destination()]).process("", message);
    }

    function mockDefaultIsm(uint32 domain, bool _verify) internal {
        vm.selectFork(domain2fork[domain]);
        mockIsm(domain2ism[domain], _verify);
    }

    function mockRecipientIsm(
        uint32 domain,
        ISpecifiesInterchainSecurityModule recipient,
        bool _verify
    ) internal {
        vm.selectFork(domain2fork[domain]);
        mockIsm(address(recipient.interchainSecurityModule()), _verify);
    }

    function mockIsm(address ism, bool _verify) internal {
        vm.mockCall(
            ism,
            abi.encodeWithSelector(IInterchainSecurityModule.verify.selector),
            abi.encode(_verify)
        );
    }
}
