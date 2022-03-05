/*
  async checkGovernance(domain: types.Domain): Promise<void> {
    expect(deploy.contracts.governanceRouter).to.not.be.undefined;

    // governanceRouter for each remote domain is registered
    const registeredRouters = await Promise.all(
      Object.keys(deploy.contracts.inboxes).map((_) =>
        deploy.contracts.governanceRouter.proxy.routers(_),
      ),
    );
    registeredRouters.map((_) =>
      expect(_).to.not.equal(ethers.constants.AddressZero),
    );

    // governor is set on governor chain, empty on others
    const localDomain = await deploy.contracts.outbox.proxy.localDomain();
    const governor = await deploy.contracts.governanceRouter.proxy.governor();
    if (localDomain === this._deploys[0].chain.domain) {
      expect(governor).to.not.equal(ethers.constants.AddressZero);
    } else {
      expect(governor).to.equal(ethers.constants.AddressZero);
    }

    const owners = [
      deploy.contracts.validatorManager.owner(),
      deploy.contracts.xAppConnectionManager.owner(),
      deploy.contracts.upgradeBeaconController.owner(),
      deploy.contracts.outbox.proxy.owner(),
    ];
    Object.values(deploy.contracts.inboxes).map((_) =>
      owners.push(_.proxy.owner()),
    );

    const expectedOwner = deploy.contracts.governanceRouter.address;
    const actualOwners = await Promise.all(owners);
    actualOwners.map((_) => expect(_).to.equal(expectedOwner));
  }

*/
