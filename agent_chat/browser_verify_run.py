"""Private worker for browser_verify; parent owns the hard deadline and process reaping."""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
import time
from collections.abc import Awaitable, Callable
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from .browser_verify import (
    CLEANUP_SECONDS,
    MAX_PAGES,
    MAX_REQUESTS,
    VIEWPORTS,
    Binding,
    Request,
    Stop,
    evidence,
    parse,
    read_binding,
    record,
    uuid_text,
    verdict,
)
from .browser_verify_artifacts import Artifacts, capture

MAX_BODY = 2 * 1024 * 1024
# Logout and the resource closes together may use this share of the cleanup budget: six of its eight seconds. The
# rest is slack, so a close times out before the budget cancels it and the worker can still report after a run limit.
CLOSE_BUDGET_SHARE = 0.75
ASSETS = {"/": "index.html", "/ui/chat.js": "chat.js", "/ui/i18n.js": "i18n.js",
          "/ui/chat.css": "chat.css", "/ui/Manrope-Variable.ttf": "Manrope-Variable.ttf"}
PUBLIC = {"/": "document", "/ui/chat.js": "script", "/ui/i18n.js": "script", "/ui/chat.css": "style",
          "/ui/Manrope-Variable.ttf": "font", "/healthz": "health", "/readyz": "ready",
          "/v1/login": "login", "/v1/logout": "logout", "/v1/browser/session": "bootstrap"}


