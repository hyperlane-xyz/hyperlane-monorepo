#![allow(non_snake_case)]

use abacus_core::SyncBlockRangeCursor;
use async_trait::async_trait;
use eyre::Result;
use mockall::mock;

mock! {
    pub SyncBlockRangeCursor {
        pub fn _new(chunk_size: u32, initial_height: u32) -> Result<Self> {}

        pub fn _current_position(&self) -> u32 {}

        pub fn _next_range(&mut self) -> Result<(u32, u32)> {}

        pub fn _backtrack(&mut self, start_from: u32) {}
    }
}

#[async_trait]
impl SyncBlockRangeCursor for MockSyncBlockRangeCursor {
    fn current_position(&self) -> u32 {
        self._current_position()
    }

    async fn next_range(&mut self) -> Result<(u32, u32)> {
        self._next_range()
    }

    fn backtrack(&mut self, start_from: u32) {
        self._backtrack(start_from)
    }
}
