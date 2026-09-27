from services.manufacturer_normalization import canonicalize_manufacturer


def test_manufacturer_aliases_share_one_label():
    assert canonicalize_manufacturer("GE") == "GE Medical Systems"
    assert canonicalize_manufacturer("GE MEDICAL SYSTEMS") == "GE Medical Systems"
    assert canonicalize_manufacturer("Philips") == "Philips"
    assert canonicalize_manufacturer("Philips Medical Systems") == "Philips"


def test_manufacturer_labels_have_consistent_brand_casing():
    assert canonicalize_manufacturer("SIEMENS") == "Siemens"
    assert canonicalize_manufacturer("TOSHIBA") == "Toshiba"
    assert canonicalize_manufacturer("  philips   medical systems ") == "Philips"


def test_unknown_and_unmapped_values_are_safe():
    assert canonicalize_manufacturer(None) == ""
    assert canonicalize_manufacturer("nan") == ""
    assert canonicalize_manufacturer("Acme Imaging") == "Acme Imaging"
