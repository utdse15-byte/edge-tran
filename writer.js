(() => {
  "use strict";

  const SEND_INTENT_TTL_MS = 3000;
  const REBIND_DELAY_MS = 80;
  const PORT_RECONNECT_DELAY_MS = 450;
  const HIDDEN_COMPOSER_GRACE_MS = 5000;
  const TEXT_CONTROL_POLL_MS = 500;
  const COMPOSER_SCAN_INTERVAL_MS = 1000;
  const EDITABLE_SELECTOR = [
    "textarea",
    'input[type="text"]',
    'input[type="search"]',
    'input[type="url"]',
    'input[type="email"]',
    "input:not([type])",
    '[contenteditable]:not([contenteditable="false"])'
  ].join(", ");

  let port = null;
  let portReconnectTimer = null;
  let attached = false;
  let lease = null;
  let composer = null;
  let rootObserver = null;
  let composerObserver = null;
  let reconcileTimer = null;
  let rebindTimer = null;
  let manualBindHandler = null;
  let manualBindTimer = null;
  let manualBindRequestId = null;
  let manualBindToken = 0;
  let manualComposer = null;
  let writerSession = randomId("writer");
  let targetEpoch = 0;
  let lifecycleGeneration = 0;
  let lastWritten = "";
  let lastObservedText = "";
  let pluginOwned = false;
  let suppressUntil = 0;
  let expectedWriteText = "";
  let sendIntent = null;
  let lastUrl = location.href;
  let preferredStrategy = null;
  let activeMutation = null;
  let mutationQueue = Promise.resolve();
  let hiddenComposerSince = 0;
  let textControlPollTimer = null;
  let composerScanTimer = null;

  function randomId(prefix) {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    return `${prefix}_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
  }

  function post(message) {
    try {
      port?.postMessage(message);
    } catch {
      // The extension was reloaded or the service worker disconnected.
    }
  }

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[\u200b\ufeff]/g, "")
      .replace(/[ \t]+$/gm, "")
      .trimEnd();
  }

  function isVisible(element, minWidth = 1, minHeight = 1) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return (
      rect.width >= minWidth
      && rect.height >= minHeight
      && rect.bottom > 0
      && rect.top < innerHeight
      && rect.right > 0
      && rect.left < innerWidth
    );
  }

  function isTextControl(element) {
    return element instanceof HTMLTextAreaElement || (
      element instanceof HTMLInputElement
      && ["text", "search", "url", "email", ""].includes(element.type)
    );
  }

  function isEditableCandidate(element) {
    if (!(element instanceof HTMLElement) || !isVisible(element, 48, 12)) {
      return false;
    }
    if (isTextControl(element)) return !element.disabled && !element.readOnly;
    // role="textbox" alone is an accessibility declaration, not a writable
    // surface. Only mutate an actual contenteditable editor.
    return element.isContentEditable;
  }

  function composerContextFor(element) {
    const values = [];
    let current = element;

    // Modern editors frequently put labels/test IDs on the shell while the
    // innermost Lexical/ProseMirror node is the actual writable surface.
    for (let depth = 0; current && depth < 4; depth += 1) {
      const className = typeof current.className === "string"
        ? current.className
        : "";
      values.push(
        current.getAttribute("aria-label"),
        current.getAttribute("aria-placeholder"),
        current.getAttribute("data-placeholder"),
        current.getAttribute("placeholder"),
        current.getAttribute("data-testid"),
        current.getAttribute("name"),
        current.getAttribute("role"),
        current.getAttribute("aria-multiline"),
        current.getAttribute("enterkeyhint"),
        className
      );
      current = current.parentElement;
    }

    return values.filter(Boolean).join(" ").toLowerCase();
  }

  function messageHintFor(element) {
    return composerContextFor(element);
  }

  function sendLabelFor(button) {
    return [
      button.getAttribute("aria-label"),
      button.getAttribute("data-testid"),
      button.getAttribute("name"),
      button.id,
      button.title,
      button.textContent
    ].filter(Boolean).join(" ").trim().toLowerCase();
  }

  function isExplicitSubmitButton(button) {
    return String(button.getAttribute("type") || "").toLowerCase() === "submit";
  }

  function isSendLikeButton(button) {
    return isExplicitSubmitButton(button)
      || /(send|发送|提交|submit)/i.test(sendLabelFor(button));
  }

  function hasAssociatedSendControl(element) {
    const form = element.closest("form");
    if (form) {
      for (const button of form.querySelectorAll("button")) {
        // A real chat send button is commonly disabled while the composer is
        // empty. Disabled remains valid association evidence; whether sending
        // is currently allowed is the host page's responsibility.
        if (!(button instanceof HTMLButtonElement) || !isVisible(button, 1, 1)) {
          continue;
        }
        // Do not treat an implicit type=submit toolbar button as Send. Only an
        // explicit submit declaration or a send-like accessible label counts.
        if (isSendLikeButton(button)) return true;
      }
    }

    const editorRect = element.getBoundingClientRect();
    for (const button of document.querySelectorAll("button")) {
      if (!(button instanceof HTMLButtonElement) || !isVisible(button, 1, 1)) {
        continue;
      }
      if (!/(send|发送|提交|submit)/i.test(sendLabelFor(button))) continue;

      const rect = button.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (
        centerX >= editorRect.left - 140
        && centerX <= editorRect.right + 240
        && centerY >= editorRect.top - 140
        && centerY <= editorRect.bottom + 140
      ) {
        return true;
      }
    }
    return false;
  }

  function hasStrongEditorSemantics(element) {
    return Boolean(
      element.matches?.('[data-lexical-editor="true"]')
      || element.matches?.('.ProseMirror[contenteditable]')
      || element.getAttribute("contenteditable") === "plaintext-only"
      || (
        element.getAttribute("role") === "textbox"
        && element.getAttribute("aria-multiline") === "true"
        && element.isContentEditable
      )
    );
  }

  function candidateScore(element) {
    const rect = element.getBoundingClientRect();
    const hint = messageHintFor(element);
    const hasMessageHint = /(message|prompt|chat|claude|compose|write|ask|消息|输入|提问)/i.test(hint);
    const hasSendControl = hasAssociatedSendControl(element);
    const hasStrongEditor = hasStrongEditorSemantics(element);
    const bottomComposerShape = rect.width >= 220
      && rect.top > innerHeight * 0.32
      && rect.bottom > innerHeight * 0.62;

    // Fail closed for generic page editors. Strong editor semantics are only
    // sufficient on a wide, lower-page composer-shaped surface.
    if (
      !hasMessageHint
      && !hasSendControl
      && !(hasStrongEditor && bottomComposerShape)
    ) {
      return Number.NEGATIVE_INFINITY;
    }

    let score = 0;
    if (element instanceof HTMLTextAreaElement) score += 55;
    if (element instanceof HTMLInputElement) score += 30;
    if (element.isContentEditable) score += 50;
    if (element.getAttribute("role") === "textbox") score += 20;
    if (hasStrongEditor) score += 45;
    if (bottomComposerShape) score += 15;
    if (rect.top > innerHeight * 0.45) score += 35;
    if (rect.bottom > innerHeight * 0.75) score += 25;
    if (rect.width > 320) score += 20;
    if (rect.height > 28) score += 10;
    if (hasMessageHint) score += 45;
    if (hasSendControl) score += 45;
    if (/(search|搜索|filter|筛选)/i.test(hint)) score -= 160;
    if (element.closest('article, [data-testid*="conversation-turn" i]')) {
      score -= 90;
    }
    if (rect.bottom < innerHeight * 0.55 && !hasMessageHint) score -= 90;
    return score;
  }

  function locateComposer() {
    const candidates = [];
    for (const element of document.querySelectorAll(EDITABLE_SELECTOR)) {
      if (!isEditableCandidate(element)) continue;
      candidates.push({ element, score: candidateScore(element) });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.score >= 55 ? candidates[0].element : null;
  }

  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET",
    "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
    "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "TABLE", "UL"
  ]);

  function isBlockElement(node) {
    return node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName);
  }

  function serializeInlineNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
    if (!(node instanceof Element)) return "";
    if (node.tagName === "BR") return "\n";
    if (isBlockElement(node)) return serializeContentContainer(node);
    let text = "";
    for (const child of node.childNodes) text += serializeInlineNode(child);
    return text;
  }

  function serializeBlock(node) {
    const meaningful = [...node.childNodes].filter((child) => {
      if (child.nodeType === Node.TEXT_NODE) return Boolean(child.nodeValue);
      return child instanceof Element;
    });
    if (meaningful.length === 1 && meaningful[0] instanceof HTMLBRElement) return "";
    return serializeContentContainer(node);
  }

  function serializeContentContainer(container) {
    const segments = [];
    let inline = "";
    const flushInline = () => {
      if (inline !== "") {
        segments.push(inline);
        inline = "";
      }
    };

    for (const child of container.childNodes) {
      if (isBlockElement(child)) {
        flushInline();
        segments.push(serializeBlock(child));
      } else {
        inline += serializeInlineNode(child);
      }
    }
    flushInline();
    return segments.join("\n");
  }

  function readComposerText(element = composer) {
    if (!element) return "";
    if (isTextControl(element)) return normalizeText(element.value);
    return normalizeText(serializeContentContainer(element));
  }

  // Un-normalized serialization. normalizeText() erases trailing newlines and
  // blank blocks, which makes an end-of-document edit (the typical effect of
  // a plain Enter inside a trailing code block or list) invisible to the
  // normalized readback. The send-intent bookkeeping needs to see it.
  function rawComposerSerialization(element = composer) {
    if (!element) return "";
    if (isTextControl(element)) return String(element.value ?? "");
    return serializeContentContainer(element);
  }

  function protectedComposerNode(element = composer) {
    if (!element || isTextControl(element)) return null;
    const alwaysAtomic = element.querySelector(
      'img, video, audio, canvas, iframe, object, embed, input, select, textarea, button, '
      + '[data-attachment], [data-file-id], [data-testid*="attachment" i], '
      + '[aria-label*="attachment" i], [aria-label*="attached" i], '
      + '[aria-label*="附件"], [aria-label*="文件"]'
    );
    if (alwaysAtomic) return alwaysAtomic;

    // Rich editors use contenteditable=false for atomic chips such as file
    // attachments and mentions. Ignore empty decoration nodes, but never select
    // across a meaningful atomic node because execCommand could delete it even
    // when the visible text readback appears unchanged.
    for (const node of element.querySelectorAll('[contenteditable="false"]')) {
      if (!(node instanceof HTMLElement)) continue;
      const hasMeaningfulText = Boolean(normalizeText(node.textContent));
      const hasMeaningfulDescendant = Boolean(node.querySelector('img, video, audio, canvas, svg, [data-attachment], [data-file-id]'));
      const label = [node.getAttribute("aria-label"), node.getAttribute("title")]
        .filter(Boolean)
        .join(" ")
        .trim();
      if (hasMeaningfulText || hasMeaningfulDescendant || label) return node;
    }

    // Attachment chips are often rendered as siblings of the editor inside the
    // same input container, not inside the contenteditable itself. Only
    // unambiguous attachment markers are checked here: generic selectors such
    // as img/button would match ordinary toolbar controls and permanently
    // disable automatic writes.
    let scope = element.parentElement;
    for (let depth = 0; scope && depth < 3; depth += 1) {
      for (const node of scope.querySelectorAll('[data-attachment], [data-file-id], [data-testid*="attachment" i]')) {
        if (!element.contains(node)) return node;
      }
      scope = scope.parentElement;
    }
    return null;
  }

  function stateSnapshot() {
    const composerReady = Boolean(
      composer
      && composer.isConnected
      && isEditableCandidate(composer)
    );
    return {
      composerReady,
      currentText: composerReady ? readComposerText() : "",
      targetEpoch,
      pluginOwned,
      strategy: preferredStrategy,
      requiresFocusWrite: Boolean(composerReady && !isTextControl(composer))
    };
  }

  function sendState(reason = "state") {
    post({
      type: "WRITER_STATE",
      writerSession,
      reason,
      state: stateSnapshot()
    });
  }

  function validSendIntent() {
    return Boolean(
      sendIntent
      && sendIntent.writerSession === writerSession
      && sendIntent.targetEpoch === targetEpoch
      && Date.now() - sendIntent.timestamp <= SEND_INTENT_TTL_MS
    );
  }

  function clearSendIntent() {
    sendIntent = null;
  }

  function recordSendIntent(kind) {
    const text = readComposerText();
    if (!text) return;
    sendIntent = {
      kind,
      text,
      // Raw (un-trimmed) serialization at intent time. ProseMirror handles
      // Enter in its keydown keymap and suppresses the native input events,
      // so a trailing-only insertion can only be detected by comparing this
      // against the raw serialization during reconcile.
      rawText: rawComposerSerialization(),
      timestamp: Date.now(),
      writerSession,
      targetEpoch
    };
    setTimeout(() => {
      if (sendIntent && Date.now() - sendIntent.timestamp > SEND_INTENT_TTL_MS) clearSendIntent();
    }, SEND_INTENT_TTL_MS + 100);
  }

  function confirmClear(previousText, intentOverride = null) {
    const currentIntent = validSendIntent() ? sendIntent : null;
    const candidateIntent = intentOverride ?? currentIntent;
    const intent = candidateIntent
      && normalizeText(candidateIntent.text) === normalizeText(previousText)
      ? candidateIntent
      : null;
    targetEpoch += 1;
    lastWritten = "";
    lastObservedText = "";
    pluginOwned = false;
    clearSendIntent();

    if (intent && normalizeText(intent.text)) {
      post({
        type: "SEND_CONFIRMED",
        writerSession,
        targetEpoch,
        sentText: intent.text,
        intentKind: intent.kind
      });
    } else {
      post({
        type: "TARGET_CLEARED",
        writerSession,
        targetEpoch,
        previousText: normalizeText(previousText)
      });
    }
    sendState(intent ? "send_confirmed" : "external_clear");
  }

  function reportManualEdit(current, reason = "manual_edit") {
    const normalized = normalizeText(current);
    targetEpoch += 1;
    pluginOwned = false;
    lastObservedText = normalized;
    clearSendIntent();
    post({
      type: "TARGET_MANUAL_EDIT",
      writerSession,
      targetEpoch,
      text: normalized
    });
    sendState(reason);
  }

  function reportRecoveryFailure(current, reason = "write_recovery_failed") {
    targetEpoch += 1;
    pluginOwned = false;
    lastObservedText = normalizeText(current);
    clearSendIntent();
    post({
      type: "TARGET_WRITE_RECOVERY_FAILED",
      writerSession,
      targetEpoch,
      text: normalizeText(current),
      reason
    });
    sendState(reason);
  }

  function reconcileComposerText({ trusted = false } = {}) {
    if (!attached || !composer) return;
    // execCommand/native setters can emit trusted-looking input and multiple
    // transient DOM states. The serialized mutation owns that very short
    // interval and validates the final readback itself.
    if (activeMutation?.element === composer) return;

    const current = readComposerText();
    const previous = lastObservedText;
    if (current === previous) {
      // A plain Enter that only edited the end of the document (newline in a
      // trailing code block, new list item) changes the raw serialization but
      // not the normalized text, and ProseMirror suppresses the input events
      // the cancellation paths in handleComposerInput rely on. Such an Enter
      // was editing, not sending: cancel the keyboard intent so a clear or
      // conversation switch within the TTL is not archived as a false send.
      if (
        sendIntent?.kind === "keyboard"
        && typeof sendIntent.rawText === "string"
        && rawComposerSerialization() !== sendIntent.rawText
      ) clearSendIntent();
      return;
    }
    lastObservedText = current;

    if (performance.now() < suppressUntil && current === normalizeText(expectedWriteText)) return;
    // Outside the timed window, only a non-empty expected value may suppress an
    // untrusted echo. An empty expectation left behind by a failed clear must
    // never swallow a page-side clear (a real send) indefinitely.
    if (!trusted && normalizeText(expectedWriteText) && current === normalizeText(expectedWriteText)) return;

    if (!current && previous) {
      confirmClear(previous);
      return;
    }

    if (validSendIntent() && current !== normalizeText(sendIntent.text)) clearSendIntent();

    if (current !== normalizeText(lastWritten)) reportManualEdit(current);
  }

  function handleComposerInput(event) {
    // A real line break means the plain Enter key was used as editing input,
    // not as a send command. readComposerText() trims trailing whitespace, so
    // relying on the resulting text alone can leave a stale keyboard intent
    // alive and misclassify a later manual clear as a confirmed send.
    if (
      event.isTrusted
      && sendIntent?.kind === "keyboard"
      && ["insertParagraph", "insertLineBreak"].includes(String(event.inputType || ""))
    ) clearSendIntent();
    // A trusted deletion or undo after a plain Enter means the Enter did not
    // send. Without this, an ineffective Enter followed by a manual select-all
    // delete within the intent TTL is archived as a confirmed send.
    if (
      event.isTrusted
      && sendIntent?.kind === "keyboard"
      && (/^delete/.test(String(event.inputType || "")) || String(event.inputType || "") === "historyUndo")
    ) clearSendIntent();

    if (activeMutation?.element === composer && event.isTrusted) {
      const current = readComposerText();
      if (
        current !== activeMutation.expectedText
        && current !== activeMutation.beforeText
      ) activeMutation.userInterference = true;
    }
    reconcileComposerText({ trusted: event.isTrusted });
  }

  function handleComposerKeydown(event) {
    if (!event.isTrusted || event.isComposing || event.keyCode === 229) return;
    if (activeMutation?.element === composer) activeMutation.userInterference = true;
    // Only treat a plain Enter as an intent. Modified Enter shortcuts vary by
    // Claude/user settings; a real submit event is captured separately and is
    // safer than guessing that Ctrl/Meta/Alt+Enter always means send.
    if (
      event.key === "Enter"
      && !event.shiftKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.altKey
    ) recordSendIntent("keyboard");
  }

  function buttonLooksLikeSend(button) {
    if (!(button instanceof HTMLButtonElement) || button.disabled || !isVisible(button, 1, 1)) return false;
    const label = sendLabelFor(button);
    const composerForm = composer?.closest("form");
    const sameForm = Boolean(composerForm && composerForm === button.closest("form"));
    // Implicit type="submit" alone is not enough: untyped toolbar buttons
    // (attach, mic, model picker) default to submit and must not record a
    // send intent. Real form submissions are still caught by the document
    // submit listener even when the button label never matches.
    if (!/(send|发送|提交|submit)/i.test(label)) return false;
    if (sameForm) return true;

    const composerRect = composer?.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    if (!composerRect) return false;
    const centerX = buttonRect.left + buttonRect.width / 2;
    const centerY = buttonRect.top + buttonRect.height / 2;
    return (
      centerX >= composerRect.left - 100
      && centerX <= composerRect.right + 180
      && centerY >= composerRect.top - 100
      && centerY <= composerRect.bottom + 100
    );
  }

  function handleDocumentClick(event) {
    if (!attached || !event.isTrusted || !composer) return;
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (buttonLooksLikeSend(button)) recordSendIntent("button");
  }

  function handleDocumentKeydown(event) {
    // Capture at document level: a listener registered on the composer itself
    // runs in the at-target phase after the page editor's own (earlier
    // registered) handlers, which may have already cleared the document and
    // made the send intent unrecordable. Document capture genuinely precedes
    // at-target listeners.
    if (!attached || !composer) return;
    const target = event.target;
    if (!(target instanceof Node) || (target !== composer && !composer.contains(target))) return;
    handleComposerKeydown(event);
  }

  function handleDocumentSubmit(event) {
    if (!attached || !event.isTrusted || !composer) return;
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (form && composer.closest("form") === form) recordSendIntent("form");
  }

  function scheduleComposerReconcile() {
    if (!attached || reconcileTimer !== null) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      reconcileComposerText({ trusted: false });
    }, 0);
  }

  function observeComposerMutations() {
    composerObserver?.disconnect();
    composerObserver = null;
    if (textControlPollTimer !== null) clearInterval(textControlPollTimer);
    textControlPollTimer = null;
    if (!composer) return;
    if (isTextControl(composer)) {
      // Programmatic value assignments emit neither input events nor DOM
      // mutations. Poll so a page-side clear (a send) on a text-control
      // composer is still observed and the draft can be archived.
      textControlPollTimer = setInterval(() => {
        if (!attached || !composer || !isTextControl(composer)) return;
        reconcileComposerText({ trusted: false });
      }, TEXT_CONTROL_POLL_MS);
      return;
    }
    composerObserver = new MutationObserver(scheduleComposerReconcile);
    composerObserver.observe(composer, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function removeComposerListeners() {
    if (composer) {
      composer.removeEventListener("input", handleComposerInput, true);
    }
    composerObserver?.disconnect();
    composerObserver = null;
    if (textControlPollTimer !== null) clearInterval(textControlPollTimer);
    textControlPollTimer = null;
    if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }

  function clearManualBind({ invalidate = true } = {}) {
    if (invalidate) manualBindToken += 1;
    if (manualBindHandler) {
      document.removeEventListener("pointerdown", manualBindHandler, true);
    }
    if (manualBindTimer !== null) clearTimeout(manualBindTimer);
    manualBindHandler = null;
    manualBindTimer = null;
    manualBindRequestId = null;
  }

  function invalidateActiveMutation() {
    if (activeMutation) activeMutation.invalidated = true;
  }

  function bindComposer(nextComposer, reason = "located", options = {}) {
    if (composer === nextComposer) {
      hiddenComposerSince = 0;
      const state = stateSnapshot();
      sendState(`${reason}_same`);
      return state;
    }
    if (manualComposer && manualComposer !== nextComposer) {
      // Any automatic switch to another target ends the old manual lock.
      manualComposer = null;
    }
    const previousComposer = composer;
    const hasPreviousTextOverride = Object.hasOwn(options, "previousText");
    const previousText = hasPreviousTextOverride
      ? normalizeText(options.previousText)
      : readComposerText(previousComposer);
    const previouslyOwned = Object.hasOwn(options, "previouslyOwned")
      ? Boolean(options.previouslyOwned)
      : pluginOwned;
    // A navigation caller resets lastWritten before rebinding; without the
    // pre-reset value the re-own comparison below always fails and plugin
    // text is misclassified as manual content after every SPA navigation.
    const previousLastWritten = Object.hasOwn(options, "previousLastWritten")
      ? normalizeText(options.previousLastWritten)
      : normalizeText(lastWritten);
    // Capture a valid send intent before changing targetEpoch. Claude may
    // replace the composer node after a successful send without changing the
    // URL; validating only after the rebind would incorrectly invalidate the
    // trusted intent and leave the side-panel draft unarchived. A navigation
    // caller may provide the intent captured before writerSession changed.
    // Capture the intent even when no replacement composer is locatable yet
    // (nextComposer null): after a real send Claude may unmount the editor
    // before its replacement exists, and the epoch bump below would otherwise
    // invalidate a trusted in-TTL intent, turning the send into a false
    // TARGET_CLEARED that never archives the draft. confirmClear still
    // validates the text match before treating it as a send.
    const replacementSendIntent = Object.hasOwn(options, "sendIntent")
      ? options.sendIntent
      : previousComposer && validSendIntent()
        && normalizeText(sendIntent?.text) === normalizeText(previousText)
        ? { ...sendIntent }
        : null;
    invalidateActiveMutation();
    removeComposerListeners();
    composer = nextComposer;
    hiddenComposerSince = 0;

    if (previousComposer && previousComposer !== nextComposer) {
      targetEpoch += 1;
    }

    if (!composer) {
      lastObservedText = "";
      pluginOwned = false;
      if (previousText) confirmClear(previousText, replacementSendIntent);
      else sendState("composer_missing");
      return;
    }

    composer.addEventListener("input", handleComposerInput, true);
    observeComposerMutations();
    const current = readComposerText();
    lastObservedText = current;

    if (!current && previousText) {
      const previousStillHoldsText = Boolean(
        previousComposer
        && previousComposer.isConnected
        && readComposerText(previousComposer) === previousText
      );
      if (previousStillHoldsText && !replacementSendIntent) {
        // Switching to a different (empty) editor — e.g. a manual bind away
        // from a wrongly auto-bound node — while the old editor still holds
        // its text untouched. Nothing was cleared and nothing was sent, so
        // only downgrade ownership; fabricating a TARGET_CLEARED here would
        // pause the panel with a false "externally cleared" banner.
        lastWritten = "";
        pluginOwned = false;
        clearSendIntent();
      } else {
        // A composer replacement that drops non-empty text is observable even
        // without a URL change. Treat it as a confirmed send only when the
        // trusted intent captured above matches; otherwise report an external
        // clear so the Chinese source is preserved and automatic sync pauses.
        confirmClear(previousText, replacementSendIntent);
      }
    } else if (previouslyOwned && current === previousLastWritten) {
      lastWritten = previousLastWritten;
      pluginOwned = true;
      clearSendIntent();
    } else if (current !== normalizeText(lastWritten)) {
      pluginOwned = false;
      clearSendIntent();
    }
    sendState(reason);
    return stateSnapshot();
  }

  function resetForNavigation({ preserveSendIntent = false } = {}) {
    invalidateActiveMutation();
    manualComposer = null;
    lifecycleGeneration += 1;
    writerSession = randomId("writer");
    targetEpoch += 1;
    lastWritten = "";
    pluginOwned = false;
    preferredStrategy = null;
    if (!preserveSendIntent) clearSendIntent();
    post({
      type: "WRITER_SESSION_CHANGED",
      writerSession,
      targetEpoch
    });
  }

  function ensureComposer() {
    rebindTimer = null;
    if (!attached) return;
    if (location.href !== lastUrl) {
      const previousObservedText = lastObservedText;
      const wasPluginOwned = pluginOwned;
      const previousLastWritten = lastWritten;
      const navigationSendIntent = validSendIntent()
        && normalizeText(sendIntent?.text) === normalizeText(previousObservedText)
        ? { ...sendIntent }
        : null;
      lastUrl = location.href;
      resetForNavigation({ preserveSendIntent: Boolean(navigationSendIntent) });
      // SPA navigation frequently replaces the editor node. A replacement and
      // the URL transition are one logical event: let bindComposer reconcile
      // the old text exactly once. The old implementation confirmed the clear
      // here and then confirmed it again while rebinding, producing a false
      // TARGET_CLEARED immediately after SEND_CONFIRMED.
      const nextComposer = composer?.isConnected && isEditableCandidate(composer)
        ? composer
        : locateComposer();
      if (nextComposer !== composer) {
        bindComposer(nextComposer, "navigation_rebound", {
          previousText: previousObservedText,
          sendIntent: navigationSendIntent,
          previouslyOwned: wasPluginOwned,
          previousLastWritten
        });
      } else {
        const currentAfterNavigation = readComposerText(nextComposer);
        if (!currentAfterNavigation && previousObservedText) {
          confirmClear(previousObservedText, navigationSendIntent);
        } else {
          lastObservedText = currentAfterNavigation;
          if (wasPluginOwned && currentAfterNavigation === normalizeText(previousLastWritten)) {
            // The URL changed but the same composer kept the plugin's draft
            // untouched; keep ownership instead of downgrading it to manual
            // content that would require a force-overwrite to update.
            lastWritten = normalizeText(previousLastWritten);
            pluginOwned = true;
          }
          clearSendIntent();
          sendState("navigation_same_composer");
        }
      }
    }
    if (!composer?.isConnected) {
      hiddenComposerSince = 0;
      bindComposer(locateComposer(), "rebound");
    } else if (!isEditableCandidate(composer)) {
      // A modal or overlay can hide the composer for a moment without touching
      // the draft. Rebinding immediately would misreport the still-present
      // text as an external clear — or bind an unrelated editor such as an
      // inline message-edit box — so keep the binding briefly while the text
      // is unchanged and re-check.
      const now = performance.now();
      if (readComposerText(composer) === lastObservedText) {
        if (hiddenComposerSince === 0) hiddenComposerSince = now;
        if (now - hiddenComposerSince < HIDDEN_COMPOSER_GRACE_MS) {
          scheduleEnsureComposer();
          return;
        }
      }
      hiddenComposerSince = 0;
      bindComposer(locateComposer(), "rebound");
    } else {
      hiddenComposerSince = 0;
      const betterComposer = locateComposer();
      const currentComposerText = readComposerText(composer);
      const betterComposerText = betterComposer
        ? readComposerText(betterComposer)
        : "";
      if (
        composer !== manualComposer
        && betterComposer
        && betterComposer !== composer
        && candidateScore(betterComposer) >= candidateScore(composer) + 60
        && (
          !currentComposerText
          || betterComposerText === currentComposerText
        )
      ) {
        bindComposer(
          betterComposer,
          "higher_priority_candidate",
          currentComposerText ? {} : { previousText: "", previouslyOwned: false }
        );
        return;
      }
      reconcileComposerText({ trusted: false });
    }
  }

  function scheduleEnsureComposer() {
    if (rebindTimer !== null) return;
    rebindTimer = setTimeout(ensureComposer, REBIND_DELAY_MS);
  }

  function nodeContainsComposer(node) {
    return Boolean(
      composer
      && node instanceof Node
      && (node === composer || (node instanceof Element && node.contains(composer)))
    );
  }

  function nodeContainsEditableCandidate(node) {
    if (!(node instanceof Element)) return false;
    if (node.matches?.(EDITABLE_SELECTOR)) return true;
    return Boolean(node.querySelector?.(EDITABLE_SELECTOR));
  }

  function handleRootMutations(mutations) {
    if (!attached) return;
    if (
      location.href !== lastUrl
      || !composer?.isConnected
      || !isEditableCandidate(composer)
    ) {
      scheduleEnsureComposer();
      return;
    }

    for (const mutation of mutations) {
      for (const node of mutation.removedNodes) {
        if (nodeContainsComposer(node)) {
          scheduleEnsureComposer();
          return;
        }
      }
      for (const node of mutation.addedNodes) {
        if (nodeContainsEditableCandidate(node)) {
          // A better main composer can appear after hydration even while an
          // early/inline editor remains connected. Re-rank after the mutation.
          scheduleEnsureComposer();
          return;
        }
      }
    }
  }

  function attach(attachLease) {
    if (attached && lease === attachLease) {
      sendState("already_attached");
      return;
    }
    detach("reattach");
    // While detached nothing observes SPA navigation, so lastUrl may be stale
    // here. Adopt the current URL and rotate per-conversation state now,
    // silently: this attach establishes fresh state that the panel adopts
    // wholesale from BIND_RESULT and the attached WRITER_STATE, so the
    // WRITER_SESSION_CHANGED pause used for live navigations is not needed.
    // Without this, the first stateful command after binding would hit the
    // URL check in validateExpectedState, rotate the session then, and fail
    // with writer_session_changed plus a forced pause.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      writerSession = randomId("writer");
      targetEpoch += 1;
      lastWritten = "";
      pluginOwned = false;
      preferredStrategy = null;
      clearSendIntent();
    }
    lifecycleGeneration += 1;
    attached = true;
    lease = attachLease;
    document.addEventListener("click", handleDocumentClick, true);
    document.addEventListener("submit", handleDocumentSubmit, true);
    document.addEventListener("keydown", handleDocumentKeydown, true);
    window.addEventListener("popstate", scheduleEnsureComposer);
    window.addEventListener("hashchange", scheduleEnsureComposer);
    window.addEventListener("pageshow", scheduleEnsureComposer);
    rootObserver = new MutationObserver(handleRootMutations);
    if (document.body) {
      rootObserver.observe(document.body, { childList: true, subtree: true });
    }
    // The root observer only sees childList changes. Claude's empty-state
    // editor can become locatable through attribute-only hydration (labels,
    // contenteditable flips, visibility) that never adds a node — without a
    // periodic rescan the composer stays unlocated until the user types into
    // the page and forces a structural mutation.
    composerScanTimer = setInterval(() => {
      if (!attached) return;
      if (!composer) {
        if (locateComposer()) scheduleEnsureComposer();
        return;
      }
      if (!composer.isConnected || !isEditableCandidate(composer)) {
        scheduleEnsureComposer();
      }
    }, COMPOSER_SCAN_INTERVAL_MS);
    bindComposer(locateComposer(), "attached");
  }

  function detach(reason = "detached") {
    lifecycleGeneration += 1;
    invalidateActiveMutation();
    attached = false;
    lease = null;
    removeComposerListeners();
    composer = null;
    manualComposer = null;
    document.removeEventListener("click", handleDocumentClick, true);
    document.removeEventListener("submit", handleDocumentSubmit, true);
    document.removeEventListener("keydown", handleDocumentKeydown, true);
    window.removeEventListener("popstate", scheduleEnsureComposer);
    window.removeEventListener("hashchange", scheduleEnsureComposer);
    window.removeEventListener("pageshow", scheduleEnsureComposer);
    rootObserver?.disconnect();
    rootObserver = null;
    if (rebindTimer !== null) clearTimeout(rebindTimer);
    rebindTimer = null;
    if (composerScanTimer !== null) clearInterval(composerScanTimer);
    composerScanTimer = null;
    clearManualBind();
    clearSendIntent();
    if (reason !== "reattach") {
      preferredStrategy = null;
      expectedWriteText = "";
      suppressUntil = 0;
    }
  }

  function dispatchInput(element, text, inputType = "insertText") {
    try {
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: text,
        inputType
      }));
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  async function settleDom() {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function enqueueMutation(task, onError) {
    const run = mutationQueue.then(task, task);
    mutationQueue = run.catch(() => undefined);
    if (typeof onError === "function") void run.catch(onError);
    return run;
  }

  function beginMutation(element, beforeText, expectedText) {
    const operation = {
      id: randomId("write"),
      element,
      writerSession,
      targetEpoch,
      lifecycleGeneration,
      beforeText: normalizeText(beforeText),
      expectedText: normalizeText(expectedText),
      invalidated: false,
      userInterference: false
    };
    activeMutation = operation;
    return operation;
  }

  function endMutation(operation) {
    if (activeMutation === operation) activeMutation = null;
    // Input/MutationObserver callbacks are intentionally suppressed while the
    // transaction owns the editor. Reconcile once more after the caller has
    // committed or rejected the transaction so a late DOM-only change cannot
    // remain invisible.
    queueMicrotask(() => reconcileComposerText({ trusted: false }));
  }

  function operationStillCurrent(operation) {
    return Boolean(
      operation
      && activeMutation === operation
      && !operation.invalidated
      && attached
      && operation.element === composer
      && operation.element?.isConnected
      && operation.writerSession === writerSession
      && operation.targetEpoch === targetEpoch
      && operation.lifecycleGeneration === lifecycleGeneration
      && document.visibilityState !== "hidden"
    );
  }

  function restorePageFocus(previousActive, target) {
    try {
      if (
        previousActive instanceof HTMLElement
        && previousActive !== target
        && previousActive.isConnected
        && previousActive !== document.body
        && previousActive !== document.documentElement
      ) {
        previousActive.focus({ preventScroll: true });
      } else if (previousActive !== target) {
        target.blur();
      }
    } catch {
      // Focus restoration is best effort; panel.js restores the sidebar editor.
    }
  }

  function setNativeControlValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (!descriptor?.set) return false;
    descriptor.set.call(element, value);
    dispatchInput(element, value, value ? "insertText" : "deleteContentBackward");
    return true;
  }

  async function writeTextControl(operation, element, text) {
    const beforeRaw = element.value;
    const before = normalizeText(beforeRaw);
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (!descriptor?.set) {
      return { ok: false, code: "native_setter_missing", strategy: "native-value-setter", focusUsed: false, before };
    }

    descriptor.set.call(element, text);
    dispatchInput(element, text, text ? "insertText" : "deleteContentBackward");
    await settleDom();
    if (!operationStillCurrent(operation)) {
      const interruptedReadback = readComposerText(element);
      if (
        !operation.userInterference
        && element.isConnected
        && interruptedReadback === normalizeText(text)
        && interruptedReadback !== before
      ) {
        expectedWriteText = beforeRaw;
        suppressUntil = performance.now() + 900;
        descriptor.set.call(element, beforeRaw);
        dispatchInput(element, beforeRaw, beforeRaw ? "insertText" : "deleteContentBackward");
        await settleDom();
        const restored = readComposerText(element) === before;
        if (restored) lastObservedText = before;
        return {
          ok: false,
          code: restored ? "write_failed_rolled_back" : "write_failed_not_restored",
          strategy: "native-value-setter",
          focusUsed: false,
          before,
          readback: interruptedReadback,
          restored
        };
      }
      return {
        ok: false,
        code: operation.userInterference ? "write_interrupted" : "target_changed",
        strategy: "native-value-setter",
        focusUsed: false,
        before,
        readback: interruptedReadback
      };
    }

    const readback = readComposerText(element);
    if (readback === normalizeText(text)) {
      return { ok: true, strategy: "native-value-setter", focusUsed: false, before, readback };
    }
    if (readback === before) {
      return { ok: false, code: "write_rejected", strategy: "native-value-setter", focusUsed: false, before, readback };
    }
    if (operation.userInterference) {
      operation.invalidated = true;
      return { ok: false, code: "write_interrupted", strategy: "native-value-setter", focusUsed: false, before, readback };
    }

    expectedWriteText = beforeRaw;
    suppressUntil = performance.now() + 900;
    descriptor.set.call(element, beforeRaw);
    dispatchInput(element, beforeRaw, beforeRaw ? "insertText" : "deleteContentBackward");
    await settleDom();
    const restored = operationStillCurrent(operation) && readComposerText(element) === before;
    if (restored) {
      lastObservedText = before;
      return {
        ok: false,
        code: "write_failed_rolled_back",
        strategy: "native-value-setter",
        focusUsed: false,
        before,
        readback,
        restored: true
      };
    }
    return {
      ok: false,
      code: "write_failed_not_restored",
      strategy: "native-value-setter",
      focusUsed: false,
      before,
      readback: readComposerText(element),
      restored: false
    };
  }

  function selectEditorContents(element) {
    const selection = window.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function runEditCommand(element, text) {
    element.focus({ preventScroll: true });
    if (!selectEditorContents(element)) return false;
    try {
      return text
        ? document.execCommand("insertText", false, text)
        : document.execCommand("delete", false);
    } catch {
      return false;
    }
  }

  async function writeContentEditableFocus(operation, element, text) {
    const before = readComposerText(element);
    const previousActive = document.activeElement;
    const commandResult = runEditCommand(element, text);
    await settleDom();

    if (!operationStillCurrent(operation)) {
      const interruptedReadback = readComposerText(element);
      let restored = interruptedReadback === before;
      if (
        !restored
        && !operation.userInterference
        && element.isConnected
        && !protectedComposerNode(element)
        && interruptedReadback === normalizeText(text)
      ) {
        expectedWriteText = before;
        suppressUntil = performance.now() + 900;
        runEditCommand(element, before);
        await settleDom();
        restored = readComposerText(element) === before;
        if (restored) lastObservedText = before;
      }
      restorePageFocus(previousActive, element);
      await settleDom();
      return {
        ok: false,
        code: restored
          ? "write_failed_rolled_back"
          : operation.userInterference
            ? "write_interrupted"
            : "write_failed_not_restored",
        strategy: "focus-execcommand",
        focusUsed: true,
        before,
        readback: interruptedReadback,
        restored
      };
    }

    const readback = readComposerText(element);
    if (readback === normalizeText(text)) {
      restorePageFocus(previousActive, element);
      await settleDom();
      return {
        ok: true,
        strategy: commandResult ? "focus-execcommand" : "focus-execcommand-readback",
        focusUsed: true,
        before,
        readback
      };
    }
    if (readback === before) {
      restorePageFocus(previousActive, element);
      await settleDom();
      return {
        ok: false,
        code: commandResult ? "write_rejected" : "execcommand_unavailable",
        strategy: "focus-execcommand",
        focusUsed: true,
        before,
        readback
      };
    }
    if (operation.userInterference) {
      operation.invalidated = true;
      restorePageFocus(previousActive, element);
      await settleDom();
      return {
        ok: false,
        code: "write_interrupted",
        strategy: "focus-execcommand",
        focusUsed: true,
        before,
        readback
      };
    }

    // A file/mention chip can appear asynchronously while the transaction is
    // settling. Never select-all again to roll back across newly introduced
    // atomic content; preserve the page as-is and force manual review instead.
    if (protectedComposerNode(element)) {
      restorePageFocus(previousActive, element);
      await settleDom();
      return {
        ok: false,
        code: "write_failed_not_restored",
        strategy: "focus-execcommand",
        focusUsed: true,
        before,
        readback,
        restored: false,
        protectedContentAppeared: true,
        commandResult
      };
    }

    expectedWriteText = before;
    suppressUntil = performance.now() + 900;
    const rollbackIssued = runEditCommand(element, before);
    await settleDom();
    const restored = operationStillCurrent(operation) && readComposerText(element) === before;
    restorePageFocus(previousActive, element);
    await settleDom();

    if (restored) {
      lastObservedText = before;
      return {
        ok: false,
        code: "write_failed_rolled_back",
        strategy: "focus-execcommand",
        focusUsed: true,
        before,
        readback,
        restored: true,
        commandResult,
        rollbackIssued
      };
    }

    return {
      ok: false,
      code: "write_failed_not_restored",
      strategy: "focus-execcommand",
      focusUsed: true,
      before,
      readback: readComposerText(element),
      restored: false,
      commandResult,
      rollbackIssued
    };
  }

  async function setComposerText(operation, target, text, { allowFocus = true } = {}) {
    if (!target || target !== composer || !target.isConnected) {
      return { ok: false, code: "target_changed", focusUsed: false };
    }
    if (isTextControl(target)) return writeTextControl(operation, target, text);
    if (!allowFocus) {
      return {
        ok: false,
        code: "focus_write_disabled",
        strategy: "focus-required",
        focusUsed: false
      };
    }
    return writeContentEditableFocus(operation, target, text);
  }

  function validateLease(message) {
    return attached && lease && message?.lease === lease;
  }

  function rejectResult(type, requestId, code, message, details = {}) {
    post({
      type,
      requestId,
      ok: false,
      code,
      message,
      writerSession,
      targetEpoch,
      ...details
    });
  }

  function validateExpectedState(message, resultType, actionLabel) {
    // history.pushState() does not emit popstate and may not mutate the DOM.
    // Reconcile the URL synchronously before every stateful command so a
    // translation queued for one Claude conversation cannot land in another.
    if (attached && location.href !== lastUrl) ensureComposer();

    if (Number.isFinite(message?.deadline) && Date.now() > message.deadline) {
      rejectResult(resultType, message.requestId, "command_expired", `${actionLabel}请求已过期，未执行`);
      return false;
    }
    if (!validateLease(message)) {
      rejectResult(resultType, message.requestId, "invalid_lease", `${actionLabel}租约已失效`);
      return false;
    }
    if (!composer?.isConnected) {
      rejectResult(resultType, message.requestId, "composer_missing", "未找到 Claude 输入框");
      return false;
    }
    if (message.expectedWriterSession && message.expectedWriterSession !== writerSession) {
      rejectResult(resultType, message.requestId, "writer_session_changed", "Claude 页面会话已变化");
      return false;
    }
    if (Number.isInteger(message.expectedTargetEpoch) && message.expectedTargetEpoch !== targetEpoch) {
      rejectResult(resultType, message.requestId, "target_epoch_changed", "Claude 输入框已变化");
      return false;
    }
    return true;
  }

  async function handleWrite(message) {
    const resultType = "WRITE_TARGET_RESULT";
    if (!validateExpectedState(message, resultType, "写入")) return;
    if (document.visibilityState === "hidden") {
      return rejectResult(resultType, message.requestId, "target_inactive", "目标 Claude 标签页不在前台，未执行写入");
    }

    const targetElement = composer;
    const operationSession = writerSession;
    const operationEpoch = targetEpoch;
    const operationGeneration = lifecycleGeneration;
    const current = readComposerText(targetElement);
    if (protectedComposerNode(targetElement)) {
      return rejectResult(
        resultType,
        message.requestId,
        "protected_content_present",
        "Claude 输入框中含有附件、图片或不可安全替换的富文本节点；未执行自动写入"
      );
    }
    if (pluginOwned && current !== normalizeText(lastWritten)) {
      if (!current) {
        // The composer emptied between a page-side clear (a send or a manual
        // wipe) and the queued reconcile. Let the pending send intent decide
        // between SEND_CONFIRMED and TARGET_CLEARED instead of destroying it
        // as a zero-length "manual edit".
        confirmClear(lastObservedText || normalizeText(lastWritten));
        return rejectResult(resultType, message.requestId, "target_cleared", "写入前发现输入框已被清空，未执行写入");
      }
      reportManualEdit(current);
      return rejectResult(resultType, message.requestId, "manual_edit", "检测到人工修改，未覆盖");
    }
    if (current && !pluginOwned && !message.force) {
      return rejectResult(resultType, message.requestId, "manual_edit", "Claude 输入框已有非插件内容，未覆盖");
    }

    const text = String(message.text ?? "");
    // Do not clear a just-recorded trusted send intent before the DOM is
    // actually modified: a write that fails without touching the editor (e.g.
    // focus_write_disabled) must not downgrade a real concurrent send to a
    // plain external clear. The intent is cleared on success below.
    const previousExpectedWriteText = expectedWriteText;
    const previousSuppressUntil = suppressUntil;
    expectedWriteText = text;
    suppressUntil = performance.now() + 900;
    const operation = beginMutation(targetElement, current, text);
    let writeResult;
    try {
      writeResult = await setComposerText(operation, targetElement, text, {
        allowFocus: message.allowFocus === true
      });
    } finally {
      endMutation(operation);
    }

    if (writeResult?.code === "write_failed_not_restored") {
      const dirtyText = readComposerText(targetElement);
      reportRecoveryFailure(dirtyText, "write_recovery_failed");
      return rejectResult(
        resultType,
        message.requestId,
        "write_failed_not_restored",
        "写入未通过校验且无法恢复原内容，已停止自动覆盖",
        { focusUsed: Boolean(writeResult.focusUsed) }
      );
    }

    if (writeResult?.code === "write_interrupted" || operation.userInterference) {
      const interruptedText = readComposerText(targetElement);
      reportManualEdit(interruptedText, "write_interrupted");
      return rejectResult(
        resultType,
        message.requestId,
        "write_interrupted",
        "写入过程中检测到用户输入，已停止自动覆盖",
        { focusUsed: Boolean(writeResult?.focusUsed) }
      );
    }

    if (
      writerSession !== operationSession
      || targetEpoch !== operationEpoch
      || lifecycleGeneration !== operationGeneration
      || composer !== targetElement
      || !targetElement.isConnected
      || operation.invalidated
    ) {
      return rejectResult(
        resultType,
        message.requestId,
        "target_changed",
        "写入期间 Claude 输入框或页面会话发生了变化",
        { focusUsed: Boolean(writeResult?.focusUsed) }
      );
    }

    const readback = readComposerText(targetElement);
    if (!writeResult?.ok || readback !== normalizeText(text)) {
      if (writeResult?.code === "focus_write_disabled") {
        // The DOM was never touched; restore the pre-attempt suppression state.
        expectedWriteText = previousExpectedWriteText;
        suppressUntil = previousSuppressUntil;
      }
      return rejectResult(
        resultType,
        message.requestId,
        writeResult?.code || "write_failed",
        writeResult?.code === "focus_write_disabled"
          ? "当前富文本输入框需要聚焦写入；请先完成页面诊断并在设置中启用"
          : "写入未通过回读校验；未把结果标记为已同步",
        { focusUsed: Boolean(writeResult?.focusUsed) }
      );
    }

    clearSendIntent();
    preferredStrategy = writeResult.strategy;
    targetEpoch += 1;
    lastWritten = normalizeText(text);
    lastObservedText = lastWritten;
    pluginOwned = true;
    post({
      type: resultType,
      requestId: message.requestId,
      ok: true,
      writerSession,
      targetEpoch,
      readback,
      strategy: writeResult.strategy,
      focusUsed: writeResult.focusUsed
    });
    sendState("plugin_write");
  }

  async function handleClearIfOwned(message) {
    const resultType = "CLEAR_TARGET_IF_OWNED_RESULT";
    if (!validateExpectedState(message, resultType, "清理")) return;
    if (document.visibilityState === "hidden") {
      return rejectResult(resultType, message.requestId, "target_inactive", "目标 Claude 标签页不在前台，未执行清理");
    }

    const targetElement = composer;
    const operationSession = writerSession;
    const operationEpoch = targetEpoch;
    const operationGeneration = lifecycleGeneration;
    const current = readComposerText(targetElement);
    if (protectedComposerNode(targetElement)) {
      return rejectResult(
        resultType,
        message.requestId,
        "protected_content_present",
        "Claude 输入框中含有附件、图片或不可安全替换的富文本节点；未执行自动清理"
      );
    }
    if (!pluginOwned || current !== normalizeText(lastWritten)) {
      return rejectResult(resultType, message.requestId, "not_plugin_owned", "当前内容不是插件的最后写入值");
    }

    // Arm the self-echo suppression only for the duration of this attempt.
    // Every failure path below must disarm (or restore) it: a leftover empty
    // expectation would silently swallow a genuine user send, and clearing the
    // send intent up front would downgrade a real send recorded milliseconds
    // earlier. The intent is cleared only after the DOM was actually emptied
    // by this operation.
    const previousExpectedWriteText = expectedWriteText;
    const previousSuppressUntil = suppressUntil;
    expectedWriteText = "";
    suppressUntil = performance.now() + 900;
    const operation = beginMutation(targetElement, current, "");
    let clearResult;
    try {
      clearResult = await setComposerText(operation, targetElement, "", {
        allowFocus: message.allowFocus === true
      });
    } finally {
      endMutation(operation);
    }

    if (clearResult?.code === "write_failed_not_restored") {
      expectedWriteText = "";
      suppressUntil = 0;
      const dirtyText = readComposerText(targetElement);
      reportRecoveryFailure(dirtyText, "clear_recovery_failed");
      return rejectResult(
        resultType,
        message.requestId,
        "clear_failed_not_restored",
        "清理失败且无法恢复原内容，已停止自动覆盖",
        { focusUsed: Boolean(clearResult.focusUsed) }
      );
    }

    if (clearResult?.code === "write_interrupted" || operation.userInterference) {
      expectedWriteText = "";
      suppressUntil = 0;
      const interruptedText = readComposerText(targetElement);
      reportManualEdit(interruptedText, "clear_interrupted");
      return rejectResult(
        resultType,
        message.requestId,
        "write_interrupted",
        "清理过程中检测到用户输入，已停止自动覆盖",
        { focusUsed: Boolean(clearResult?.focusUsed) }
      );
    }

    if (
      writerSession !== operationSession
      || targetEpoch !== operationEpoch
      || lifecycleGeneration !== operationGeneration
      || composer !== targetElement
      || !targetElement.isConnected
      || operation.invalidated
    ) {
      expectedWriteText = "";
      suppressUntil = 0;
      return rejectResult(
        resultType,
        message.requestId,
        "target_changed",
        "清理期间 Claude 输入框或页面会话发生了变化",
        { focusUsed: Boolean(clearResult?.focusUsed) }
      );
    }

    if (!clearResult?.ok || readComposerText(targetElement) !== "") {
      // The DOM was not modified (e.g. focus_write_disabled) or still holds
      // text; restore the pre-attempt suppression state so the old draft's
      // eventual real send is reported normally.
      expectedWriteText = previousExpectedWriteText;
      suppressUntil = previousSuppressUntil;
      return rejectResult(
        resultType,
        message.requestId,
        clearResult?.code || "clear_failed",
        clearResult?.code === "focus_write_disabled"
          ? "富文本输入框无法在不聚焦的情况下安全清除；旧译文仍保留"
          : "未能安全清除旧译文",
        { focusUsed: Boolean(clearResult?.focusUsed) }
      );
    }

    clearSendIntent();
    targetEpoch += 1;
    lastWritten = "";
    lastObservedText = "";
    pluginOwned = false;
    post({
      type: resultType,
      requestId: message.requestId,
      ok: true,
      writerSession,
      targetEpoch,
      strategy: clearResult.strategy,
      focusUsed: clearResult.focusUsed
    });
    sendState("stale_target_cleared");
  }

  function handleGetTargetText(message) {
    const resultType = "GET_TARGET_TEXT_RESULT";
    if (!validateExpectedState(message, resultType, "读取")) return;
    post({
      type: resultType,
      requestId: message.requestId,
      ok: true,
      code: null,
      writerSession,
      targetEpoch,
      text: readComposerText(),
      pluginOwned
    });
  }

  function handleSetBaseline(message) {
    const resultType = "SET_BASELINE_RESULT";
    if (!validateExpectedState(message, resultType, "基线")) return;
    const current = readComposerText();
    lastWritten = current;
    lastObservedText = current;
    pluginOwned = false;
    clearSendIntent();
    post({
      type: resultType,
      requestId: message.requestId,
      ok: true,
      writerSession,
      targetEpoch,
      text: current
    });
    sendState("manual_baseline");
  }

  function manualCandidateDistance(element, clientX, clientY) {
    const rect = element.getBoundingClientRect();
    const dx = clientX < rect.left
      ? rect.left - clientX
      : clientX > rect.right
        ? clientX - rect.right
        : 0;
    const dy = clientY < rect.top
      ? rect.top - clientY
      : clientY > rect.bottom
        ? clientY - rect.bottom
        : 0;
    return Math.hypot(dx, dy);
  }

  function bestManualCandidate(nodes, clientX, clientY) {
    const candidates = [];
    const seen = new Set();

    const add = (element) => {
      if (
        !(element instanceof HTMLElement)
        || seen.has(element)
        || !element.matches?.(EDITABLE_SELECTOR)
        || !isEditableCandidate(element)
      ) {
        return;
      }
      seen.add(element);
      const rect = element.getBoundingClientRect();
      candidates.push({
        element,
        distance: manualCandidateDistance(element, clientX, clientY),
        area: Math.max(1, rect.width * rect.height)
      });
    };

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      add(node);
      add(node.closest?.(EDITABLE_SELECTOR));
      for (const descendant of node.querySelectorAll?.(EDITABLE_SELECTOR) || []) {
        add(descendant);
      }
    }

    candidates.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.area - b.area;
    });
    return candidates[0]?.element || null;
  }

  function manualBindCandidateFromEvent(event) {
    const eventPath = typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];
    return bestManualCandidate(eventPath, event.clientX, event.clientY);
  }

  function manualBindCandidateAtPoint(clientX, clientY) {
    const hit = document.elementFromPoint(clientX, clientY);
    const path = [];
    let current = hit instanceof HTMLElement ? hit : null;
    for (let depth = 0; current && depth < 8; depth += 1) {
      path.push(current);
      current = current.parentElement;
    }

    let candidate = bestManualCandidate(path, clientX, clientY);
    if (candidate) return candidate;

    // React/Lexical may replace the clicked subtree between pointerdown and
    // verification. Search visible editors once and select only a nearby one.
    candidate = bestManualCandidate(
      document.querySelectorAll(EDITABLE_SELECTOR),
      clientX,
      clientY
    );
    return candidate && manualCandidateDistance(candidate, clientX, clientY) <= 96
      ? candidate
      : null;
  }

  async function waitForManualBindStability() {
    // Do not declare success in the pointerdown turn. Give Claude enough time
    // to focus/hydrate the editor and replace a transient React node.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await Promise.race([
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }),
      new Promise((resolve) => setTimeout(resolve, 160))
    ]);
  }

  function manualBindContextIsCurrent(token, expectedLease, expectedGeneration) {
    return Boolean(
      token === manualBindToken
      && attached
      && lease === expectedLease
      && lifecycleGeneration === expectedGeneration
    );
  }

  function finishManualBindToken(token) {
    if (manualBindToken === token) manualBindToken += 1;
  }

  function startManualBind(message) {
    if (!validateLease(message)) {
      return rejectResult(
        "START_MANUAL_BIND_RESULT",
        message.requestId,
        "invalid_lease",
        "手动绑定租约已失效"
      );
    }

    if (manualBindRequestId) {
      post({
        type: "START_MANUAL_BIND_RESULT",
        requestId: manualBindRequestId,
        ok: false,
        code: "manual_bind_replaced",
        message: "新的手动绑定请求已替换上一次请求",
        writerSession,
        targetEpoch,
        state: stateSnapshot()
      });
    }

    clearManualBind();
    const operationToken = ++manualBindToken;
    const expectedLease = lease;
    const expectedGeneration = lifecycleGeneration;
    manualBindRequestId = message.requestId;

    manualBindHandler = (event) => {
      const initialCandidate = manualBindCandidateFromEvent(event);
      if (!initialCandidate) return;

      const requestId = manualBindRequestId;
      const clientX = event.clientX;
      const clientY = event.clientY;
      // Remove the click listener and timeout without invalidating this
      // operation. A detach or newer request will invalidate its token.
      clearManualBind({ invalidate: false });

      let selectedCandidate = null;
      void (async () => {
        try {
          await waitForManualBindStability();

          if (!manualBindContextIsCurrent(
            operationToken,
            expectedLease,
            expectedGeneration
          )) {
            post({
              type: "START_MANUAL_BIND_RESULT",
              requestId,
              ok: false,
              code: "manual_bind_cancelled",
              message: "页面、租约或手动绑定请求在验证期间发生变化",
              writerSession,
              targetEpoch,
              state: stateSnapshot()
            });
            return;
          }

          const currentCandidate = manualBindCandidateAtPoint(clientX, clientY);
          let candidate = initialCandidate;
          if (
            !candidate.isConnected
            || !isEditableCandidate(candidate)
            || (
              currentCandidate
              && currentCandidate !== candidate
              && manualCandidateDistance(currentCandidate, clientX, clientY)
                < manualCandidateDistance(candidate, clientX, clientY)
            )
          ) {
            candidate = currentCandidate;
          }

          if (!candidate || !candidate.isConnected || !isEditableCandidate(candidate)) {
            manualComposer = null;
            finishManualBindToken(operationToken);
            post({
              type: "START_MANUAL_BIND_RESULT",
              requestId,
              ok: false,
              code: "manual_bind_unstable",
              message: "点击后输入框节点被页面替换或不可写，请再点一次真实输入区域",
              writerSession,
              targetEpoch,
              state: stateSnapshot()
            });
            return;
          }

          selectedCandidate = candidate;
          manualComposer = candidate;
          const state = bindComposer(candidate, "manual_bind") || stateSnapshot();
          const verified = Boolean(
            manualBindContextIsCurrent(
              operationToken,
              expectedLease,
              expectedGeneration
            )
            && state?.composerReady
            && composer === candidate
            && candidate.isConnected
            && isEditableCandidate(candidate)
          );

          if (!verified && manualComposer === candidate) manualComposer = null;
          finishManualBindToken(operationToken);
          post({
            type: "START_MANUAL_BIND_RESULT",
            requestId,
            ok: verified,
            code: verified ? null : "manual_bind_not_verified",
            message: verified ? "手动绑定已验证" : "手动绑定后未通过可写性验证",
            writerSession,
            targetEpoch,
            state: stateSnapshot()
          });
        } catch (error) {
          if (manualBindToken === operationToken) {
            manualBindToken += 1;
            if (manualComposer === selectedCandidate) manualComposer = null;
          }
          post({
            type: "START_MANUAL_BIND_RESULT",
            requestId,
            ok: false,
            code: "manual_bind_internal_error",
            message: "手动绑定验证发生内部错误",
            writerSession,
            targetEpoch,
            state: stateSnapshot(),
            errorName: String(error?.name || "Error").slice(0, 60)
          });
        }
      })();
    };

    document.addEventListener("pointerdown", manualBindHandler, true);
    manualBindTimer = setTimeout(() => {
      if (!manualBindContextIsCurrent(
        operationToken,
        expectedLease,
        expectedGeneration
      )) {
        return;
      }
      const requestId = manualBindRequestId;
      clearManualBind({ invalidate: false });
      finishManualBindToken(operationToken);
      post({
        type: "START_MANUAL_BIND_RESULT",
        requestId,
        ok: false,
        code: "manual_bind_timeout",
        message: "等待点击 Claude 输入框超时",
        writerSession,
        targetEpoch,
        state: stateSnapshot()
      });
    }, 15000);

    post({
      type: "MANUAL_BIND_ARMED",
      requestId: message.requestId,
      writerSession,
      targetEpoch
    });
  }

  function queueWriterCommand(message, handler) {
    enqueueMutation(
      () => handler(message),
      (error) => rejectResult(
        `${message.type}_RESULT`,
        message.requestId,
        "writer_internal_error",
        "Claude 写入器发生内部错误",
        { errorName: String(error?.name || "Error").slice(0, 60) }
      )
    );
  }

  function handlePortMessage(message) {
    switch (message?.type) {
      case "ATTACH":
        attach(message.lease);
        break;
      case "DETACH":
        if (!message.lease || message.lease === lease) detach(message.reason);
        break;
      case "WRITE_TARGET":
        queueWriterCommand(message, handleWrite);
        break;
      case "CLEAR_TARGET_IF_OWNED":
        queueWriterCommand(message, handleClearIfOwned);
        break;
      case "GET_TARGET_TEXT":
        queueWriterCommand(message, handleGetTargetText);
        break;
      case "SET_BASELINE":
        queueWriterCommand(message, handleSetBaseline);
        break;
      case "START_MANUAL_BIND":
        startManualBind(message);
        break;
      case "REQUEST_WRITER_STATE":
        queueWriterCommand(message, () => {
          if (attached && location.href !== lastUrl) ensureComposer();
          sendState("requested");
          post({
            type: "REQUEST_WRITER_STATE_RESULT",
            requestId: message.requestId,
            ok: validateLease(message),
            code: validateLease(message) ? null : "invalid_lease",
            writerSession,
            targetEpoch,
            state: stateSnapshot()
          });
        });
        break;
      default:
        break;
    }
  }

  function schedulePortReconnect() {
    if (portReconnectTimer !== null) return;
    try {
      if (!chrome.runtime?.id) return;
    } catch {
      return;
    }
    portReconnectTimer = setTimeout(() => {
      portReconnectTimer = null;
      connectPort();
    }, PORT_RECONNECT_DELAY_MS);
  }

  function connectPort() {
    if (port) return;
    let nextPort;
    try {
      nextPort = chrome.runtime.connect({ name: "zh2en-writer" });
    } catch {
      schedulePortReconnect();
      return;
    }

    port = nextPort;
    nextPort.onMessage.addListener(handlePortMessage);
    nextPort.onDisconnect.addListener(() => {
      if (port !== nextPort) return;
      port = null;
      detach("port_disconnected");
      schedulePortReconnect();
    });

    post({
      type: "WRITER_HELLO",
      writerSession,
      state: stateSnapshot()
    });
  }

  if (document.prerendering) {
    // A prerendered document must not compete for the per-tab writer slot:
    // it would capture the lease and receive writes into an invisible
    // composer. Connect only once this document becomes the active one.
    document.addEventListener("prerenderingchange", () => connectPort(), { once: true });
  } else {
    connectPort();
  }
})();
