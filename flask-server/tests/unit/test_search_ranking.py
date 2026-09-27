import math
from random import Random

import pandas as pd

from services.search_ranking import rank_quality_results, select_balanced_tumor_results


def _frame(rows):
    return pd.DataFrame(rows).set_index("id", drop=False)


def _row(
    case_id,
    *,
    tumor,
    voxels,
    spacing,
    sex,
    age,
    order,
    thumbnail_rank=0,
    ct_bytes=100,
):
    return {
        "id": case_id,
        "__tumor01": tumor,
        "__thumbnail_quality_rank": thumbnail_rank,
        "__ct_bytes": ct_bytes,
        "__voxel_count": voxels,
        "__spacing_volume": spacing,
        "__shape_sum": 50,
        "__spacing_sum": 2.0,
        "__case_sortkey": order,
        "__sex": sex,
        "__age": age,
    }


def test_quality_ranking_prioritizes_thumbnail_status_before_file_size():
    df = _frame([
        _row(
            "huge-distorted",
            tumor=1,
            voxels=1000,
            spacing=0.1,
            sex="F",
            age=40,
            order=1,
            thumbnail_rank=2,
            ct_bytes=10_000,
        ),
        _row(
            "small-undistorted",
            tumor=0,
            voxels=100,
            spacing=1.0,
            sex="F",
            age=40,
            order=2,
            thumbnail_rank=0,
            ct_bytes=100,
        ),
        _row(
            "unknown",
            tumor=0,
            voxels=500,
            spacing=0.5,
            sex="F",
            age=40,
            order=3,
            thumbnail_rank=1,
            ct_bytes=500,
        ),
    ])

    ranked = rank_quality_results(df, balance_sex=False, balance_age=False)

    assert ranked["id"].tolist() == [
        "small-undistorted",
        "unknown",
        "huge-distorted",
    ]


def test_quality_ranking_prioritizes_larger_ct_within_thumbnail_tier():
    df = _frame([
        _row("small", tumor=1, voxels=1000, spacing=0.2, sex="F", age=40, order=1, ct_bytes=100),
        _row("large", tumor=0, voxels=100, spacing=1.0, sex="F", age=40, order=2, ct_bytes=1000),
    ])

    ranked = rank_quality_results(df, balance_sex=False, balance_age=False)

    assert ranked["id"].tolist() == ["large", "small"]


def test_quality_ranking_falls_back_when_ct_size_is_missing():
    df = _frame([
        _row("lower-resolution", tumor=1, voxels=100, spacing=1.0, sex="F", age=40, order=1, ct_bytes=math.nan),
        _row("higher-resolution", tumor=0, voxels=1000, spacing=0.2, sex="F", age=40, order=2, ct_bytes=math.nan),
    ])

    ranked = rank_quality_results(df, balance_sex=False, balance_age=False)

    assert ranked["id"].tolist() == ["higher-resolution", "lower-resolution"]


def test_quality_ranking_balances_sex_and_age_inside_thumbnail_tier():
    df = _frame([
        _row("f40-1", tumor=1, voxels=1000, spacing=0.2, sex="F", age=44, order=1, ct_bytes=1000),
        _row("f40-2", tumor=1, voxels=990, spacing=0.2, sex="F", age=45, order=2, ct_bytes=990),
        _row("m60", tumor=1, voxels=980, spacing=0.2, sex="M", age=66, order=3, ct_bytes=980),
        _row("f20", tumor=1, voxels=970, spacing=0.2, sex="F", age=28, order=4, ct_bytes=970),
        _row("distorted-m20", tumor=0, voxels=5000, spacing=0.1, sex="M", age=20, order=5, thumbnail_rank=2, ct_bytes=5000),
    ])

    ranked = rank_quality_results(df)

    assert ranked["id"].tolist()[:3] == ["f40-1", "m60", "f20"]
    assert ranked["id"].tolist()[-1] == "distorted-m20"


def test_balanced_tumor_selection_returns_four_from_each_cohort():
    rows = []
    for index in range(6):
        rows.append(
            _row(
                f"tumor-{index}",
                tumor=1,
                voxels=1000 - index,
                spacing=0.2,
                sex="F",
                age=40,
                order=index,
                ct_bytes=2000 - index,
            )
        )
    for index in range(6):
        rows.append(
            _row(
                f"non-tumor-{index}",
                tumor=0,
                voxels=900 - index,
                spacing=0.3,
                sex="M",
                age=60,
                order=20 + index,
                ct_bytes=1000 - index,
            )
        )

    ranked = rank_quality_results(
        _frame(rows),
        balance_sex=False,
        balance_age=False,
    )
    selected = select_balanced_tumor_results(
        ranked,
        count=8,
        pool_size=12,
        rng=Random(7),
    )

    assert selected["__tumor01"].value_counts().to_dict() == {1: 4, 0: 4}
    assert selected["id"].is_unique


def test_balanced_tumor_selection_randomizes_the_display_arrangement():
    rows = [
        _row(f"tumor-{index}", tumor=1, voxels=100 - index, spacing=1.0, sex="F", age=40, order=index)
        for index in range(4)
    ]
    rows.extend(
        _row(f"non-tumor-{index}", tumor=0, voxels=90 - index, spacing=1.0, sex="M", age=50, order=10 + index)
        for index in range(4)
    )
    ranked = rank_quality_results(
        _frame(rows),
        balance_sex=False,
        balance_age=False,
    )

    first = select_balanced_tumor_results(
        ranked,
        count=8,
        pool_size=8,
        rng=Random(1),
    )
    second = select_balanced_tumor_results(
        ranked,
        count=8,
        pool_size=8,
        rng=Random(2),
    )

    assert first["id"].tolist() != second["id"].tolist()
    assert first["__tumor01"].value_counts().to_dict() == {1: 4, 0: 4}
    assert second["__tumor01"].value_counts().to_dict() == {1: 4, 0: 4}


def test_balanced_tumor_selection_returns_empty_when_quota_is_impossible():
    df = _frame([
        _row("tumor-1", tumor=1, voxels=100, spacing=1.0, sex="F", age=40, order=1, ct_bytes=100),
        _row("tumor-2", tumor=1, voxels=90, spacing=1.0, sex="F", age=41, order=2, ct_bytes=90),
        _row("tumor-3", tumor=1, voxels=80, spacing=1.0, sex="F", age=42, order=3, ct_bytes=80),
        _row("non-tumor", tumor=0, voxels=70, spacing=1.0, sex="M", age=70, order=4, ct_bytes=70),
    ])

    ranked = rank_quality_results(df, balance_sex=False, balance_age=False)
    selected = select_balanced_tumor_results(
        ranked,
        count=4,
        pool_size=4,
        rng=Random(7),
    )

    assert selected.empty