class Fence:
    def __init__(self, binding: Binding, result: dict[str, Any]) -> None:
        self.binding, self.result = binding, result
        self.viewer = False
        self.closing = False
        self.pages: dict[tuple[str, str], set[str]] = {}
        self.assets: set[str] = set()
        self.intentional_aborts: dict[Any, Stop] = {}
        self.incomplete_urls: set[str] = set()
        self.navigation_stop: Stop | None = None
        # Completion time of the last exchange on the shared keep-alive pool (cleanup diagnostics).
        self.exchanged = time.monotonic()

    def request_failed(self, request: Any) -> None:
        intentional = self.intentional_aborts.pop(request, None)
        if intentional is not None:
            record(self.result, intentional.code, intentional.result)
        elif not self.closing:
            record(self.result, "REQUEST_FAILED", "FAIL")

    def console(self, message: Any) -> None:
        if message.type != "error":
            return
        # Chromium also emits this resource diagnostic for our deliberate abort.
        # Do not suppress arbitrary console errors or genuine request failures.
        if (message.location.get("url") in self.incomplete_urls
                and message.text == "Failed to load resource: net::ERR_FAILED"):
            return
        record(self.result, "CONSOLE_ERROR", "FAIL")

    async def navigate(self, page: Any, *, reload: bool = False) -> None:
        self.navigation_stop = None
        try:
            if reload:
                await page.reload(wait_until="networkidle", timeout=10000)
            else:
                await page.goto(self.binding.origin + "/", wait_until="networkidle", timeout=10000)
        except Exception:
            if self.navigation_stop is not None:
                raise self.navigation_stop from None
            raise
        self.healthy()

    def target(self, url: str, method: str, *, api: bool = False, cleanup: bool = False) -> str:
        parsed = urlsplit(url)
        if (parsed.scheme + "://" + parsed.netloc != self.binding.origin or parsed.fragment
                or len(url) > 1024 or "%" in parsed.path or "\\" in url):
            raise Stop("ORIGIN_BLOCKED")
        path = parsed.path
        name = PUBLIC.get(path)
        if path == "/v1/rooms":
            name = "rooms"
        match = re.fullmatch(r"/v1/rooms/([0-9a-f-]{36})/(participants|history|state)", path)
        if match and match[1] in self.binding.room_ids:
            name = match[2]
        if name is None or (not self.viewer and name in ("rooms", "participants", "history", "state")):
            raise Stop("ROUTE_BLOCKED")
        if method != "GET" and not (api and method == "POST" and name in ("login", "logout")):
            raise Stop("METHOD_BLOCKED")
        if cleanup and name not in ("bootstrap", "logout"):
            raise Stop("ROUTE_BLOCKED")
        pairs = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True)
        query = dict(pairs)
        allowed = {"participants": {"limit", "after_session"}, "history": {"limit", "before", "after"},
                   "state": {"limit"}}.get(name, set())
        if len(query) != len(pairs) or not set(query) <= allowed:
            raise Stop("QUERY_BLOCKED")
        for key, value in pairs:
            if key == "after_session":
                try:
                    uuid_text(value)
                except ValueError:
                    raise Stop("QUERY_BLOCKED") from None
            elif key == "limit":
                if value not in ("50", "100"):
                    raise Stop("QUERY_BLOCKED")
            elif re.fullmatch(r"[0-9]{1,19}", value) is None or int(value) > 9223372036854775807:
                raise Stop("QUERY_BLOCKED")
        if "before" in query and "after" in query:
            raise Stop("QUERY_BLOCKED")
        if match:
            cursor = query.get("after_session", query.get("before", query.get("after", "initial")))
            seen = self.pages.setdefault((match[1], name), set())
            seen.add(cursor)
            if len(seen) > MAX_PAGES:
                raise Stop("PAGE_LIMIT", "UNAVAILABLE")
        # Reserve three exchanges for uncertain-login recovery, logout and confirmation.
        limit = MAX_REQUESTS if cleanup else MAX_REQUESTS - 3
        if self.result["requests"] >= limit:
            raise Stop("REQUEST_LIMIT", "UNAVAILABLE")
        self.result["requests"] += 1
        return name

    async def api(self, context: Any, path: str, *, method: str = "GET", body: Any = None,
                  csrf: str = "", cleanup: bool = False, accept: tuple[int, ...] = (200,)) -> dict[str, Any]:
        url = self.binding.origin + path
        name = self.target(url, method, api=True, cleanup=cleanup)
        response = await context.request.fetch(
            url, method=method, data=body,
            headers={"Origin": self.binding.origin, "X-CSRF-Token": csrf} if method == "POST" else {},
            max_redirects=0, max_retries=0, timeout=1000 if cleanup else 5000,
        )
        try:
            if 300 <= response.status < 400:
                raise Stop("REDIRECT_BLOCKED", http_status=response.status)
            if response.status not in accept:
                if name == "login" and response.status in (401, 403, 429):
                    raise Stop("LOGIN_UNAVAILABLE", "UNAVAILABLE", response.status)
                raise Stop("REQUIRED_HTTP_ERROR", http_status=response.status)
            content = await response.body()
            if len(content) > MAX_BODY:
                raise Stop("RESPONSE_LIMIT", "UNAVAILABLE")
            try:
                data = json.loads(content)
            except (ValueError, UnicodeError):
                raise Stop("API_SHAPE_MISMATCH") from None
            if not isinstance(data, dict):
                raise Stop("API_SHAPE_MISMATCH")
            return {**data, "_status": response.status}
        finally:
            await response.dispose()
            self.exchanged = time.monotonic()

    async def route(self, route: Any) -> None:
        response = None
        try:
            if self.closing:
                await route.abort()
                return
            request = route.request
            name = self.target(request.url, request.method)
            if request.redirected_from is not None:
                raise Stop("REDIRECT_BLOCKED")
            if request.resource_type in ("eventsource", "websocket", "manifest", "other"):
                raise Stop("RESOURCE_BLOCKED")
            # route.continue_() follows redirects before a response listener can stop them.
            # This transport is independently bound just like context.request, not trusted
            # on the assumption that a browser route also intercepts APIRequestContext.
            response = await route.fetch(max_redirects=0, max_retries=0, timeout=5000)
            self.exchanged = time.monotonic()
            if 300 <= response.status < 400:
                raise Stop("REDIRECT_BLOCKED")
            if response.status != 200:
                raise Stop("REQUIRED_HTTP_ERROR")
            if "attachment" in response.headers.get("content-disposition", "").lower():
                raise Stop("DOWNLOAD_BLOCKED")
            body = await response.body()
            if len(body) > MAX_BODY:
                raise Stop("RESPONSE_LIMIT", "UNAVAILABLE")
            if urlsplit(request.url).path == "/v1/browser/session":
                data = json.loads(body)
                if data.get("access") != "viewer":
                    self.viewer = False
                    raise Stop("ACCESS_KIND_MISMATCH")
            asset = ASSETS.get(urlsplit(request.url).path)
            if asset is not None:
                digest = sha256(body).hexdigest()
                previous = self.result["served_hashes"][asset]
                self.result["served_hashes"][asset] = digest
                if previous not in ("unknown", digest):
                    raise Stop("ASSET_CHANGED")
            await route.fulfill(response=response, body=body)
            if name in ("script", "style"):
                self.assets.add(name)
        except Stop as error:
            record(self.result, error.code, error.result)
            self.intentional_aborts[route.request] = error
            if error.result == "UNAVAILABLE":
                self.incomplete_urls.add(route.request.url)
            if route.request.resource_type == "document":
                self.navigation_stop = error
            await route.abort()
        except Exception:
            record(self.result, "REQUEST_FAILED", "FAIL")
            await route.abort()
        finally:
            if response is not None:
                await response.dispose()

    def healthy(self) -> None:
        failures = [entry for entry in self.result["assertions"] if entry["result"] != "PASS"]
        if failures:
            first = failures[0]
            raise Stop(first["code"], first["result"])


