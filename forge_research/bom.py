"""Live Bill of Materials (BOM) and causal cost delta engine."""

from .models import (
    BomLineItem,
    CostBreakdown,
    DeviceSpecification,
    Part,
    ProcurementOffer,
    ProcurementState,
)

MINOR_UNIT_EXPONENTS: dict[str, int] = {
    "BIF": 0,
    "CLP": 0,
    "DJF": 0,
    "GNF": 0,
    "ISK": 0,
    "JPY": 0,
    "KMF": 0,
    "KRW": 0,
    "PYG": 0,
    "RWF": 0,
    "UGX": 0,
    "VND": 0,
    "VUV": 0,
    "XAF": 0,
    "XOF": 0,
    "XPF": 0,
    "BHD": 3,
    "IQD": 3,
    "JOD": 3,
    "KWD": 3,
    "LYD": 3,
    "OMR": 3,
    "TND": 3,
}


def format_minor_currency(amount_minor: int, currency: str) -> str:
    code = currency.upper().strip() or "USD"
    exp = MINOR_UNIT_EXPONENTS.get(code, 2)
    major = amount_minor / (10**exp)
    symbols = {"USD": "$", "EUR": "€", "GBP": "£", "CAD": "CA$", "AUD": "A$", "JPY": "¥"}
    prefix = symbols.get(code, f"{code} ")
    return f"{prefix}{major:,.{exp}f}"


def format_usd_delta(delta_cents: int) -> str:
    sign = "+" if delta_cents >= 0 else "-"
    return f"{sign}${abs(delta_cents) / 100:,.2f}"


def _find_selected_offer(
    catalog_id: str, offer_id: str | None, procurement: ProcurementState | None
) -> ProcurementOffer | None:
    if not offer_id or procurement is None:
        return None
    part_result = procurement.results_by_part.get(catalog_id)
    if part_result is None:
        return None
    for offer in part_result.offers:
        if offer.offer_id == offer_id:
            return offer
    return None


def _build_line_item(
    comp, part: Part, procurement: ProcurementState | None
) -> BomLineItem:
    quote = part.quote
    cat_cents = quote.unit_price_usd_cents if quote is not None else None
    offer = _find_selected_offer(part.id, comp.selected_offer_id, procurement)
    notes: list[str] = []

    effective_cents = cat_cents
    source = "catalog_quote" if cat_cents is not None else "unpriced"

    if offer is not None:
        if not offer.available:
            notes.append(f"Selected offer from {offer.seller_name} is out of stock; using catalog reference.")
        elif offer.match_kind != "exact_match":
            notes.append(
                f"Offer '{offer.title}' is classified as {offer.match_kind}; not applied as unit replacement price."
            )
        elif offer.currency.upper() != "USD" or offer.price_usd_cents is None:
            notes.append(
                f"Merchant offer ({offer.formatted_price} at {offer.seller_name}) is in {offer.currency}; "
                "kept separate to avoid incompatible currency totals."
            )
        else:
            effective_cents = offer.price_usd_cents
            source = "merchant_offer"
            if cat_cents is not None:
                diff = effective_cents - cat_cents
                if diff < 0:
                    notes.append(f"Saves ${abs(diff) / 100:,.2f}/unit vs {quote.vendor} catalog reference.")
                elif diff > 0:
                    notes.append(f"+${diff / 100:,.2f}/unit vs {quote.vendor} catalog reference.")
                else:
                    notes.append(f"Matches {quote.vendor} catalog unit price.")
            else:
                notes.append(f"Priced via live {offer.seller_name} USD offer (no curated catalog quote).")

    if effective_cents is None:
        notes.append("No verified USD unit quote available yet.")

    extended = effective_cents * comp.quantity if effective_cents is not None else None
    return BomLineItem(
        instance_id=comp.instance_id,
        catalog_id=part.id,
        name=part.name,
        manufacturer=part.manufacturer,
        sku=part.sku,
        role=comp.role,
        quantity=comp.quantity,
        catalog_unit_usd_cents=cat_cents,
        catalog_vendor=quote.vendor if quote else None,
        catalog_url=str(quote.url) if quote else None,
        catalog_reviewed_on=quote.reviewed_on if quote else None,
        selected_offer=offer,
        effective_unit_usd_cents=effective_cents,
        pricing_source=source,
        extended_usd_cents=extended,
        notes=notes,
    )


