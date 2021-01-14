use ethers_core::types::H256;
use std::{collections::VecDeque, io::Write};

use crate::{accumulator::*, *};

#[derive(Default, Debug, Clone)]
pub struct Waiting {
    queue: VecDeque<H256>,
    accumulator: IncrementalMerkle,
}

#[derive(Debug, Clone)]
pub struct Failed {
    queue: VecDeque<H256>,
    accumulator: IncrementalMerkle,
}

impl Waiting {
    pub fn queue(&self) -> &VecDeque<H256> {
        &self.queue
    }

    pub fn accumulator(&self) -> &IncrementalMerkle {
        &self.accumulator
    }
}

impl Failed {
    pub fn queue(&self) -> &VecDeque<H256> {
        &self.queue
    }

    pub fn accumulator(&self) -> &IncrementalMerkle {
        &self.accumulator
    }
}

fn format_message(
    origin: u32,
    sender: H256,
    destination: u32,
    recipient: H256,
    body: &[u8],
) -> Vec<u8> {
    let mut buf = vec![];
    buf.write_all(&origin.to_be_bytes()).unwrap();
    buf.write_all(sender.as_ref()).unwrap();
    buf.write_all(&destination.to_be_bytes()).unwrap();
    buf.write_all(recipient.as_ref()).unwrap();
    buf.write_all(&body).unwrap();
    buf
}

#[derive(Debug, Clone)]
pub struct Home<S> {
    origin: u32,
    updater: Address,
    current_root: H256,
    state: S,
}

impl<S> Home<S> {
    pub fn origin(&self) -> u32 {
        self.origin
    }

    pub fn updater(&self) -> Address {
        self.updater
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
}

impl From<Home<Waiting>> for Home<Failed> {
    fn from(h: Home<Waiting>) -> Self {
        Self {
            origin: h.origin,
            updater: h.updater,
            current_root: h.current_root,
            state: Failed {
                accumulator: h.state.accumulator,
                queue: h.state.queue,
            },
        }
    }
}

impl Home<Waiting> {
    pub fn init(origin: u32, updater: Address) -> Home<Waiting> {
        Self {
            origin,
            updater,
            current_root: Default::default(),
            state: Waiting::default(),
        }
    }

    pub fn enqueue(&mut self, sender: H256, destination: u32, recipient: H256, body: &[u8]) {
        let message = format_message(self.origin, sender, destination, recipient, body);
        let message_hash = keccak256(message);
        self.state.accumulator.ingest(message_hash);
        self.state.queue.push_back(self.state.accumulator.root());
    }

    fn _update(&mut self, update: &Update) -> Result<(), ()> {
        if update.previous_root != self.current_root {
            return Err(());
        }

        if self.state.queue.contains(&update.new_root) {
            loop {
                let item = self.state.queue.pop_front().unwrap();
                if item == update.new_root {
                    return Ok(());
                }
            }
        }

        Err(())
    }

    pub fn update(&mut self, update: &SignedUpdate) -> Result<(), ()> {
        self.check_sig(update)?;
        self._update(&update.update)
    }

    pub fn double_update(
        self,
        first: &SignedUpdate,
        second: &SignedUpdate,
    ) -> Result<Home<Failed>, Home<Waiting>> {
        if first == second || self.check_sig(first).is_err() || self.check_sig(second).is_err() {
            Err(self)
        } else {
            Ok(self.into())
        }
    }

    pub fn improper_update(self, update: &SignedUpdate) -> Result<Home<Failed>, Home<Waiting>> {
        if self.check_sig(update).is_err() || self.state.queue.contains(&update.update.new_root) {
            Err(self)
        } else {
            Ok(self.into())
        }
    }
}
