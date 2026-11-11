"""Opt-in private PNGs under a binding-owned retention contract; no expiry provisioning."""
from __future__ import annotations

import os
import re
import stat
import struct
import zlib
from typing import Any
from uuid import uuid4

from .browser_verify import ArtifactPolicy, Request, Stop, private_directory

MAX_IMAGES = 4
MAX_IMAGE_BYTES = 5 * 1024 * 1024
PNG_HEADER = b"\x89PNG\r\n\x1a\n"


def png_bounds(content: bytes) -> None:
    if len(content) > MAX_IMAGE_BYTES:
        raise Stop("ARTIFACT_LIMIT", "UNAVAILABLE")
    if not content.startswith(PNG_HEADER):
        raise Stop("CAPTURE_PNG_INVALID")
    offset, chunks = 8, []
    while offset < len(content):
        if offset + 12 > len(content):
            raise Stop("CAPTURE_PNG_INVALID")
        size = int.from_bytes(content[offset:offset + 4], "big")
        kind = content[offset + 4:offset + 8]
        end = offset + 8 + size
        if end + 4 > len(content) or kind not in (b"IHDR", b"IDAT", b"IEND", b"sRGB"):
            # In particular, never retain PNG text/EXIF chunks as a hidden text channel.
            raise Stop("CAPTURE_PNG_INVALID")
        if zlib.crc32(content[offset + 4:end]) != int.from_bytes(content[end:end + 4], "big"):
            raise Stop("CAPTURE_PNG_INVALID")
        if kind == b"IHDR":
            if chunks or size != 13:
                raise Stop("CAPTURE_PNG_INVALID")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", content[offset + 8:end])
            if (not 1 <= width <= 1280 or not 1 <= height <= 4096 or depth != 8 or color not in (2, 6)
                    or compression or filtering or interlace):
                raise Stop("CAPTURE_PNG_INVALID")
        if (kind == b"sRGB" and (size != 1 or content[offset + 8] > 3)
                or kind == b"IEND" and size != 0 or len(chunks) >= 1024):
            raise Stop("CAPTURE_PNG_INVALID")
        chunks.append(kind)
        offset = end + 4
    if not chunks or chunks[0] != b"IHDR" or chunks[-1] != b"IEND" or b"IDAT" not in chunks:
        raise Stop("CAPTURE_PNG_INVALID")


