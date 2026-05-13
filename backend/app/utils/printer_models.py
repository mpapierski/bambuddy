"""Printer model normalization utilities.

Converts 3MF printer model names (e.g., "Bambu Lab X1 Carbon") to
normalized short names (e.g., "X1C") that match database storage.
"""

import re

# Map from 3MF printer_model strings to normalized short names
PRINTER_MODEL_MAP = {
    "Bambu Lab X1 Carbon": "X1C",
    "Bambu Lab X1": "X1",
    "Bambu Lab X1E": "X1E",
    "Bambu Lab P1S": "P1S",
    "Bambu Lab P1P": "P1P",
    "Bambu Lab P2S": "P2S",
    "Bambu Lab A1": "A1",
    "Bambu Lab A1 Mini": "A1 Mini",
    "Bambu Lab A1 mini": "A1 Mini",
    "Bambu Lab H2D": "H2D",
    "Bambu Lab H2D Pro": "H2D Pro",
    "Bambu Lab H2C": "H2C",
    "Bambu Lab H2S": "H2S",
    "Bambu Lab X2D": "X2D",
}

# Map from printer_model_id (internal codes in slice_info.config) to short names
# These are the codes Bambu Studio uses internally
PRINTER_MODEL_ID_MAP = {
    # X1 series
    "C11": "X1C",
    "C12": "X1",
    "C13": "X1E",
    # P1 series
    "P1P": "P1P",
    "P1S": "P1S",
    # P2 series
    "P2S": "P2S",
    # X2 series
    "N6": "X2D",
    # A1 series
    "A11": "A1",
    "A12": "A1 Mini",
    "N1": "A1",
    "N2S": "A1 Mini",
    "A04": "A1 Mini",
    # H2 series (Office/H series)
    "O1D": "H2D",
    "O1E": "H2D Pro",  # Some devices report O1E
    "O2D": "H2D Pro",  # Some devices report O2D
    "O1C": "H2C",
    "O1C2": "H2C",
    "O1S": "H2S",
}

DEVICE_KIND_ORDER = (
    "X1C",
    "X1",
    "X1E",
    "P1S",
    "P1P",
    "P2S",
    "A1",
    "A1 Mini",
    "H2D",
    "H2D Pro",
    "H2C",
    "H2S",
    "X2D",
)

_DEVICE_KIND_SORT = {name: idx for idx, name in enumerate(DEVICE_KIND_ORDER)}

# Keep longer / more specific aliases first so "A1 Mini" wins before "A1",
# and "X1 Carbon" wins before the generic "X1" token.
_DEVICE_ALIASES = (
    ("H2D Pro", ("H2DPRO", "H2D-PRO", "O1E", "O2D")),
    ("A1 Mini", ("A1MINI", "A1-MINI", "A1 MINI", "N2S", "A12", "A04")),
    ("X1C", ("X1CARBON", "X1 CARBON", "X1C", "C11")),
    ("X1E", ("X1E", "C13")),
    ("X2D", ("X2D", "N6")),
    ("H2C", ("H2C", "O1C2", "O1C")),
    ("H2S", ("H2S", "O1S")),
    ("H2D", ("H2D", "O1D")),
    ("P2S", ("P2S", "N7")),
    ("P1S", ("P1S",)),
    ("P1P", ("P1P",)),
    ("A1", ("A1", "N1", "A11")),
    ("X1", ("X1", "C12")),
)


# Rod/rail type classification for maintenance tasks.
# Carbon rods: X1, P1 series (CoreXY with carbon fiber rods)
# Steel rods: P2S, X2D series (hardened steel linear shafts)
# Linear rails: A1, H2 series (linear rail motion system)
# Values must be uppercase with spaces stripped for normalized comparison.
CARBON_ROD_MODELS = frozenset(
    [
        # Display names (uppercase, no spaces)
        "X1",
        "X1C",
        "X1E",
        "P1P",
        "P1S",
        # Internal codes
        "C11",  # X1C
        "C12",  # X1
        "C13",  # X1E
    ]
)

STEEL_ROD_MODELS = frozenset(
    [
        # Display names (uppercase, no spaces)
        "P2S",
        "X2D",
        # Internal codes
        "N7",  # P2S
        "N6",  # X2D
    ]
)

LINEAR_RAIL_MODELS = frozenset(
    [
        # Display names (uppercase, no spaces)
        "A1",
        "A1MINI",
        "H2D",
        "H2DPRO",
        "H2C",
        "H2S",
        # Internal codes
        "N1",  # A1
        "N2S",  # A1 Mini
        "A04",  # A1 Mini (alternate)
        "A11",  # A1
        "A12",  # A1 Mini
        "O1D",  # H2D
        "O1E",  # H2D Pro
        "O2D",  # H2D Pro (alternate)
        "O1C",  # H2C
        "O1C2",  # H2C (dual nozzle variant)
        "O1S",  # H2S
    ]
)


