use tokio::task::JoinHandle;
use tokio_metrics::TaskMonitor;

use hyperlane_core::HyperlaneDomain;

use super::dymension_metadata::PendingMessageMetadataGetter;
use hyperlane_base::kas_hack::logic_loop::Foo;

use super::Relayer;

impl Relayer {
    pub(crate) fn launch_dymension_kaspa_tasks(
        &self,
        origin: &HyperlaneDomain,
        tasks: &mut Vec<JoinHandle<()>>,
        task_monitor: TaskMonitor,
    ) {
        // we do not run IGP or merkle insertion or merkle tree building, we do not run dispatch indexer
        // we run our own loop for dispatch polling

        let kas_db = self.dbs.get(origin).unwrap();

        let kas_provider = self.kas_provider.clone().unwrap();

        let metadata_getter = PendingMessageMetadataGetter::new();

        let hub_mailbox = self.dym_mailbox.clone().unwrap();

        let foo = Foo::new(
            origin.clone(),
            kas_db.clone().to_owned(),
            kas_provider,
            hub_mailbox,
            metadata_getter,
        );

        tasks.push(foo.run(task_monitor.clone()));

        // it observes the local db and makes sure messages are eventually written to the destination chain
        tasks.push(self.run_message_processor(origin, send_channels.clone(), task_monitor.clone()));
        continue;
    }
}
