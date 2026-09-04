from datetime import datetime

from app import clock

ET = clock.zone()

WEEKLY = {"waiver_type": 2, "waiver_day_of_week": 2, "waiver_hour": 0, "waiver_clear_days": 2}  # Wednesday 00:00
DAILY = {"waiver_type": 2, "daily_waivers": 1, "daily_waivers_hour": 3, "waiver_clear_days": 1}


def test_weekly_waivers_land_on_the_configured_day():
    now = datetime(2026, 9, 6, 20, 0, tzinfo=ET)  # a Sunday evening
    runs = clock.next_runs(WEEKLY, now, count=2)
    assert [(r.weekday(), r.hour) for r in runs] == [(2, 0), (2, 0)]
    assert runs[0].date() == datetime(2026, 9, 9).date()  # the coming Wednesday
    assert (runs[1] - runs[0]).days == 7


def test_a_run_later_today_still_counts_but_one_already_past_does_not():
    just_before = datetime(2026, 9, 8, 23, 55, tzinfo=ET)
    assert clock.next_runs(WEEKLY, just_before)[0] == datetime(2026, 9, 9, 0, 0, tzinfo=ET)
    just_after = datetime(2026, 9, 9, 0, 5, tzinfo=ET)
    assert clock.next_runs(WEEKLY, just_after)[0] == datetime(2026, 9, 16, 0, 0, tzinfo=ET)


def test_daily_waivers_run_every_day_at_the_daily_hour():
    runs = clock.next_runs(DAILY, datetime(2026, 9, 6, 20, 0, tzinfo=ET), count=3)
    assert [r.hour for r in runs] == [3, 3, 3]
    assert [r.day for r in runs] == [7, 8, 9]


def test_daily_waiver_day_mask_is_honoured_when_it_decodes():
    masked = {**DAILY, "daily_waivers_days": 0b0000101}  # Monday and Wednesday
    runs = clock.next_runs(masked, datetime(2026, 9, 6, 20, 0, tzinfo=ET), count=3)
    assert [r.weekday() for r in runs] == [0, 2, 0]
    assert clock.run_days({**DAILY, "daily_waivers_days": 0}) == clock.ALL_DAYS


def test_a_league_without_a_waiver_day_has_no_scheduled_run():
    assert clock.next_runs({"waiver_type": 0}, datetime(2026, 9, 6, tzinfo=ET)) == []
    assert clock.describe({"waiver_type": 0}) == "No scheduled waiver run"


def test_a_dropped_player_clears_at_the_run_after_his_clear_days():
    # Dropped Sunday, 2 clear days -> eligible Tuesday, so he clears at Wednesday's run.
    dropped = datetime(2026, 9, 6, 16, 30, tzinfo=ET)
    assert clock.clears_at(dropped, WEEKLY) == datetime(2026, 9, 9, 0, 0, tzinfo=ET)
    # Dropped on Wednesday afternoon: the coming Wednesday is too soon, so he waits a week.
    assert clock.clears_at(datetime(2026, 9, 9, 14, 0, tzinfo=ET), WEEKLY) == datetime(2026, 9, 16, 0, 0, tzinfo=ET)
    # Daily waivers clear him the next morning.
    assert clock.clears_at(datetime(2026, 9, 6, 16, 30, tzinfo=ET), DAILY) == datetime(2026, 9, 8, 3, 0, tzinfo=ET)


def test_describe_reads_like_a_label():
    assert clock.describe(WEEKLY).startswith("Wed 00:00")
    assert "2d clear" in clock.describe(WEEKLY)
    assert clock.describe(DAILY).startswith("Daily 03:00")


def test_kickoffs_lock_a_team_once_its_game_starts():
    games = [
        {"week": 3, "date": "2026-09-24", "home": "DET", "away": "CHI", "status": "in_game"},
        {"week": 3, "date": "2026-09-27", "home": "KC", "away": "BUF", "status": "pre_game"},
        {"week": 4, "date": "2026-10-01", "home": "DET", "away": "GB", "status": "pre_game"},
    ]
    week3 = clock.kickoffs(games, 3)
    assert week3["DET"]["locked"] is True and week3["CHI"]["locked"] is True
    assert week3["KC"]["locked"] is False
    assert "GB" not in week3
    assert clock.first_kickoff(week3) == "2026-09-27"
    assert clock.first_kickoff({}) is None