def _explain_deltas(
    spec: DeviceSpecification,
    items: list[BomLineItem],
    known_subtotal: int,
    prev_spec: DeviceSpecification | None,
    prev_cost: CostBreakdown | None,
) -> list[str]:
    if prev_spec is None or prev_cost is None:
        return []
    deltas: list[str] = []
    prev_by_role = {item.role: item for item in prev_cost.line_items}
    curr_by_role = {item.role: item for item in items}

    for role, label in (("controller", "Controller"), ("emg_sensor", "Sensor")):
        old = prev_by_role.get(role)
        new = curr_by_role.get(role)
        if old is None or new is None:
            continue
        if old.catalog_id != new.catalog_id:
            if old.extended_usd_cents is not None and new.extended_usd_cents is not None:
                diff = new.extended_usd_cents - old.extended_usd_cents
                deltas.append(
                    f"{label} changed ({old.sku} → {new.sku}): {format_usd_delta(diff)}"
                )
            elif new.extended_usd_cents is None:
                dropped = (
                    f" ({format_usd_delta(-old.extended_usd_cents)} known)"
                    if old.extended_usd_cents is not None
                    else ""
                )
                deltas.append(
                    f"{label} changed ({old.sku} → {new.sku}): {new.name} is unpriced in USD{dropped}"
                )
            else:
                deltas.append(
                    f"{label} changed ({old.sku} → {new.sku}): +{format_minor_currency(new.extended_usd_cents, 'USD')} known"
                )
        elif old.quantity != new.quantity:
            if old.extended_usd_cents is not None and new.extended_usd_cents is not None:
                diff = new.extended_usd_cents - old.extended_usd_cents
                deltas.append(
                    f"{label} quantity changed ({old.quantity} → {new.quantity}): {format_usd_delta(diff)}"
                )
            else:
                deltas.append(f"{label} quantity changed ({old.quantity} → {new.quantity}): unit price unquoted")
        elif old.extended_usd_cents != new.extended_usd_cents:
            if old.extended_usd_cents is not None and new.extended_usd_cents is not None:
                diff = new.extended_usd_cents - old.extended_usd_cents
                merchant = new.selected_offer.seller_name if new.selected_offer else "catalog reference"
                deltas.append(f"{new.sku} offer updated ({merchant}): {format_usd_delta(diff)}")
            elif new.extended_usd_cents is not None:
                deltas.append(
                    f"{new.sku} priced via merchant offer: {format_minor_currency(new.extended_usd_cents, 'USD')}"
                )

    if not deltas:
        if prev_spec.mechanical != spec.mechanical:
            if prev_spec.mechanical.wrist_circumference_mm != spec.mechanical.wrist_circumference_mm:
                deltas.append(
                    f"Wrist size changed ({prev_spec.mechanical.wrist_circumference_mm:g} → "
                    f"{spec.mechanical.wrist_circumference_mm:g} mm): hardware BOM unchanged "
                    f"({format_minor_currency(known_subtotal, 'USD')})"
                )
            else:
                deltas.append(
                    f"Enclosure dimensions changed: hardware BOM unchanged "
                    f"({format_minor_currency(known_subtotal, 'USD')})"
                )
        elif prev_spec.requirements.budget_usd_cents != spec.requirements.budget_usd_cents or (
            prev_spec.requirements.budget_exclusive != spec.requirements.budget_exclusive
        ):
            old_b = (
                format_minor_currency(prev_spec.requirements.budget_usd_cents, "USD")
                if prev_spec.requirements.budget_usd_cents is not None
                else "none"
            )
            new_b = (
                format_minor_currency(spec.requirements.budget_usd_cents, "USD")
                if spec.requirements.budget_usd_cents is not None
                else "none"
            )
            deltas.append(
                f"Budget target updated ({old_b} → {new_b}): hardware BOM unchanged "
                f"({format_minor_currency(known_subtotal, 'USD')})"
            )
        elif prev_spec.wiring != spec.wiring:
            deltas.append("Electrical wiring updated: hardware BOM unchanged")
    return deltas


def compute_cost_breakdown(
    revision: int,
    spec: DeviceSpecification,
    catalog_snapshot: dict[str, Part],
    procurement: ProcurementState | None = None,
    previous_spec: DeviceSpecification | None = None,
    previous_cost: CostBreakdown | None = None,
) -> CostBreakdown:
    items: list[BomLineItem] = []
    for comp in spec.components:
        part = catalog_snapshot.get(comp.catalog_id)
        if part is None:
            continue
        items.append(_build_line_item(comp, part, procurement))

    known_subtotal = sum(
        item.extended_usd_cents for item in items if item.extended_usd_cents is not None
    )
    unpriced_ids = [item.catalog_id for item in items if item.extended_usd_cents is None]
    has_unpriced = bool(unpriced_ids)
    complete_subtotal = None if has_unpriced else known_subtotal

    all_catalog_priced = items and all(item.catalog_unit_usd_cents is not None for item in items)
    catalog_subtotal = (
        sum((item.catalog_unit_usd_cents or 0) * item.quantity for item in items)
        if all_catalog_priced
        else None
    )

    cap = spec.requirements.budget_usd_cents
    exclusive = spec.requirements.budget_exclusive
    if cap is None:
        remaining = None
        budget_status = "unspecified"
    else:
        remaining = cap - known_subtotal
        exceeded = known_subtotal > cap or (exclusive and known_subtotal == cap)
        if exceeded:
            budget_status = "exceeded"
        elif has_unpriced:
            budget_status = "incomplete"
        else:
            budget_status = "within_budget"

    deltas = _explain_deltas(spec, items, known_subtotal, previous_spec, previous_cost)
    return CostBreakdown(
        revision=revision,
        line_items=items,
        catalog_subtotal_usd_cents=catalog_subtotal,
        known_subtotal_usd_cents=known_subtotal,
        complete_subtotal_usd_cents=complete_subtotal,
        has_unpriced_items=has_unpriced,
        unpriced_catalog_ids=unpriced_ids,
        budget_usd_cents=cap,
        budget_exclusive=exclusive,
        budget_remaining_usd_cents=remaining,
        budget_status=budget_status,
        deltas_from_previous=deltas,
    )
