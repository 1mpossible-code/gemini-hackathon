"""Read-only Shop.dev MCP client (https://mcp.shop.com/) for live BOM procurement."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from .bom import format_minor_currency
from .models import (
    OfferMatchKind,
    Part,
    PartProcurementResult,
    ProcurementOffer,
)

SHOP_MCP_ENDPOINT = "https://mcp.shop.com/"
SHOP_PROTOCOL_VERSION = "2026-07-28"
CLIENT_INFO = {"name": "forge-engineering-studio", "version": "0.2.0"}

ShopTransport = Callable[[str, dict[str, str], bytes], tuple[int, dict[str, Any]]]

_PACK_RE = re.compile(r"\b(\d+\s*-\s*pack|\d+\s*pcs|\d+\s*pack|kit|bundle|starter)\b", re.I)
_ACCESSORY_RE = re.compile(
    r"\b(shield|cable|case|enclosure|cover|strap|hat|adapter|mount|electrode)\b", re.I
)


class ShopMcpError(RuntimeError):
    """Structured error returned by or while contacting Shop MCP."""

    def __init__(self, message: str, *, code: str | None = None, retry_after: int | None = None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after


def _default_transport(
    url: str, headers: dict[str, str], payload: bytes
) -> tuple[int, dict[str, Any]]:
    request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as parse_err:
            raise ShopMcpError(
                f"Shop MCP returned HTTP {exc.code}.", code=f"http_{exc.code}"
            ) from parse_err
        return exc.code, parsed
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ShopMcpError(
            "Could not reach Shop MCP (network or timeout error).", code="network_error"
        ) from exc


def call_shop_tool_sync(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    transport: ShopTransport | None = None,
) -> dict[str, Any]:
    active_transport = transport or _default_transport
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": SHOP_PROTOCOL_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool_name,
        "User-Agent": f"{CLIENT_INFO['name']}/{CLIENT_INFO['version']}",
    }
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": SHOP_PROTOCOL_VERSION,
                "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    }
    status, data = active_transport(
        SHOP_MCP_ENDPOINT, headers, json.dumps(body).encode("utf-8")
    )

    if "error" in data and data["error"]:
        err = data["error"]
        msg = err.get("message") or f"Shop MCP rejected {tool_name} (HTTP {status})."
        raise ShopMcpError(str(msg), code=str(err.get("code", "rpc_error")))

    result = data.get("result") or {}
    structured = result.get("structuredContent")
    if structured is None:
        text_parts = [
            p.get("text", "")
            for p in (result.get("content") or [])
            if isinstance(p, dict) and p.get("type") == "text"
        ]
        joined = "\n".join(t for t in text_parts if t).strip()
        if not result.get("isError") and joined.startswith("{"):
            try:
                structured = json.loads(joined)
            except json.JSONDecodeError:
                structured = None
        if result.get("isError"):
            meta_err = (result.get("_meta") or {}).get("com.shopify/error") or {}
            code = meta_err.get("code") or "tool_error"
            retry_after = meta_err.get("retry_after")
            msg = joined or f"Shop MCP tool '{tool_name}' failed ({code})."
            raise ShopMcpError(msg, code=str(code), retry_after=retry_after)

    if result.get("isError"):
        msgs = [
            m.get("content", "")
            for m in ((structured or {}).get("messages") or [])
            if isinstance(m, dict) and m.get("content")
        ]
        raise ShopMcpError(
            "; ".join(msgs) or f"Shop MCP '{tool_name}' returned an error.", code="ucp_error"
        )

    if not isinstance(structured, dict):
        raise ShopMcpError("Shop MCP returned an empty or unrecognized payload.", code="bad_payload")
    return structured


def _extract_warnings(document: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    for msg in document.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        content = str(msg.get("content") or "").strip()
        if content and msg.get("type") in ("warning", "error", "disclosure", None):
            warnings.append(content)
    return warnings


def _classify_offer_for_part(
    part: Part, title: str, variant_options: str
) -> tuple[OfferMatchKind, str] | None:
    haystack = f"{title} {variant_options}".lower()
    sku_low = part.sku.lower()

    if part.id == "esp32-devkitc-32e":
        if "esp32" not in haystack and "wroom-32e" not in haystack:
            return None
        if any(
            bad in haystack
            for bad in (
                "esp32-s2",
                "esp32-s3",
                "esp32-c3",
                "esp32-c5",
                "esp32-c6",
                "wroom-32d",
                "devkitc-32d",
            )
        ):
            return ("variant_or_accessory", "Different ESP32 silicon/module revision (not 32E); verify datasheet.")
        if _ACCESSORY_RE.search(haystack):
            return ("variant_or_accessory", "Accessory/enclosure listing, not the controller board.")
        if _PACK_RE.search(haystack):
            return ("bundle_or_pack", "Multi-board pack or bundle; unit price differs from pack total.")
        if "usb-c" in haystack or "type-c" in haystack:
            return (
                "variant_or_accessory",
                "USB-C third-party clone; mechanical connector differs from Espressif Micro-USB drawing.",
            )
        if sku_low in haystack or ("devkitc" in haystack and "32e" in haystack):
            return ("exact_match", "Matches ESP32-DevKitC-32E SKU.")
        return ("variant_or_accessory", "Generic ESP32 board; verify pinout and dimensions against datasheet.")

    if part.id == "arduino-uno-r3":
        if "uno" not in haystack and sku_low not in haystack:
            return None
        if any(bad in haystack for bad in ("uno r4", "wifi", "mini", "q ")):
            return ("variant_or_accessory", "Different Arduino UNO generation/variant.")
        if _ACCESSORY_RE.search(haystack):
            return ("variant_or_accessory", "Shield or accessory, not the Arduino UNO Rev3 board.")
        if _PACK_RE.search(haystack):
            return ("bundle_or_pack", "Starter kit or multi-pack bundle.")
        if "smd" in haystack:
            return ("variant_or_accessory", "SMD package variant (A000073) vs DIP Rev3 (A000066).")
        if sku_low in haystack or ("arduino" in haystack and "uno" in haystack and ("rev3" in haystack or "rev 3" in haystack or "r3" in haystack)):
            return ("exact_match", "Matches Arduino UNO Rev3.")
        return ("variant_or_accessory", "Compatible UNO-style board; verify manufacturer SKU.")

    if part.id == "myoware-2-dev-27924":
        if "myoware" not in haystack and sku_low not in haystack:
            return None
        if _ACCESSORY_RE.search(haystack):
            return ("variant_or_accessory", "MyoWare add-on shield/cable accessory, not the EMG sensor.")
        if _PACK_RE.search(haystack):
            return ("bundle_or_pack", "MyoWare sensor kit/bundle; includes extra shields or accessories.")
        if sku_low in haystack or ("myoware" in haystack and "muscle sensor" in haystack):
            return ("exact_match", "Matches SparkFun MyoWare 2 Muscle Sensor.")
        return ("variant_or_accessory", "MyoWare ecosystem item; verify exact DEV-27924 SKU.")

    tokens = [t for t in re.split(r"[^a-z0-9]+", f"{part.manufacturer} {part.sku} {part.name}".lower()) if len(t) >= 3]
    if not any(tok in haystack for tok in tokens):
        return None
    if _ACCESSORY_RE.search(haystack):
        return ("variant_or_accessory", "Accessory listing.")
    if _PACK_RE.search(haystack):
        return ("bundle_or_pack", "Bundle or multi-pack listing.")
    if sku_low in haystack:
        return ("exact_match", f"Title contains SKU {part.sku}.")
    return ("variant_or_accessory", "Similar product title; verify datasheet and exact SKU.")


def _parse_offers(
    part: Part, products: list[dict[str, Any]], retrieved_at: datetime
) -> list[ProcurementOffer]:
    offers: list[ProcurementOffer] = []
    for product in products:
        if not isinstance(product, dict):
            continue
        title = str(product.get("title") or "").strip()
        product_id = str(product.get("id") or "")
        variants = product.get("variants") or []
        if not title or not product_id or not variants:
            continue
        variant = variants[0] if isinstance(variants[0], dict) else {}
        variant_id = str(variant.get("id") or "")
        url = str(variant.get("url") or "").strip()
        price_obj = variant.get("price") or {}
        seller_obj = variant.get("seller") or {}
        if not variant_id or not url.startswith(("https://", "http://")):
            continue
        try:
            amount = int(price_obj.get("amount"))
        except (TypeError, ValueError):
            continue
        currency = str(price_obj.get("currency") or "USD").upper()
        opt_labels = ", ".join(
            f"{opt.get('name')}: {opt.get('label')}"
            for opt in (variant.get("options") or [])
            if isinstance(opt, dict) and opt.get("label")
        )
        classified = _classify_offer_for_part(part, title, opt_labels)
        if classified is None:
            continue
        match_kind, match_note = classified
        available = bool((variant.get("availability") or {}).get("available", False))
        media = product.get("media") or []
        image_url = None
        if media and isinstance(media[0], dict):
            raw_img = str(media[0].get("url") or "")
            if raw_img.startswith(("https://", "http://")):
                image_url = raw_img

        offer_hash = hashlib.sha1(f"{part.id}:{variant_id}".encode()).hexdigest()[:12]
        offers.append(
            ProcurementOffer(
                offer_id=offer_hash,
                product_id=product_id,
                variant_id=variant_id,
                title=title,
                variant_label=opt_labels or None,
                seller_name=str(seller_obj.get("name") or seller_obj.get("domain") or "Merchant"),
                seller_domain=str(seller_obj.get("domain") or ""),
                price_minor_units=amount,
                currency=currency,
                formatted_price=format_minor_currency(amount, currency),
                price_usd_cents=amount if currency == "USD" else None,
                available=available,
                url=url,
                image_url=image_url,
                match_kind=match_kind,
                match_note=match_note,
                retrieved_at=retrieved_at,
            )
        )

    rank = {"exact_match": 0, "bundle_or_pack": 1, "variant_or_accessory": 2}
    offers.sort(
        key=lambda o: (
            rank[o.match_kind],
            0 if o.available else 1,
            0 if o.currency == "USD" else 1,
            o.price_minor_units,
        )
    )
    return offers


def default_query_for_part(part: Part) -> str:
    if part.id == "esp32-devkitc-32e":
        return "ESP32-DevKitC-32E"
    if part.id == "arduino-uno-r3":
        return "Arduino Uno Rev3"
    if part.id == "myoware-2-dev-27924":
        return "MyoWare 2 Muscle Sensor"
    return f"{part.manufacturer} {part.sku}"


def search_part_offers_sync(
    part: Part,
    *,
    query: str | None = None,
    country: str = "US",
    currency: str = "USD",
    limit: int = 8,
    transport: ShopTransport | None = None,
) -> PartProcurementResult:
    effective_query = (query or "").strip() or default_query_for_part(part)
    now = datetime.now(UTC)
    try:
        doc = call_shop_tool_sync(
            "search_catalog",
            {
                "catalog": {
                    "query": effective_query,
                    "context": {"address_country": country, "currency": currency},
                    "pagination": {"limit": max(1, min(limit, 20))},
                }
            },
            transport=transport,
        )
    except ShopMcpError as exc:
        return PartProcurementResult(
            catalog_id=part.id,
            sku=part.sku,
            query=effective_query,
            status="error",
            warnings=[],
            error_message=str(exc),
            retrieved_at=now,
        )

    warnings = _extract_warnings(doc)
    offers = _parse_offers(part, doc.get("products") or [], now)
    return PartProcurementResult(
        catalog_id=part.id,
        sku=part.sku,
        query=effective_query,
        status="ok" if offers else "no_results",
        offers=offers,
        warnings=warnings,
        retrieved_at=now,
    )


def get_shop_product_sync(
    product_id: str,
    *,
    country: str = "US",
    currency: str = "USD",
    transport: ShopTransport | None = None,
) -> dict[str, Any]:
    doc = call_shop_tool_sync(
        "get_product",
        {
            "catalog": {
                "id": product_id,
                "context": {"address_country": country, "currency": currency},
            }
        },
        transport=transport,
    )
    product = doc.get("product") or doc
    options = []
    for opt in product.get("options") or []:
        if not isinstance(opt, dict):
            continue
        vals = [
            {
                "label": v.get("label"),
                "available": v.get("available"),
                "exists": v.get("exists"),
            }
            for v in (opt.get("values") or [])
            if isinstance(v, dict)
        ]
        options.append({"name": opt.get("name"), "values": vals})
    variants = []
    for var in product.get("variants") or []:
        if not isinstance(var, dict):
            continue
        price = var.get("price") or {}
        amt = price.get("amount")
        cur = str(price.get("currency") or currency).upper()
        variants.append(
            {
                "id": var.get("id"),
                "price_formatted": format_minor_currency(int(amt), cur)
                if isinstance(amt, int)
                else None,
                "currency": cur,
                "available": bool((var.get("availability") or {}).get("available", False)),
                "seller": (var.get("seller") or {}).get("name"),
                "url": var.get("url"),
                "options": var.get("options") or [],
            }
        )
    return {
        "id": product.get("id") or product_id,
        "title": product.get("title"),
        "options": options,
        "variants": variants,
        "warnings": _extract_warnings(doc),
    }


def lookup_shop_catalog_sync(
    ids: list[str],
    *,
    country: str = "US",
    currency: str = "USD",
    transport: ShopTransport | None = None,
) -> dict[str, Any]:
    return call_shop_tool_sync(
        "lookup_catalog",
        {
            "catalog": {
                "ids": ids[:20],
                "context": {"address_country": country, "currency": currency},
            }
        },
        transport=transport,
    )


async def search_part_offers(
    part: Part,
    *,
    query: str | None = None,
    country: str = "US",
    currency: str = "USD",
    limit: int = 8,
    transport: ShopTransport | None = None,
) -> PartProcurementResult:
    return await asyncio.to_thread(
        search_part_offers_sync,
        part,
        query=query,
        country=country,
        currency=currency,
        limit=limit,
        transport=transport,
    )


async def get_shop_product(
    product_id: str,
    *,
    country: str = "US",
    currency: str = "USD",
    transport: ShopTransport | None = None,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        get_shop_product_sync,
        product_id,
        country=country,
        currency=currency,
        transport=transport,
    )
