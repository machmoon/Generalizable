from services.site_normalization import (
    normalize_site_code,
    site_country_label,
    split_site_codes,
)


def test_multi_country_sites_split_into_individual_codes():
    assert split_site_codes("DE; NL; CA; IL; FR; US; CN") == (
        "DE",
        "NL",
        "CA",
        "IL",
        "FR",
        "US",
        "CN",
    )
    assert split_site_codes("US; CA; US") == ("US", "CA")


def test_legacy_country_aliases_are_normalized():
    assert normalize_site_code("USA") == "US"
    assert normalize_site_code("GB") == "UK"
    assert split_site_codes("U.S.; GB") == ("US", "UK")


def test_country_codes_have_readable_labels():
    assert site_country_label("US") == "United States"
    assert site_country_label("CH") == "Switzerland"
    assert site_country_label("DE") == "Germany"
    assert site_country_label("CN") == "China"


def test_unknown_site_values_are_empty():
    assert split_site_codes(None) == ()
    assert split_site_codes("N/A") == ()
