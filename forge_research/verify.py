"""Deterministic constraint extraction and Lean 4 kernel verification."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

from .bom import format_minor_currency
from .models import (
    CostBreakdown,
    DeviceSpecification,
    ObligationResult,
    Part,
    ProofStatus,
    VerificationReport,
    VerificationStatus,
)

RULES_PATH = Path(__file__).resolve().parents[1] / "lean" / "ForgeVerify" / "Rules.lean"
ALLOWED_AXIOMS = frozenset({"propext", "Classical.choice", "Quot.sound"})
FORBIDDEN_TOKENS = ("sorry", "admit", "axiom ", "unsafe ", "native_decide", "implemented_by")
_AXIOM_RE = re.compile(r"^'([^']+)'\s+(?:does not depend on any axioms|depends on axioms:\s*\[([^\]]*)\])")
_VERIFY_CACHE: OrderedDict[str, tuple[str | None, str, list[ObligationResult]]] = OrderedDict()
_LEAN_VERSION_CACHE: dict[str, str] = {}


@dataclass(frozen=True)
class _ObligationSpec:
    id: str
    title: str
    category: str
    proposition: str | None
    inputs: dict[str, object]
    pass_summary: str
    fail_summary: str
    unverified_summary: str | None = None
    sources: tuple[str, ...] = ()


def find_lean_binary() -> str | None:
    configured = os.getenv("FORGE_LEAN_BIN", "").strip()
    if configured:
        return configured if Path(configured).is_file() else shutil.which(configured)
    found = shutil.which("lean")
    if found:
        return found
    elan_default = Path.home() / ".elan" / "bin" / "lean"
    return str(elan_default) if elan_default.is_file() else None


def _lean_str(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _lean_str_list(values: list[str]) -> str:
    return "[" + ", ".join(_lean_str(v) for v in values) + "]"


def _lean_nat_list(values: list[int]) -> str:
    return "[" + ", ".join(str(int(v)) for v in values) + "]"


def _lean_bool(value: bool) -> str:
    return "true" if value else "false"


def _ensure_rules_compiled(lean_bin: str) -> tuple[Path, str]:
    if not RULES_PATH.is_file():
        raise RuntimeError(f"Missing Lean rulebook at {RULES_PATH}")
    rules_bytes = RULES_PATH.read_bytes()
    digest = hashlib.sha256(rules_bytes).hexdigest()
    cache_root = Path(tempfile.gettempdir()).resolve() / f"forge-lean-rules-{digest[:12]}"
    olean_path = cache_root / "ForgeVerify" / "Rules.olean"
    if not olean_path.is_file():
        (cache_root / "ForgeVerify").mkdir(parents=True, exist_ok=True)
        local_rules = cache_root / "ForgeVerify" / "Rules.lean"
        local_rules.write_bytes(rules_bytes)
        proc = subprocess.run(
            [lean_bin, "-o", str(olean_path), str(local_rules)],
            cwd=str(cache_root),
            capture_output=True,
            text=True,
            timeout=20,
        )
        if proc.returncode != 0:
            raise RuntimeError(f"Failed to compile ForgeVerify/Rules.lean: {proc.stderr or proc.stdout}")
    return cache_root, digest


def _get_lean_version(lean_bin: str) -> str:
    if lean_bin not in _LEAN_VERSION_CACHE:
        proc = subprocess.run(
            [lean_bin, "--version"], capture_output=True, text=True, timeout=5, check=False
        )
        first = (proc.stdout or "").splitlines()
        _LEAN_VERSION_CACHE[lean_bin] = first[0].strip() if first else "Lean 4"
    return _LEAN_VERSION_CACHE[lean_bin]


def _describe_pin_failure(
    spec: DeviceSpecification, ctrl: Part, required_analog: int
) -> str:
    reasons: list[str] = []
    analog = spec.wiring.signal_pins
    led = spec.wiring.status_led_pin
    wifi_active = spec.requirements.transport == "wifi"
    if len(analog) != required_analog:
        reasons.append(
            f"Design has {required_analog} EMG sensor channel(s) but {len(analog)} analog pin(s) bound ({analog})."
        )
    for pin in dict.fromkeys(analog):
        if pin in ctrl.reserved_pins:
            reasons.append(f"{pin} is reserved for internal board/flash interface on {ctrl.sku}.")
        elif pin in ctrl.board_restricted_adc_pins:
            reasons.append(
                f"{pin} cannot be used for oneshot ADC on {ctrl.sku} (external auto-flash strapping circuit)."
            )
        elif pin not in ctrl.adc_pins:
            reasons.append(f"{pin} is not an ADC-capable pin on {ctrl.sku}.")
        elif wifi_active and pin in ctrl.adc_wifi_conflict_pins:
            reasons.append(
                f"{pin} is on ESP32 ADC2, which conflicts with active Wi-Fi radio driver."
            )
    if led:
        if led in ctrl.reserved_pins:
            reasons.append(f"Status LED pin {led} is reserved on {ctrl.sku}.")
        elif led in ctrl.input_only_pins:
            reasons.append(f"Status LED pin {led} is input-only (GPI) on {ctrl.sku} and cannot drive outputs.")
        elif led not in ctrl.digital_pins:
            reasons.append(f"Status LED pin {led} is not a valid digital GPIO on {ctrl.sku}.")
    all_pins = [*analog, *([led] if led else [])]
    if len(all_pins) != len(set(all_pins)):
        reasons.append(f"Duplicate GPIO assignment detected across signals: {all_pins}.")
    return " ".join(reasons) or f"Pin configuration violates {ctrl.sku} GPIO capability constraints."


def _extract_obligations(
    spec: DeviceSpecification,
    catalog_snapshot: dict[str, Part],
    cost: CostBreakdown,
) -> list[_ObligationSpec]:
    controllers = [c for c in spec.components if c.role == "controller"]
    sensors = [c for c in spec.components if c.role == "emg_sensor"]
    ctrl_inst = controllers[0] if controllers else None
    sens_inst = sensors[0] if sensors else None
    ctrl = catalog_snapshot.get(ctrl_inst.catalog_id) if ctrl_inst else None
    sens = catalog_snapshot.get(sens_inst.catalog_id) if sens_inst else None
    sensor_qty = sens_inst.quantity if sens_inst else 1

    if ctrl is None or sens is None:
        return [
            _ObligationSpec(
                id="core_components_present",
                title="Core controller and sensor evidence",
                category="connectivity",
                proposition=None,
                inputs={},
                pass_summary="",
                fail_summary="",
                unverified_summary="Missing sourced controller or EMG sensor in specification.",
            )
        ]

    both_sources = tuple(
        dict.fromkeys([*(str(u) for u in ctrl.technical_sources), *(str(u) for u in sens.technical_sources)])
    )
    ctrl_sources = tuple(str(u) for u in ctrl.technical_sources)
    rail_mv = spec.wiring.supply_rail_mv
    obligations: list[_ObligationSpec] = []

    # 1. Sensor operating voltage range
    if ctrl.available_rails_mv and sens.supply_range_mv is not None:
        s_min, s_max = sens.supply_range_mv
        prop = (
            f"ForgeVerify.sensorSupplySafe {rail_mv} {s_min} {s_max} "
            f"{_lean_nat_list(ctrl.available_rails_mv)}"
        )
        obligations.append(
            _ObligationSpec(
                id="sensor_supply_voltage",
                title="Sensor operating supply range",
                category="voltage",
                proposition=prop,
                inputs={
                    "supply_rail_mv": rail_mv,
                    "board_available_rails_mv": ctrl.available_rails_mv,
                    "sensor_supply_range_mv": list(sens.supply_range_mv),
                },
                pass_summary=(
                    f"Selected {rail_mv} mV rail is available on {ctrl.sku} and within "
                    f"{sens.sku} rated supply [{s_min}, {s_max}] mV."
                ),
                fail_summary=(
                    f"Supply rail {rail_mv} mV is either unavailable on {ctrl.sku} "
                    f"({ctrl.available_rails_mv} mV) or outside {sens.sku} rated [{s_min}, {s_max}] mV."
                ),
                sources=both_sources,
            )
        )
    else:
        obligations.append(
            _ObligationSpec(
                id="sensor_supply_voltage",
                title="Sensor operating supply range",
                category="voltage",
                proposition=None,
                inputs={"supply_rail_mv": rail_mv},
                pass_summary="",
                fail_summary="",
                unverified_summary="Missing sourced board rails or sensor supply voltage bounds.",
                sources=both_sources,
            )
        )

    # 2. ADC input voltage ceiling
    if ctrl.adc_max_mv is not None and sens.output_scales_with_supply is True:
        sig_max = rail_mv
        prop = f"ForgeVerify.adcInputSafe {sig_max} {ctrl.adc_max_mv}"
        obligations.append(
            _ObligationSpec(
                id="adc_input_voltage",
                title="ADC input overvoltage safety",
                category="voltage",
                proposition=prop,
                inputs={
                    "sensor_output_max_mv": sig_max,
                    "controller_adc_max_mv": ctrl.adc_max_mv,
                    "ratiometric_to_supply": True,
                },
                pass_summary=(
                    f"{sens.sku} analog output (0–{sig_max} mV) stays within "
                    f"{ctrl.sku} {ctrl.adc_max_mv} mV ADC input ceiling."
                ),
                fail_summary=(
                    f"Overvoltage hazard: {sens.sku} powered at {sig_max} mV drives ENV up to "
                    f"{sig_max} mV, exceeding {ctrl.sku} {ctrl.adc_max_mv} mV ADC input limit."
                ),
                sources=both_sources,
            )
        )
    else:
        obligations.append(
            _ObligationSpec(
                id="adc_input_voltage",
                title="ADC input overvoltage safety",
                category="voltage",
                proposition=None,
                inputs={"supply_rail_mv": rail_mv, "controller_adc_max_mv": ctrl.adc_max_mv},
                pass_summary="",
                fail_summary="",
                unverified_summary="Missing sourced ADC input ceiling or sensor output voltage law.",
                sources=both_sources,
            )
        )

    # 3. GPIO capability, board restrictions, Wi-Fi ADC2 contention & disjointness
    if ctrl.adc_pins and ctrl.digital_pins:
        wifi_active = spec.requirements.transport == "wifi"
        dig_pins = [spec.wiring.status_led_pin] if spec.wiring.status_led_pin else []
        prop = (
            f"ForgeVerify.pinsValidAndDisjoint {sensor_qty} "
            f"{_lean_str_list(spec.wiring.signal_pins)} {_lean_str_list(dig_pins)} "
            f"{_lean_bool(wifi_active)} {_lean_str_list(ctrl.adc_pins)} "
            f"{_lean_str_list(ctrl.digital_pins)} {_lean_str_list(ctrl.adc_wifi_conflict_pins)} "
            f"{_lean_str_list(ctrl.board_restricted_adc_pins)} "
            f"{_lean_str_list(ctrl.input_only_pins)} {_lean_str_list(ctrl.reserved_pins)}"
        )
        pin_desc = ", ".join(spec.wiring.signal_pins)
        led_desc = f", LED={spec.wiring.status_led_pin}" if spec.wiring.status_led_pin else ""
        obligations.append(
            _ObligationSpec(
                id="gpio_pin_assignments",
                title="GPIO capability & pin conflict check",
                category="gpio",
                proposition=prop,
                inputs={
                    "required_analog_channels": sensor_qty,
                    "signal_pins": spec.wiring.signal_pins,
                    "status_led_pin": spec.wiring.status_led_pin,
                    "wifi_active": wifi_active,
                },
                pass_summary=(
                    f"Pin bindings ({pin_desc}{led_desc}) are valid, unreserved, and pairwise disjoint "
                    f"on {ctrl.sku} (transport={spec.requirements.transport})."
                ),
                fail_summary=_describe_pin_failure(spec, ctrl, sensor_qty),
                sources=ctrl_sources,
            )
        )
    else:
        obligations.append(
            _ObligationSpec(
                id="gpio_pin_assignments",
                title="GPIO capability & pin conflict check",
                category="gpio",
                proposition=None,
                inputs={"signal_pins": spec.wiring.signal_pins},
                pass_summary="",
                fail_summary="",
                unverified_summary=f"Missing complete GPIO/ADC pin table for {ctrl.sku}.",
                sources=ctrl_sources,
            )
        )

    # 4. Rail current limit (honestly unverified when datasheet current specs are absent)
    if ctrl.rail_max_current_ma is not None and sens.max_current_ma is not None:
        total_ma = sens.max_current_ma * sensor_qty
        prop = f"ForgeVerify.railCurrentSafe {total_ma} {ctrl.rail_max_current_ma}"
        obligations.append(
            _ObligationSpec(
                id="rail_current_budget",
                title="Power rail current limit",
                category="power",
                proposition=prop,
                inputs={
                    "sensor_total_current_ma": total_ma,
                    "controller_rail_max_current_ma": ctrl.rail_max_current_ma,
                },
                pass_summary=(
                    f"Sensor load ({total_ma} mA) is within {ctrl.sku} rail limit "
                    f"({ctrl.rail_max_current_ma} mA)."
                ),
                fail_summary=(
                    f"Sensor load ({total_ma} mA) exceeds {ctrl.sku} rail limit "
                    f"({ctrl.rail_max_current_ma} mA)."
                ),
                sources=both_sources,
            )
        )
    else:
        missing = []
        if ctrl.rail_max_current_ma is None:
            missing.append(f"{ctrl.sku}.rail_max_current_ma")
        if sens.max_current_ma is None:
            missing.append(f"{sens.sku}.max_current_ma")
        obligations.append(
            _ObligationSpec(
                id="rail_current_budget",
                title="Power rail current limit",
                category="power",
                proposition=None,
                inputs={"missing_fields": missing, "sensor_quantity": sensor_qty},
                pass_summary="",
                fail_summary="",
                unverified_summary=(
                    f"Unverified: missing sourced current ratings ({', '.join(missing)}). "
                    "FORGE never invents electrical current limits."
                ),
                sources=both_sources,
            )
        )

    # 5. Transport protocol support
    req_transport = spec.requirements.transport
    if req_transport in ("unspecified", "other"):
        obligations.append(
            _ObligationSpec(
                id="wireless_transport_support",
                title="Requested connectivity support",
                category="connectivity",
                proposition=None,
                inputs={"requested_transport": req_transport, "controller_transports": ctrl.transports},
                pass_summary="",
                fail_summary="",
                unverified_summary=f"Connectivity '{req_transport}' is not specific enough to formally verify.",
                sources=ctrl_sources,
            )
        )
    else:
        prop = (
            f"ForgeVerify.transportSupported {_lean_str(req_transport)} "
            f"{_lean_str_list(list(ctrl.transports))}"
        )
        obligations.append(
            _ObligationSpec(
                id="wireless_transport_support",
                title="Requested connectivity support",
                category="connectivity",
                proposition=prop,
                inputs={"requested_transport": req_transport, "controller_transports": ctrl.transports},
                pass_summary=f"{ctrl.sku} natively supports requested '{req_transport}' connectivity.",
                fail_summary=(
                    f"{ctrl.sku} supports [{', '.join(ctrl.transports)}], which does not satisfy "
                    f"requested '{req_transport}' transport."
                ),
                sources=ctrl_sources,
            )
        )

    # 6. Core hardware budget constraint
    cap = cost.budget_usd_cents
    excl = cost.budget_exclusive
    known = cost.known_subtotal_usd_cents
    quote_sources = tuple(
        item.selected_offer.url
        if item.pricing_source == "merchant_offer" and item.selected_offer
        else item.catalog_url
        for item in cost.line_items
        if (item.pricing_source == "merchant_offer" and item.selected_offer) or item.catalog_url
    )
    if cap is None:
        obligations.append(
            _ObligationSpec(
                id="core_parts_budget",
                title="Known hardware budget cap",
                category="budget",
                proposition=None,
                inputs={"known_subtotal_usd_cents": known, "budget_usd_cents": None},
                pass_summary="",
                fail_summary="",
                unverified_summary="No USD budget cap set; cost constraint not applicable.",
                sources=quote_sources,
            )
        )
    elif cost.has_unpriced_items and not (known > cap or (excl and known == cap)):
        obligations.append(
            _ObligationSpec(
                id="core_parts_budget",
                title="Known hardware budget cap",
                category="budget",
                proposition=None,
                inputs={
                    "known_subtotal_usd_cents": known,
                    "budget_usd_cents": cap,
                    "unpriced_parts": cost.unpriced_catalog_ids,
                },
                pass_summary="",
                fail_summary="",
                unverified_summary=(
                    f"Incomplete pricing: {', '.join(cost.unpriced_catalog_ids)} has no verified USD price "
                    f"(known items total {format_minor_currency(known, 'USD')} vs "
                    f"{'<' if excl else '≤'} {format_minor_currency(cap, 'USD')})."
                ),
                sources=quote_sources,
            )
        )
    else:
        prop = f"ForgeVerify.budgetSatisfied {known} {cap} {_lean_bool(excl)}"
        op_str = "under" if excl else "at most"
        obligations.append(
            _ObligationSpec(
                id="core_parts_budget",
                title="Known hardware budget cap",
                category="budget",
                proposition=prop,
                inputs={
                    "known_subtotal_usd_cents": known,
                    "budget_usd_cents": cap,
                    "budget_exclusive": excl,
                    "has_unpriced_items": cost.has_unpriced_items,
                },
                pass_summary=(
                    f"Known BOM subtotal ({format_minor_currency(known, 'USD')}) is {op_str} "
                    f"{format_minor_currency(cap, 'USD')} cap (shipping, tax & electrodes excluded)."
                ),
                fail_summary=(
                    f"Known BOM subtotal ({format_minor_currency(known, 'USD')}) violates "
                    f"{op_str} {format_minor_currency(cap, 'USD')} cap by "
                    f"{format_minor_currency(max(0, known - cap + (1 if excl and known == cap else 0)), 'USD')}."
                ),
                sources=quote_sources,
            )
        )

    return obligations


def _build_lean_file(
    items: list[_ObligationSpec], negated: bool = False
) -> tuple[str, dict[str, tuple[int, int, str]]]:
    lines = ["import ForgeVerify.Rules", ""]
    spans: dict[str, tuple[int, int, str]] = {}
    for ob in items:
        assert ob.proposition is not None
        suffix = "_refuted" if negated else ""
        thm_name = f"ob_{ob.id}{suffix}"
        goal = f"¬ ({ob.proposition})" if negated else ob.proposition
        thm_line = f"theorem {thm_name} : {goal} := by decide"
        ax_line = f"#print axioms {thm_name}"
        start_line = len(lines) + 1
        lines.append(thm_line)
        lines.append(ax_line)
        end_line = len(lines)
        lines.append("")
        spans[ob.id] = (start_line, end_line, thm_line)
    source = "\n".join(lines)
    for token in FORBIDDEN_TOKENS:
        if token in source:
            raise ValueError(f"Generated Lean obligation contains forbidden token '{token}'.")
    return source, spans


def _run_lean_batch(
    lean_bin: str,
    cache_root: Path,
    items: list[_ObligationSpec],
    *,
    negated: bool,
) -> tuple[str, dict[str, tuple[bool, list[str], str | None]]]:
    source, spans = _build_lean_file(items, negated=negated)
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".lean", dir=str(cache_root), delete=False, encoding="utf-8"
    ) as handle:
        handle.write(source)
        check_path = Path(handle.name)

    try:
        env = {**os.environ, "LEAN_PATH": str(cache_root)}
        proc = subprocess.run(
            [lean_bin, "--json", str(check_path)],
            cwd=str(cache_root),
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    finally:
        check_path.unlink(missing_ok=True)

    messages: list[dict] = []
    for raw in (proc.stdout or "").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            messages.append(json.loads(raw))
        except json.JSONDecodeError:
            continue

    outcomes: dict[str, tuple[bool, list[str], str | None]] = {}
    for ob in items:
        start_l, end_l, _ = spans[ob.id]
        suffix = "_refuted" if negated else ""
        expected_thm = f"ob_{ob.id}{suffix}"
        errors: list[str] = []
        axioms: list[str] | None = None

        for msg in messages:
            pos_line = (msg.get("pos") or {}).get("line", 0)
            if not (start_l <= pos_line <= end_l):
                continue
            sev = msg.get("severity")
            data = str(msg.get("data") or "").strip()
            if sev in ("error", "warning"):
                errors.append(data)
            elif sev == "information":
                match = _AXIOM_RE.match(data)
                if match and match.group(1) == expected_thm:
                    raw_ax = match.group(2)
                    axioms = (
                        [a.strip() for a in raw_ax.split(",") if a.strip()]
                        if raw_ax
                        else []
                    )

        disallowed = [a for a in (axioms or []) if a not in ALLOWED_AXIOMS]
        if disallowed:
            errors.append(f"Disallowed axioms used: {disallowed}")
        proved = (not errors) and (axioms is not None)
        diag = "; ".join(errors) if errors else None
        outcomes[ob.id] = (proved, axioms or [], diag)

    return source, outcomes


def verify_design_sync(
    revision: int,
    spec: DeviceSpecification,
    catalog_snapshot: dict[str, Part],
    cost: CostBreakdown,
    *,
    use_cache: bool = True,
) -> VerificationReport:
    extracted = _extract_obligations(spec, catalog_snapshot, cost)
    checkable = [ob for ob in extracted if ob.proposition is not None]
    lean_bin = find_lean_binary()

    if not checkable:
        results = [
            ObligationResult(
                id=ob.id,
                title=ob.title,
                category=ob.category,  # type: ignore[arg-type]
                status="unverified",
                summary=ob.unverified_summary or "Insufficient sourced evidence.",
                inputs=ob.inputs,
                sources=list(ob.sources),
            )
            for ob in extracted
        ]
        return _finalize_report(revision, results, lean_version=None, lean_source=None)

    if lean_bin is None:
        results = []
        for ob in extracted:
            if ob.proposition is None:
                results.append(
                    ObligationResult(
                        id=ob.id,
                        title=ob.title,
                        category=ob.category,  # type: ignore[arg-type]
                        status="unverified",
                        summary=ob.unverified_summary or "Insufficient sourced evidence.",
                        inputs=ob.inputs,
                        sources=list(ob.sources),
                    )
                )
            else:
                results.append(
                    ObligationResult(
                        id=ob.id,
                        title=ob.title,
                        category=ob.category,  # type: ignore[arg-type]
                        status="error",
                        summary="Lean 4 kernel binary is not installed or configured on the server.",
                        inputs=ob.inputs,
                        lean_proposition=ob.proposition,
                        diagnostic="lean binary unavailable",
                        sources=list(ob.sources),
                    )
                )
        return _finalize_report(revision, results, lean_version=None, lean_source=None)

    try:
        cache_root, rules_digest = _ensure_rules_compiled(lean_bin)
        lean_version = _get_lean_version(lean_bin)
        cache_key = hashlib.sha256(
            json.dumps(
                {
                    "rules": rules_digest,
                    "ver": lean_version,
                    "obs": [
                        (
                            ob.id,
                            ob.proposition,
                            ob.pass_summary,
                            ob.fail_summary,
                            ob.unverified_summary,
                            ob.inputs,
                        )
                        for ob in extracted
                    ],
                },
                sort_keys=True,
                default=str,
            ).encode()
        ).hexdigest()

        if use_cache and cache_key in _VERIFY_CACHE:
            cached_ver, cached_src, cached_obs = _VERIFY_CACHE[cache_key]
            _VERIFY_CACHE.move_to_end(cache_key)
            return _finalize_report(
                revision,
                [item.model_copy(deep=True) for item in cached_obs],
                lean_version=cached_ver,
                lean_source=cached_src,
            )

        pos_source, pos_outcomes = _run_lean_batch(lean_bin, cache_root, checkable, negated=False)
        unresolved = [ob for ob in checkable if not pos_outcomes[ob.id][0]]
        neg_source = ""
        neg_outcomes: dict[str, tuple[bool, list[str], str | None]] = {}
        if unresolved:
            neg_source, neg_outcomes = _run_lean_batch(
                lean_bin, cache_root, unresolved, negated=True
            )

        combined_source = pos_source
        if neg_source:
            combined_source = (
                pos_source
                + "\n-- Formal refutation pass for violated constraints --\n"
                + "\n".join(neg_source.splitlines()[2:])
            )

        results: list[ObligationResult] = []
        for ob in extracted:
            if ob.proposition is None:
                results.append(
                    ObligationResult(
                        id=ob.id,
                        title=ob.title,
                        category=ob.category,  # type: ignore[arg-type]
                        status="unverified",
                        summary=ob.unverified_summary or "Insufficient sourced evidence.",
                        inputs=ob.inputs,
                        sources=list(ob.sources),
                    )
                )
                continue

            proved_pos, pos_axioms, pos_diag = pos_outcomes[ob.id]
            if proved_pos:
                results.append(
                    ObligationResult(
                        id=ob.id,
                        title=ob.title,
                        category=ob.category,  # type: ignore[arg-type]
                        status="verified",
                        summary=ob.pass_summary,
                        inputs=ob.inputs,
                        lean_theorem=f"theorem ob_{ob.id} : {ob.proposition} := by decide",
                        lean_proposition=ob.proposition,
                        axioms_used=pos_axioms,
                        diagnostic="Kernel proof checked (0 sorry).",
                        sources=list(ob.sources),
                    )
                )
                continue

            proved_neg, neg_axioms, neg_diag = neg_outcomes.get(ob.id, (False, [], None))
            if proved_neg:
                results.append(
                    ObligationResult(
                        id=ob.id,
                        title=ob.title,
                        category=ob.category,  # type: ignore[arg-type]
                        status="failed",
                        summary=ob.fail_summary,
                        inputs=ob.inputs,
                        lean_theorem=f"theorem ob_{ob.id}_refuted : ¬ ({ob.proposition}) := by decide",
                        lean_proposition=f"¬ ({ob.proposition})",
                        axioms_used=neg_axioms,
                        diagnostic="Constraint violation formally proved by Lean 4 kernel.",
                        sources=list(ob.sources),
                    )
                )
            else:
                results.append(
                    ObligationResult(
                        id=ob.id,
                        title=ob.title,
                        category=ob.category,  # type: ignore[arg-type]
                        status="error",
                        summary="Lean 4 kernel could not establish proof or refutation.",
                        inputs=ob.inputs,
                        lean_proposition=ob.proposition,
                        diagnostic=neg_diag or pos_diag or "Lean kernel check failed.",
                        sources=list(ob.sources),
                    )
                )

        if use_cache:
            _VERIFY_CACHE[cache_key] = (
                lean_version,
                combined_source,
                [item.model_copy(deep=True) for item in results],
            )
            if len(_VERIFY_CACHE) > 64:
                _VERIFY_CACHE.popitem(last=False)

        return _finalize_report(
            revision, results, lean_version=lean_version, lean_source=combined_source
        )
    except Exception as error:
        results = [
            ObligationResult(
                id=ob.id,
                title=ob.title,
                category=ob.category,  # type: ignore[arg-type]
                status="unverified" if ob.proposition is None else "error",
                summary=(
                    ob.unverified_summary or "Insufficient sourced evidence."
                    if ob.proposition is None
                    else f"Verification infrastructure error: {error}"
                ),
                inputs=ob.inputs,
                lean_proposition=ob.proposition,
                diagnostic=str(error) if ob.proposition is not None else None,
                sources=list(ob.sources),
            )
            for ob in extracted
        ]
        return _finalize_report(revision, results, lean_version=None, lean_source=None)


async def verify_design(
    revision: int,
    spec: DeviceSpecification,
    catalog_snapshot: dict[str, Part],
    cost: CostBreakdown,
    *,
    use_cache: bool = True,
) -> VerificationReport:
    return await asyncio.to_thread(
        verify_design_sync, revision, spec, catalog_snapshot, cost, use_cache=use_cache
    )


def _finalize_report(
    revision: int,
    obligations: list[ObligationResult],
    *,
    lean_version: str | None,
    lean_source: str | None,
) -> VerificationReport:
    counts: dict[ProofStatus, int] = {"verified": 0, "failed": 0, "unverified": 0, "error": 0}
    for ob in obligations:
        counts[ob.status] += 1
    status: VerificationStatus
    if counts["error"] > 0:
        status = "error"
    elif counts["failed"] > 0:
        status = "failed"
    elif counts["unverified"] > 0:
        status = "partial"
    else:
        status = "verified"
    return VerificationReport(
        revision=revision,
        status=status,
        lean_version=lean_version,
        lean_source=lean_source,
        verified_count=counts["verified"],
        failed_count=counts["failed"],
        unverified_count=counts["unverified"],
        error_count=counts["error"],
        obligations=obligations,
    )
