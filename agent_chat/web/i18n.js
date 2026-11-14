// Polish/English UI translation. Source strings are Polish; English is the only added locale.
"use strict";

(() => {
  const STORAGE_KEY = "agent-chat.language";
  const EN = {
  "Sprawdzanie sesji…": "Checking session…",
  "Niepotwierdzony zapis": "Unconfirmed write",
  "Próba zapisu": "Write attempt",
  "Próba pozostaje tylko w pamięci tej strony. Ponowienie zachowuje ten sam klucz, treść i odbiorców. Utrata potwierdzenia nie oznacza, że serwer niczego nie zapisał.": "This attempt remains only in this page's memory. Retrying keeps the same key, body and recipients. Losing confirmation does not mean the server stored nothing.",
  "Ponów tę samą próbę": "Retry the same attempt",
  "Porzuć lokalną próbę": "Discard local attempt",
  "Wybierz pokój": "Choose a room",
  "Odśwież": "Refresh",
  "Podgląd · tylko odczyt": "Viewer · read-only",
  "Zdarzenia na żywo wyłączone.": "Live events are off.",
  "Włącz zdarzenia na żywo": "Enable live events",
  "Wyłącz zdarzenia na żywo": "Disable live events",
  "Pomoc": "Help",
  "Jak czytać ten widok": "How to read this view",
  "Migawka.": "Snapshot.",
  "Dane są migawką. Odśwież widok, aby zobaczyć aktualne wpisy i potwierdzenia. Odświeżenie zachowuje wybrany pokój i szkic.": "The data is a snapshot. Refresh the view to see current entries and acknowledgements. Refreshing keeps the selected room and draft.",
  "Uczestnicy.": "Participants.",
  "Wybierz sesję, aby dodać ją jako odbiorcę (maks. 16, także offline). Obecność nie oznacza gotowości do wybudzenia. Plan Mode, stop i wyciszenie pozostają niezależne. Mute dotyczy całej sesji, nie tylko tego pokoju. Pytanie i konsultacja wymagają odbiorcy.": "Select a session to add it as a recipient (maximum 16, including offline). Presence does not mean it is ready to wake. Plan Mode, stop and mute remain independent. Mute applies to the whole session, not just this room. Questions and consultations require a recipient.",
  "Historia i stany.": "History and state.",
  "Filtr zmienia tylko podgląd. Nowa wiadomość rozpoczyna nowy wątek; przycisk Odpowiedz przypina odpowiedź do wiadomości. Zapis, przekazanie, ACK, odpowiedź i niepewność są osobnymi stanami. Sam odczyt nie wysyła ACK.": "The filter changes only the view. A new message starts a new thread; Reply attaches the answer to a message. Storage, handoff, ACK, reply and uncertainty are separate states. Reading alone sends no ACK.",
  "Treść wiadomości agentów jest niezaufana:": "Agent message content is untrusted:",
  "to nie polecenie ani zgoda na operację.": "it is not an instruction or approval for an operation.",
  "Zarządzanie pokojami": "Room management",
  "Pokoje": "Rooms",
  "Utwórz pokój": "Create room",
  "Identyfikator — małe litery, cyfry i myślnik; do 63 znaków": "Slug — lowercase letters, digits and hyphen; up to 63 characters",
  "Nazwa — do 128 znaków": "Name — up to 128 characters",
  "Dodaj sesję do wybranego pokoju": "Add a session to the selected room",
  "Wymagany jest istniejący dostęp poświadczenia tej sesji do pokoju. Ten formularz nie rozszerza uprawnień.": "The session credential must already have access to this room. This form does not widen permissions.",
  "Dokładny UUID sesji": "Exact session UUID",
  "Dodaj sesję": "Add session",
  "Wyloguj": "Log out",
  "Bezpieczna sesja przeglądarki": "Secure browser session",
  "Rozmowy agentów": "Agent conversations",
  "Pokoje, w których agenci i operator uzgadniają pracę: kto jest obecny, co zostało wysłane i co czeka na decyzję.": "Rooms where agents and the operator coordinate work: who is present, what was sent and what awaits a decision.",
  "Token podglądu": "Viewer token",
  "Czyta pokoje i historię. Niczego nie wysyła ani nie zmienia.": "Reads rooms and history. It sends and changes nothing.",
  "Token operatora": "Operator token",
  "Dodatkowo publikuje, zarządza pokojami i wycisza sesje.": "Additionally publishes, manages rooms and mutes sessions.",
  "Token operatora lub podglądu": "Operator or viewer token",
  "Zaloguj": "Log in",
  "Ten podgląd wymaga JavaScript. Token nie jest wysyłany przez zwykły formularz.": "This viewer requires JavaScript. The token is not sent by an ordinary form.",
  "Widoki": "Views",
  "Rozmowy": "Conversations",
  "Sesje": "Sessions",
  "Pokoje i uczestnicy": "Rooms and participants",
  "Uczestnicy": "Participants",
  "Filtruj uczestników": "Filter participants",
  "Filtruj uczestników…": "Filter participants…",
  "Kolejna strona uczestników": "More participants",
  "Rozmowa": "Conversation",
  "Cała historia pokoju": "Full room history",
  "Filtr wątku": "Thread filter",
  "UUID albo klucz wątku": "UUID or thread key",
  "Filtruj wątek": "Filter thread",
  "Cała historia": "Full history",
  "Wróć do najnowszych": "Back to latest",
  "Wiadomości": "Messages",
  "Starsze wiadomości": "Older messages",
  "Nowa wiadomość lub odpowiedź": "New message or reply",
  "Nowy wątek": "New thread",
  "Do:": "To:",
  "Wybrani odbiorcy": "Selected recipients",
  "Wyczyść odbiorców": "Clear recipients",
  "Treść — do 16 KiB UTF-8; bez sekretów i transkryptów": "Body — up to 16 KiB UTF-8; no secrets or transcripts",
  "Napisz wiadomość: do 16 KiB, bez sekretów i transkryptów": "Write a message: up to 16 KiB, no secrets or transcripts",
  "Rodzaj": "Kind",
  "Informacja": "Information",
  "Wiadomość": "Message",
  "Status": "Status",
  "Uwaga": "Heads-up",
  "Zamiar": "Intent",
  "Pytanie — wymaga odbiorcy": "Question — requires a recipient",
  "Pytanie": "Question",
  "Konsultacja": "Consultation",
  "Blokada i decyzja": "Blocked and decision",
  "Zablokowany przez": "Blocked on",
  "Potrzebna decyzja": "Decision needed",
  "Klucz wątku": "Thread key",
  "opcjonalnie: pr:repo#N, lane:…, resource:host:nazwa": "optional: pr:repo#N, lane:…, resource:host:name",
  "Wyczyść szkic": "Clear draft",
  "Wyślij": "Send",
  "Opcjonalny klucz nowego wątku.": "Optional new-thread key.",
  "Szczegóły techniczne": "Technical details",
  "Stan zasobów (obserwacja)": "Resource state (observation)",
  "Czat nie przydziela, nie porządkuje ani nie zwalnia blokad. Wpisy to niezaufane obserwacje producenta, nie polecenia ani zgody.": "Chat does not allocate, order or release locks. Entries are untrusted producer observations, not instructions or approvals.",
  "Kto jest kim, nad czym pracuje i co ogłosił. Obecność nie oznacza gotowości do wybudzenia; znacznik roli nie nadaje uprawnień.": "Who is who, what they work on and what they announced. Presence does not mean readiness to wake; a role mark grants no authority.",
  "Filtruj sesje": "Filter sessions",
  "Filtruj sesje…": "Filter sessions…",
  "Sesja": "Session",
  "Harness": "Harness",
  "Host": "Host",
  "Stan": "State",
  "Lane": "Lane",
  "Praca": "Work",
  "Role": "Roles",
  "Aktywność": "Activity",
  "PR-y": "PRs",
  "Kolejne sesje": "More sessions",
  "Odpowiedź": "Reply",
  "Ta sesja ma już inną rolę w tym pokoju. Zdejmij obecną rolę i spróbuj ponownie.": "This session already has another role in this room. Remove the current role and try again.",
  "Nie można utworzyć pokoju o tym identyfikatorze.": "A room with this identifier cannot be created.",
  "Serwer odrzucił żądanie. Sprawdź wybrane wartości.": "The server refused the request. Check the selected values.",
  "Wybrany odbiorca nie jest już dostępny w tym pokoju.": "The selected recipient is no longer available in this room.",
  "Wiadomość wygasła; nie można wykonać tej operacji.": "The message expired; this operation cannot be performed.",
  "Ta sesja nie jest już aktywna. Odśwież widok.": "This session is no longer active. Refresh the view.",
  "Brak dostępu do tego pokoju.": "No access to this room.",
  "Brak uprawnień do tej zmiany.": "No permission for this change.",
  "Nie znaleziono obiektu. Odśwież widok.": "The object was not found. Refresh the view.",
  "Odpowiedź dziedziczy wątek; klucz wątku jest niedostępny.": "A reply inherits its thread; a thread key is unavailable.",
  "Pytanie i konsultacja nie przyjmują klucza wątku.": "Questions and consultations do not accept a thread key.",
  "Zapis mógł już powstać. Usunąć wyłącznie lokalną kopię próby? To nie cofa zapisu na serwerze.": "The write may already exist. Delete only the local attempt copy? This does not undo the server write.",
  "Zmiana administracyjna może zostać zapisana mimo opuszczenia widoku. Kontynuować?": "The administrative change may be stored even after leaving this view. Continue?",
  "Usunąć niezapisany szkic?": "Delete the unsaved draft?",
  "Odpowiedź na {id} · wątek {thread}": "Reply to {id} · thread {thread}",
  "Wybierz": "Select",
  "Wybierz {id}": "Select {id}",
  "Można wybrać najwyżej 16 sesji.": "At most 16 sessions can be selected.",
  "Cofnij wyciszenie": "Unmute",
  "Wycisz": "Mute",
  "Zdejmij PM": "Remove PM",
  "Ustaw PM": "Set PM",
  "Szczegóły": "Details",
  "Odpowiedz": "Reply",
  "Wątek": "Thread",
  "Potwierdzenia dostarczenia": "Delivery acknowledgements",
  "ID wiadomości": "Message ID",
  "Odpowiedź na": "Reply to",
  "Nadawca": "Sender",
  "Sesja natywna": "Native session",
  "Czas": "Time",
  "Brak obserwacji stanu.": "No state observations.",
  "Bez klucza wątku": "Without a thread key",
  "Pokaż wątek": "Show thread",
  "Wyświetlono pierwsze wpisy; reszta wymaga agent-chat state.": "Only the first entries are shown; the rest requires agent-chat state.",
  "Stan zasobów niedostępny.": "Resource state unavailable.",
  "Brak wiadomości w tym wątku.": "No messages in this thread.",
  "Klucz: ": "Key: ",
  "stan:": "state:",
  "otwarty": "open",
  "wolny": "free",
  "zajęty ({who}) od {since}": "held ({who}) since {since}",
  "zablokowany (stuck)": "stuck",
  "nieznany": "unknown",
  "nieznany (producent odwołany)": "unknown (producer revoked)",
  "Klucz: {key} · pokój: {room}": "Key: {key} · room: {room}",
  "rozwiązany {time}": "resolved {time}",
  "Klucz:": "Key:",
  "brak": "none",
  "Otwórz ponownie": "Reopen",
  "Oznacz jako rozwiązany": "Mark resolved",
  "Podaj poprawny UUID wątku, klucz wątku albo pozostaw puste pole.": "Enter a valid thread UUID, thread key, or leave the field empty.",
  "Wątek: {thread}": "Thread: {thread}",
  "Odczyt historii…": "Reading history…",
  "Migawka historii. Odczyt nie potwierdza przetworzenia wiadomości.": "History snapshot. The read does not confirm message processing.",
  "Migawka historii. Filtr nie zmienia szkicu ani odbiorców.": "History snapshot. The filter does not change the draft or recipients.",
  "Powrót do najnowszych…": "Returning to latest…",
  "Zapisywanie zmiany…": "Saving change…",
  "Nie udało się pobrać kolejnej strony sesji. Spróbuj ponownie.": "Could not load the next sessions page. Try again.",
  "Zmień rolę": "Change role",
  "Zdejmij": "Remove",
  "Nadaj": "Assign",
  "Brak sesji w tym pokoju.": "No sessions in this room.",
  "Niepoprawny identyfikator lub nazwa pokoju.": "Invalid room identifier or name.",
  "Podaj dokładny UUID sesji.": "Enter the exact session UUID.",
  "Odczyt pokoju…": "Reading room…",
  "Wybrany pokój nie jest już dostępny. Wybierz pokój z listy.": "The selected room is no longer available. Choose a room from the list.",
  "Brak dostępnych pokoi. Możesz utworzyć pokój.": "No rooms available. You can create one.",
  "Brak dostępnych pokoi.": "No rooms available.",
  "Wybierz pokój, aby otworzyć rozmowę. Szkic pozostaje w pamięci tej strony.": "Choose a room to open the conversation. The draft remains in this page's memory.",
  "Sprawdzanie powiązania i zakresu…": "Checking binding and scope…",
  "Brak aktywnej sesji. Zaloguj się tokenem operatora lub podglądu.": "No active session. Log in with an operator or viewer token.",
  "Logowanie…": "Logging in…",
  "Logowanie odrzucone. Sprawdź token i spróbuj ponownie.": "Login refused. Check the token and try again.",
  "Wylogowywanie…": "Logging out…",
  "Wylogowano.": "Logged out.",
  "Sesja nie jest już aktywna.": "The session is no longer active.",
  "Wylogowanie niepotwierdzone. Ponów wylogowanie; nie zamykaj tego okna jako potwierdzenia.": "Logout unconfirmed. Retry logout; do not treat closing this window as confirmation.",
  "Wysyłanie…": "Sending…",
  "Zapis niepotwierdzony. Ponów tę samą próbę lub sprawdź historię w osobnym oknie.": "Write unconfirmed. Retry the same attempt or check history in another window.",
  "Treść musi zawierać od 1 do 16384 bajtów UTF-8, bez NUL.": "The body must contain 1 to 16384 UTF-8 bytes, without NUL.",
  "Wybierz konkretnego odbiorcę.": "Select a specific recipient.",
  "Niepoprawny klucz wątku albo rodzaj wiadomości, który go nie przyjmuje.": "Invalid thread key, or a message kind that does not accept one.",
  "Usunięto klucz wątku: pytanie i konsultacja nie przyjmują klucza wątku.": "Thread key removed: questions and consultations do not accept one.",
  "Zmiana administracyjna niepotwierdzona; wymagany świeży odczyt.": "Administrative change unconfirmed; a fresh read is required.",
  "Wymagana resynchronizacja historii i zakresu.": "A history and scope resynchronization is required.",
  "Połączenie przerwane; ponowny odczyt przed połączeniem.": "Connection interrupted; a fresh read is required before reconnecting.",
  "Strumień zakończony; ponowne łączenie od zapamiętanego kursora.": "Stream ended; reconnecting from the remembered cursor.",
  "Połączenie zdarzeń aktywne; odczyty nie wysyłają ACK.": "Event connection active; reads do not send ACK.",
  "Niepoprawna ramka zdarzeń. Odśwież widok ręcznie.": "Invalid event frame. Refresh the view manually.",
  "Nie wybrano pokoju; zdarzenia wyłączone.": "No room selected; events are off.",
  "Brak dostępnych pokoi; zdarzenia wyłączone.": "No rooms available; events are off.",
  "Odtworzono zachowaną historię; wznawianie zdarzeń.": "Restored history; resuming events.",
  "Sesja lub zakres zmieniły się. Zaloguj się ponownie; nie przyjmujemy innego powiązania automatycznie.": "The session or scope changed. Log in again; another binding is not adopted automatically.",
  "Niepoprawny kursor. Odśwież widok ręcznie.": "Invalid cursor. Refresh the view manually.",
  "rozwiązany": "resolved",
  "Liczby dotyczą załadowanej strony uczestników, nie całego pokoju.": "The counts cover the loaded participants page, not the whole room.",
  "na stronie: ": "on this page: ",
  " na stronie": " on this page",
  "Online": "Online",
  "Offline": "Offline",
  "Agent": "Agent",
  "Operator": "Operator",
  "zapis:": "stored:",
  "przekazanie:": "handed:",
  "odpowiedź:": "reply:",
  "niepewność:": "uncertainty:",
  "próba:": "attempt:",
  "Zbyt wiele żądań lub nieudanych prób logowania. Spróbuj ponownie za minutę.": "Too many requests or failed login attempts. Try again in a minute.",
  "Nie udało się odczytać danych. Odśwież widok lub zaloguj się ponownie.": "Could not read data. Refresh the view or log in again.",
  "Nie udało się odczytać danych. Odśwież widok; nie wysyłaj wiadomości ponownie.": "Could not read data. Refresh the view; do not send the message again.",
  "zapis": "stored",
  "przekazanie": "handed",
  "odpowiedź": "reply",
  "niepewność": "uncertainty",
  "próba": "attempt",
  "tak": "yes",
  "niepewność: {reason}": "uncertainty: {reason}",
  "próba: {outcome}": "attempt: {outcome}",
  "Zapis {label} potwierdzony, ale odczyt stanu niedostępny.": "Write of {label} confirmed, but state read unavailable.",
  "Zmiana {label} niepotwierdzona.": "Change of {label} unconfirmed.",
  "Dostęp wygasł lub został cofnięty. Zaloguj się ponownie.": "Access expired or was revoked. Log in again.",
  "Odśwież stan przed następną decyzją.": "Refresh state before the next decision.",
  "Odśwież stan przed następną decyzją; nie ponawiamy operacji automatycznie.": "Refresh state before the next decision; the operation is not retried automatically.",
  "Zapisano {id}. To nie jest potwierdzenie wybudzenia ani ACK.": "Stored {id}. This is not confirmation of a wake or ACK.",
  "Sesja wygasła lub dostęp został cofnięty. Zaloguj się ponownie.": "The session expired or access was revoked. Log in again."
};
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  const LOOKUP = Object.fromEntries(Object.entries(EN).map(([key, value]) => [normalize(key), value]));
  const language = (() => { try { return window.localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "pl"; } catch { return "pl"; } })();
  function t(text, values = {}) {
    const key = normalize(text);
    let result = language === "en" ? (LOOKUP[key] ?? text) : text;
    for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value));
    return result;
  }
  const skipText = (node) => node.parentElement?.closest("script, style, textarea, #language, [data-no-i18n]");
  const skipElement = (node) => node.closest("script, style, #language, [data-no-i18n]");
  function translateNode(node) {
    if (language !== "en" || !node.nodeValue) return;
    const raw = node.nodeValue;
    const key = normalize(raw);
    if (!key || LOOKUP[key] === undefined) return;
    const leading = raw.match(/^\s*/)[0];
    const trailing = raw.match(/\s*$/)[0];
    node.nodeValue = leading + LOOKUP[key] + trailing;
  }
  function translateAttributes(element) {
    if (language !== "en" || skipElement(element)) return;
    for (const name of ["placeholder", "title", "aria-label", "label"]) {
      const value = element.getAttribute(name);
      if (value && LOOKUP[normalize(value)] !== undefined) element.setAttribute(name, LOOKUP[normalize(value)]);
    }
  }
  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) { if (!skipText(root)) translateNode(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE || skipElement(root)) return;
    translateAttributes(root);
    for (const child of root.childNodes) walk(child);
  }
  function apply() {
    document.documentElement.lang = language;
    for (const select of document.querySelectorAll("#language")) select.value = language;
    walk(document.body);
  }
  for (const select of document.querySelectorAll("#language")) {
    select.value = language;
    select.addEventListener("change", () => {
      try { window.localStorage.setItem(STORAGE_KEY, select.value === "en" ? "en" : "pl"); } catch {}
      window.location.reload();
    });
  }
  window.AgentChatI18n = Object.freeze({ t, language, locale: language === "en" ? "en-US" : "pl-PL", apply });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
})();
