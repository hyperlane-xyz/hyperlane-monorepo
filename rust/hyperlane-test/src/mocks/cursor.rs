#![allow(non_snake_case)]

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::SyncBlockRangeCursor;
use mockall::mock;
use std::future::Future;

mock! {
    pub SyncBlockRangeCursor {
        pub fn _next_range(&mut self) -> impl Future<Output=Result<(u32, u32)>> + Send {}

        pub fn _current_position(&self) -> u32 {}

        pub fn _backtrack(&mut self, start_from: u32) {}
    }
}

#[async_trait]
impl SyncBlockRangeCursor for MockSyncBlockRangeCursor {
    fn current_position(&self) -> u32 {
        self._current_position()
    }

    async fn next_range(&mut self) -> Result<(u32, u32)> {
        self._next_range().await
    }

    fn backtrack(&mut self, start_from: u32) {
        self._backtrack(start_from)
    }
}
