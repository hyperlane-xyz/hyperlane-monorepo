use super::*;

#[tokio::test(start_paused = true)]
async fn raw_dispatch_scan_advances_only_after_a_full_page() {
    let started_at = Instant::now();
    let mut scan =
        Scan::new(10, 250, started_at).expect("frontier beyond the cursor should start a scan");
    let full_page = PageResult {
        candidate_count: BATCH_SIZE as usize,
        next_after_id: 110,
        ..Default::default()
    };

    assert!(!scan.complete_page(&full_page, started_at));
    assert_eq!(scan.after_id, 110);
    assert_eq!(scan.next_page_at, instant_after(started_at, PAGE_DELAY));

    let final_page = PageResult {
        candidate_count: 0,
        ..Default::default()
    };
    assert!(scan.complete_page(&final_page, scan.next_page_at));
    assert_eq!(scan.through_id, 250);
}

#[tokio::test(start_paused = true)]
async fn raw_dispatch_scan_uses_an_immutable_frontier() {
    let now = Instant::now();

    assert!(Scan::new(50, 50, now).is_none());
    let scan = Scan::new(50, 75, now).expect("new rows beyond the watermark should start a scan");
    assert_eq!(scan.after_id, 50);
    assert_eq!(scan.through_id, 75);
}

#[tokio::test(start_paused = true)]
async fn failed_lane_stays_backed_off_after_global_cooldown() {
    let failure_at = Instant::now();
    let global_retry_at = instant_after(failure_at, RPC_RETRY_SLEEP_DURATION);
    let lane_retry_at = failed_lane_retry_at(failure_at);

    tokio::time::advance(RPC_RETRY_SLEEP_DURATION).await;
    let next_wake = Instant::now();

    assert_eq!(next_wake, global_retry_at);
    assert!(lane_retry_at > next_wake);
}

#[tokio::test(start_paused = true)]
async fn near_head_discovery_keeps_its_short_interval_after_empty_and_complete_pages() {
    let now = Instant::now();
    let mut schedule = Schedule::new(0, now, now);
    schedule.start_discovery(0, now);
    assert_eq!(schedule.discovery_delay(now), Duration::from_secs(30));
    schedule.start_discovery(10, now);
    let scan = schedule.discovery_scan.unwrap();
    schedule.complete_discovery_page(scan, &PageResult::default(), now);
    assert_eq!(schedule.discovery_delay(now), Duration::from_secs(30));
}

#[tokio::test(start_paused = true)]
async fn multi_page_full_sweep_yields_to_overdue_discovery() {
    let started_at = Instant::now();
    let mut schedule = Schedule::new(0, started_at, started_at);
    tokio::time::advance(DISCOVERY_INTERVAL).await;
    let now = Instant::now();

    schedule.start_full_sweep(200, now);
    let sweep = schedule
        .full_sweep
        .expect("full sweep should own scan slot");
    let full_page = PageResult {
        candidate_count: BATCH_SIZE as usize,
        next_after_id: 100,
        ..Default::default()
    };
    schedule.complete_full_sweep_page(sweep, &full_page, now);

    assert_eq!(schedule.discovery_delay(now), Duration::ZERO);
    assert!(schedule.discovery_slot_available());
    schedule.start_discovery(250, now);
    assert_eq!(schedule.discovery_scan.map(|scan| scan.after_id), Some(100));
    assert!(schedule.full_sweep.is_some());
    assert_eq!(schedule.full_sweep_delay(now), Duration::MAX);

    let discovery = schedule
        .discovery_scan
        .expect("discovery should preempt the parked sweep");
    let discovery_page = PageResult {
        candidate_count: BATCH_SIZE as usize,
        next_after_id: 150,
        ..Default::default()
    };
    schedule.complete_discovery_page(discovery, &discovery_page, now);
    assert_eq!(schedule.discovery_delay(now), PAGE_DELAY);
    assert_eq!(schedule.full_sweep_delay(now), Duration::MAX);

    let discovery = schedule
        .discovery_scan
        .expect("second discovery page should remain active");
    let discovery_ready_at = discovery.next_page_at;
    schedule.complete_discovery_page(discovery, &PageResult::default(), discovery_ready_at);
    assert_eq!(
        schedule.full_sweep_delay(discovery_ready_at),
        Duration::ZERO
    );
}

#[tokio::test(start_paused = true)]
async fn overdue_successor_sweep_starts_without_an_extra_interval() {
    let started_at = Instant::now();
    let mut schedule = Schedule::new(0, started_at, started_at);

    schedule.start_full_sweep(200, started_at);
    let sweep = schedule
        .full_sweep
        .expect("full sweep should own scan slot");

    tokio::time::advance(FULL_SWEEP_INTERVAL + Duration::from_secs(1)).await;
    let completed_at = Instant::now();
    schedule.complete_full_sweep_page(sweep, &PageResult::default(), completed_at);

    assert!(schedule.full_sweep.is_none());
    assert_eq!(schedule.full_sweep_delay(completed_at), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn reconciliation_schedule_preserves_progress_and_yields_failed_lanes() {
    let started_at = Instant::now();
    let mut schedule = Schedule::new(50, started_at, started_at);

    schedule.defer_retry_lane(started_at);
    tokio::time::advance(RPC_RETRY_SLEEP_DURATION).await;
    let after_global_cooldown = Instant::now();
    assert!(schedule.retry_not_before > after_global_cooldown);

    schedule.start_full_sweep(100, after_global_cooldown);
    assert!(!schedule.scan_slot_available());
    assert!(schedule.discovery_scan.is_none());
    let sweep = schedule.full_sweep.expect("sweep should be active");

    schedule.defer_sweep_page(sweep, after_global_cooldown);
    let deferred = schedule
        .full_sweep
        .expect("failed sweep should retain its cursor");
    assert_eq!(deferred.after_id, sweep.after_id);
    assert_eq!(deferred.through_id, sweep.through_id);

    let final_page = PageResult::default();
    schedule.complete_full_sweep_page(deferred, &final_page, deferred.next_page_at);
    assert!(schedule.full_sweep.is_none());
    assert_eq!(schedule.discovery_watermark, 100);
    assert!(schedule.scan_slot_available());
}
