"""Named read assertions; expected private text stays in memory, never in evidence."""
from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from .browser_verify import MAX_PAGES, Request, Stop, record, uuid_text


async def require(condition: bool, code: str) -> None:
    if not condition:
        raise Stop(code)


def identity(row: dict[str, Any]) -> str:
    # This is the documented presentation contract, not the browser's renderer helper.
    return f"{row.get('harness') or 'Agent'}" + (f" · {row['host']}" if row.get("host") else "") + \
        f" · {row['session_id'][:8]}"


def presented(batch: list[dict[str, Any]], ids: list[str]) -> list[str]:
    # The roster lists online sessions first and keeps the API order inside each group: the stable partition the page
    # applies to the one page it renders. The row set stays exact, so a missing, repeated or retargeted id differs.
    return [i for row, i in zip(batch, ids, strict=True) if row.get("online")] + \
        [i for row, i in zip(batch, ids, strict=True) if not row.get("online")]


async def text(locator: Any, expected: str, code: str) -> None:
    await require(await locator.count() == 1 and await locator.text_content() == expected, code)


async def read_only(page: Any) -> None:
    controls = page.locator(
        "#composer input, #composer textarea, #composer button, #create-room input, #create-room button, "
        "#join-room input, #join-room button, .reply, .mute-session, .pm-session, .resolve-thread"
    )
    for control in await controls.all():
        await require(not (await control.is_visible() and await control.is_enabled()), "MUTATION_CONTROL_ENABLED")
    await require(await page.locator("#viewer[data-access='viewer']").is_visible(), "VIEWER_MISMATCH")
    await require(await page.locator("#read-only-indicator").is_visible(), "READ_ONLY_INDICATOR_MISSING")


async def select_room(request: Request, fence: Any, page: Any) -> None:
    fence.healthy()
    await page.locator("#viewer[data-access='viewer']").wait_for(state="visible")
    await page.locator("#read-only-indicator").wait_for(state="visible")
    options = await page.locator("#room option").evaluate_all("nodes => nodes.map(n => n.value).filter(Boolean)")
    if not set(options) <= set(fence.binding.room_ids):
        raise Stop("ROOM_SCOPE_MISMATCH")
    if request.room not in options:
        raise Stop("ROOM_UNAVAILABLE", "UNAVAILABLE")
    if await page.locator("#room").input_value() != request.room:
        async with page.expect_response(lambda response: f"/v1/rooms/{request.room}/participants?" in response.url):
            await page.locator("#room").select_option(request.room)
        await page.wait_for_load_state("networkidle")
    fence.healthy()
    await require(await page.locator("#room").input_value() == request.room, "ROOM_MISMATCH")


async def collection(request: Request, fence: Any, context: Any, page: Any, kind: str,
                     *, target: str | None = None) -> list[dict[str, Any]]:
    participants = kind == "participants"
    key, attr = ("participants", "session-id") if participants else ("messages", "message-id")
    id_key = "session_id" if participants else "id"
    button = page.locator("#more-participants" if participants else "#more-messages")
    query = {"limit": "50"}
    if not participants:
        query["before"] = "9223372036854775807"
    rows = []
    if participants and await page.locator("#participants-details").get_attribute("open") is None:
        await page.locator("#participants-details > summary").click()
    for number in range(MAX_PAGES):
        data = await fence.api(context, f"/v1/rooms/{request.room}/{kind}?{urlencode(query)}")
        batch = data.get(key)
        if not isinstance(batch, list) or len(batch) > 50 or not all(isinstance(row, dict) for row in batch):
            raise Stop("API_SHAPE_MISMATCH")
        ids = [uuid_text(row[id_key]) for row in batch]
        if len(ids) != len(set(ids)):
            raise Stop("API_SHAPE_MISMATCH")
        # networkidle is a navigation milestone, not an AJAX-render barrier.
        # Wait for the exact API snapshot after room/page changes; persistent
        # contrary DOM still fails within the bounded assertion timeout.
        # The roster is shown in its presentation order; the history keeps the API order.
        shown = presented(batch, ids) if participants else ids
        try:
            await page.wait_for_function("""input => JSON.stringify(
                [...document.querySelectorAll(input.selector)].map(n => n.getAttribute(input.attribute))
              ) === JSON.stringify(input.ids)""",
                arg={"selector": f"#{key} > li[data-{attr}]", "attribute": f"data-{attr}", "ids": shown},
                timeout=5000)
        except Exception:
            fence.healthy()
            raise Stop("PARTICIPANT_IDS_MISMATCH" if participants else "MESSAGE_IDS_MISMATCH") from None
        rows.extend(batch)
        if target is not None and target in ids:
            return batch
        if participants:
            cursor = data.get("next_session_id")
            if cursor is not None:
                uuid_text(cursor)
            more = cursor is not None
        else:
            more = data.get("has_more")
            if type(more) is not bool:
                raise Stop("API_SHAPE_MISMATCH")
            cursor = data.get("next_cursor")
            if not isinstance(cursor, str) or not cursor.isdecimal():
                raise Stop("API_SHAPE_MISMATCH")
        await require(await button.is_visible() == more, "PAGINATION_CONTROL_MISMATCH")
        if not more:
            if target is not None:
                raise Stop("SESSION_UNAVAILABLE" if participants else "MESSAGE_UNAVAILABLE", "UNAVAILABLE")
            return rows
        if number == MAX_PAGES - 1:
            raise Stop("PAGE_LIMIT", "UNAVAILABLE")
        query["after_session" if participants else "before"] = cursor
        async with page.expect_response(lambda response: f"/{kind}?" in response.url):
            await button.click()
        await page.wait_for_load_state("networkidle")
        fence.healthy()
    raise Stop("PAGE_LIMIT", "UNAVAILABLE")