class Artifacts:
    def __init__(self, policy: ArtifactPolicy, name: str, root_fd: int, directory_fd: int) -> None:
        self.policy, self.name = policy, name
        self.root_fd, self.directory_fd = root_fd, directory_fd

    @classmethod
    def create(cls, policy: ArtifactPolicy) -> Artifacts:
        root = private_directory(policy.root, "ARTIFACT_UNSAFE")
        name = "run-" + uuid4().hex
        made = False
        try:
            os.mkdir(name, mode=0o700, dir_fd=root)
            made = True
            directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        except (OSError, Stop):
            if made:
                os.rmdir(name, dir_fd=root)
            os.close(root)
            raise
        result = cls(policy, name, root, directory)
        try:
            result.validate()
        except (OSError, Stop):
            try:
                result.discard()
            finally:
                result.close()
            raise
        return result

    @classmethod
    def attach(cls, policy: ArtifactPolicy, name: str, inherited_fd: int) -> Artifacts:
        if re.fullmatch(r"run-[0-9a-f]{32}", name) is None:
            raise Stop("ARTIFACT_UNSAFE")
        root = private_directory(policy.root, "ARTIFACT_UNSAFE")
        try:
            directory = os.dup(inherited_fd)
        except OSError:
            os.close(root)
            raise
        result = cls(policy, name, root, directory)
        try:
            result.validate()
        except (OSError, Stop):
            result.close()
            raise
        return result

    def validate(self) -> None:
        current = private_directory(self.policy.root, "ARTIFACT_UNSAFE")
        try:
            root = os.fstat(self.root_fd)
            reopened = os.fstat(current)
            directory = os.fstat(self.directory_fd)
            try:
                named = os.stat(self.name, dir_fd=current, follow_symlinks=False)
            except OSError:
                raise Stop("ARTIFACT_UNSAFE") from None
            if ((root.st_dev, root.st_ino) != (reopened.st_dev, reopened.st_ino)
                    or (directory.st_dev, directory.st_ino) != (named.st_dev, named.st_ino)
                    or not stat.S_ISDIR(named.st_mode) or directory.st_uid != os.geteuid()
                    or stat.S_IMODE(directory.st_mode) != 0o700):
                raise Stop("ARTIFACT_UNSAFE")
        finally:
            os.close(current)

    def save(self, number: int, content: bytes) -> None:
        if type(number) is not int or not 0 <= number < MAX_IMAGES:
            raise Stop("ARTIFACT_LIMIT", "UNAVAILABLE")
        png_bounds(content)
        self.validate()
        name = f"capture-{number}.png"
        # No pathname is given to Playwright. Only checked in-memory PNG bytes reach
        # an exclusively-created descriptor in this run's already-open directory.
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.directory_fd)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise Stop("ARTIFACT_UNSAFE")
            remaining = memoryview(content)
            while remaining:
                written = os.write(fd, remaining)
                if not written:
                    raise Stop("CAPTURE_WRITE_FAILED")
                remaining = remaining[written:]
            os.fsync(fd)
        except (OSError, Stop):
            os.unlink(name, dir_fd=self.directory_fd)
            raise
        finally:
            os.close(fd)

    def paths(self, expected: int) -> list[str]:
        self.validate()
        paths = []
        for number in range(MAX_IMAGES):
            name = f"capture-{number}.png"
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.directory_fd)
            except FileNotFoundError:
                continue
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1
                        or not 1 <= info.st_size <= MAX_IMAGE_BYTES):
                    raise Stop("ARTIFACT_UNSAFE")
                png_bounds(stream.read(MAX_IMAGE_BYTES + 1))
            paths.append(str(self.policy.root / self.name / name))
        if len(paths) != expected:
            raise Stop("CAPTURE_INCOMPLETE", "UNAVAILABLE")
        return paths

    def discard(self) -> None:
        # This namespace was created exclusively for this run. Unlinking these fixed
        # names never follows a symlink or touches any other run under the root.
        for number in range(MAX_IMAGES):
            try:
                os.unlink(f"capture-{number}.png", dir_fd=self.directory_fd)
            except FileNotFoundError:
                pass
        named = os.stat(self.name, dir_fd=self.root_fd, follow_symlinks=False)
        owned = os.fstat(self.directory_fd)
        if (named.st_dev, named.st_ino) != (owned.st_dev, owned.st_ino) or not stat.S_ISDIR(named.st_mode):
            raise Stop("ARTIFACT_UNSAFE")
        os.rmdir(self.name, dir_fd=self.root_fd)

    def close(self) -> None:
        try:
            os.close(self.directory_fd)
        finally:
            os.close(self.root_fd)


