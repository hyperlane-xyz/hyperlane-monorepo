// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {DomainRoutingIsm} from "../../contracts/isms/routing/DomainRoutingIsm.sol";
import {DefaultFallbackRoutingIsm} from "../../contracts/isms/routing/DefaultFallbackRoutingIsm.sol";
import {DomainRoutingIsmFactory} from "../../contracts/isms/routing/DomainRoutingIsmFactory.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {MessageUtils, TestIsm} from "./IsmTestUtils.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";

contract DomainRoutingIsmTest is Test {
    address private constant NON_OWNER =
        0xCAfEcAfeCAfECaFeCaFecaFecaFECafECafeCaFe;
    DomainRoutingIsm internal ism;

    function setUp() public virtual {
        ism = new DomainRoutingIsm();
        ism.initialize(address(this));
    }

    function deployTestIsm(
        bytes32 requiredMetadata
    ) internal returns (TestIsm) {
        return new TestIsm(abi.encode(requiredMetadata));
    }

    function getMetadata(uint32 domain) internal view returns (bytes memory) {
        return TestIsm(address(ism.module(domain))).requiredMetadata();
    }

    function testSet(uint32 domain) public {
        TestIsm _ism = deployTestIsm(bytes32(0));
        ism.set(domain, _ism);
        assertEq(address(ism.module(domain)), address(_ism));
    }

    function buildIsmConfigs(
        uint32 domain,
        uint8 count
    ) internal returns (DomainRoutingIsm.IsmConfig[] memory) {
        vm.assume(
            uint256(domain) + uint256(count) <= uint256(type(uint32).max) + 1
        );
        DomainRoutingIsm.IsmConfig[]
            memory configs = new DomainRoutingIsm.IsmConfig[](count);
        for (uint32 i = 0; i < count; ++i) {
            configs[i] = DomainRoutingIsm.IsmConfig({
                domain: domain + i,
                ism: IInterchainSecurityModule(
                    address(deployTestIsm(bytes32(0)))
                )
            });
        }
        return configs;
    }

    function testSetIsms(uint32 domain, uint8 count) public {
        vm.assume(count > 0);
        DomainRoutingIsm.IsmConfig[] memory configs = buildIsmConfigs(
            domain,
            count
        );

        ism.setIsms(configs);
        for (uint256 i = 0; i < count; ++i) {
            assertEq(
                address(ism.module(configs[i].domain)),
                address(configs[i].ism)
            );
        }
    }

    function testSetIsmsNonOwner(uint32 domain) public {
        DomainRoutingIsm.IsmConfig[]
            memory configs = new DomainRoutingIsm.IsmConfig[](1);
        configs[0] = DomainRoutingIsm.IsmConfig({
            domain: domain,
            ism: IInterchainSecurityModule(address(0))
        });
        vm.prank(NON_OWNER);
        vm.expectRevert("Ownable: caller is not the owner");
        ism.setIsms(configs);
    }

    function testRemoveIsms(uint32 domain, uint8 count) public virtual {
        vm.assume(count > 0);
        DomainRoutingIsm.IsmConfig[] memory configs = buildIsmConfigs(
            domain,
            count
        );
        ism.setIsms(configs);

        uint32[] memory domains = new uint32[](count);
        for (uint256 i = 0; i < count; ++i) {
            domains[i] = configs[i].domain;
        }
        ism.removeIsms(domains);
        for (uint256 i = 0; i < count; ++i) {
            vm.expectRevert();
            ism.module(domains[i]);
        }
    }

    function testRemoveIsmsNonOwner(uint32 domain) public {
        uint32[] memory domains = new uint32[](1);
        domains[0] = domain;
        vm.prank(NON_OWNER);
        vm.expectRevert("Ownable: caller is not the owner");
        ism.removeIsms(domains);
    }

    function testRemove(uint32 domain) public virtual {
        vm.expectRevert();
        ism.remove(domain);

        TestIsm _ism = deployTestIsm(bytes32(0));
        ism.set(domain, _ism);
        ism.remove(domain);
    }

    function testSetManyViaFactory(uint8 count, uint32 domain) public {
        vm.assume(domain > count);
        DomainRoutingIsmFactory factory = new DomainRoutingIsmFactory();
        uint32[] memory _domains = new uint32[](count);
        IInterchainSecurityModule[]
            memory _isms = new IInterchainSecurityModule[](count);
        for (uint32 i = 0; i < count; ++i) {
            _domains[i] = domain - i;
            _isms[i] = deployTestIsm(bytes32(0));
        }
        ism = factory.deploy(address(this), _domains, _isms);
        for (uint256 i = 0; i < count; ++i) {
            assertEq(address(ism.module(_domains[i])), address(_isms[i]));
        }
    }

    function testSetNonOwner(
        uint32 domain,
        IInterchainSecurityModule _ism
    ) public {
        vm.prank(NON_OWNER);
        vm.expectRevert("Ownable: caller is not the owner");
        ism.set(domain, _ism);
    }

    function testVerify(uint32 domain, bytes32 seed) public {
        ism.set(domain, deployTestIsm(seed));

        bytes memory metadata = getMetadata(domain);
        uint256 gasBefore = gasleft();
        assertTrue(ism.verify(metadata, MessageUtils.build(domain)));
        uint256 gasAfter = gasleft();
        console.log("Overhead gas usage: %d", gasBefore - gasAfter);
    }

    function testVerifyNoIsm(uint32 domain, bytes32 seed) public virtual {
        vm.assume(domain > 0);
        ism.set(domain, deployTestIsm(seed));

        bytes memory metadata = getMetadata(domain);
        vm.expectRevert();
        ism.verify(metadata, MessageUtils.build(domain - 1));
    }

    function testRoute(uint32 domain, bytes32 seed) public {
        TestIsm testIsm = deployTestIsm(seed);
        ism.set(domain, testIsm);
        assertEq(
            address(ism.route(MessageUtils.build(domain))),
            address(testIsm)
        );
    }
}

