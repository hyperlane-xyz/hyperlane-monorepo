use crate::SignedUpdate;
use ethers_core::types::{Address, H256, U256};

#[derive(Debug, Clone, Copy, Default)]
pub struct Waiting {
    root: H256,
}

#[derive(Debug, Clone, Copy)]
pub struct Pending {
    root: H256,
    new_root: H256,
    timeout: U256,
}

#[derive(Debug, Clone, Copy)]
pub struct Failed {}

#[derive(Debug, Clone, Copy, Default)]
pub struct Replica<S> {
    origin: u32,
    local: u32,
    updater: Address,
    optimistic_wait: U256,
    state: S,
}

impl<S> Replica<S> {
    pub fn origin(&self) -> u32 {
        self.origin
    }

    pub fn local(&self) -> u32 {
        self.local
    }

    pub fn updater(&self) -> Address {
        self.updater
    }

    pub fn wait(&self) -> U256 {
        self.optimistic_wait
    }

    pub fn state(&self) -> &S {
        &self.state
    }

    fn check_sig(&self, update: &SignedUpdate) -> Result<(), ()> {
        let signer = update.recover()?;
        if signer == self.updater {
            Ok(())
        } else {
            Err(())
        }
    }

    pub fn double_update(
        self,
        first: &SignedUpdate,
        second: &SignedUpdate,
    ) -> Result<Replica<Failed>, Self> {
        if first == second || self.check_sig(first).is_err() || self.check_sig(second).is_err() {
            Err(self)
        } else {
            Ok(Replica {
                origin: self.origin,
                local: self.local,
                updater: self.updater,
                optimistic_wait: self.optimistic_wait,
                state: Failed {},
            })
        }
    }
}

impl Replica<Waiting> {
    pub fn init(origin: u32, local: u32, updater: Address, optimistic_wait: U256) -> Self {
        Self {
            origin,
            local,
            updater,
            optimistic_wait,
            state: Waiting::default(),
        }
    }

    pub fn update(
        self,
        update: &SignedUpdate,
        now: impl FnOnce() -> U256,
    ) -> Result<Replica<Pending>, Replica<Waiting>> {
        if self.check_sig(update).is_err() {
            return Err(self);
        }

        Ok(Replica {
            origin: self.origin,
            local: self.local,
            updater: self.updater,
            optimistic_wait: self.optimistic_wait,
            state: Pending {
                root: self.state.root,
                new_root: update.update.new_root,
                timeout: now() + self.optimistic_wait,
            },
        })
    }
}

impl Replica<Pending> {
    pub fn confirm_update(self, now: impl FnOnce() -> U256) -> Result<Replica<Waiting>, Self> {
        if self.state.timeout < now() {
            return Err(self);
        }

        Ok(Replica {
            origin: self.origin,
            local: self.local,
            updater: self.updater,
            optimistic_wait: self.optimistic_wait,
            state: Waiting {
                root: self.state.new_root,
            },
        })
    }
}