# A deny-by-default mask inventory: keep only an independently expected selected
# title or the fixed receipt-state vocabulary. Unexpected ancestor text fails
# rather than escaping between masks. No DOM/text inventory leaves the page.
PREPARE = """(root, input) => {
  const nodes = [root, ...root.querySelectorAll('*')];
  if (nodes.length > 512) return {safe:false};
  let allowed = [];
  if (input.kind === 'session-title' || input.kind === 'layout') {
    const title = root.querySelector('.session-title');
    if (input.title && title && !title.children.length && title.textContent === input.title) allowed = [title];
  } else if (input.kind === 'history-receipt') {
    const safe = new Set(['zapis: tak','zapis: —','przekazanie: tak','przekazanie: —',
                          'ACK: tak','ACK: —','odpowiedź: tak','odpowiedź: —']);
    allowed = [...root.querySelectorAll('.receipt-summary .receipt-state')]
      .filter(n => !n.children.length && safe.has(n.textContent));
  }
  const keep = n => allowed.includes(n) || allowed.some(a => n.contains(a));
  if (allowed.length && nodes.some(n => keep(n) && !allowed.includes(n) &&
      [...n.childNodes].some(c => c.nodeType === Node.TEXT_NODE && c.textContent.trim()))) return {safe:false};
  const masked = allowed.length ? nodes.filter(n => !keep(n)) : [root];
  if (!masked.length) return {safe:false};
  root.setAttribute('data-agent-chat-verify-component', input.nonce);
  for (const node of masked) node.setAttribute('data-agent-chat-verify-mask', input.nonce);
  const state = {root, masked, dirty:false, nonce:input.nonce};
  state.observer = new MutationObserver(() => { state.dirty = true; });
  state.observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true});
  window.__agentChatCapture = state;
  return {safe:true, count:masked.length};
}"""
VERIFY = """(root, nonce) => {
  const s = window.__agentChatCapture;
  return Boolean(s && s.root === root && s.nonce === nonce && !s.dirty && !s.observer.takeRecords().length &&
    s.masked.every(n => n.isConnected && n.getAttribute('data-agent-chat-verify-mask') === nonce));
}"""
REMOVE = """() => {
  const s = window.__agentChatCapture;
  if (!s) return;
  s.observer.disconnect(); s.root.removeAttribute('data-agent-chat-verify-component');
  for (const n of s.masked) n.removeAttribute('data-agent-chat-verify-mask');
  delete window.__agentChatCapture;
}"""


async def capture(request: Request, page: Any, artifacts: Artifacts, number: int, *, viewer: bool) -> None:
    if not viewer or not await page.locator("#viewer[data-access='viewer']").is_visible():
        raise Stop("CAPTURE_ACCESS_MISMATCH")
    if request.scenario in ("session-title", "layout"):
        selector = f"#participants > li[data-session-id='{request.session}']"
    elif request.scenario == "history-receipt":
        selector = f"#messages > li[data-message-id='{request.message}']"
    else:
        selector = "#read-only-indicator"
    component = page.locator(selector)
    nonce = uuid4().hex
    content = None
    try:
        if await component.count() != 1 or not await component.is_visible():
            raise Stop("CAPTURE_COMPONENT_UNAVAILABLE", "UNAVAILABLE")
        box = await component.bounding_box()
        if box is None or not 1 <= box["width"] <= 1280 or not 1 <= box["height"] <= 4096:
            raise Stop("ARTIFACT_LIMIT", "UNAVAILABLE")
        prepared = await component.evaluate(PREPARE, {"kind": request.scenario,
                                                    "title": request.expected_title, "nonce": nonce})
        masks = page.locator(f'[data-agent-chat-verify-mask="{nonce}"]')
        if not prepared.get("safe") or await masks.count() != prepared["count"]:
            raise Stop("CAPTURE_MASK_FAILED")
        # Exclude unrelated overlays outside the selected component as well as
        # masking private descendants with opaque black rectangles, never blur.
        visible = f'[data-agent-chat-verify-component="{nonce}"]'
        style = ("body * {visibility:hidden !important; background-image:none !important} "
                 f"{visible}, {visible} * {{visibility:visible !important}} "
                 "*::before,*::after,*::marker {content:none !important}")
        content = await component.screenshot(type="png", mask=[masks], mask_color="#000000",
                                             animations="disabled", caret="hide", style=style, timeout=5000)
        if not await component.evaluate(VERIFY, nonce):
            raise Stop("CAPTURE_MASK_FAILED")
    except Stop:
        raise
    except Exception:
        raise Stop("CAPTURE_FAILED") from None
    finally:
        # A cleanup failure must also discard the in-memory capture; never fall
        # back to an unmasked image or a different component.
        try:
            await page.evaluate(REMOVE)
        except Exception:
            raise Stop("CAPTURE_MASK_FAILED") from None
    if content is None:
        raise Stop("CAPTURE_FAILED")
    try:
        artifacts.save(number, content)
    except OSError:
        raise Stop("CAPTURE_WRITE_FAILED") from None
