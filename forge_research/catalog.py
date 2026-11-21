from pathlib import Path

from pydantic import TypeAdapter

from .models import CatalogReview, Finding, Part, Proposal, Requirements

PARTS = TypeAdapter(list[Part]).validate_json(
    Path(__file__).with_name("parts.json").read_bytes()
)


class ResearchError(Exception):
    """The workflow could not produce a trustworthy research report."""


def review_proposal(
    requirements: Requirements, proposal: Proposal, evidence: dict[str, Part]
) -> CatalogReview:
    selected = []
    for part_id, role in (
        (proposal.controller_id, "controller"),
        (proposal.sensor_id, "emg_sensor"),
    ):
        if part_id is None:
            continue
        part = evidence.get(part_id)
        if part is None or part.role != role:
            raise ResearchError(
                f"Sourcing proposed a {role} without matching catalog evidence."
            )
        selected.append(part)

    if requirements.application == "unsupported":
        if selected:
            raise ResearchError("Sourcing proposed parts for an unsupported brief.")
        return CatalogReview(
            status="unsupported",
            selected_parts=[],
            core_subtotal_usd_cents=None,
            findings=[
                Finding(
                    check="catalog_scope",
                    status="unknown",
                    detail=(
                        "The curated research catalog has no reviewed parts for this "
                        "application. The PCB studio selects parts from its general catalog."
                    ),
                )
            ],
        )

    if len(selected) < 2:
        return CatalogReview(
            status="blocked",
            selected_parts=selected,
            core_subtotal_usd_cents=None,
            findings=[
                Finding(
                    check="core_parts",
                    status="fail",
                    detail="A controller and an EMG sensor are required.",
                )
            ],
        )

    controller, sensor = selected
    requested = requirements.transport
    transports = set(controller.transports)
    transport_supported = requested in transports or (
        requested == "wireless" and bool(transports & {"wifi", "ble"})
    )
    rail = controller.sensor_rail_mv
    supply = sensor.supply_range_mv
    quotes = [part.quote for part in selected]
    quoted_cents = sum(quote.unit_price_usd_cents for quote in quotes if quote is not None)
    subtotal = quoted_cents if all(quote is not None for quote in quotes) else None

    cap = requirements.budget_usd_cents
    budget_status = "unknown"
    if cap is not None:
        if quoted_cents > cap or (requirements.budget_exclusive and quoted_cents == cap):
            budget_status = "fail"
        elif subtotal is not None:
            budget_status = "pass"

    findings = [
        Finding(
            check="transport",
            status="unknown"
            if requested == "unspecified"
            else ("pass" if transport_supported else "fail"),
            detail=f"Requested {requested}. Controller lists {', '.join(controller.transports)}.",
        ),
        Finding(
            check="signal_interface",
            status="pass"
            if controller.adc_pins and sensor.signal_output == "analog_envelope"
            else "fail",
            detail="Compare the sensor output type to the controller's available ADC inputs.",
        ),
        Finding(
            check="nominal_sensor_supply",
            status="unknown"
            if rail is None or supply is None
            else ("pass" if supply[0] <= rail <= supply[1] else "fail"),
            detail=f"Controller rail {rail} mV. Sensor supply range {supply} mV.",
        ),
        Finding(
            check="core_parts_budget",
            status=budget_status,
            detail=(
                "Dated unit prices for the controller and sensor only. Electrodes, power, "
                "enclosure, shipping, and tax still need estimates."
            ),
        ),
        Finding(
            check="prototype_validation",
            status="unknown",
            detail=(
                "ADC input range, rail current, on-body power, fit, BLE communication, and "
                "per-gesture accuracy still need engineering or physical validation."
            ),
        ),
    ]
    return CatalogReview(
        status="blocked"
        if any(finding.status == "fail" for finding in findings)
        else "candidate",
        selected_parts=selected,
        core_subtotal_usd_cents=subtotal,
        findings=findings,
    )
