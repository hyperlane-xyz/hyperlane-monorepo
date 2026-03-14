"""Background scan scheduler using APScheduler.

Runs periodic scans in a background thread within the Flask process.
"""

import time
import threading
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger


_scheduler = None
_next_run_time = None


def _scan_job(config, scan_fn, scan_status, after_success=None):
    """Execute a scan, updating shared status dict."""
    global _next_run_time

    if scan_status["running"]:
        return  # Skip if already running

    scan_status["running"] = True
    scan_status["error"] = None
    start = time.time()

    try:
        class Args:
            no_competitors = False
            monorepo = None
        scan_fn(Args(), config)
        if after_success is not None:
            after_success(config, source_label="scheduled_scan")
        scan_status["last_scan_time"] = time.time()
        scan_status["last_scan_duration"] = round(time.time() - start, 1)

        # Post to Slack if configured
        try:
            from output.slack import post_scan_summary
            post_scan_summary(config=config)
        except Exception:
            pass  # Never let Slack failures break the scan cycle
    except Exception as e:
        scan_status["error"] = str(e)
    finally:
        scan_status["running"] = False

    # Update next run time
    if _scheduler:
        job = _scheduler.get_job("periodic_scan")
        if job and job.next_run_time:
            _next_run_time = job.next_run_time.timestamp()


def start_scheduler(config, scan_fn, scan_status, interval_minutes=15, after_success=None):
    """Start the background scheduler.

    Args:
        config: System config dict
        scan_fn: The cmd_scan function from main.py
        scan_status: Shared dict for tracking scan state
        interval_minutes: How often to scan (default 15)
    """
    global _scheduler, _next_run_time

    if _scheduler is not None:
        return  # Already running

    _scheduler = BackgroundScheduler(daemon=True)

    _scheduler.add_job(
        _scan_job,
        trigger=IntervalTrigger(minutes=interval_minutes),
        args=[config, scan_fn, scan_status, after_success],
        id="periodic_scan",
        name="Periodic fee data scan",
        max_instances=1,
        coalesce=True,
    )

    _scheduler.start()

    # Record next run time
    job = _scheduler.get_job("periodic_scan")
    if job and job.next_run_time:
        _next_run_time = job.next_run_time.timestamp()

    return _scheduler


def get_next_run_time():
    """Return next scheduled run as unix timestamp, or None."""
    global _next_run_time
    if _scheduler:
        job = _scheduler.get_job("periodic_scan")
        if job and job.next_run_time:
            _next_run_time = job.next_run_time.timestamp()
    return _next_run_time


def trigger_immediate_scan(config, scan_fn, scan_status, with_competitors=True, after_success=None):
    """Trigger an immediate scan in a background thread."""
    if scan_status["running"]:
        return False

    def _run():
        scan_status["running"] = True
        scan_status["error"] = None
        start = time.time()
        try:
            class Args:
                no_competitors = not with_competitors
                monorepo = None
            scan_fn(Args(), config)
            if after_success is not None:
                after_success(config, source_label="manual_trigger")
            scan_status["last_scan_time"] = time.time()
            scan_status["last_scan_duration"] = round(time.time() - start, 1)
        except Exception as e:
            scan_status["error"] = str(e)
        finally:
            scan_status["running"] = False

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    return True


def stop_scheduler():
    """Shutdown the scheduler."""
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