async def participant(request: Request, rows: list[dict[str, Any]], page: Any) -> None:
    row = next((row for row in rows if row["session_id"] == request.session), None)
    if row is None:
        raise Stop("SESSION_UNAVAILABLE", "UNAVAILABLE")
    title = row["title"]
    if title is not None and not isinstance(title, str):
        raise Stop("API_SHAPE_MISMATCH")
    if request.expected_title is not None:
        await require((title or "") == request.expected_title, "EXPECTED_TITLE_MISMATCH")
    node = page.locator(f"#participants > li[data-session-id='{request.session}']")
    await require(await node.count() == 1, "SESSION_DOM_MISSING")
    await text(node.locator(".participant-id"), request.session or "", "SESSION_UUID_MISMATCH")
    await text(node.locator(".participant-label"), row["label"], "SESSION_LABEL_MISMATCH")
    await text(node.locator(".session-title"), title or identity(row), "TITLE_DOM_MISMATCH")
    await require(await node.locator(".session-title *").count() == 0, "TITLE_MARKUP_ACTIVE")
    await text(node.locator(".participant-identity"), identity(row), "SESSION_IDENTITY_MISMATCH")


async def history_receipt(request: Request, rows: list[dict[str, Any]], page: Any) -> None:
    message = next(row for row in rows if row["id"] == request.message)
    await require(message["room_id"] == request.room, "MESSAGE_ROOM_MISMATCH")
    receipts = message.get("receipts")
    if not isinstance(receipts, list):
        raise Stop("API_SHAPE_MISMATCH")
    receipt = next((row for row in receipts if row["session_id"] == request.receipt_session), None)
    if receipt is None:
        raise Stop("RECEIPT_UNAVAILABLE", "UNAVAILABLE")
    fields = {"stored": "stored_at", "handed": "handed_at", "acknowledged": "acknowledged_at",
              "replied": "replying_message_id", "uncertain": "uncertainty_reason"}
    for state in request.receipt_states:
        await require(bool(receipt.get(fields[state])), "EXPECTED_RECEIPT_MISMATCH")
    node = page.locator(f"#messages > li[data-message-id='{request.message}']")
    await text(node.locator(".body"), message["body"], "MESSAGE_BODY_MISMATCH")
    await require(await node.locator(".body *").count() == 0, "MESSAGE_MARKUP_ACTIVE")
    sender = message["sender"]
    if sender["session_id"] is None:
        await text(node.locator(".sender-name"), "Operator", "SENDER_MISMATCH")
    else:
        await text(node.locator(".sender-name"), sender.get("title") or identity(sender), "SENDER_MISMATCH")
        # An untitled session is named by its identity alone; only a titled one repeats it beneath the name.
        if sender.get("title"):
            await text(node.locator(".sender-identity"), identity(sender), "SENDER_IDENTITY_MISMATCH")
        else:
            await require(await node.locator(".sender-identity").count() == 0, "SENDER_IDENTITY_MISMATCH")
    summaries = node.locator(".receipt-summary > li")
    await require(await summaries.count() == len(receipts), "RECEIPT_COUNT_MISMATCH")
    await node.locator(".message-evidence > summary").click()
    evidence = node.locator(".evidence-receipts > li")
    await require(await evidence.count() == len(receipts), "RECEIPT_EVIDENCE_MISMATCH")
    for index, row in enumerate(receipts):
        states = [f"{label}: {'tak' if row.get(field) else '—'}"
                  for label, field in (("zapis", "stored_at"), ("przekazanie", "handed_at"),
                                       ("ACK", "acknowledged_at"), ("odpowiedź", "replying_message_id"))]
        states += [f"niepewność: {row.get('uncertainty_reason') or '—'}",
                   f"próba: {(row.get('delivery') or {}).get('outcome') or '—'}"]
        await require(await summaries.nth(index).locator(".receipt-state").all_text_contents() == states,
                      "RECEIPT_STATE_DOM_MISMATCH")
        expected = (f"{row['session_id']} · zapis: {row.get('stored_at') or '—'} · "
                    f"przekazanie: {row.get('handed_at') or '—'} · ACK: {row.get('acknowledged_at') or '—'} · "
                    f"odpowiedź: {row.get('replying_message_id') or '—'} · "
                    f"niepewność: {row.get('uncertainty_reason') or '—'} · "
                    f"próba: {(row.get('delivery') or {}).get('outcome') or '—'}")
        await text(evidence.nth(index), expected, "RECEIPT_EVIDENCE_MISMATCH")


