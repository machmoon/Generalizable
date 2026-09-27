import pandas as pd
from flask import Flask

import api.api_blueprint as api_routes
from api.api_blueprint import (
    _exclude_recent_cases,
    _has_both_tumor_cohorts,
    _has_tumor_capacity,
)


def _frame():
    return pd.DataFrame([
        {"__case_str": "PanTS_00000001", "__tumor01": 1},
        {"__case_str": "PanTS_00000002", "__tumor01": 0},
        {"__case_str": "PanTS_00000003", "__tumor01": 1},
        {"__case_str": "PanTS_00000004", "__tumor01": 0},
    ])


def test_has_both_tumor_cohorts_ignores_unknown_values():
    frame = _frame()
    frame.loc[len(frame)] = {"__case_str": "PanTS_00000005", "__tumor01": None}

    assert _has_both_tumor_cohorts(frame)


def test_tumor_capacity_requires_the_full_requested_quota():
    frame = pd.concat([_frame(), pd.DataFrame([
        {"__case_str": "PanTS_00000005", "__tumor01": 1},
        {"__case_str": "PanTS_00000006", "__tumor01": 0},
        {"__case_str": "PanTS_00000007", "__tumor01": 1},
        {"__case_str": "PanTS_00000008", "__tumor01": 0},
    ])], ignore_index=True)

    assert _has_tumor_capacity(frame, 8)
    assert not _has_tumor_capacity(frame.iloc[:-1], 8)


def test_recent_exclusion_keeps_enough_balanced_candidates():
    filtered, used = _exclude_recent_cases(
        _frame(),
        ["PanTS_00000001", "PanTS_00000002"],
        minimum=2,
    )

    assert filtered["__case_str"].tolist() == [
        "PanTS_00000003",
        "PanTS_00000004",
    ]
    assert used == 2


def test_recent_exclusion_relaxes_when_it_would_remove_one_cohort():
    filtered, used = _exclude_recent_cases(
        _frame().iloc[:3],
        ["PanTS_00000002"],
        minimum=2,
    )

    assert _has_both_tumor_cohorts(filtered)
    assert used == 0


def test_recent_exclusion_relaxes_until_four_of_each_cohort_remain():
    frame = pd.DataFrame([
        {"__case_str": f"PanTS_1{index:07d}", "__tumor01": 1}
        for index in range(5)
    ] + [
        {"__case_str": f"PanTS_0{index:07d}", "__tumor01": 0}
        for index in range(5)
    ])
    filtered, used = _exclude_recent_cases(
        frame,
        ["PanTS_10000000", "PanTS_10000001"],
        minimum=8,
    )

    assert _has_tumor_capacity(filtered, 8)
    assert used == 1


def test_random_endpoint_keeps_even_windows_tumor_balanced(monkeypatch):
    rows = []
    for cohort in (1, 0):
        for index in range(20):
            rows.append({
                "__case_str": f"PanTS_{cohort}{index:07d}",
                "__tumor01": cohort,
                "__thumbnail_quality_rank": 0,
                "__ct_bytes": 10_000 - index,
                "__voxel_count": 1_000 - index,
                "__spacing_volume": 1.0,
                "__shape_sum": 100.0,
                "__spacing_sum": 3.0,
                "__case_sortkey": cohort * 100 + index,
                "__complete": True,
                "__sex": "F" if index % 2 else "M",
                "__age": 30 + index,
                "_orig_cols": {},
            })

    monkeypatch.setattr(api_routes, "DF", pd.DataFrame(rows))
    monkeypatch.setattr(api_routes, "DF_CV", None)
    app = Flask(__name__)

    for offset in range(20):
        with app.test_request_context(
            f"/random?n=8&k=20&scope=all&offset={offset}"
        ):
            response = api_routes.api_random_topk_rotate_norand()
            tumors = [item["tumor"] for item in response.get_json()["items"]]

        assert tumors.count(1) == 4
        assert tumors.count(0) == 4
