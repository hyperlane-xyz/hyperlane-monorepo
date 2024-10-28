//! Modified from {https://github.com/nodeset-org/erc4626-cairo/blob/main/src/erc4626/erc4626.cairo}
#[starknet::interface]
pub trait IERC4626YieldSharing<TContractState> {
    fn set_fee(ref self: TContractState, new_fee: u256);
    fn get_claimable_fees(self: @TContractState) -> u256;
    fn scale(self: @TContractState) -> u256;
    fn accumulated_fees(self: @TContractState) -> u256;
    fn last_vault_balance(self: @TContractState) -> u256;
}

#[starknet::contract]
mod ERC4626YieldSharingMock {
    use contracts::libs::math;
    use core::integer::BoundedInt;
    use openzeppelin::access::ownable::{OwnableComponent};
    use openzeppelin::introspection::src5::SRC5Component;
    use openzeppelin::token::erc20::interface::{ERC20ABIDispatcher, ERC20ABIDispatcherTrait};
    use openzeppelin::token::erc20::{ERC20Component, ERC20HooksEmptyImpl};
    use starknet::{get_contract_address, get_caller_address, ContractAddress};
    use token::interfaces::ierc4626::{IERC4626, IERC4626Camel};

    component!(path: ERC20Component, storage: erc20, event: ERC20Event);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);

    impl ERC20MixinImpl = ERC20Component::ERC20MixinImpl<ContractState>;
    impl ERC20InternalImpl = ERC20Component::InternalImpl<ContractState>;
    #[abi(embed_v0)]
    impl OwnableImpl = OwnableComponent::OwnableImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;
    // E18
    const SCALE: u256 = 1_000_000_000_000_000_000;

    pub mod Errors {
        pub const EXCEEDED_MAX_DEPOSIT: felt252 = 'ERC4626: exceeded max deposit';
        pub const EXCEEDED_MAX_MINT: felt252 = 'ERC4626: exceeded max mint';
        pub const EXCEEDED_MAX_REDEEM: felt252 = 'ERC4626: exceeded max redeem';
        pub const EXCEEDED_MAX_WITHDRAW: felt252 = 'ERC4626: exceeded max withdraw';
    }

    #[storage]
    struct Storage {
        fee: u256,
        accumulated_fees: u256,
        last_vault_balance: u256,
        ERC4626_asset: ContractAddress,
        ERC4626_underlying_decimals: u8,
        ERC4626_offset: u8,
        #[substorage(v0)]
        erc20: ERC20Component::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Deposit: Deposit,
        Withdraw: Withdraw,
        #[flat]
        ERC20Event: ERC20Component::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event
    }

    #[derive(Drop, starknet::Event)]
    struct Deposit {
        #[key]
        sender: ContractAddress,
        #[key]
        owner: ContractAddress,
        assets: u256,
        shares: u256
    }

    #[derive(Drop, starknet::Event)]
    struct Withdraw {
        #[key]
        sender: ContractAddress,
        #[key]
        receiver: ContractAddress,
        #[key]
        owner: ContractAddress,
        assets: u256,
        shares: u256
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        asset: ContractAddress,
        name: ByteArray,
        symbol: ByteArray,
        initial_fee: u256
    ) {
        let dispatcher = ERC20ABIDispatcher { contract_address: asset };
        self.ERC4626_offset.write(0);
        let decimals = dispatcher.decimals();
        self.erc20.initializer(name, symbol);
        self.ERC4626_asset.write(asset);
        self.ERC4626_underlying_decimals.write(decimals);
        self.fee.write(initial_fee);
        self.ownable.initializer(get_caller_address());
    }

    #[abi(embed_v0)]
    pub impl ERC4626YieldSharingImpl of super::IERC4626YieldSharing<ContractState> {
        fn set_fee(ref self: ContractState, new_fee: u256) {
            self.ownable.assert_only_owner();
            self.fee.write(new_fee);
        }

        fn get_claimable_fees(self: @ContractState) -> u256 {
            let new_vault_balance = ERC20ABIDispatcher {
                contract_address: self.ERC4626_asset.read()
            }
                .balance_of(get_contract_address());
            let last_vault_balance = self.last_vault_balance.read();
            if new_vault_balance <= last_vault_balance {
                return self.accumulated_fees.read();
            }

            let new_yield = new_vault_balance - last_vault_balance;
            let new_fees = math::mul_div(new_yield, self.fee.read(), SCALE);

            self.accumulated_fees.read() + new_fees
        }

        fn scale(self: @ContractState) -> u256 {
            SCALE
        }
        fn accumulated_fees(self: @ContractState) -> u256 {
            self.accumulated_fees.read()
        }

        fn last_vault_balance(self: @ContractState) -> u256 {
            self.last_vault_balance.read()
        }
    }

    #[abi(embed_v0)]
    pub impl ERC4626Impl of IERC4626<ContractState> {
        fn name(self: @ContractState) -> ByteArray {
            self.erc20.name()
        }

        fn symbol(self: @ContractState) -> ByteArray {
            self.erc20.symbol()
        }

        fn decimals(self: @ContractState) -> u8 {
            self.ERC4626_underlying_decimals.read() + self.ERC4626_offset.read()
        }

        fn total_supply(self: @ContractState) -> u256 {
            self.erc20.total_supply()
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.erc20.balance_of(account)
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress
        ) -> u256 {
            self.erc20.allowance(owner, spender)
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            self.erc20.transfer(recipient, amount)
        }

        fn transfer_from(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256
        ) -> bool {
            self.erc20.transfer_from(sender, recipient, amount)
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            self.erc20.approve(spender, amount)
        }

        fn asset(self: @ContractState) -> ContractAddress {
            self.ERC4626_asset.read()
        }

        fn convert_to_assets(self: @ContractState, shares: u256) -> u256 {
            self._convert_to_assets(shares, false)
        }

        fn convert_to_shares(self: @ContractState, assets: u256) -> u256 {
            self._convert_to_shares(assets, false)
        }
        // Overriden
        fn deposit(ref self: ContractState, assets: u256, receiver: ContractAddress) -> u256 {
            let last_vault_balance = self.last_vault_balance.read();
            self.last_vault_balance.write(last_vault_balance + assets);
            let max_assets = self.max_deposit(receiver);
            assert(max_assets >= assets, Errors::EXCEEDED_MAX_DEPOSIT);

            let caller = get_caller_address();
            let shares = self.preview_deposit(assets);
            self._deposit(caller, receiver, assets, shares);

            shares
        }

        fn mint(ref self: ContractState, shares: u256, receiver: ContractAddress) -> u256 {
            let max_shares = self.max_mint(receiver);
            assert(max_shares >= shares, Errors::EXCEEDED_MAX_MINT);

            let caller = get_caller_address();
            let assets = self.preview_mint(shares);
            self._deposit(caller, receiver, assets, shares);

            assets
        }

        fn preview_deposit(self: @ContractState, assets: u256) -> u256 {
            self._convert_to_shares(assets, false)
        }

        fn preview_mint(self: @ContractState, shares: u256) -> u256 {
            self._convert_to_assets(shares, true)
        }

        fn preview_redeem(self: @ContractState, shares: u256) -> u256 {
            self._convert_to_assets(shares, false)
        }

        fn preview_withdraw(self: @ContractState, assets: u256) -> u256 {
            self._convert_to_shares(assets, true)
        }

        fn max_deposit(self: @ContractState, receiver: ContractAddress) -> u256 {
            BoundedInt::max()
        }

        fn max_mint(self: @ContractState, receiver: ContractAddress) -> u256 {
            BoundedInt::max()
        }

        fn max_redeem(self: @ContractState, owner: ContractAddress) -> u256 {
            self.erc20.balance_of(owner)
        }

        fn max_withdraw(self: @ContractState, owner: ContractAddress) -> u256 {
            let balance = self.erc20.balance_of(owner);
            let shares = self._convert_to_assets(balance, false);
            shares
        }
        // Overriden
        fn redeem(
            ref self: ContractState, shares: u256, receiver: ContractAddress, owner: ContractAddress
        ) -> u256 {
            self._accrue_yield();
            let max_shares = self.max_redeem(owner);
            assert(shares <= max_shares, Errors::EXCEEDED_MAX_REDEEM);

            let caller = get_caller_address();
            let assets = self.preview_redeem(shares);
            self._withdraw(caller, receiver, owner, assets, shares);
            assets
        }

        fn total_assets(self: @ContractState) -> u256 {
            let dispatcher = ERC20ABIDispatcher { contract_address: self.ERC4626_asset.read() };
            dispatcher.balance_of(get_contract_address()) - self.get_claimable_fees()
        }

        fn withdraw(
            ref self: ContractState, assets: u256, receiver: ContractAddress, owner: ContractAddress
        ) -> u256 {
            let max_assets = self.max_withdraw(owner);
            assert(assets <= max_assets, Errors::EXCEEDED_MAX_WITHDRAW);

            let caller = get_caller_address();
            let shares = self.preview_withdraw(assets);
            self._withdraw(caller, receiver, owner, assets, shares);

            shares
        }
    }

    #[abi(embed_v0)]
    pub impl ERC4626CamelImpl of IERC4626Camel<ContractState> {
        fn totalSupply(self: @ContractState) -> u256 {
            ERC4626Impl::total_supply(self)
        }
        fn balanceOf(self: @ContractState, account: ContractAddress) -> u256 {
            ERC4626Impl::balance_of(self, account)
        }
        fn transferFrom(
            ref self: ContractState,
            sender: ContractAddress,
            recipient: ContractAddress,
            amount: u256
        ) -> bool {
            ERC4626Impl::transfer_from(ref self, sender, recipient, amount)
        }

        fn convertToAssets(self: @ContractState, shares: u256) -> u256 {
            self._convert_to_assets(shares, false)
        }

        fn convertToShares(self: @ContractState, assets: u256) -> u256 {
            self._convert_to_shares(assets, false)
        }

        fn previewDeposit(self: @ContractState, assets: u256) -> u256 {
            self._convert_to_shares(assets, false)
        }

        fn previewMint(self: @ContractState, shares: u256) -> u256 {
            self._convert_to_assets(shares, true)
        }

        fn previewRedeem(self: @ContractState, shares: u256) -> u256 {
            self._convert_to_assets(shares, false)
        }

        fn previewWithdraw(self: @ContractState, assets: u256) -> u256 {
            self._convert_to_shares(assets, true)
        }

        fn totalAssets(self: @ContractState) -> u256 {
            self.total_assets()
        }

        fn maxDeposit(self: @ContractState, receiver: ContractAddress) -> u256 {
            BoundedInt::max()
        }

        fn maxMint(self: @ContractState, receiver: ContractAddress) -> u256 {
            BoundedInt::max()
        }

        fn maxRedeem(self: @ContractState, owner: ContractAddress) -> u256 {
            self.max_redeem(owner)
        }

        fn maxWithdraw(self: @ContractState, owner: ContractAddress) -> u256 {
            self.max_withdraw(owner)
        }
    }

    fn pow_256(self: u256, mut exponent: u8) -> u256 {
        if self == 0 {
            return 0;
        }
        let mut result = 1;
        let mut base = self;

        loop {
            if exponent & 1 == 1 {
                result = result * base;
            }

            exponent = exponent / 2;
            if exponent == 0 {
                break result;
            }

            base = base * base;
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn _accrue_yield(ref self: ContractState) {
            let new_vault_balance = ERC20ABIDispatcher {
                contract_address: self.ERC4626_asset.read()
            }
                .balance_of(get_contract_address());
            let last_vault_balance = self.last_vault_balance.read();
            if new_vault_balance > last_vault_balance {
                let new_yield = new_vault_balance - last_vault_balance;
                let new_fees = math::mul_div(new_yield, self.fee.read(), SCALE);
                let accumulated_fees = self.accumulated_fees.read();
                self.accumulated_fees.write(accumulated_fees + new_fees);
                self.last_vault_balance.write(new_vault_balance);
            }
        }

        fn _convert_to_assets(self: @ContractState, shares: u256, round: bool) -> u256 {
            let total_assets = ERC4626Impl::total_assets(self) + 1;
            let total_shares = ERC4626Impl::total_supply(self)
                + pow_256(10, self.ERC4626_offset.read());
            let assets = shares * total_assets / total_shares;
            if round && ((assets * total_shares) / total_assets < shares) {
                assets + 1
            } else {
                assets
            }
        }

        fn _convert_to_shares(self: @ContractState, assets: u256, round: bool) -> u256 {
            let total_assets = ERC4626Impl::total_assets(self) + 1;
            let total_shares = ERC4626Impl::total_supply(self)
                + pow_256(10, self.ERC4626_offset.read());
            let share = assets * total_shares / total_assets;
            if round && ((share * total_assets) / total_shares < assets) {
                share + 1
            } else {
                share
            }
        }

        fn _deposit(
            ref self: ContractState,
            caller: ContractAddress,
            receiver: ContractAddress,
            assets: u256,
            shares: u256
        ) {
            let dispatcher = ERC20ABIDispatcher { contract_address: self.ERC4626_asset.read() };
            dispatcher.transfer_from(caller, get_contract_address(), assets);
            self.erc20.mint(receiver, shares);
            self.emit(Deposit { sender: caller, owner: receiver, assets, shares });
        }

        fn _withdraw(
            ref self: ContractState,
            caller: ContractAddress,
            receiver: ContractAddress,
            owner: ContractAddress,
            assets: u256,
            shares: u256
        ) {
            if (caller != owner) {
                let allowance = self.erc20.allowance(owner, caller);
                if (allowance != BoundedInt::max()) {
                    assert(allowance >= shares, ERC20Component::Errors::APPROVE_FROM_ZERO);
                    self.erc20.ERC20_allowances.write((owner, caller), allowance - shares);
                }
            }

            self.erc20.burn(owner, shares);

            let dispatcher = ERC20ABIDispatcher { contract_address: self.ERC4626_asset.read() };
            dispatcher.transfer(receiver, assets);

            self.emit(Withdraw { sender: caller, receiver, owner, assets, shares });
        }

        fn _decimals_offset(self: @ContractState) -> u8 {
            self.ERC4626_offset.read()
        }
    }
}