async def layout(page: Any) -> None:
    await require(await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),
                  "DOCUMENT_OVERFLOW")
    details = page.locator("#participants-details")
    await details.locator(":scope > summary").click()
    await require(await details.get_attribute("open") is None, "PANEL_COLLAPSE_MISMATCH")
    await details.locator(":scope > summary").click()
    await require(await details.get_attribute("open") is not None, "PANEL_EXPAND_MISMATCH")
    for selector in ("#room", "#refresh", "#participants-details > summary", "#thread-filter", "#messages"):
        control = page.locator(selector)
        await require(await control.is_visible(), "READ_CONTROL_MISSING")
        if selector != "#messages":
            await control.scroll_into_view_if_needed()
            box = await control.bounding_box()
            width = await page.evaluate("window.innerWidth")
            await require(box is not None and box["width"] > 0 and box["height"] > 0
                          and box["x"] >= -1 and box["x"] + box["width"] <= width + 1,
                          "READ_CONTROL_UNREACHABLE")


async def scenario(request: Request, fence: Any, context: Any, page: Any, viewport: int) -> None:
    await read_only(page)
    if request.scenario == "snapshot":
        # Empty history is legitimate, but missing/retargeted API-to-DOM rows are not.
        await collection(request, fence, context, page, "participants")
        await collection(request, fence, context, page, "history")
        record(fence.result, "SNAPSHOT_CONTENT", viewport=viewport)
    elif request.scenario in ("session-title", "layout"):
        if request.scenario == "layout":
            # Full bounded enumeration establishes the live precondition, not a fixture claim.
            rows = await collection(request, fence, context, page, "participants")
            if len(rows) < (request.min_participants or 1):
                raise Stop("LAYOUT_DATA_UNAVAILABLE", "UNAVAILABLE")
            # Re-open the initial page; find the exact UUID, never a title match.
            await fence.navigate(page, reload=True)
            await select_room(request, fence, page)
        rows = await collection(request, fence, context, page, "participants", target=request.session)
        await participant(request, rows, page)
        record(fence.result, "SESSION_TITLE", viewport=viewport)
        if request.scenario == "layout":
            await layout(page)
            record(fence.result, "LAYOUT_GEOMETRY", viewport=viewport)
    else:
        rows = await collection(request, fence, context, page, "history", target=request.message)
        await history_receipt(request, rows, page)
        record(fence.result, "HISTORY_RECEIPT", viewport=viewport)
    await read_only(page)
    record(fence.result, "READ_ONLY_VIEW", viewport=viewport)