# Models with an ethernet port.
# X1, P1P, A1, A1 Mini do NOT have ethernet.
ETHERNET_MODELS = frozenset(
    [
        # Display names (uppercase, no spaces)
        "X1C",
        "X1E",
        "X2D",
        "P1S",
        "P2S",
        "H2D",
        "H2DPRO",
        "H2C",
        "H2S",
        # Internal codes
        "C11",  # X1C
        "C13",  # X1E
        "N6",  # X2D
        "P1S",  # P1S
        "O1D",  # H2D
        "O1E",  # H2D Pro
        "O2D",  # H2D Pro (alternate)
        "O1C",  # H2C
        "O1C2",  # H2C (dual nozzle variant)
        "O1S",  # H2S
    ]
)


def has_ethernet(model: str | None) -> bool:
    """Return True if the printer model has an ethernet port."""
    if not model:
        return False
    normalized = model.strip().upper().replace(" ", "").replace("-", "")
    return normalized in ETHERNET_MODELS


def get_rod_type(model: str | None) -> str | None:
    """Return the rod/rail type for a printer model.

    Returns:
        "carbon" for X1/P1 series (carbon fiber rods),
        "steel_rod" for P2S/X2D series (hardened steel rods),
        "linear_rail" for A1/H2 series (linear rails),
        None for unknown models.
    """
    if not model:
        return None
    normalized = model.strip().upper().replace(" ", "").replace("-", "")
    if normalized in CARBON_ROD_MODELS:
        return "carbon"
    if normalized in STEEL_ROD_MODELS:
        return "steel_rod"
    if normalized in LINEAR_RAIL_MODELS:
        return "linear_rail"
    return None


def normalize_printer_model_id(model_id: str | None) -> str | None:
    """Convert printer_model_id (internal code) to normalized short name.

    Args:
        model_id: The printer_model_id from slice_info.config (e.g., "C11", "O1D")

    Returns:
        Normalized short name (e.g., "X1C", "H2D") or the original ID if unknown.
    """
    if not model_id:
        return None

    # Check known mappings
    if model_id in PRINTER_MODEL_ID_MAP:
        return PRINTER_MODEL_ID_MAP[model_id]

    # Return original if unknown (might already be a short name)
    return model_id


def normalize_printer_model(raw_model: str | None) -> str | None:
    """Convert 3MF printer_model to normalized short name.

    Args:
        raw_model: The printer_model string from 3MF metadata
            (e.g., "Bambu Lab X1 Carbon")

    Returns:
        Normalized short name (e.g., "X1C") or None if input is empty.
        Unknown models have "Bambu Lab " prefix stripped.
    """
    if not raw_model:
        return None

    # Check known mappings first
    if raw_model in PRINTER_MODEL_MAP:
        return PRINTER_MODEL_MAP[raw_model]

    # Strip "Bambu Lab " prefix for unknown models
    stripped = raw_model.replace("Bambu Lab ", "").strip()
    return stripped or None


def _compact_model_token(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", value.upper())


def normalize_device_kind(raw_model: object) -> str | None:
    """Best-effort normalization to Bambuddy's short device kind.

    Unlike :func:`normalize_printer_model`, this accepts free-form preset
    names such as ``"0.20mm Standard @BBL X1C"`` or
    ``"Bambu Lab X1 Carbon 0.4 nozzle"`` and extracts the device token.
    """
    if not isinstance(raw_model, str) or not raw_model:
        return None

    direct = normalize_printer_model_id(raw_model)
    if direct in _DEVICE_KIND_SORT:
        return direct

    direct = normalize_printer_model(raw_model)
    if direct in _DEVICE_KIND_SORT:
        return direct

    compact = _compact_model_token(raw_model)
    if not compact:
        return None

    for canonical, aliases in _DEVICE_ALIASES:
        for alias in aliases:
            if _compact_model_token(alias) in compact:
                return canonical
    return None


def infer_device_kinds_from_strings(values: list[str | None] | tuple[str | None, ...]) -> list[str]:
    """Return unique normalized device kinds found in free-form strings."""
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        kind = normalize_device_kind(value)
        if kind and kind not in seen:
            seen.add(kind)
            out.append(kind)
    return sort_device_kinds(out)


def sort_device_kinds(values: list[str] | set[str] | tuple[str, ...]) -> list[str]:
    """Stable user-facing sort for device kind selectors."""
    return sorted(set(values), key=lambda v: (_DEVICE_KIND_SORT.get(v, 10_000), v))