async def cleanup_step(fence: Fence, step: str,
                       call: Callable[[], Awaitable[dict[str, Any]]]) -> dict[str, Any] | None:
    """Run one logout exchange; record its fixed-vocabulary outcome, never exception or URL text."""
    from playwright.async_api import Error
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    started = time.monotonic()
    # "deadline" survives only if the outer cleanup budget cancels this exchange. idle_ms
    # separates a reused stale keep-alive socket from a slow server.
    entry: dict[str, Any] = {"step": step, "outcome": "deadline", "http_status": None, "elapsed_ms": 0,
                             "idle_ms": round((started - fence.exchanged) * 1000)}
    fence.result["cleanup_steps"].append(entry)
    try:
        response = await call()
        entry["outcome"], entry["http_status"] = "ok", response["_status"]
        return response
    except Stop as error:
        entry["outcome"] = "http_status" if error.http_status is not None else error.code
        entry["http_status"] = error.http_status
    except PlaywrightTimeout:
        entry["outcome"] = "timeout"
    except Error as error:
        message = str(error)
        entry["outcome"] = "reset" if "ECONNRESET" in message or "socket hang up" in message else "transport"
    except Exception:
        entry["outcome"] = "other"
    finally:
        entry["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return None


async def blocked_surface(result: dict[str, Any], code: str, surface: Any) -> None:
    record(result, code, "FAIL")
    await surface.close()


async def inspect(request: Request, fence: Fence, context: Any, page: Any, artifacts: Artifacts | None) -> None:
    from .browser_verify_checks import scenario, select_room

    for viewport, (width, height) in enumerate(VIEWPORTS):
        await page.set_viewport_size({"width": width, "height": height})
        fence.assets.clear()
        await fence.navigate(page)
        if fence.assets != {"script", "style"}:
            raise Stop("ASSET_UNAVAILABLE", "UNAVAILABLE")
        record(fence.result, "ASSET_HTTP", viewport=viewport)
        await select_room(request, fence, page)
        await scenario(request, fence, context, page, viewport)
        fence.healthy()
        if artifacts is not None:
            await capture(request, page, artifacts, viewport, viewer=fence.viewer)
            record(fence.result, "SCREENSHOT_CAPTURE", viewport=viewport)


async def run(request: Request, binding: Binding, test_spki: str | None = None,
              artifacts: Artifacts | None = None) -> dict[str, Any]:
    result = evidence(request, binding)
    fence = Fence(binding, result)
    driver = browser = context = None
    login_attempted = False
    csrf = ""
    transport_error: type[Exception] | None = None

    async def operation() -> None:
        nonlocal driver, browser, context, login_attempted, csrf, transport_error
        try:
            from playwright.async_api import Error, async_playwright
            transport_error = Error
        except ImportError:
            raise Stop("BROWSER_UNAVAILABLE", "UNAVAILABLE") from None
        driver = await async_playwright().start()
        try:
            browser = await driver.chromium.launch(
                args=["--ignore-certificate-errors-spki-list=" + test_spki] if test_spki else [],
                downloads_path=str(Path.home() / "downloads"), timeout=15000,
            )
        except Exception:
            raise Stop("BROWSER_UNAVAILABLE", "UNAVAILABLE") from None
        context = await browser.new_context(
            viewport={"width": 1280, "height": 720}, service_workers="block", accept_downloads=False,
        )
        context.set_default_timeout(5000)
        await context.route("**/*", fence.route)

        async def socket(route: Any) -> None:
            record(result, "WEBSOCKET_BLOCKED", "FAIL")
            await route.close()

        await context.route_web_socket("**/*", socket)
        challenge = await fence.api(context, "/v1/login")
        challenge_csrf = challenge.get("csrf_token")
        if not isinstance(challenge_csrf, str) or re.fullmatch(r"[0-9a-f]{64}", challenge_csrf) is None:
            raise Stop("API_SHAPE_MISMATCH")
        login_attempted = True
        login = await fence.api(context, "/v1/login", method="POST", body={"token": binding.viewer_token},
                                csrf=challenge_csrf)
        login_csrf = login.get("csrf_token")
        csrf = login_csrf if isinstance(login_csrf, str) else ""
        bootstrap = await fence.api(context, "/v1/browser/session")
        bootstrap_csrf = bootstrap.get("csrf_token")
        csrf = bootstrap_csrf if isinstance(bootstrap_csrf, str) else csrf
        if bootstrap.get("access") != "viewer" or login.get("access") != "viewer":
            raise Stop("ACCESS_KIND_MISMATCH")
        if not isinstance(csrf, str) or re.fullmatch(r"[0-9a-f]{64}", csrf) is None:
            raise Stop("API_SHAPE_MISMATCH")
        if type(login.get("expires_in")) is not int or not 1 <= login["expires_in"] <= 600:
            raise Stop("SESSION_LIFETIME_MISMATCH")
        fence.viewer = True
        result["cookie_max_lifetime_seconds"] = login["expires_in"]
        record(result, "VIEWER_BOOTSTRAP")
        for path, status in (("/healthz", "ok"), ("/readyz", "ready")):
            if (await fence.api(context, path)).get("status") != status:
                raise Stop("HEALTH_MISMATCH")
        record(result, "HEALTH_READY")
        rooms = (await fence.api(context, "/v1/rooms")).get("rooms")
        if not isinstance(rooms, list) or not all(isinstance(room, dict) for room in rooms):
            raise Stop("API_SHAPE_MISMATCH")
        ids = [room["id"] for room in rooms]
        if len(set(ids)) != len(ids) or not set(ids) <= set(binding.room_ids):
            raise Stop("ROOM_SCOPE_MISMATCH")
        if request.room not in ids:
            raise Stop("ROOM_UNAVAILABLE", "UNAVAILABLE")
        record(result, "ROOM_SCOPE")
        page = await context.new_page()

        async def new_page(other: Any) -> None:
            if other != page:
                await blocked_surface(result, "POPUP_BLOCKED", other)

        context.on("page", new_page)
        page.on("pageerror", lambda _: record(result, "JAVASCRIPT_ERROR", "FAIL"))
        page.on("console", fence.console)
        page.on("requestfailed", fence.request_failed)
        page.on("download", lambda download: cancel_download(download, result))
        page.on("worker", lambda _: record(result, "WORKER_BLOCKED", "FAIL"))
        page.on("dialog", lambda dialog: dismiss_dialog(dialog, result))
        # Prevent creation, rather than merely reacting after a popup/worker has
        # already sent its first request. These fixed guards contain no page input.
        def blocked(_source: Any, code: Any) -> None:
            permitted = {"WORKER_BLOCKED", "POPUP_BLOCKED", "SERVICE_WORKER_BLOCKED"}
            record(result, code if isinstance(code, str) and code in permitted else "RESOURCE_BLOCKED", "FAIL")

        await context.expose_binding("__agentChatVerifyBlocked", blocked)
        await context.add_init_script("""
            (() => {
              const report = window.__agentChatVerifyBlocked;
              for (const name of ['Worker', 'SharedWorker']) {
                Object.defineProperty(window, name, {value: function() {
                  report('WORKER_BLOCKED'); throw Error('WORKER_BLOCKED');
                }});
              }
              Object.defineProperty(window, 'open', {value: function() {
                report('POPUP_BLOCKED'); throw Error('POPUP_BLOCKED');
              }});
              if (navigator.serviceWorker) {
                Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {value: function() {
                  report('SERVICE_WORKER_BLOCKED'); return Promise.reject(Error('SERVICE_WORKER_BLOCKED'));
                }});
              }
            })();
        """)
        await inspect(request, fence, context, page, artifacts)
        record(result, "BROWSER_ERRORS")

    task = asyncio.create_task(operation())
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await asyncio.wait_for(task, timeout=120)
    except Stop as error:
        record(result, error.code, error.result)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        record(result, "RUN_LIMIT", "UNAVAILABLE")
    except Exception as error:
        # Classify TLS/network prerequisites without copying URL-bearing exception text.
        unavailable = not fence.viewer and transport_error is not None and isinstance(error, transport_error)
        record(result, "AUTH_TRANSPORT_UNAVAILABLE" if unavailable else "UNEXPECTED_ERROR",
               "UNAVAILABLE" if unavailable else "FAIL")
    finally:
        fence.closing = True

        budget = CLEANUP_SECONDS - 2

        async def cleanup() -> None:
            nonlocal csrf
            closing_end = time.monotonic() + budget * CLOSE_BUDGET_SHARE
            if context is not None and login_attempted:
                uncertain = False
                if not csrf:
                    bootstrap = await cleanup_step(fence, "bootstrap", lambda: fence.api(
                        context, "/v1/browser/session", cleanup=True, accept=(200, 401)))
                    if bootstrap is None:
                        uncertain = True
                    else:
                        value = bootstrap.get("csrf_token")
                        csrf = value if isinstance(value, str) else ""
                # Failure to recover CSRF must not skip the logout attempt itself.
                if await cleanup_step(fence, "logout", lambda: fence.api(
                        context, "/v1/logout", method="POST", body={}, csrf=csrf,
                        cleanup=True, accept=(200, 401))) is None:
                    uncertain = True
                confirmation = await cleanup_step(fence, "confirm", lambda: fence.api(
                    context, "/v1/browser/session", cleanup=True, accept=(200, 401)))
                if confirmation is None:
                    uncertain = True
                else:
                    result["cleanup"]["logout"] = "PASS" if confirmation["_status"] == 401 else "FAIL"
                if uncertain:
                    result["cleanup"]["logout"] = "UNAVAILABLE"
            # Each independent resource gets its own attempt, even if the previous close fails. A close gets an
            # equal share of the time left, so a slow one cannot starve the next and a quick one leaves its time
            # to the rest.
            closes = [("context", context.close if context is not None else None),
                      ("browser", browser.close if browser is not None else None),
                      ("driver", driver.stop if driver is not None else None)]
            pending = [(name, close) for name, close in closes if close is not None]
            for position, (name, close) in enumerate(pending):
                # "deadline" survives only if the outer cleanup budget cancels this close, as it does a close
                # that ignores its own timeout. The driver's failure is reported as the browser's, so the step
                # names which resource was slow.
                started = time.monotonic()
                entry: dict[str, Any] = {"step": name, "outcome": "deadline", "elapsed_ms": 0}
                result["close_steps"].append(entry)
                try:
                    await asyncio.wait_for(close(), timeout=(closing_end - started) / (len(pending) - position))
                    entry["outcome"] = "ok"
                    if name != "driver":
                        result["cleanup"][name] = "PASS"
                except Exception as error:
                    entry["outcome"] = "timeout" if isinstance(error, asyncio.TimeoutError) else "other"
                    result["cleanup"]["browser" if name == "driver" else name] = "UNAVAILABLE"
                finally:
                    entry["elapsed_ms"] = round((time.monotonic() - started) * 1000)

        try:
            await asyncio.wait_for(cleanup(), timeout=budget)
        except asyncio.TimeoutError:
            for name in ("logout", "context", "browser"):
                if result["cleanup"][name] == "NOT_RUN":
                    result["cleanup"][name] = "UNAVAILABLE"
        loop.remove_signal_handler(signal.SIGTERM)
    verdict(result)
    return result


async def cancel_download(download: Any, result: dict[str, Any]) -> None:
    record(result, "DOWNLOAD_BLOCKED", "FAIL")
    await download.cancel()


async def dismiss_dialog(dialog: Any, result: dict[str, Any]) -> None:
    record(result, "DIALOG_BLOCKED", "FAIL")
    await dialog.dismiss()


def worker() -> None:
    result = evidence()
    artifacts = None
    try:
        payload = json.loads(sys.stdin.buffer.read(16385))
        request = parse(payload["argv"])
        result = evidence(request)
        binding = read_binding(request.binding)
        result = evidence(request, binding)
        policy = binding.artifact_policy
        policy_record = [str(policy.root), policy.retention_seconds] if policy else None
        if (binding.origin != payload["origin"] or list(binding.room_ids) != payload["room_ids"]
                or request.room not in binding.room_ids or policy_record != payload["artifact_policy"]):
            raise Stop("BINDING_CHANGED")
        if request.screenshot:
            if policy is None or payload["artifact_target"] is None:
                raise Stop("ARTIFACT_POLICY_UNAVAILABLE", "UNAVAILABLE")
            target = payload["artifact_target"]
            artifacts = Artifacts.attach(policy, target["name"], target["fd"])
            os.close(target["fd"])
        pin = payload["test_spki"]
        if pin is not None and (not isinstance(pin, str) or re.fullmatch(r"[A-Za-z0-9+/]{43}=", pin) is None
                                or urlsplit(binding.origin).hostname != "127.0.0.1"):
            raise Stop("TEST_TRUST_INVALID")
        result = asyncio.run(run(request, binding, pin, artifacts))
    except Stop as error:
        record(result, error.code, error.result)
    except Exception:
        record(result, "UNEXPECTED_ERROR", "FAIL")
    finally:
        if artifacts is not None:
            artifacts.close()
    verdict(result)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    worker()