contract DefaultFallbackRoutingIsmTest is DomainRoutingIsmTest {
    TestIsm defaultIsm;

    function setUp() public override {
        defaultIsm = deployTestIsm(bytes32(0));
        TestMailbox mailbox = new TestMailbox(1000);
        TestPostDispatchHook hook = new TestPostDispatchHook();
        mailbox.initialize(
            address(this),
            address(defaultIsm),
            address(hook),
            address(hook)
        );

        ism = new DefaultFallbackRoutingIsm(
            address(mailbox),
            address(this),
            new uint32[](0),
            new IInterchainSecurityModule[](0)
        );
    }

    function testConstructorReverts() public {
        vm.expectRevert("MailboxClient: invalid mailbox");
        new DefaultFallbackRoutingIsm(
            address(0),
            address(this),
            new uint32[](0),
            new IInterchainSecurityModule[](0)
        );
    }

    function testConstructorDisablesReinitialization() public {
        vm.expectRevert("Initializable: contract is already initialized");
        ism.initialize(address(this));
    }

    function testRemoveIsms(uint32 domain, uint8 count) public override {
        vm.assume(count > 0);
        DomainRoutingIsm.IsmConfig[] memory configs = buildIsmConfigs(
            domain,
            count
        );
        ism.setIsms(configs);

        uint32[] memory domains = new uint32[](count);
        for (uint256 i = 0; i < count; ++i) {
            domains[i] = configs[i].domain;
        }
        ism.removeIsms(domains);
        for (uint256 i = 0; i < count; ++i) {
            assertEq(address(ism.module(domains[i])), address(defaultIsm));
        }
    }

    function testVerifyNoIsm(uint32 domain, bytes32 seed) public override {
        vm.assume(domain > 0);
        ism.set(domain, deployTestIsm(seed));

        bytes memory metadata = getMetadata(domain);
        bytes memory message = MessageUtils.build(domain - 1);
        vm.expectCall(
            address(defaultIsm),
            abi.encodeCall(defaultIsm.verify, (metadata, message))
        );
        ism.verify(metadata, message);
    }
}
