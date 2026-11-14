"use strict";

const t = window.AgentChatI18n.t;
const UI_LOCALE = window.AgentChatI18n.locale;

// Operator publications use an immutable in-memory attempt. No ACK or automatic retry.
(() => {
  const el = (id) => document.getElementById(id);
  let csrf = null;
  let principal = null;
  let access = null;
  const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

  function acceptSession(data) {
    if (!uuid(data.principal_id) || typeof data.csrf_token !== "string" || !/^[0-9a-f]{64}$/.test(data.csrf_token)
        || !["operator", "viewer"].includes(data.access)) {
      const error = new Error("INVALID_SESSION");
      error.status = 401;
      throw error;
    }
    if (principal !== data.principal_id || access !== data.access) scopeEpoch += 1;
    principal = data.principal_id;
    csrf = data.csrf_token;
    access = data.access;
    el("viewer").dataset.access = access;
    el("read-only-indicator").hidden = access !== "viewer";
  }
  let generation = 0;
  // Bumped only when the authenticated scope really changes (login/logout, room switch, SSE scope
  // invalidation), never by a harmless live-refresh cycle. Sessions reads and their deferred request
  // fence on this, so a refresh restart cannot discard work the operator already asked for.
  let scopeEpoch = 0;
  let requestController = new AbortController();
  // History pages hold the newest messages below a cursor; a null page start is the newest page.
  let historyCursor = null;
  let historyPageStart = null;
  let participantCursor = null;
  let participantPageStart = null;
  // True while the loaded roster page is not the whole room: a next page exists, or this page is not the first. The
  // server sends a page and a cursor, never a room-wide total, so the roster counts describe the loaded page only.
  let rosterPartial = false;
  let selectedRoom = "";
  let selectedThread = null;
  let selectedRef = null;
  let lastMessages = [];
  const participantNames = new Map();
  // Which roster rows, and whether the PM line, have their details open. A reload rebuilds both from the server's
  // answer, so the reader's choice lives here and not in the nodes.
  const openRows = new Set();
  let pmDetailsOpen = false;
  // Bumped whenever the room view is dropped, so a late expiry timer or state read never paints another room.
  let stateEpoch = 0;
  let stateTimer = null;
  let composerReady = false;
  let controlsReady = false;
  const targets = new Map();
  let replyTarget = null;
  let pending = null;
  let sending = false;
  let controlRequest = null;
  let live = null;
  let view = "chat";
  // The narrow layout scrolls the document and hiding the tall conversation clamps that position, so the
  // reading position is saved when the conversation is hidden and restored once it is visible again.
  let savedChatScroll = null;
  let sessionsPage = null;
  let sessionsLoading = false;
  let sessionsLoadingMore = false;
  // A first visit to Sesje can arrive while a write or a live refresh is in flight; remember the request
  // and satisfy it when that operation settles instead of leaving the view empty.
  let sessionsDeferred = null;
  // A flush asked for while a sessions read is already in flight runs when that read settles.
  let sessionsFlushPending = false;
  // The one value this page keeps in browser storage: a per-browser request to start live events after a load or a
  // login. It carries no credential, draft or scope, and grants nothing; every start still revalidates the binding.
  const LIVE_KEY = "agent-chat.live";
  // The page reads the choice from storage once, when it loads, and acts on this value from then on: only the
  // switch changes it. A refresh, a logout and a new login keep it whether or not storage works, and a change that
  // another tab stores is adopted at the next load, never in the middle of this page.
  let liveWanted = (() => {
    try { return window.localStorage.getItem(LIVE_KEY) === "1"; } catch { return false; }
  })();
  function rememberLive(on) {
    liveWanted = on;
    try {
      if (on) window.localStorage.setItem(LIVE_KEY, "1");
      else window.localStorage.removeItem(LIVE_KEY);
    } catch { /* Storage may be blocked; the choice then lasts for this page only. */ }
  }
  let reads = 0;
  let historyEventCursor = "0";
  let historyFloor = "0";
  const cursorValid = (value) => typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
  // The server reads any `before` cursor above the event clock as "now", i.e. the newest page.
  const NEWEST = "9223372036854775807";
  // The same grammar the server enforces on a thread key; the server stays the authority.
  const REF_KEY = /^(pr:[A-Za-z0-9_.-]{1,40}\/[A-Za-z0-9_.-]{1,80}#[1-9][0-9]{0,9}|lane:[A-Za-z0-9_.\/-]{1,80}::[A-Za-z0-9-]{1,40}|resource:[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62})$/;
  const KIND_LABELS = {
    message: t("Wiadomość"), status: t("Status"), question: t("Pytanie"), consultation: t("Konsultacja"), reply: t("Odpowiedź"),
    heads_up: t("Uwaga"), blocked_on: t("Zablokowany przez"), decision_needed: t("Potrzebna decyzja"), intent: t("Zamiar"),
  };
  const QUESTION_KINDS = new Set(["question", "consultation"]);
  // Safe, allowlisted server refusals. An unknown code keeps the generic fallback.
  const REFUSAL_TEXT = {
    ROLE_CONFLICT: t("Ta sesja ma już inną rolę w tym pokoju. Zdejmij obecną rolę i spróbuj ponownie."),
    ROOM_CONFLICT: t("Nie można utworzyć pokoju o tym identyfikatorze."),
    INVALID_REQUEST: t("Serwer odrzucił żądanie. Sprawdź wybrane wartości."),
    INVALID_RECIPIENT: t("Wybrany odbiorca nie jest już dostępny w tym pokoju."),
    MESSAGE_EXPIRED: t("Wiadomość wygasła; nie można wykonać tej operacji."),
    STALE_INSTANCE: t("Ta sesja nie jest już aktywna. Odśwież widok."),
    ROOM_FORBIDDEN: t("Brak dostępu do tego pokoju."),
    SESSION_FORBIDDEN: t("Brak uprawnień do tej zmiany."),
    NOT_FOUND: t("Nie znaleziono obiektu. Odśwież widok."),
  };
  // Only a refusal that cannot mask a revoked scope may keep the loaded view.
  // NOT_FOUND can deliberately mask ROOM_FORBIDDEN for a message-derived room.
  const PRESERVE_ON_REFUSAL = new Set(["ROLE_CONFLICT"]);
  function refusal(error) {
    const detail = REFUSAL_TEXT[error.code];
    return detail ? `${error.code}: ${t(detail)}` : "";
  }
  const TIME_FORMAT = new Intl.DateTimeFormat(UI_LOCALE, { dateStyle: "short", timeStyle: "short" });

  // Secondary panels are disclosures where they would crowd the conversation: below 821 px the roster and the resource
  // observations stack under the app bar and start collapsed.
  for (const [id, query] of [["participants-details", "(max-width: 820px)"], ["room-state", "(max-width: 820px)"]]) {
    const panel = el(id);
    const media = window.matchMedia(query);
    const sync = () => { if (panel) panel.open = !media.matches; };
    sync();
    media.addEventListener("change", sync);
  }

  // Writes block the draft fields; a live refresh blocks navigation and controls but never typing.
  function writesBusy() { return pending !== null || sending || controlRequest !== null; }
  function busy() { return writesBusy() || live?.loading === true; }
  // True while `held` is no longer the owner that started the work, or the view moved on.
  function stale(held, expected, current) { return held !== expected || current !== generation; }

  function composerDraft() { return el("body").value || el("ref-key").value || targets.size || replyTarget; }

  function syncComposer() {
    const writable = access === "operator";
    el("composer").hidden = !writable || (!composerReady && !composerDraft());
    el("room-admin").hidden = !writable;
    el("draft-fields").disabled = !writable || writesBusy();
    el("send").disabled = !writable || busy() || !composerReady;
    el("room-fields").disabled = !writable || busy() || !controlsReady;
    el("membership-fields").disabled = !writable || busy() || !composerReady;
    el("kind").disabled = !writable || replyTarget !== null;
    // A keyed thread opens only through a new post; a question or consultation (wake-eligible) never names one.
    const question = QUESTION_KINDS.has(el("kind").value);
    el("ref-key").disabled = !writable || writesBusy() || replyTarget !== null || question;
    el("ref-key-hint").textContent = replyTarget
      ? t("Odpowiedź dziedziczy wątek; klucz wątku jest niedostępny.")
      : question
        ? t("Pytanie i konsultacja nie przyjmują klucza wątku.")
        : t("Opcjonalny klucz nowego wątku.");
    el("ref-key-hint").hidden = replyTarget === null && !question;
    el("pending").hidden = pending === null;
    el("retry-write").disabled = el("abandon-write").disabled = !writable || sending;
    for (const id of ["room", "refresh", "more-messages", "more-participants", "latest", "more-sessions"])
      el(id).disabled = busy();
    el("latest").hidden = historyPageStart === null;
    for (const id of ["thread", "apply-thread", "all-history"])
      el(id).disabled = busy() || !composerReady;
    // A live read must not blur a focused message action. The handlers themselves
    // refuse while busy(); only a write or a missing composer disables these controls.
    for (const button of document.querySelectorAll(".reply, .mute-session, .pm-session, .role-session, .resolve-thread, .choose-target")) {
      button.disabled = !writable || writesBusy() || !composerReady;
      button.hidden = !writable;
    }
    for (const button of document.querySelectorAll(".show-thread"))
      button.disabled = writesBusy() || !composerReady;
    el("targets").replaceChildren(...Array.from(targets, ([id, label]) => {
      const item = document.createElement("li");
      item.append(bdi(label), ` · ${id}`);
      return item;
    }));
    for (const row of el("participants").children) row.classList.toggle("is-target", targets.has(row.dataset.sessionId));
    el("reply-target").textContent = replyTarget
      ? t("Odpowiedź na {id} · wątek {thread}", { id: replyTarget.id, thread: replyTarget.thread_id })
      : t("Nowy wątek");
    const roomOption = el("room").selectedOptions[0];
    el("room-title").textContent = selectedRoom && roomOption
      ? (roomOption.dataset.label || roomOption.textContent)
      : t("Wybierz pokój");
    el("live-toggle").hidden = csrf === null || el("viewer").hidden;
    el("live-toggle").disabled = live === null && (busy() || !composerReady);
    scheduleLive(live);
  }

  function clearDraft() {
    targets.clear();
    replyTarget = null;
    el("body").value = "";
    el("ref-key").value = "";
    el("kind").value = "message";
    syncComposer();
  }

  function hasDraft() {
    return composerDraft() || el("room-slug").value || el("room-label").value || el("member-session").value;
  }

  function mayDiscard() {
    if (pending) return window.confirm(t("Zapis mógł już powstać. Usunąć wyłącznie lokalną kopię próby? To nie cofa zapisu na serwerze."));
    if (controlRequest && !window.confirm(t("Zmiana administracyjna może zostać zapisana mimo opuszczenia widoku. Kontynuować?"))) return false;
    return !hasDraft() || window.confirm(t("Usunąć niezapisany szkic?"));
  }

  function invalidate(abort = true) {
    generation += 1;
    if (abort) requestController.abort();
    requestController = new AbortController();
    return generation;
  }

  function clearSnapshot() {
    lastMessages = [];
    participantNames.clear();
    el("messages").replaceChildren();
    el("participants").replaceChildren();
    el("pm-mark").hidden = true;
    // The sessions table is scope-sensitive too: clear its page and DOM with the rest of the snapshot.
    sessionsPage = null;
    sessionsDeferred = null;
    // A read already in flight will settle against the old scope; the flush after it must run again.
    if (sessionsLoading) sessionsFlushPending = true;
    el("sessions-table").querySelector("tbody").replaceChildren();
    el("sessions-count").textContent = "";
    el("sessions-note").hidden = true;
    el("more-sessions").hidden = true;
    clearState();
    el("thread-header").hidden = true;
    el("more-messages").hidden = true;
    el("more-participants").hidden = true;
    composerReady = controlsReady = false;
    syncComposer();
  }

  function clearRoom() {
    scopeEpoch += 1;
    clearSnapshot();
    historyCursor = historyPageStart = participantCursor = participantPageStart = selectedThread = selectedRef = null;
    el("thread").value = "";
    el("thread-scope").textContent = t("Cała historia pokoju");
    composerReady = controlsReady = false;
    syncComposer();
  }

  function lock() {
    stopLive();
    clearState();
    invalidate();
    clearRoom();
    csrf = principal = access = null;
    delete el("viewer").dataset.access;
    el("read-only-indicator").hidden = true;
    pending = controlRequest = null;
    clearDraft();
    el("write-key").textContent = el("write-status").textContent = "";
    selectedRoom = "";
    el("token").value = "";
    el("room-slug").value = el("room-label").value = el("member-session").value = "";
    el("room").replaceChildren();
    el("viewer").hidden = true;
    el("logout").hidden = el("live-toggle").hidden = true;
    el("app-room").hidden = true;
    el("roster-filter").value = "";
    el("roster-count").textContent = "";
    el("roster-count").removeAttribute("title");
    rosterPartial = false;
    el("login").hidden = false;
    el("login-view").hidden = false;
    view = "chat";
    el("chat-view").hidden = false;
    el("sessions-view").hidden = true;
    el("tab-chat").setAttribute("aria-selected", "true");
    el("tab-sessions").setAttribute("aria-selected", "false");
    el("sessions-filter").value = "";
  }

  function showSession() {
    el("viewer").hidden = false;
    el("app-room").hidden = false;
    el("logout").hidden = false;
    el("login").hidden = true;
    el("login-view").hidden = true;
  }

  async function request(path, { method = "GET", body, csrfToken, key, signal = requestController.signal } = {}) {
    const reading = method === "GET";
    if (!reading && access !== "operator" && path !== "/v1/login" && path !== "/v1/logout")
      throw new Error("READ_ONLY");
    if (reading) reads += 1;
    try {
      const response = await fetch(path, {
        method, credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: body === undefined ? {} : {
          "Content-Type": "application/json", "X-CSRF-Token": csrfToken,
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const error = new Error("REQUEST_FAILED");
        error.status = response.status;
        try {
          const payload = await response.json();
          const code = payload?.error?.code;
          if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) error.code = code;
        } catch { /* A non-JSON refusal keeps the generic message. */ }
        throw error;
      }
      return await response.json();
    } finally { if (reading) reads -= 1; scheduleLive(live); }
  }

  // A failed read discards potentially stale scope-sensitive content, never the operator's draft.
  // `saved` is a confirmed write that this read followed: the failure is appended, not substituted.
  function failed(error, current, { saved = "", denied = t("Sesja wygasła lub dostęp został cofnięty. Zaloguj się ponownie.") } = {}) {
    if (current !== generation || pending || controlRequest) return false;
    invalidate();
    clearRoom();
    const prefix = saved ? `${saved} ` : "";
    if (error.status === 401 || error.status === 403) {
      lock();
      el("notice").textContent = prefix + denied;
    } else if (error.status === 429) {
      el("notice").textContent = prefix + t("Zbyt wiele żądań lub nieudanych prób logowania. Spróbuj ponownie za minutę.");
    } else {
      el("notice").textContent = prefix + t(saved
        ? "Nie udało się odczytać danych. Odśwież widok; nie wysyłaj wiadomości ponownie."
        : "Nie udało się odczytać danych. Odśwież widok lub zaloguj się ponownie.");
    }
    return true;
  }

  // Runs one read; returns whether it failed and was reported.
  async function read(work, current, options) {
    try { await work(); return false; } catch (error) { return failed(error, current, options); }
  }

  function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value == null ? "—" : String(value);
    if (className) node.className = className;
    return node;
  }

  // Isolates a session-controlled label so bidirectional controls cannot reorder the text around it.
  function bdi(value) { return text("bdi", value); }

  function roomPath(room = selectedRoom) { return `/v1/rooms/${encodeURIComponent(room)}`; }

  function sessionIdentity(p) {
    return `${p.harness ?? "Agent"}${p.host ? ` · ${p.host}` : ""} · ${p.session_id.slice(0, 8)}`;
  }

  function sessionName(p) {
    return p.title || sessionIdentity(p);
  }

  function senderInfo(m) {
    return participantNames.get(m.sender.session_id) ?? m.sender;
  }

  function senderName(m) {
    return m.sender.session_id === null ? "Operator" : sessionName(senderInfo(m));
  }

  function senderInitial(m) {
    return m.sender.session_id === null ? "OP" : (senderInfo(m).harness ?? "A").slice(0, 2).toUpperCase();
  }

  function displayTimestamp(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : TIME_FORMAT.format(parsed);
  }

  // Desktop scrolls #messages; the narrow layout scrolls the document instead.
  const mobileLayout = () => window.matchMedia("(max-width: 820px)").matches;
  function messageScrollTop() { return mobileLayout() ? window.scrollY : el("messages").scrollTop; }
  function setMessageScrollTop(value) {
    if (mobileLayout()) window.scrollTo({ top: value, behavior: "auto" });
    else el("messages").scrollTop = value;
  }
  function scrollMessagesToBottom() {
    if (mobileLayout()) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
    else el("messages").scrollTop = el("messages").scrollHeight;
  }
  function atBottom() {
    if (mobileLayout())
      return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
    const list = el("messages");
    return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  }

  function identifier(value) {
    return text("code", value == null ? "—" : String(value), "identifier");
  }

  function definition(term, value) {
    const dt = text("dt", term);
    const dd = document.createElement("dd");
    dd.append(identifier(value));
    return [dt, dd];
  }

  function receiptState(label, present) {
    return text("span", `${t(label)}: ${present ? t("tak") : "—"}`,
      `receipt-state ${present ? "is-present" : "is-missing"}`);
  }

  function receiptSummary(receipt) {
    const item = document.createElement("li");
    const peer = participantNames.get(receipt.session_id) ?? receipt;
    item.append(text("bdi", peer.title ? `${peer.title} · ${sessionIdentity(peer)}` : sessionIdentity(peer), "receipt-session"));
    item.append(receiptState(t("zapis"), Boolean(receipt.stored_at)));
    item.append(receiptState(t("przekazanie"), Boolean(receipt.handed_at)));
    item.append(receiptState("ACK", Boolean(receipt.acknowledged_at)));
    item.append(receiptState(t("odpowiedź"), Boolean(receipt.replying_message_id)));
    // Every state renders, absent ones as "—". `browser_verify_checks.py`
    // asserts this exact set against the API row, so hiding the empty ones
    // would break the verifier's receipt contract rather than merely tidy the
    // line. Readability here is the label fix above, not dropping fields.
    item.append(text("span", t("niepewność: {reason}", { reason: receipt.uncertainty_reason ?? "—" }),
      `receipt-state ${receipt.uncertainty_reason ? "is-uncertain" : "is-missing"}`));
    item.append(text("span", t("próba: {outcome}", { outcome: receipt.delivery?.outcome ?? "—" }), "receipt-state"));
    return item;
  }

  // The room's one PM mark is a coordination label and never authority. It is a room-level line, so it shows
  // even when its holder sits on another roster page; the holder's row also carries a badge.
  function renderPmMark(pm) {
    const line = el("pm-mark");
    line.replaceChildren();
    line.hidden = false;
    line.classList.toggle("is-set", pm !== null && pm !== undefined);
    if (!pm) {
      line.append(t("Znacznik PM: brak."));
      return;
    }
    const holder = participantNames.get(pm.session_id);
    const more = document.createElement("details");
    more.className = "pm-mark-details";
    more.open = pmDetailsOpen;
    more.addEventListener("toggle", () => { pmDetailsOpen = more.open; });
    const times = text("p", t("{session} · ustawiony {set} · ostatnia aktywność {activity} · wygasa {expires}.", {
      session: pm.session_id, set: displayTimestamp(pm.set_at),
      activity: displayTimestamp(pm.last_activity_at), expires: displayTimestamp(pm.expires_at),
    }), "pm-mark-times");
    // The text shows local times; the tooltip keeps the exact server values.
    times.title = t("ustawiony: {set} · ostatnia aktywność: {activity} · wygasa: {expires}", {
      set: pm.set_at, activity: pm.last_activity_at, expires: pm.expires_at,
    });
    more.append(text("summary", t("Znacznik nie nadaje uprawnień.")), times);
    line.append(t("Znacznik PM: "), holder ? bdi(sessionName(holder)) : t("sesja z innej strony listy"), more);
  }

  // A chip names only what needs attention: a confirmed "off" stays quiet, anything else (on, unknown) shows.
  function attentionChip(label, value) {
    return value === false ? null
      : text("span", value === true ? label : `${label}: ${value ?? "unknown"}`, "chip chip-flag");
  }

  // The visible word is short; the exact session UUID stays in the accessible name for assistive tools.
  function rosterButton(className, shown, accessibleName, onClick) {
    const button = text("button", shown, className);
    button.type = "button";
    button.setAttribute("aria-label", accessibleName);
    button.addEventListener("click", onClick);
    return button;
  }

  // Client-side narrowing of the rows already loaded; it never asks the server and never selects a recipient. It
  // owns which rows show and where the group headings sit: CSS draws a heading from the data attributes of the first
  // row of a group that is still shown, so narrowing never leaves a group without one. The count in a heading is the
  // group's size on the loaded page, like #roster-count (and says "na stronie" while the page is partial), not the
  // number of rows the filter lets through.
  function applyRosterFilter() {
    const query = el("roster-filter").value.trim().toLowerCase();
    const rows = [...el("participants").children];
    const sizes = { true: 0, false: 0 };
    for (const row of rows) sizes[row.dataset.online] += 1;
    const headed = new Set();
    for (const row of rows) {
      row.hidden = query !== "" && !(row.dataset.search ?? "").includes(query);
      delete row.dataset.group;
      delete row.dataset.count;
      if (row.hidden || headed.has(row.dataset.online)) continue;
      headed.add(row.dataset.online);
      row.dataset.group = row.dataset.online === "true" ? "Online" : "Offline";
      row.dataset.count = `${sizes[row.dataset.online]}${rosterPartial ? t(" na stronie") : ""}`;
    }
  }

  function renderParticipants(rows, pm = null, partial = false) {
    rosterPartial = partial;
    participantNames.clear();
    for (const p of rows)
      participantNames.set(p.session_id, p);
    renderPmMark(pm);
    // Online sessions first, the server's order inside each group. The group headings are drawn by CSS from data
    // attributes that applyRosterFilter places, so the list keeps exactly one <li> per participant.
    const ordered = [...rows.filter((p) => p.online), ...rows.filter((p) => !p.online)];
    const onlineCount = rows.length - ordered.filter((p) => !p.online).length;
    // The counts describe the loaded page. While it is the whole room they stand bare; otherwise they say so, and the
    // tooltip explains it, because the server sends no room-wide total.
    el("roster-count").textContent = `${partial ? t("na stronie: ") : ""}${onlineCount} online · ${rows.length}`;
    if (partial) el("roster-count").title = t("Liczby dotyczą załadowanej strony uczestników, nie całego pokoju.");
    else el("roster-count").removeAttribute("title");
    el("participants").replaceChildren(...ordered.map((p) => {
      const label = sessionName(p);
      if (targets.has(p.session_id)) targets.set(p.session_id, label);
      const item = document.createElement("li");
      item.dataset.sessionId = p.session_id;
      item.dataset.online = String(Boolean(p.online));
      item.dataset.search = `${label} ${sessionIdentity(p)} ${p.session_id} ${p.lane ?? ""}`.toLowerCase();
      const holder = pm !== null && pm.session_id === p.session_id;
      item.classList.toggle("is-pm", holder);
      item.classList.toggle("is-target", targets.has(p.session_id));
      const dot = text("span", "", `status-dot ${p.online ? "status-online" : "status-offline"}`);
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", p.online ? "online" : "offline");
      dot.title = p.online ? "online" : "offline";
      item.append(dot);
      const top = document.createElement("div");
      top.className = "participant-top";
      top.append(text("bdi", label, p.title ? "session-title" : "session-title participant-identity"));
      if (holder) top.append(text("span", "PM", "status-pill pm-badge"));
      top.append(text("span", p.native_state, "native-state"));
      item.append(top);
      const sub = document.createElement("div");
      sub.className = "participant-sub";
      if (p.title) sub.append(text("bdi", sessionIdentity(p), "participant-identity"));
      for (const [flag, value] of [["mute", p.muted], ["stop", p.stopped], ["Plan Mode", p.plan_mode]]) {
        const chip = attentionChip(flag, value);
        if (chip) sub.append(chip);
      }
      // Advisory only: the declaration is neither an entitlement nor evidence of what the session is doing.
      // The row shows a short chip; the full wording, with the disclaimer, is one disclosure away.
      const laneNote = p.lane
        ? ` · ${t("zadeklarowany {minutes} min temu · deklaracja, nie uprawnienie", { minutes: Math.floor((p.lane_age_seconds ?? 0) / 60) })}`
        : "";
      if (p.lane) {
        const chip = document.createElement("span");
        chip.className = "chip chip-lane";
        chip.title = `lane: ${p.lane}${laneNote}`;
        chip.append("lane: ", bdi(p.lane));
        sub.append(chip);
      }
      if (sub.childElementCount) item.append(sub);
      const actions = document.createElement("div");
      actions.className = "participant-actions";
      actions.append(rosterButton("choose-target", t("Wybierz"), t("Wybierz {id}", { id: p.session_id }), () => {
        if (access !== "operator" || writesBusy() || !composerReady) return;
        if (targets.size === 16 && !targets.has(p.session_id)) {
          el("notice").textContent = t("Można wybrać najwyżej 16 sesji.");
          return;
        }
        targets.set(p.session_id, label);
        syncComposer();
      }));
      if (typeof p.muted === "boolean") {
        const verb = p.muted ? t("Cofnij wyciszenie") : t("Wycisz");
        actions.append(rosterButton("mute-session", verb, `${verb} ${p.session_id}`,
          () => muteSession(p.session_id, !p.muted)));
      }
      const mark = holder ? t("Zdejmij PM") : t("Ustaw PM");
      actions.append(rosterButton("pm-session", mark, `${mark} ${p.session_id}`, () => setPm(p.session_id, !holder)));
      item.append(actions);
      // The exact selector stays on the row, one disclosure away, and is never replaced by the title.
      const details = document.createElement("details");
      details.className = "participant-details";
      details.open = openRows.has(p.session_id);
      details.addEventListener("toggle", () => {
        if (details.open) openRows.add(p.session_id);
        else openRows.delete(p.session_id);
      });
      const selector = document.createElement("div");
      selector.className = "participant-label";
      selector.append(bdi(p.label));
      details.append(text("summary", t("Szczegóły")), text("div", p.session_id, "participant-id"), selector,
        text("div", `${p.online ? "online" : "offline"} · ${p.native_state} · ` +
          `mute: ${p.muted} · stop: ${p.stopped} · Plan Mode: ${p.plan_mode}`, "participant-flags"));
      if (p.lane) {
        const lane = document.createElement("div");
        lane.className = "participant-lane";
        lane.append("lane: ", bdi(p.lane), laneNote);
        details.append(lane);
      }
      item.append(details);
      return item;
    }));
    applyRosterFilter();
    // Participant names make a sender identity readable; repaint the current page once they are known.
    // renderMessages captures and restores open evidence, focus and the reading position.
    if (lastMessages.length) renderMessages(lastMessages, { follow: atBottom() });
    syncComposer();
  }

  function captureMessageView() {
    const list = el("messages");
    const open = new Set();
    for (const evidence of list.querySelectorAll("details.message-evidence[open]")) {
      const item = evidence.closest("li[data-message-id]");
      if (item) open.add(item.dataset.messageId);
    }
    const focused = document.activeElement;
    let focus = null;
    if (focused && list.contains(focused)) {
      const item = focused.closest("li[data-message-id]");
      if (item) focus = { id: item.dataset.messageId, action: focused.dataset.messageAction || null };
    }
    // The newest page is capped, so a live read can evict the oldest entry above
    // the reader. Anchor to the first visible message, not to a raw scroll offset.
    const listBox = list.getBoundingClientRect();
    const listTop = listBox.top;
    // On a narrow viewport the document scrolls and the list box starts above
    // the viewport; "visible" means the viewport, not the list box.
    const visibleTop = Math.max(listTop, 0);
    const visibleBottom = Math.min(listBox.bottom, window.innerHeight);
    const children = Array.from(list.children);
    // Rows are flat, so a sliver of the row above is usually still in view. If that sliver were
    // the anchor and were evicted with its neighbours, the nearest survivor would land rows too
    // high. Anchor to the first row that starts in view; a row taller than the view keeps itself.
    const inView = children.filter((item) => {
      const box = item.getBoundingClientRect();
      return box.bottom > visibleTop + 1 && box.top < visibleBottom;
    });
    const anchor = inView.find((item) => item.getBoundingClientRect().top >= visibleTop - 1) ?? inView[0];
    return {
      open,
      focus,
      top: messageScrollTop(),
      anchor: anchor ? {
        id: anchor.dataset.messageId,
        index: children.indexOf(anchor),
        offset: anchor.getBoundingClientRect().top - listTop,
      } : null,
    };
  }

  function restoreMessageView(view, follow) {
    const items = Array.from(el("messages").children);
    for (const item of items) {
      if (view.open.has(item.dataset.messageId)) {
        const evidence = item.querySelector("details.message-evidence");
        if (evidence) evidence.open = true;
      }
    }
    if (view.focus) {
      const item = items.find((node) => node.dataset.messageId === view.focus.id);
      const target = item && view.focus.action
        ? item.querySelector(`[data-message-action="${view.focus.action}"]`)
        : null;
      target?.focus({ preventScroll: true });
    }
    if (follow) {
      scrollMessagesToBottom();
      return;
    }
    const list = el("messages");
    let anchor = null;
    let desiredOffset = 0;
    if (view.anchor) {
      anchor = items.find((node) => node.dataset.messageId === view.anchor.id);
      if (anchor) desiredOffset = view.anchor.offset;
      else if (items.length) {
        // The anchored message itself was evicted. The page is ordered oldest
        // first, so the first surviving entry is the nearest one after the
        // removed front block; anchor there at the same visual offset.
        anchor = items[0];
        desiredOffset = view.anchor.offset;
      }
    }
    if (!anchor) {
      setMessageScrollTop(view.top);
      return;
    }
    const currentOffset = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
    setMessageScrollTop(messageScrollTop() + currentOffset - desiredOffset);
  }

  function renderMessages(rows, { follow = false } = {}) {
    const view = captureMessageView();
    lastMessages = rows;
    el("messages").replaceChildren(...rows.map((m) => {
      const receipts = Array.isArray(m.receipts) ? m.receipts : [];
      const operator = m.sender.session_id === null;
      const item = document.createElement("li");
      item.dataset.messageId = m.id;
      item.className = `${operator ? "message-operator " : ""}msg-${m.kind}`;
      item.dataset.harness = operator ? "operator" : (senderInfo(m).harness ?? "");
      item.append(text("span", senderInitial(m), "message-avatar"));
      const main = document.createElement("div");
      main.className = "message-main";
      const header = document.createElement("header");
      header.className = "message-header";
      header.append(text("bdi", senderName(m), "sender-name"));
      // An untitled session is already named by its identity; repeating it would only add noise.
      if (m.sender.session_id !== null && senderInfo(m).title)
        header.append(text("bdi", sessionIdentity(senderInfo(m)), "sender-identity"));
      // Only an operator publishes without a session; an agent cannot produce this shape.
      if (operator) header.append(text("span", "operator", "operator-label"));
      const time = text("time", displayTimestamp(m.created_at), "timestamp");
      time.dateTime = m.created_at;
      time.title = m.created_at; // the text is the local format; the tooltip is the exact server value
      header.append(time);
      // A plain message or reply carries no badge ("Odpowiedź na ..." already marks a reply): only the kinds that
      // mean something else (question, status, ...) are marked.
      if (m.kind !== "message" && m.kind !== "reply") header.append(text("span", KIND_LABELS[m.kind] ?? m.kind, `kind-badge kind-${m.kind}`));
      if (m.thread_ref_key) header.append(text("bdi", m.thread_ref_key, "thread-key"));
      if (m.thread_resolved_at) header.append(text("span", t("rozwiązany"), "resolved-badge"));
      main.append(header);
      if (m.reply_to) main.append(text("p", t("Odpowiedź na {id}", { id: `${String(m.reply_to).slice(0, 8)}…` }), "reply-context"));
      main.append(text("p", m.body, "body"));
      if (receipts.length) {
        const summary = document.createElement("ul");
        summary.className = "receipt-summary";
        summary.setAttribute("aria-label", t("Potwierdzenia dostarczenia"));
        for (const receipt of receipts) summary.append(receiptSummary(receipt));
        main.append(summary);
      }
      const actions = document.createElement("div");
      actions.className = "message-actions";
      // The identifier belongs in the evidence disclosure, not in the label: a
      // full UUID as button text was the single loudest thing on the page.
      const button = text("button", t("Odpowiedz"), "reply");
      button.type = "button";
      button.dataset.messageAction = "reply";
      button.addEventListener("click", () => {
        if (access !== "operator" || busy() || !composerReady || !mayDiscard()) return;
        clearDraft();
        replyTarget = { id: m.id, thread_id: m.thread_id, senderSession: m.sender.session_id };
        if (m.sender.session_id) targets.set(m.sender.session_id, senderName(m));
        syncComposer();
        el("body").focus();
      });
      actions.append(button);
      const show = text("button", t("Wątek"), "show-thread");
      show.type = "button";
      show.dataset.messageAction = "thread";
      show.addEventListener("click", () => filterThread(m.thread_id));
      actions.append(show);
      main.append(actions);
      const evidence = document.createElement("details");
      evidence.className = "message-evidence";
      const evidenceSummary = text("summary", t("Szczegóły techniczne"));
      evidenceSummary.dataset.messageAction = "evidence";
      evidence.append(evidenceSummary);
      const grid = document.createElement("dl");
      grid.className = "evidence-grid";
      grid.append(...definition(t("ID wiadomości"), m.id));
      grid.append(...definition(t("Wątek"), m.thread_id));
      grid.append(...definition(t("Odpowiedź na"), m.reply_to ?? "—"));
      grid.append(...definition(t("Nadawca"), m.sender.session_id ?? m.sender.principal_id));
      if (m.sender.session_id && senderInfo(m).native_session_id)
        grid.append(...definition(t("Sesja natywna"), senderInfo(m).native_session_id));
      grid.append(...definition(t("Czas"), m.created_at));
      evidence.append(grid);
      if (receipts.length) {
        const full = document.createElement("ul");
        full.className = "evidence-receipts";
        for (const receipt of receipts) full.append(text("li",
          `${receipt.session_id} · ${t("zapis:")} ${receipt.stored_at ?? "—"} · ${t("przekazanie:")} ${receipt.handed_at ?? "—"} · ` +
          `ACK: ${receipt.acknowledged_at ?? "—"} · ${t("odpowiedź:")} ${receipt.replying_message_id ?? "—"} · ` +
          `${t("niepewność:")} ${receipt.uncertainty_reason ?? "—"} · ${t("próba:")} ${receipt.delivery?.outcome ?? "—"}`,
        ));
        evidence.append(full);
      }
      main.append(evidence);
      item.append(main);
      return item;
    }));
    restoreMessageView(view, follow);
    syncComposer();
  }

  function clearState() {
    stateEpoch += 1;
    clearTimeout(stateTimer);
    stateTimer = null;
    el("state-groups").replaceChildren();
  }

  // One slot of a validation-lease observation, as text.
  function slotLine(slot, since) {
    const who = [slot.lane ?? slot.owner, slot.branch, slot.profile].filter(Boolean).join(", ");
    const state = {
      free: t("wolny"),
      held: t("zajęty ({who}) od {since}", { who, since }),
      stuck: t("zablokowany (stuck)"),
    }[slot.state];
    return `Slot ${slot.slot ?? "?"}: ${state ?? t("nieznany")}`;
  }

  function renderStateValue(entry) {
    const box = document.createElement("div");
    const value = entry.value;
    if (entry.stale) {
      box.append(text("p", entry.stale_reason === "revoked"
        ? t("nieznany (producent odwołany)")
        : t("nieznany, ostatnio widziany {seconds} s temu", { seconds: entry.age_seconds })));
    } else if (value.schema === "agent-chat.validation-lease.v1") {
      if (value.scan === "unknown") box.append(text("p", t("nieznany ({reason})", { reason: value.reason ?? "—" })));
      else {
        // Times are local and absolute; the exact ISO value stays in the tooltip.
        for (const slot of (Array.isArray(value.slots) ? value.slots : []).slice(0, 16)) {
          const line = text("p", slotLine(slot && typeof slot === "object" ? slot : {}, displayTimestamp(entry.changed_at)));
          if (slot?.state === "held") line.title = `od: ${entry.changed_at}`;
          box.append(line);
        }
        for (const waiter of (Array.isArray(value.waiters) ? value.waiters : []).slice(0, 16)) {
          const w = waiter && typeof waiter === "object" ? waiter : {};
          const line = text("p", t("Oczekuje: {who} od {since}", {
            who: [w.lane ?? w.owner, w.branch].filter(Boolean).join(", "),
            since: w.waiting_since ? displayTimestamp(w.waiting_since) : "—",
          }));
          if (w.waiting_since) line.title = `od: ${w.waiting_since}`;
          box.append(line);
        }
      }
    } else {
      box.append(text("pre", JSON.stringify(value, null, 1).slice(0, 2000)));
    }
    return box;
  }

  function renderState(data) {
    clearTimeout(stateTimer);
    stateTimer = null;
    const groups = new Map();
    for (const entry of data.entries) {
      const key = entry.ref_key ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    if (!data.entries.length) {
      el("state-groups").replaceChildren(text("p", t("Brak obserwacji stanu."), "meta"));
      return;
    }
    el("state-groups").replaceChildren(...Array.from(groups, ([key, entries]) => {
      const group = document.createElement("div");
      group.append(key ? bdi(key) : text("span", t("Bez klucza wątku")));
      if (key) {
        const show = text("button", t("Pokaż wątek"), "show-thread");
        show.type = "button";
        show.setAttribute("aria-label", `Pokaż wątek ${key}`);
        show.addEventListener("click", () => filterThread(key));
        group.append(" ", show);
      }
      const list = document.createElement("ul");
      for (const entry of entries) {
        const item = document.createElement("li");
        // Local, absolute times: a snapshot ages, so "3 min ago" would be wrong. The exact ISO values sit in the tooltip.
        const meta = text("p", `${entry.state_key} · ${entry.producer.producer}@${entry.producer.host} · ` +
          t("zmiana: {changed} · obserwacja: {observed}", {
            changed: displayTimestamp(entry.changed_at), observed: displayTimestamp(entry.observed_at),
          }), "meta");
        meta.title = t("zmiana: {changed} · obserwacja: {observed}", {
          changed: entry.changed_at, observed: entry.observed_at,
        });
        item.append(meta, renderStateValue(entry));
        list.append(item);
      }
      group.append(list);
      return group;
    }));
    if (data.next_key) el("state-groups").append(text("p", t("Wyświetlono pierwsze wpisy; reszta wymaga agent-chat state."), "meta"));
    // Staleness comes from the server's flags; this timer only asks it again just after the soonest fresh entry lapses.
    const lives = data.entries.filter((entry) => !entry.stale).map((entry) => entry.expires_in_seconds);
    if (lives.length) {
      const epoch = stateEpoch;
      const room = selectedRoom;
      stateTimer = setTimeout(async () => {
        stateTimer = null;
        if (epoch !== stateEpoch || room !== selectedRoom) return;
        try {
          const fresh = await request(`${roomPath(room)}/state?limit=100`);
          if (epoch === stateEpoch && room === selectedRoom) renderState(fresh);
        } catch (error) {
          if (epoch !== stateEpoch) return;
          if (error.status === 401 || error.status === 403) failed(error, generation);
          else el("state-groups").replaceChildren(text("p", t("Stan zasobów niedostępny."), "meta"));
        }
      }, Math.min(...lives) * 1000 + 1500);
    }
  }

  async function roomState(current) {
    const epoch = stateEpoch;
    try {
      const data = await request(`${roomPath()}/state?limit=100`);
      if (current === generation && epoch === stateEpoch) renderState(data);
    } catch (error) {
      // The card is advisory: only a lost session ends the view; any other failure leaves the rest readable.
      if (error.status === 401 || error.status === 403) throw error;
      if (current === generation) el("state-groups").replaceChildren(text("p", t("Stan zasobów niedostępny."), "meta"));
    }
  }

  async function participants(current, after = null) {
    const query = new URLSearchParams({ limit: "50" });
    if (after !== null) query.set("after_session", after);
    const data = await request(`${roomPath()}/participants?${query}`);
    if (current !== generation) return;
    renderParticipants(data.participants, data.pm ?? null, after !== null || data.next_session_id !== null);
    participantPageStart = after;
    participantCursor = data.next_session_id;
    el("more-participants").hidden = participantCursor === null;
  }

  async function history(current, before = null) {
    const query = new URLSearchParams({ limit: "50", before: before ?? NEWEST });
    if (selectedThread !== null) query.set("thread_id", selectedThread);
    else if (selectedRef !== null) query.set("ref_key", selectedRef);
    const data = await request(`${roomPath()}/history?${query}`);
    if (current !== generation) return;
    if (![data.next_cursor, data.retained_floor, data.position].every(cursorValid)) throw new Error("INVALID_HISTORY_CURSOR");
    historyEventCursor = data.position;
    historyFloor = data.retained_floor;
    const follow = before === null && atBottom();
    renderMessages(data.messages, { follow });
    renderThreadHeader(data.messages);
    historyPageStart = before;
    historyCursor = data.has_more ? data.next_cursor : null;
    el("more-messages").hidden = historyCursor === null;
    el("latest").hidden = historyPageStart === null;
  }

  // One thread, shown with its key and resolution state. The button posts the opposite state through `control`.
  function renderThreadHeader(messages) {
    const header = el("thread-header");
    header.replaceChildren();
    header.hidden = selectedThread === null && selectedRef === null;
    if (header.hidden) return;
    const first = messages[0];
    if (!first) {
      header.append(t("Brak wiadomości w tym wątku."));
      return;
    }
    const resolved = Boolean(first.thread_resolved_at);
    const threadState = resolved
      ? t("rozwiązany {time}", { time: first.thread_resolved_at })
      : t("otwarty");
    header.append(`${t("Klucz:")} `, first.thread_ref_key ? bdi(first.thread_ref_key) : t("brak"),
      ` · ${t("stan:")} ${threadState} `);
    const button = text("button", resolved ? t("Otwórz ponownie") : t("Oznacz jako rozwiązany"), "resolve-thread");
    button.type = "button";
    button.disabled = access !== "operator" || busy() || !composerReady;
    button.hidden = access !== "operator";
    button.addEventListener("click", () => control(`/v1/threads/${first.thread_id}/resolution`, { resolved: !resolved }, {
      matches: (data) => data.thread_id === first.thread_id && data.resolved === !resolved,
      success: () => t("Potwierdzono zapis: wątek {state}. Rozwiązanie nie blokuje pisania.", {
        state: resolved ? t("otwarty ponownie") : t("oznaczony jako rozwiązany"),
      }),
      label: "rozwiązania wątku",
    }));
    header.append(button);
  }

  async function filterThread(thread) {
    if (busy() || !composerReady) return;
    const isRef = thread !== null && !uuid(thread) && REF_KEY.test(thread);
    if (thread !== null && !uuid(thread) && !isRef) {
      el("notice").textContent = t("Podaj poprawny UUID wątku, klucz wątku albo pozostaw puste pole.");
      return;
    }
    const current = invalidate();
    selectedThread = isRef ? null : thread;
    selectedRef = isRef ? thread : null;
    el("thread").value = thread ?? "";
    el("thread-scope").textContent = thread
      ? t("Wątek: {thread}", { thread })
      : t("Cała historia pokoju");
    el("thread-header").hidden = true;
    el("messages").replaceChildren();
    historyCursor = historyPageStart = null;
    el("more-messages").hidden = true;
    el("latest").hidden = true;
    el("notice").textContent = t("Odczyt historii…");
    await read(async () => {
      await history(current);
      if (current === generation) el("notice").textContent = t("Migawka historii. Filtr nie zmienia szkicu ani odbiorców.");
    }, current);
  }

  async function latestHistory() {
    if (busy() || !composerReady || historyPageStart === null) return;
    const current = invalidate();
    el("latest").disabled = true;
    el("notice").textContent = t("Powrót do najnowszych…");
    await read(async () => {
      await history(current);
      if (current === generation) {
        scrollMessagesToBottom();
        el("notice").textContent = t("Migawka historii. Filtr nie zmienia szkicu ani odbiorców.");
      }
    }, current);
    syncComposer();
  }

  async function control(path, payload, { matches, success, label, updateRooms = false }) {
    if (access !== "operator" || busy() || !controlsReady) return;
    const current = invalidate();
    const attempt = Object.freeze({ csrfToken: csrf });
    const after = participantPageStart;
    const historyAfter = historyPageStart;
    controlRequest = attempt;
    syncComposer();
    let confirmed = false;
    el("notice").textContent = t("Zapisywanie zmiany…");
    try {
      const data = await request(path, { method: "POST", body: payload, csrfToken: attempt.csrfToken });
      if (stale(controlRequest, attempt, current)) return;
      if (!matches(data)) throw new Error("UNCONFIRMED_CONTROL");
      confirmed = true;
      if (updateRooms) await roomOptions(current);
      if (stale(controlRequest, attempt, current)) return;
      if (selectedRoom) await Promise.all([participants(current, after), history(current, historyAfter), roomState(current)]);
      if (stale(controlRequest, attempt, current)) return;
      controlsReady = true;
      el("notice").textContent = success(data);
      return data;
    } catch (error) {
      if (stale(controlRequest, attempt, current)) return;
      controlRequest = null;
      const result = confirmed
        ? t("Zapis {label} potwierdzony, ale odczyt stanu niedostępny.", { label: t(label) })
        : t("Zmiana {label} niepotwierdzona.", { label: t(label) });
      const detail = !confirmed && error.status !== 401 && error.status !== 403 ? refusal(error) : "";
      if (error.status === 401 || error.status === 403) {
        failed(error, current);
        el("notice").textContent = `${result} ${t("Dostęp wygasł lub został cofnięty. Zaloguj się ponownie.")}`;
      } else if (detail && PRESERVE_ON_REFUSAL.has(error.code)) {
        // These refusals cannot mask a revoked room or session scope.
        el("notice").textContent = `${result} ${detail}`;
      } else {
        invalidate();
        clearRoom();
        el("notice").textContent = detail
          ? `${result} ${detail} ${t("Odśwież stan przed następną decyzją.")}`
          : `${result} ${t("Odśwież stan przed następną decyzją; nie ponawiamy operacji automatycznie.")}`;
      }
    } finally {
      if (controlRequest === attempt) controlRequest = null;
      flushSessions();
      syncComposer();
    }
  }

  function muteSession(session, muted) {
    if (access !== "operator" || !composerReady || !uuid(session) || typeof muted !== "boolean") return;
    return control(`/v1/sessions/${session}/mute`, { muted }, {
      matches: (data) => data.session_id === session && data.muted === muted,
      success: () => t("Potwierdzono zapis mute={muted} dla {session}. Lista pokazuje późniejszy odczyt; stop i Plan Mode pozostają niezależne.", { muted, session }),
      label: "mute",
    });
  }

  // Operator only, through the existing login. The route is idempotent per call and carries no authority.
  function setPm(session, pm) {
    if (access !== "operator" || !composerReady || !uuid(session) || typeof pm !== "boolean") return;
    const targetRoom = selectedRoom;
    return control(`${roomPath(targetRoom)}/pm`, { session_id: session, pm }, {
      matches: (data) => data.room_id === targetRoom && (pm ? data.pm?.session_id === session : data.pm === null),
      success: () => pm
        ? t("Potwierdzono zapis: znacznik PM ma {session}. Znacznik nie nadaje uprawnień.", { session })
        : t("Potwierdzono zapis: znacznik PM zdjęty z {session}.", { session }),
      label: "znacznika PM",
    });
  }

  const ROLE_LABELS = { pm: "Forgejo PM", github_pm: "GitHub PM", delivery_manager: "Delivery manager" };
  const ROLE_ORDER = ["pm", "github_pm", "delivery_manager"];

  function formatAge(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "";
    if (seconds < 60) return `${seconds} s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
    return `${Math.floor(seconds / 86400)} d`;
  }

  function showView(next) {
    if (next !== "chat" && next !== "sessions") return;
    if (view === "chat" && next === "sessions") savedChatScroll = messageScrollTop();
    view = next;
    el("chat-view").hidden = next !== "chat";
    el("sessions-view").hidden = next !== "sessions";
    el("tab-chat").setAttribute("aria-selected", String(next === "chat"));
    el("tab-sessions").setAttribute("aria-selected", String(next === "sessions"));
    if (next === "chat" && savedChatScroll !== null) {
      setMessageScrollTop(savedChatScroll);
      savedChatScroll = null;
    }
    if (next === "sessions") requestSessions();
  }

  function requestSessions() {
    if (!selectedRoom) return;
    // The request belongs to the room, not to the read that happened to be in flight when the operator
    // opened the tab: stopping or retrying a live refresh must not discard it.
    sessionsDeferred = { room: selectedRoom };
    flushSessions();
  }

  async function flushSessions() {
    if (view !== "sessions" || !selectedRoom) {
      sessionsDeferred = null;
      return;
    }
    if (sessionsDeferred && sessionsDeferred.room !== selectedRoom) sessionsDeferred = null;
    if (busy()) return;
    if (sessionsLoading) {
      sessionsFlushPending = true;
      return;
    }
    // Nothing is owed when the table still belongs to this scope and no visit asked for a fresh read.
    if (!sessionsDeferred && sessionsPage !== null) return;
    const room = selectedRoom;
    const epoch = scopeEpoch;
    const painted = await loadSessions(room, epoch);
    if (painted) sessionsDeferred = null;
  }

  async function loadSessions(room, epoch) {
    if (!selectedRoom || room !== selectedRoom || sessionsLoading) return false;
    sessionsLoading = true;
    let painted = false;
    let reported = false;
    try {
      reported = await read(async () => {
        const data = await request(`${roomPath(room)}/participants?limit=100`);
        // A harmless live-refresh restart bumps the generation; only a real scope change discards this read.
        if (room !== selectedRoom || epoch !== scopeEpoch) return;
        sessionsPage = data;
        renderSessions();
        painted = true;
      }, generation);
    } finally {
      sessionsLoading = false;
      if (reported) {
        // The failure already told the operator to refresh; enqueuing its own replacement here would
        // loop on the same failing endpoint, so the next attempt needs that explicit refresh.
        sessionsFlushPending = false;
      } else if (sessionsFlushPending) {
        sessionsFlushPending = false;
        flushSessions();
      }
    }
    return painted;
  }

  async function loadMoreSessions() {
    if (!selectedRoom || !sessionsPage?.next_session_id || sessionsLoading || sessionsLoadingMore || busy()) return;
    const room = selectedRoom;
    const epoch = scopeEpoch;
    const basePage = sessionsPage;
    const after = basePage.next_session_id;
    sessionsLoadingMore = true;
    renderSessions();
    try {
      const query = new URLSearchParams({ limit: "100", after_session: after });
      const data = await request(`${roomPath(room)}/participants?${query}`);
      // Append only to the exact snapshot this request extended. A revisit of
      // Sessions may have replaced it while the request was in flight.
      if (room !== selectedRoom || epoch !== scopeEpoch || sessionsPage !== basePage) return;
      if (!Array.isArray(data.participants)) throw new Error("INVALID_RESPONSE");
      const seen = new Set(basePage.participants.map((person) => person.session_id));
      sessionsPage = {
        ...basePage,
        participants: [
          ...basePage.participants,
          ...data.participants.filter((person) => !seen.has(person.session_id)),
        ],
        next_session_id: data.next_session_id,
        roles: data.roles ?? basePage.roles,
        pm: data.pm ?? basePage.pm,
      };
      renderSessions();
    } catch (error) {
      // A failed later page is not a failed snapshot. Ignore it when a newer
      // snapshot replaced this one; keep access refusals fail-closed.
      if (room !== selectedRoom || epoch !== scopeEpoch || sessionsPage !== basePage) return;
      if (error.status === 401 || error.status === 403) {
        failed(error, generation);
        return;
      }
      el("notice").textContent = t("Nie udało się pobrać kolejnej strony sesji. Spróbuj ponownie.");
    } finally {
      sessionsLoadingMore = false;
      if (sessionsPage) renderSessions();
    }
  }

  async function setRole(session, role, assigned) {
    if (access !== "operator" || busy() || !uuid(session) || !ROLE_ORDER.includes(role)) return;
    const targetRoom = selectedRoom;
    const label = ROLE_LABELS[role] ?? role;
    const result = await control(`${roomPath(targetRoom)}/roles`, { role, session_id: session, assigned }, {
      matches: (data) => data.room_id === targetRoom
        && (assigned ? data.roles?.[role]?.session_id === session : data.roles?.[role] === null),
      success: () => assigned
        ? t("Potwierdzono: {label} ma {session}. Znacznik nie nadaje uprawnień.", { label, session })
        : t("Potwierdzono: znacznik {label} zdjęty z {session}.", { label, session }),
      label: `znacznika ${label}`,
    });
    if (result && view === "sessions") requestSessions();
  }

  function sessionCell(person) {
    const cell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "session-name";
    name.append(bdi(sessionName(person)));
    cell.append(name, text("span", person.session_id, "session-id"));
    if (person.label && person.label !== person.session_id) {
      cell.append(text("span", person.label, "session-meta"));
    }
    return cell;
  }

  function workCell(person) {
    const cell = document.createElement("td");
    const work = person.repositories && typeof person.repositories === "object" ? person.repositories : {};
    const forges = Object.entries(work).filter(([, repos]) => Array.isArray(repos) && repos.length > 0);
    if (!forges.length) {
      cell.append(text("span", "—", "session-meta"));
      return cell;
    }
    for (const [forge, repos] of forges) {
      cell.append(text("span", forge, "work-forge"));
      const list = document.createElement("ul");
      list.className = "work-list";
      for (const repo of repos.slice(0, 8)) {
        const item = document.createElement("li");
        item.append(bdi(repo));
        list.append(item);
      }
      if (repos.length > 8) list.append(text("li", `+${repos.length - 8}`, "session-meta"));
      cell.append(list);
    }
    return cell;
  }

  function rolesCell(person, roles) {
    const cell = document.createElement("td");
    cell.className = "role-cell";
    for (const role of ROLE_ORDER) {
      const block = roles?.[role];
      if (block && block.session_id === person.session_id) {
        cell.append(text("span", ROLE_LABELS[role], `role-badge${role === "pm" ? " is-pm" : ""}`));
      }
    }
    if (!cell.childNodes.length) cell.append(text("span", "—", "session-meta"));
    if (access !== "operator") return cell;
    const details = document.createElement("details");
    details.className = "role-controls";
    details.append(text("summary", t("Zmień rolę")));
    for (const role of ROLE_ORDER) {
      const held = roles?.[role]?.session_id === person.session_id;
      const row = document.createElement("div");
      row.className = "role-row";
      row.append(text("span", ROLE_LABELS[role]));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "role-session";
      button.dataset.role = role;
      button.disabled = busy() || !composerReady;
      button.textContent = held ? t("Zdejmij") : t("Nadaj");
      button.setAttribute("aria-label", `${held ? t("Zdejmij") : t("Nadaj")} ${ROLE_LABELS[role]}`);
      button.addEventListener("click", () => setRole(person.session_id, role, !held));
      row.append(button);
      details.append(row);
    }
    cell.append(details);
    return cell;
  }

  function stateCell(person) {
    const cell = document.createElement("td");
    // Liveness and the observed native state are separate facts. A live lease
    // with `unknown` must not be rendered as a positive idle claim.
    const state = !person.online
      ? t("offline")
      : { busy: t("online, pracuje"), idle: t("online, bezczynna") }[person.native_state] ?? t("online, stan nieznany");
    cell.append(text("span", state, "state-line"));
    const flags = [];
    if (person.stopped) flags.push("stop");
    if (person.plan_mode) flags.push("Plan Mode");
    if (person.muted) flags.push(t("wyciszona"));
    if (flags.length) cell.append(text("span", flags.join(" · "), "state-line"));
    return cell;
  }

  function laneCell(person) {
    const cell = document.createElement("td");
    if (!person.lane) {
      cell.append(text("span", "—", "session-meta"));
      return cell;
    }
    cell.append(bdi(person.lane));
    const age = formatAge(person.lane_age_seconds);
    if (age) cell.append(text("span", t("od {age}", { age }), "session-meta"));
    return cell;
  }

  function activityCell(person) {
    const cell = document.createElement("td");
    cell.append(text("span", person.last_published_at ? displayTimestamp(person.last_published_at) : "—", "state-line"));
    const count = Number(person.messages_24h) || 0;
    cell.append(text("span", t("{count} w 24 h", { count }), "session-meta"));
    return cell;
  }

  function prsCell(person) {
    const cell = document.createElement("td");
    const prs = Array.isArray(person.announced_prs) ? person.announced_prs : [];
    if (!prs.length) {
      cell.append(text("span", "—", "session-meta"));
      return cell;
    }
    const list = document.createElement("ul");
    list.className = "pr-list";
    for (const pr of prs.slice(0, 3)) {
      const item = document.createElement("li");
      item.append(text("bdi", `${pr.repository}#${pr.number}`, ""));
      list.append(item);
    }
    if (prs.length > 3) list.append(text("li", `+${prs.length - 3}`, "session-meta"));
    cell.append(list);
    return cell;
  }

  function renderSessions() {
    if (!sessionsPage) return;
    const query = el("sessions-filter").value.trim().toLowerCase();
    const roles = sessionsPage.roles ?? { pm: sessionsPage.pm ?? null, github_pm: null, delivery_manager: null };
    const rows = Array.isArray(sessionsPage.participants) ? sessionsPage.participants : [];
    const ordered = [...rows].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return sessionName(a).localeCompare(sessionName(b), "pl");
    });
    const body = el("sessions-table").querySelector("tbody");
    body.replaceChildren();
    let shown = 0;
    for (const person of ordered) {
      const repositories = person.repositories && typeof person.repositories === "object" ? person.repositories : {};
      const search = [
        sessionName(person), sessionIdentity(person), person.session_id, person.harness ?? "", person.host ?? "",
        person.lane ?? "", ...Object.values(repositories).flat().filter((repo) => typeof repo === "string"),
      ].join(" ").toLowerCase();
      const row = document.createElement("tr");
      row.dataset.sessionId = person.session_id;
      if (query && !search.includes(query)) {
        row.hidden = true;
      } else {
        shown += 1;
      }
      row.append(
        sessionCell(person),
        (() => { const cell = document.createElement("td"); cell.append(text("span", person.harness ?? "—", "chip")); return cell; })(),
        (() => { const cell = document.createElement("td"); cell.append(text("span", person.host ?? "—", "")); return cell; })(),
        stateCell(person),
        laneCell(person),
        workCell(person),
        rolesCell(person, roles),
        activityCell(person),
        prsCell(person),
      );
      body.append(row);
    }
    if (!ordered.length) {
      const row = document.createElement("tr");
      row.className = "empty-row";
      const cell = document.createElement("td");
      cell.colSpan = 9;
      cell.textContent = t("Brak sesji w tym pokoju.");
      row.append(cell);
      body.append(row);
    }
    el("sessions-count").textContent = t("{shown} z {total}", { shown, total: rows.length });
    const note = el("sessions-note");
    const next = Boolean(sessionsPage.next_session_id);
    note.hidden = !next;
    note.textContent = next
      ? t("Wczytano {count} sesji. Filtr obejmuje wczytane wiersze; pobierz kolejną stronę, aby szukać dalej.", { count: rows.length })
      : "";
    const more = el("more-sessions");
    more.hidden = !next;
    more.disabled = sessionsLoadingMore || busy();
  }

  el("create-room").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (access !== "operator" || busy() || !controlsReady) return;
    const slug = el("room-slug").value;
    const label = el("room-label").value;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || !label || [...label].length > 128 || /[\x00-\x1f\x7f]/.test(label)) {
      el("notice").textContent = t("Niepoprawny identyfikator lub nazwa pokoju.");
      return;
    }
    const result = await control("/v1/rooms", { slug, label }, {
      matches: (data) => uuid(data.id) && data.slug === slug && data.label === label,
      success: (data) => t("Pokój zapisany: {id}. Wybierz go na liście pokoi.", { id: data.id }),
      label: "pokoju",
      updateRooms: true,
    });
    if (result) { el("room-slug").value = el("room-label").value = ""; }
  });

  el("join-room").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (access !== "operator" || busy() || !composerReady) return;
    const session = el("member-session").value.trim().toLowerCase();
    const targetRoom = selectedRoom;
    if (!uuid(session)) { el("notice").textContent = t("Podaj dokładny UUID sesji."); return; }
    const result = await control(`${roomPath(targetRoom)}/memberships`, { session_id: session }, {
      matches: (data) => data.room_id === targetRoom && data.session_id === session,
      success: () => t("Członkostwo zapisane: {session}. Uprawnienia poświadczenia nie zostały rozszerzone.", { session }),
      label: "członkostwa",
    });
    if (result) el("member-session").value = "";
  });

  // Reads the room chosen in the list. `saved` reports a write that this read follows;
  // `keep` re-reads the same room without discarding its draft.
  async function room(saved = "", keep = false) {
    const current = invalidate();
    selectedRoom = el("room").value;
    clearRoom();
    if (!keep) clearDraft();
    if (!selectedRoom) {
      stopLive();
      controlsReady = true;
      syncComposer();
      return;
    }
    el("notice").textContent = saved ? `${saved} Odczyt pokoju…` : t("Odczyt pokoju…");
    await read(async () => {
      await Promise.all([participants(current), history(current), roomState(current)]);
      if (current === generation) {
        el("viewer").hidden = false;
        composerReady = controlsReady = true;
        syncComposer();
        // The composer changes the list height; keep the newest page at its true bottom.
        if (historyPageStart === null) scrollMessagesToBottom();
        el("notice").textContent = saved || t("Migawka historii. Odczyt nie potwierdza przetworzenia wiadomości.");
        if (view === "sessions") requestSessions();
        resumeLive();
      }
    }, current, { saved });
  }

  async function roomOptions(current) {
    const data = await request("/v1/rooms");
    if (current !== generation) return;
    const empty = text("option", t("Wybierz pokój"));
    empty.value = "";
    el("room").replaceChildren(empty, ...data.rooms.map((r) => {
      const option = text("option", r.label && r.label !== r.slug ? `${r.label} — ${r.slug}` : r.slug);
      option.value = r.id;
      option.dataset.slug = r.slug;
      option.dataset.label = r.label || r.slug;
      option.title = `${r.label || r.slug} (${r.slug})`;
      return option;
    }));
    if (selectedRoom && !data.rooms.some((r) => r.id === selectedRoom)) {
      // Never move the operator, or a draft written for that room, into another room unasked.
      selectedRoom = "";
      clearRoom();
      el("notice").textContent = t("Wybrany pokój nie jest już dostępny. Wybierz pokój z listy.") +
        (composerDraft() ? " Szkic został zachowany." : "");
    }
    el("room").value = selectedRoom;
    return data.rooms;
  }

  // Initial session loading may choose the first room. A refresh preserves the operator's room;
  // a room that disappeared from scope is reported and never replaced by another one unasked.
  async function rooms(current, { initial = false, keepDraft = false } = {}) {
    const hadSelection = Boolean(selectedRoom);
    const available = await roomOptions(current);
    if (current !== generation) return;
    if (!available.length) {
      clearRoom();
      controlsReady = true;
      syncComposer();
      el("notice").textContent = access === "operator"
        ? t("Brak dostępnych pokoi. Możesz utworzyć pokój.") : t("Brak dostępnych pokoi.");
      return;
    }
    if (selectedRoom) {
      await room("", keepDraft);
      return;
    }
    if (initial) {
      el("room").value = available[0].id;
      await room();
      return;
    }
    controlsReady = true;
    syncComposer();
    if (!hadSelection)
      el("notice").textContent = t("Wybierz pokój, aby otworzyć rozmowę. Szkic pozostaje w pamięci tej strony.");
  }

  function stopLive(message = t("Zdarzenia na żywo wyłączone.")) {
    const owner = live;
    live = null;
    if (owner) {
      owner.source?.close();
      clearTimeout(owner.timer);
      owner.controller.abort();
      if (owner.loading) invalidate();
    }
    el("live-toggle").textContent = t("Włącz zdarzenia na żywo");
    el("live-status").textContent = message;
    el("live-count").textContent = "";
    el("live-indicator").dataset.live = "off";
  }

  function scheduleLive(owner, delay = 500) {
    if (!owner || live !== owner || !owner.dirty || owner.loading || owner.timer !== null || reads || writesBusy()) return;
    owner.timer = setTimeout(() => { owner.timer = null; refreshLive(owner); }, delay);
  }

  function disconnectLive(owner, resync = false) {
    if (live !== owner) return;
    owner.source?.close();
    owner.source = null;
    owner.resync ||= resync;
    owner.dirty = true;
    // Fence old reads without aborting an outstanding, immutable mutation.
    invalidate(false);
    scopeEpoch += 1;
    clearSnapshot();
    if (pending) el("viewer").hidden = true;
    if (controlRequest) el("notice").textContent = t("Zmiana administracyjna niepotwierdzona; wymagany świeży odczyt.");
    el("live-indicator").dataset.live = "off";
    el("live-status").textContent = resync ? t("Wymagana resynchronizacja historii i zakresu.") : t("Połączenie przerwane; ponowny odczyt przed połączeniem.");
    scheduleLive(owner, 1000);
  }

  // The server ends every stream after a bounded lifetime. Reconnect from the retained cursor, after the
  // usual binding and scope revalidation, but keep showing the last snapshot until that read replaces it.
  function reconnectLive(owner) {
    if (live !== owner) return;
    owner.source?.close();
    owner.source = null;
    owner.dirty = true;
    el("live-indicator").dataset.live = "off";
    el("live-status").textContent = t("Strumień zakończony; ponowne łączenie od zapamiętanego kursora.");
    scheduleLive(owner, 1000);
  }

  function connectLive(owner) {
    const source = new EventSource(`/v1/events?after=${owner.cursor}`);
    owner.source = source;
    owner.opened = false;
    source.onopen = () => {
      if (live === owner && owner.source === source) {
        owner.opened = true;
        el("live-indicator").dataset.live = "on";
        el("live-status").textContent = t("Połączenie zdarzeń aktywne; odczyty nie wysyłają ACK.");
      }
    };
    source.onerror = () => {
      if (live !== owner || owner.source !== source) return;
      // A stream that opened and is being re-established ended normally; a refused or never-opened one did not.
      if (owner.opened && source.readyState === EventSource.CONNECTING) reconnectLive(owner);
      else disconnectLive(owner);
    };
    // `state` and `thread` are invalidations like the rest: the refresh reads the tables, never the event body.
    for (const kind of ["message", "receipt", "control", "state", "thread"]) source.addEventListener(kind, (event) => {
      if (live !== owner || owner.source !== source) return;
      try {
        const data = JSON.parse(event.data);
        // ID-less errors can inherit the previous EventSource lastEventId.
        if (data.error) {
          disconnectLive(owner, ["ROOM_SCOPE_CHANGED", "CURSOR_EXPIRED"].includes(data.error.code));
          return;
        }
        if (!cursorValid(event.lastEventId) || !uuid(data.room_id)) throw new Error("INVALID_EVENT");
        if (BigInt(event.lastEventId) <= BigInt(owner.cursor)) return;
        owner.cursor = event.lastEventId;
        if (BigInt(event.lastEventId) <= BigInt(owner.seen.get(data.room_id) ?? "0")) return;
        owner.seen.set(data.room_id, event.lastEventId);
        owner.received += 1;
        el("live-count").textContent = t("Odebrane zdarzenia: {received} · kursor: {cursor}", {
          received: owner.received, cursor: owner.cursor,
        });
        if (data.room_id === selectedRoom) { owner.dirty = true; scheduleLive(owner); }
      } catch {
        disconnectLive(owner);
        stopLive(t("Niepoprawna ramka zdarzeń. Odśwież widok ręcznie."));
        syncComposer();
      }
    });
  }

  async function refreshLive(owner) {
    if (live !== owner || reads || writesBusy()) { scheduleLive(owner); return; }
    owner.loading = true;
    owner.dirty = false;
    const current = invalidate();
    syncComposer();
    let delay = 500;
    try {
      const session = await request("/v1/browser/session", { signal: owner.controller.signal });
      if (stale(live, owner, current)) return;
      if (session.principal_id !== owner.principal || session.csrf_token !== owner.csrf || session.access !== access)
        throw Object.assign(new Error("BINDING_CHANGED"), { status: 401 });
      const available = await roomOptions(current);
      if (stale(live, owner, current)) return;
      const scope = available.map((r) => r.id).sort().join(",");
      if (scope !== owner.rooms) { owner.rooms = scope; owner.resync = true; }
      if (!selectedRoom) {
        stopLive(available.length ? t("Nie wybrano pokoju; zdarzenia wyłączone.") : t("Brak dostępnych pokoi; zdarzenia wyłączone."));
        controlsReady = true;
        return;
      }
      if (owner.resync) historyPageStart = participantPageStart = null;
      await Promise.all([history(current, historyPageStart), participants(current, participantPageStart), roomState(current)]);
      if (stale(live, owner, current)) return;
      if (BigInt(owner.cursor) < BigInt(historyFloor)) owner.resync = true;
      if (owner.resync) {
        owner.source?.close();
        owner.source = null;
        owner.cursor = historyFloor;
        owner.resync = false;
        el("live-status").textContent = t("Odtworzono zachowaną historię; wznawianie zdarzeń.");
      }
      // Detect HTTP cursor refusals before EventSource, whose error hides the status.
      if (!owner.source) await request(`${roomPath()}/history?after=${owner.cursor}&limit=1`);
      if (stale(live, owner, current)) return;
      composerReady = controlsReady = true;
      el("viewer").hidden = false;
      owner.backoff = 1000;
      if (!owner.source) connectLive(owner);
    } catch (error) {
      if (stale(live, owner, current)) return;
      if (error.status === 401 || error.status === 403) {
        stopLive();
        lock();
        el("notice").textContent = t("Sesja lub zakres zmieniły się. Zaloguj się ponownie; nie przyjmujemy innego powiązania automatycznie.");
      } else if (error.status === 422) {
        disconnectLive(owner);
        stopLive(t("Niepoprawny kursor. Odśwież widok ręcznie."));
      } else {
        if (error.status === 410) owner.resync = true;
        disconnectLive(owner, owner.resync);
        delay = owner.backoff;
        owner.backoff = Math.min(10000, owner.backoff * 2);
      }
    } finally {
      owner.loading = false;
      flushSessions();
      scheduleLive(owner, delay);
      syncComposer();
    }
  }

  function startLive() {
    if (live || busy() || !composerReady) return false;
    live = {
      // The history read just rendered is current up to this event position; nothing older is replayed.
      principal, csrf, cursor: historyEventCursor,
      rooms: Array.from(el("room").options, (option) => option.value).filter(Boolean).sort().join(","), received: 0,
      source: null, opened: false, timer: null, controller: new AbortController(), seen: new Map(),
      loading: false, dirty: true, resync: false, backoff: 1000,
    };
    el("live-toggle").textContent = t("Wyłącz zdarzenia na żywo");
    el("live-status").textContent = t("Sprawdzanie powiązania i zakresu…");
    scheduleLive(live, 0);
    return true;
  }

  // A remembered opt-in starts the same bound, revalidated path as the toggle once a room snapshot is in place.
  // Only the toggle changes the choice: logout, expiry, a room switch or a stream error never clear it.
  function resumeLive() {
    if (!live && csrf !== null && liveWanted) startLive();
  }

  el("live-toggle").addEventListener("click", () => {
    if (live) { rememberLive(false); stopLive(); syncComposer(); return; }
    if (startLive()) rememberLive(true);
  });

  // Initial load selects the first authorized room. A refresh revalidates the session and scope
  // without moving the operator to another room or discarding the draft.
  async function start({ preserve = false } = {}) {
    if (!preserve) {
      lock();
    } else {
      stopLive();
      invalidate();
      clearState();
      composerReady = controlsReady = false;
      syncComposer();
    }
    el("login").hidden = true;
    el("login-view").hidden = true;
    const current = generation;
    const reported = await read(async () => {
      const data = await request("/v1/browser/session");
      if (current !== generation) return;
      acceptSession(data);
      showSession();
      await rooms(current, { initial: !preserve, keepDraft: preserve });
    }, current, { denied: t("Brak aktywnej sesji. Zaloguj się tokenem operatora lub podglądu.") });
    if (reported) {
      el("login").hidden = csrf !== null;
      el("login-view").hidden = csrf !== null;
    }
  }

  el("login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = el("token").value;
    el("token").value = ""; // Never retain the entered credential in the DOM or browser storage.
    const current = invalidate();
    el("login").hidden = true;
    el("login-view").hidden = true;
    el("notice").textContent = t("Logowanie…");
    const reported = await read(async () => {
      const challenge = await request("/v1/login");
      if (current !== generation) return;
      const data = await request("/v1/login", { method: "POST", body: { token }, csrfToken: challenge.csrf_token });
      if (current !== generation) return;
      const session = await request("/v1/browser/session");
      if (current !== generation) return;
      if (session.csrf_token !== data.csrf_token || !["operator", "viewer"].includes(data.access)
          || session.access !== data.access) {
        const error = new Error("SESSION_CHANGED");
        error.status = 401;
        throw error;
      }
      acceptSession(session);
      showSession();
      await rooms(current, { initial: true });
    }, current, { denied: t("Logowanie odrzucone. Sprawdź token i spróbuj ponownie.") });
    if (reported) {
      el("login").hidden = csrf !== null;
      el("login-view").hidden = csrf !== null;
    }
  });

  el("logout").addEventListener("click", async () => {
    if (!mayDiscard()) return;
    const oldCsrf = csrf;
    lock(); // Hide private data immediately, even if the network is unavailable.
    const current = generation;
    el("login").hidden = true;
    el("notice").textContent = t("Wylogowywanie…");
    try {
      await request("/v1/logout", { method: "POST", body: {}, csrfToken: oldCsrf });
      if (current !== generation) return;
      el("notice").textContent = t("Wylogowano.");
      el("login").hidden = false;
    } catch (error) {
      if (current !== generation) return;
      if (error.status === 401) {
        el("notice").textContent = t("Sesja nie jest już aktywna.");
        el("login").hidden = false;
      } else {
        csrf = oldCsrf;
        el("logout").hidden = false;
        el("notice").textContent = t("Wylogowanie niepotwierdzone. Ponów wylogowanie; nie zamykaj tego okna jako potwierdzenia.");
      }
    }
  });

  el("room").addEventListener("change", () => {
    if (busy() || !mayDiscard()) { el("room").value = selectedRoom; return; }
    room();
  });
  el("refresh").addEventListener("click", async () => {
    if (busy()) return;
    // A refresh always revalidates in place. When revocation has already cleared the
    // selection, the preserving path still keeps the draft and never chooses a room.
    await start({ preserve: true });
    if (view === "sessions") requestSessions();
  });
  el("tab-chat").addEventListener("click", () => showView("chat"));
  el("tab-sessions").addEventListener("click", () => showView("sessions"));
  el("sessions-filter").addEventListener("input", renderSessions);
  el("more-sessions").addEventListener("click", loadMoreSessions);
  el("thread-filter").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = el("thread").value.trim();
    filterThread((uuid(value.toLowerCase()) ? value.toLowerCase() : value) || null);
  });
  el("all-history").addEventListener("click", () => filterThread(null));
  el("latest").addEventListener("click", latestHistory);
  for (const [id, load, cursor] of [
    ["more-messages", history, () => historyCursor],
    ["more-participants", participants, () => participantCursor],
  ]) el(id).addEventListener("click", async () => {
    const page = cursor();
    if (page === null || busy()) return;
    const current = generation;
    el(id).disabled = true;
    await read(() => load(current, page), current);
    if (id === "more-messages") {
      if (mobileLayout()) el("messages").scrollIntoView({ block: "start" });
      else el("messages").scrollTop = 0;
    }
    syncComposer();
  });

  async function sendPending() {
    if (!pending || sending) return;
    const attempt = pending;
    sending = true;
    syncComposer();
    el("write-status").textContent = t("Wysyłanie…");
    try {
      const data = await request(attempt.path, attempt.options);
      if (pending !== attempt) return;
      const expected = attempt.options.body;
      if (!uuid(data.id) || !uuid(data.thread_id) || data.sender?.principal_id !== attempt.principal ||
          data.sender?.session_id !== null || data.room_id !== attempt.room || data.body !== expected.body || data.kind !== expected.kind ||
          data.reply_to !== expected.reply_to || !Array.isArray(data.recipients) ||
          JSON.stringify([...data.recipients].sort()) !== JSON.stringify(expected.recipients) ||
          (expected.thread_id !== null && data.thread_id !== expected.thread_id) ||
          (expected.ref_key !== undefined && data.thread_ref_key !== expected.ref_key))
        throw new Error("UNCONFIRMED_RECEIPT");
      pending = null;
      clearDraft();
      // The message is committed: report it before the read-back, which can only add to that report.
      const saved = t("Zapisano {id}. To nie jest potwierdzenie wybudzenia ani ACK.", { id: data.id });
      el("notice").textContent = saved;
      await room(saved);
      scrollMessagesToBottom();
    } catch (error) {
      if (pending !== attempt) return;
      // Even a refusal on a retry cannot disprove an earlier committed attempt.
      el("write-status").textContent = t("Zapis niepotwierdzony. Ponów tę samą próbę lub sprawdź historię w osobnym oknie.");
      if (error.status === 401 || error.status === 403) {
        clearRoom();
        el("viewer").hidden = true;
        el("body").value = "";
        el("write-status").textContent += " " + t("Brak dostępu; nie zmieniamy tożsamości ani klucza próby.");
      }
    } finally {
      sending = false;
      flushSessions();
      syncComposer();
    }
  }

  el("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    if (access !== "operator" || busy() || !composerReady) return;
    const body = el("body").value;
    const kind = replyTarget ? "reply" : el("kind").value;
    if (!body || body.includes("\u0000") || new TextEncoder().encode(body).length > 16384) {
      el("notice").textContent = t("Treść musi zawierać od 1 do 16384 bajtów UTF-8, bez NUL.");
      return;
    }
    // Empty replies otherwise implicitly address the parent sender on the server.
    if ((["question", "consultation"].includes(kind) || replyTarget?.senderSession) && !targets.size) {
      el("notice").textContent = t("Wybierz konkretnego odbiorcę.");
      return;
    }
    const refKey = el("ref-key").value.trim();
    if (refKey && (replyTarget || ["question", "consultation"].includes(kind) || !REF_KEY.test(refKey))) {
      el("notice").textContent = t("Niepoprawny klucz wątku albo rodzaj wiadomości, który go nie przyjmuje.");
      return;
    }
    const key = crypto.randomUUID();
    pending = Object.freeze({
      principal, room: selectedRoom, path: `${roomPath()}/messages`,
      options: Object.freeze({ method: "POST", key, csrfToken: csrf,
        body: Object.freeze({ body, kind, recipients: Object.freeze([...targets.keys()].sort()),
          thread_id: replyTarget?.thread_id ?? null, reply_to: replyTarget?.id ?? null,
          ...(refKey ? { ref_key: refKey } : {}) }),
      }),
    });
    el("write-key").textContent = t("Klucz: {key} · pokój: {room}", { key, room: selectedRoom });
    sendPending();
  });
  el("kind").addEventListener("change", () => {
    // A question or consultation cannot carry a thread key. Clear an existing one instead of
    // leaving a disabled but submitted value that the server would refuse.
    if (QUESTION_KINDS.has(el("kind").value) && el("ref-key").value) {
      el("ref-key").value = "";
      el("notice").textContent = t("Usunięto klucz wątku: pytanie i konsultacja nie przyjmują klucza wątku.");
    }
    syncComposer();
  });
  el("retry-write").addEventListener("click", sendPending);
  el("abandon-write").addEventListener("click", () => {
    if (sending || !mayDiscard()) return;
    pending = null;
    start(); // Revalidate scope before allowing another publication.
  });
  el("clear-draft").addEventListener("click", () => { if (!writesBusy() && mayDiscard()) clearDraft(); });
  el("clear-targets").addEventListener("click", () => { if (!writesBusy()) { targets.clear(); syncComposer(); } });
  el("roster-filter").addEventListener("input", applyRosterFilter);
  let languageUnload = false;
  window.agentChatMayDiscardForLanguage = () => {
    if (!writesBusy() && !hasDraft()) return true;
    if (!mayDiscard()) return false;
    languageUnload = true;
    return true;
  };
  window.addEventListener("beforeunload", (event) => {
    if (!languageUnload && (writesBusy() || hasDraft())) { event.preventDefault(); event.returnValue = ""; }
  });
  window.addEventListener("pagehide", lock);
  // pagehide has already locked the page, so a bfcache restore reloads like a first load: it selects a room
  // and holds no draft. Only the in-page Refresh control preserves the room and the draft.
  window.addEventListener("pageshow", (event) => { if (event.persisted) start(); });
  start();
})();
