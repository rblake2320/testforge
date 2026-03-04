/**
 * SeleniumForge — Content Script: recorder.js
 * ============================================
 * Records user interactions on web pages and converts them into Selenese
 * commands. Also handles playback execution and self-healing locators.
 *
 * Architecture
 * ------------
 * All code lives in a single IIFE to avoid polluting the global scope.
 * The content script cannot use ES modules (Chrome MV3 content script
 * restriction), so patterns like module-level exports are unavailable.
 *
 * Sections
 * --------
 *  1. Constants & Key Map
 *  2. Locator Generation  — buildLocatorSet(), bestLocator()
 *  3. Command Builders    — helpers that create {command, target, value} objects
 *  4. Event Listeners     — attach/detach all DOM listeners for recording
 *  5. Visual Overlay      — hover highlight, flash, recording badge
 *  6. Playback Engine     — executeCommand(), findElement(), assertions, waits
 *  7. Self-Healing        — tryAlternatives(), recordHealingSuggestion()
 *  8. Messaging Bridge    — chrome.runtime.onMessage handler
 *  9. Init                — boot sequence
 */

(function SeleniumForgeRecorder() {
  'use strict';

  // ─── Guard: prevent double-injection ───────────────────────────────────────
  if (window.__seleniumForgeLoaded) return;
  window.__seleniumForgeLoaded = true;

  // ===========================================================================
  // 1. CONSTANTS & KEY MAP
  // ===========================================================================

  /** Mapping of KeyboardEvent.key → Selenium key constant string */
  const KEY_MAP = {
    Enter:      '${KEY_ENTER}',
    Tab:        '${KEY_TAB}',
    Escape:     '${KEY_ESCAPE}',
    Backspace:  '${KEY_BACKSPACE}',
    Delete:     '${KEY_DELETE}',
    ArrowUp:    '${KEY_UP}',
    ArrowDown:  '${KEY_DOWN}',
    ArrowLeft:  '${KEY_LEFT}',
    ArrowRight: '${KEY_RIGHT}',
    Home:       '${KEY_HOME}',
    End:        '${KEY_END}',
    PageUp:     '${KEY_PAGE_UP}',
    PageDown:   '${KEY_PAGE_DOWN}',
    F1:  '${KEY_F1}',  F2:  '${KEY_F2}',  F3:  '${KEY_F3}',  F4:  '${KEY_F4}',
    F5:  '${KEY_F5}',  F6:  '${KEY_F6}',  F7:  '${KEY_F7}',  F8:  '${KEY_F8}',
    F9:  '${KEY_F9}',  F10: '${KEY_F10}', F11: '${KEY_F11}', F12: '${KEY_F12}',
  };

  const RECORD_BADGE_ID  = '__sfBadge';
  const HIGHLIGHT_ID     = '__sfHighlight';
  const MAX_TEXT_LENGTH  = 200;   // truncate long text nodes for selectors
  const DEBOUNCE_DELAY   = 300;   // ms — for resize / input coalescing
  const FLASH_DURATION   = 600;   // ms — element flash on playback

  // ===========================================================================
  // 2. LOCATOR GENERATION
  // ===========================================================================

  /**
   * Build a priority-ordered set of locators for an element.
   * Returns an array of { strategy, value } objects, best first.
   */
  function buildLocatorSet(el) {
    const locators = [];

    // 1. id
    if (el.id && !/^\d/.test(el.id)) {
      locators.push({ strategy: 'id', value: el.id });
    }

    // 2. name
    if (el.name) {
      locators.push({ strategy: 'name', value: el.name });
    }

    // 3. data-testid / data-cy / data-qa (test-specific attributes)
    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-test']) {
      const val = el.getAttribute(attr);
      if (val) {
        locators.push({
          strategy: 'css',
          value: `[${attr}="${CSS.escape(val)}"]`,
        });
      }
    }

    // 4. aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      locators.push({
        strategy: 'css',
        value: `[aria-label="${CSS.escape(ariaLabel)}"]`,
      });
    }

    // 5. link text (anchors only)
    if (el.tagName === 'A' && el.textContent.trim()) {
      const txt = el.textContent.trim().slice(0, MAX_TEXT_LENGTH);
      locators.push({ strategy: 'linkText',        value: txt });
      locators.push({ strategy: 'partialLinkText', value: txt.slice(0, 30) });
    }

    // 6. CSS path (class-based shorthand)
    const cssShort = buildShortCss(el);
    if (cssShort) locators.push({ strategy: 'css', value: cssShort });

    // 7. Full CSS path
    locators.push({ strategy: 'css',   value: fullCssPath(el) });

    // 8. XPath (fallback)
    locators.push({ strategy: 'xpath', value: fullXPath(el) });

    return locators;
  }

  /** Choose the best single locator from buildLocatorSet output. */
  function bestLocator(el) {
    return buildLocatorSet(el)[0];
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  function buildShortCss(el) {
    const tag = el.tagName.toLowerCase();
    const meaningful = [...el.classList].filter(
      c => !/^(active|disabled|selected|hover|focus|open|closed|hidden|show|col-|row-|d-|p-|m-|text-|bg-|btn-?$|form-|is-|has-)/.test(c)
    ).slice(0, 2);
    if (!meaningful.length) return null;
    const selector = `${tag}.${meaningful.map(c => CSS.escape(c)).join('.')}`;
    // Make sure it's unique in the document
    return document.querySelectorAll(selector).length === 1 ? selector : null;
  }

  function fullCssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      let seg = node.tagName.toLowerCase();
      if (node.id && !/^\d/.test(node.id)) {
        seg += '#' + CSS.escape(node.id);
        parts.unshift(seg);
        break; // id is unique — stop here
      }
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(c => c.tagName === node.tagName)
        : [];
      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        seg += `:nth-of-type(${idx})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function fullXPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      if (node.id && !/^\d/.test(node.id)) {
        parts.unshift(`//*[@id='${node.id}']`);
        return parts.join('/');
      }
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter(c => c.tagName === node.tagName)
        : [];
      const idx = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? `${tag}[${idx}]` : tag);
      node = node.parentElement;
    }
    return '/' + parts.join('/');
  }

  // ===========================================================================
  // 3. COMMAND BUILDERS
  // ===========================================================================

  function makeCmd(command, target, value = '') {
    return { command, target, value, timestamp: Date.now() };
  }

  function cmdClick(el) {
    const loc = bestLocator(el);
    return makeCmd('click', formatTarget(loc));
  }

  function cmdType(el, text) {
    const loc = bestLocator(el);
    return makeCmd('type', formatTarget(loc), text);
  }

  function cmdSelect(el) {
    const loc  = bestLocator(el);
    const opt  = el.options[el.selectedIndex];
    const val  = opt ? `label=${opt.text}` : `value=${el.value}`;
    return makeCmd('select', formatTarget(loc), val);
  }

  function cmdCheck(el) {
    const loc = bestLocator(el);
    return makeCmd(el.checked ? 'check' : 'uncheck', formatTarget(loc));
  }

  function cmdMouseOver(el) {
    const loc = bestLocator(el);
    return makeCmd('mouseOver', formatTarget(loc));
  }

  function cmdDragAndDrop(src, dst) {
    const srcLoc = bestLocator(src);
    const dstLoc = bestLocator(dst);
    return makeCmd('dragAndDropToObject', formatTarget(srcLoc), formatTarget(dstLoc));
  }

  function cmdAssertText(el) {
    const loc  = bestLocator(el);
    const text = el.textContent.trim().slice(0, 500);
    return makeCmd('assertText', formatTarget(loc), text);
  }

  function cmdScreenshot() {
    return makeCmd('captureEntirePageScreenshot', 'screenshot.png');
  }

  function formatTarget({ strategy, value }) {
    const prefixMap = {
      id:              'id=',
      name:            'name=',
      css:             'css=',
      xpath:           'xpath=',
      linkText:        'link=',
      partialLinkText: 'linkText=',
    };
    return (prefixMap[strategy] || 'css=') + value;
  }

  // ===========================================================================
  // 4. EVENT LISTENERS
  // ===========================================================================

  let _recording  = false;
  let _commands   = [];   // accumulated test steps
  let _lastInput  = null; // {el, value} — coalesce rapid input events
  let _inputTimer = null;
  let _dragSrc    = null; // drag-source element

  const _bound = {};  // keyed handler refs so we can removeEventListener

  function attachListeners() {
    _bound.click      = onDocClick.bind(null);
    _bound.change     = onDocChange.bind(null);
    _bound.input      = onDocInput.bind(null);
    _bound.keydown    = onDocKeyDown.bind(null);
    _bound.mouseover  = onDocMouseOver.bind(null);
    _bound.dragstart  = onDocDragStart.bind(null);
    _bound.drop       = onDocDrop.bind(null);
    _bound.submit     = onDocSubmit.bind(null);

    document.addEventListener('click',     _bound.click,     true);
    document.addEventListener('change',    _bound.change,    true);
    document.addEventListener('input',     _bound.input,     true);
    document.addEventListener('keydown',   _bound.keydown,   true);
    document.addEventListener('mouseover', _bound.mouseover, true);
    document.addEventListener('dragstart', _bound.dragstart, true);
    document.addEventListener('drop',      _bound.drop,      true);
    document.addEventListener('submit',    _bound.submit,    true);
  }

  function detachListeners() {
    document.removeEventListener('click',     _bound.click,     true);
    document.removeEventListener('change',    _bound.change,    true);
    document.removeEventListener('input',     _bound.input,     true);
    document.removeEventListener('keydown',   _bound.keydown,   true);
    document.removeEventListener('mouseover', _bound.mouseover, true);
    document.removeEventListener('dragstart', _bound.dragstart, true);
    document.removeEventListener('drop',      _bound.drop,      true);
    document.removeEventListener('submit',    _bound.submit,    true);
  }

  // ─── Individual handlers ─────────────────────────────────────────────────────

  function onDocClick(e) {
    if (!_recording) return;
    const el = e.target;
    // Skip clicks on our own overlay elements
    if (el.closest(`#${RECORD_BADGE_ID}`) || el.closest(`#${HIGHLIGHT_ID}`)) return;

    flushPendingInput();

    if (el.type === 'checkbox' || el.type === 'radio') {
      pushCmd(cmdCheck(el));
    } else {
      pushCmd(cmdClick(el));
    }
  }

  function onDocChange(e) {
    if (!_recording) return;
    const el = e.target;
    if (el.tagName === 'SELECT') {
      flushPendingInput();
      pushCmd(cmdSelect(el));
    }
  }

  function onDocInput(e) {
    if (!_recording) return;
    const el = e.target;
    if (el.tagName === 'SELECT') return; // handled by change
    // Coalesce rapid keystrokes into a single type command
    clearTimeout(_inputTimer);
    _lastInput = { el, value: el.value };
    _inputTimer = setTimeout(flushPendingInput, DEBOUNCE_DELAY);
  }

  function flushPendingInput() {
    clearTimeout(_inputTimer);
    if (_lastInput) {
      pushCmd(cmdType(_lastInput.el, _lastInput.value));
      _lastInput = null;
    }
  }

  function onDocKeyDown(e) {
    if (!_recording) return;
    const key = e.key;
    if (key in KEY_MAP) {
      flushPendingInput();
      const loc = bestLocator(e.target);
      pushCmd(makeCmd('sendKeys', formatTarget(loc), KEY_MAP[key]));
    }
  }

  function onDocMouseOver(e) {
    if (!_recording) return;
    // Only record mouseover for elements with a tooltip or title attr
    const el = e.target;
    if (el.title || el.getAttribute('data-tooltip') || el.getAttribute('aria-describedby')) {
      // Debounce — don't record every pixel of mouse movement
      if (_lastMouseOver === el) return;
      _lastMouseOver = el;
      setTimeout(() => { _lastMouseOver = null; }, 500);
      pushCmd(cmdMouseOver(el));
    }
    // Also update visual highlight
    updateHighlight(el);
  }
  let _lastMouseOver = null;

  function onDocDragStart(e) {
    if (!_recording) return;
    _dragSrc = e.target;
  }

  function onDocDrop(e) {
    if (!_recording || !_dragSrc) return;
    const dst = e.target;
    if (dst && dst !== _dragSrc) {
      pushCmd(cmdDragAndDrop(_dragSrc, dst));
    }
    _dragSrc = null;
  }

  function onDocSubmit(e) {
    if (!_recording) return;
    flushPendingInput();
    const form = e.target;
    const loc  = bestLocator(form);
    pushCmd(makeCmd('submit', formatTarget(loc)));
  }

  // ─── Command accumulator ─────────────────────────────────────────────────────

  function pushCmd(cmd) {
    _commands.push(cmd);
    // Notify the panel
    chrome.runtime.sendMessage({ type: 'COMMAND_RECORDED', payload: cmd });
    flashElement(document.elementFromPoint(
      /* just flash the last interacted element via the stored ref */
      window.__sfLastX || 0, window.__sfLastY || 0
    ));
  }

  document.addEventListener('mousemove', e => {
    window.__sfLastX = e.clientX;
    window.__sfLastY = e.clientY;
  }, { passive: true, capture: false });

  // ===========================================================================
  // 5. VISUAL OVERLAY
  // ===========================================================================

  let _highlightEl = null;

  function ensureHighlightEl() {
    if (document.getElementById(HIGHLIGHT_ID)) return;
    const div = document.createElement('div');
    div.id = HIGHLIGHT_ID;
    Object.assign(div.style, {
      position:        'fixed',
      pointerEvents:   'none',
      boxSizing:       'border-box',
      border:          '2px solid #ef4444',
      borderRadius:    '3px',
      background:      'rgba(239,68,68,0.08)',
      zIndex:          '2147483646',
      transition:      'all 80ms ease',
      display:         'none',
    });
    document.documentElement.appendChild(div);
  }

  function updateHighlight(el) {
    if (!_recording) return;
    ensureHighlightEl();
    const hl  = document.getElementById(HIGHLIGHT_ID);
    const box = el.getBoundingClientRect();
    Object.assign(hl.style, {
      display: 'block',
      top:     `${box.top    - 2}px`,
      left:    `${box.left   - 2}px`,
      width:   `${box.width  + 4}px`,
      height:  `${box.height + 4}px`,
    });
  }

  function hideHighlight() {
    const hl = document.getElementById(HIGHLIGHT_ID);
    if (hl) hl.style.display = 'none';
  }

  function flashElement(el) {
    if (!el) return;
    const orig = el.style.outline;
    el.style.outline = '3px solid #22c55e';
    setTimeout(() => { el.style.outline = orig; }, FLASH_DURATION);
  }

  function showRecordingBadge() {
    if (document.getElementById(RECORD_BADGE_ID)) return;
    const badge = document.createElement('div');
    badge.id = RECORD_BADGE_ID;
    badge.textContent = '● REC';
    Object.assign(badge.style, {
      position:   'fixed',
      top:        '12px',
      right:      '12px',
      zIndex:     '2147483647',
      background: '#ef4444',
      color:      '#fff',
      padding:    '4px 10px',
      borderRadius: '4px',
      fontSize:   '12px',
      fontWeight: 'bold',
      fontFamily: 'monospace',
      boxShadow:  '0 2px 8px rgba(0,0,0,.35)',
      userSelect: 'none',
      cursor:     'default',
    });
    document.documentElement.appendChild(badge);
  }

  function removeRecordingBadge() {
    const badge = document.getElementById(RECORD_BADGE_ID);
    if (badge) badge.remove();
  }

  // ===========================================================================
  // 6. PLAYBACK ENGINE
  // ===========================================================================

  const PLAYBACK_TIMEOUT = 10_000; // ms — default wait for element

  /**
   * Execute a single Selenese command object.
   * Returns a Promise that resolves with { ok: true } or rejects with an Error.
   */
  async function executeCommand(cmd) {
    const { command, target, value } = cmd;

    switch (command) {

      // ── Navigation ──────────────────────────────────────────────────────────
      case 'open':
        window.location.href = value || target;
        return { ok: true };

      case 'refresh':
        window.location.reload();
        return { ok: true };

      case 'goBack':
        history.back();
        return { ok: true };

      case 'goForward':
        history.forward();
        return { ok: true };

      // ── Waits ────────────────────────────────────────────────────────────────
      case 'waitForElementPresent':
        await waitForElement(target, PLAYBACK_TIMEOUT);
        return { ok: true };

      case 'waitForElementNotPresent':
        await waitForAbsent(target, PLAYBACK_TIMEOUT);
        return { ok: true };

      case 'waitForElementVisible':
        await waitForVisible(target, PLAYBACK_TIMEOUT);
        return { ok: true };

      case 'pause':
        await sleep(parseInt(value, 10) || 1000);
        return { ok: true };

      // ── Interactions ─────────────────────────────────────────────────────────
      case 'click': {
        const el = await findElement(target);
        el.click();
        return { ok: true };
      }

      case 'doubleClick': {
        const el = await findElement(target);
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return { ok: true };
      }

      case 'rightClick': {
        const el = await findElement(target);
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        return { ok: true };
      }

      case 'mouseOver': {
        const el = await findElement(target);
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        return { ok: true };
      }

      case 'mouseOut': {
        const el = await findElement(target);
        el.dispatchEvent(new MouseEvent('mouseout',  { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        return { ok: true };
      }

      case 'type': {
        const el = await findElement(target);
        el.focus();
        // Clear then set nativeInputValueSetter to trigger React synthetic events
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(el, value);
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.value = value;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true };
      }

      case 'sendKeys': {
        const el = await findElement(target);
        el.focus();
        const seKey = resolveSeleniumKey(value);
        ['keydown','keypress','keyup'].forEach(evType => {
          el.dispatchEvent(new KeyboardEvent(evType, {
            key:      seKey.key,
            keyCode:  seKey.keyCode,
            bubbles:  true,
            cancelable: true,
          }));
        });
        return { ok: true };
      }

      case 'clear': {
        const el = await findElement(target);
        el.value = '';
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }

      case 'select': {
        const el = await findElement(target);
        if (value.startsWith('label=')) {
          const label = value.slice(6);
          const opt   = [...el.options].find(o => o.text === label);
          if (!opt) throw new Error(`Option "${label}" not found in <select>`);
          el.value = opt.value;
        } else if (value.startsWith('value=')) {
          el.value = value.slice(6);
        } else if (value.startsWith('index=')) {
          el.selectedIndex = parseInt(value.slice(6), 10);
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }

      case 'check': {
        const el = await findElement(target);
        if (!el.checked) el.click();
        return { ok: true };
      }

      case 'uncheck': {
        const el = await findElement(target);
        if (el.checked) el.click();
        return { ok: true };
      }

      case 'submit': {
        const el = await findElement(target);
        const form = el.tagName === 'FORM' ? el : el.closest('form');
        if (!form) throw new Error('No form found for submit target');
        form.submit();
        return { ok: true };
      }

      case 'focus': {
        const el = await findElement(target);
        el.focus();
        return { ok: true };
      }

      case 'blur': {
        const el = await findElement(target);
        el.blur();
        return { ok: true };
      }

      case 'scroll': {
        const [x, y] = value.split(',').map(Number);
        window.scrollTo(x || 0, y || 0);
        return { ok: true };
      }

      case 'scrollTo': {
        const el = await findElement(target);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return { ok: true };
      }

      case 'dragAndDropToObject': {
        const src = await findElement(target);
        const dst = await findElement(value);
        const srcRect = src.getBoundingClientRect();
        const dstRect = dst.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true };
        src.dispatchEvent(new MouseEvent('mousedown',  { ...opts, clientX: srcRect.x, clientY: srcRect.y }));
        src.dispatchEvent(new DragEvent('dragstart',   { ...opts }));
        src.dispatchEvent(new DragEvent('drag',        { ...opts }));
        dst.dispatchEvent(new DragEvent('dragover',    { ...opts, clientX: dstRect.x, clientY: dstRect.y }));
        dst.dispatchEvent(new DragEvent('drop',        { ...opts, clientX: dstRect.x, clientY: dstRect.y }));
        src.dispatchEvent(new DragEvent('dragend',     { ...opts }));
        return { ok: true };
      }

      // ── Assertions ───────────────────────────────────────────────────────────
      case 'assertText': {
        const el   = await findElement(target);
        const text = el.textContent.trim();
        if (text !== value) throw new Error(`assertText failed: expected "${value}", got "${text}"`);
        return { ok: true };
      }

      case 'assertValue': {
        const el = await findElement(target);
        if (el.value !== value) throw new Error(`assertValue failed: expected "${value}", got "${el.value}"`);
        return { ok: true };
      }

      case 'assertChecked': {
        const el = await findElement(target);
        if (!el.checked) throw new Error(`assertChecked failed: element is not checked`);
        return { ok: true };
      }

      case 'assertNotChecked': {
        const el = await findElement(target);
        if (el.checked) throw new Error(`assertNotChecked failed: element is checked`);
        return { ok: true };
      }

      case 'assertElementPresent':
        await findElement(target);
        return { ok: true };

      case 'assertElementNotPresent': {
        const found = document.querySelector(target.replace(/^(css=|xpath=|id=|name=)/, ''));
        if (found) throw new Error(`assertElementNotPresent failed: element is present`);
        return { ok: true };
      }

      case 'assertTitle': {
        if (document.title !== value)
          throw new Error(`assertTitle failed: expected "${value}", got "${document.title}"`);
        return { ok: true };
      }

      case 'assertLocation': {
        if (window.location.href !== value)
          throw new Error(`assertLocation failed: expected "${value}", got "${window.location.href}"`);
        return { ok: true };
      }

      case 'verifyText': {
        const el   = await findElement(target);
        const text = el.textContent.trim();
        if (text !== value) {
          chrome.runtime.sendMessage({ type: 'VERIFY_FAILED', payload: { command, target, value, actual: text } });
        }
        return { ok: true }; // verify doesn't throw
      }

      // ── Store ────────────────────────────────────────────────────────────────
      case 'storeText': {
        const el = await findElement(target);
        window.__sfVars = window.__sfVars || {};
        window.__sfVars[value] = el.textContent.trim();
        return { ok: true };
      }

      case 'storeValue': {
        const el = await findElement(target);
        window.__sfVars = window.__sfVars || {};
        window.__sfVars[value] = el.value;
        return { ok: true };
      }

      case 'storeTitle': {
        window.__sfVars = window.__sfVars || {};
        window.__sfVars[value] = document.title;
        return { ok: true };
      }

      // ── Misc ─────────────────────────────────────────────────────────────────
      case 'echo':
        console.log('[SeleniumForge echo]', value);
        chrome.runtime.sendMessage({ type: 'ECHO', payload: { value } });
        return { ok: true };

      case 'captureEntirePageScreenshot':
        chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT', payload: { filename: value || 'screenshot.png' } });
        return { ok: true };

      case 'executeScript': {
        // eslint-disable-next-line no-new-func
        const fn = new Function('arguments', target);
        const result = fn([value]);
        return { ok: true, result };
      }

      case 'executeAsyncScript': {
        const result = await new Promise((resolve, reject) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function('arguments', target);
          fn([value, resolve, reject]);
        });
        return { ok: true, result };
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  // ─── Element finder ──────────────────────────────────────────────────────────

  async function findElement(target, timeout = PLAYBACK_TIMEOUT) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = resolveTarget(target);
      if (el) return el;
      await sleep(100);
    }
    const el = resolveTarget(target);
    if (!el) throw new Error(`Element not found: ${target}`);
    return el;
  }

  function resolveTarget(target) {
    if (!target) return null;
    if (target.startsWith('id='))       return document.getElementById(target.slice(3));
    if (target.startsWith('name='))     return document.querySelector(`[name="${target.slice(5)}"]`);
    if (target.startsWith('css='))      return document.querySelector(target.slice(4));
    if (target.startsWith('link='))     return findByLinkText(target.slice(5), false);
    if (target.startsWith('linkText=')) return findByLinkText(target.slice(9), true);
    if (target.startsWith('xpath='))    return document.evaluate(
      target.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
    // bare CSS fallback
    try { return document.querySelector(target); } catch { return null; }
  }

  function findByLinkText(text, partial) {
    const anchors = document.querySelectorAll('a');
    for (const a of anchors) {
      const t = a.textContent.trim();
      if (partial ? t.includes(text) : t === text) return a;
    }
    return null;
  }

  // ─── Wait helpers ─────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitForElement(target, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (resolveTarget(target)) return;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for element: ${target}`);
  }

  async function waitForAbsent(target, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!resolveTarget(target)) return;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for element to disappear: ${target}`);
  }

  async function waitForVisible(target, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const el = resolveTarget(target);
      if (el && isVisible(el)) return;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for element to be visible: ${target}`);
  }

  function isVisible(el) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ─── Selenium key resolver ────────────────────────────────────────────────

  const KEY_CODE_MAP = {
    '${KEY_ENTER}':     { key: 'Enter',     keyCode: 13 },
    '${KEY_TAB}':       { key: 'Tab',       keyCode: 9  },
    '${KEY_ESCAPE}':    { key: 'Escape',    keyCode: 27 },
    '${KEY_BACKSPACE}': { key: 'Backspace', keyCode: 8  },
    '${KEY_DELETE}':    { key: 'Delete',    keyCode: 46 },
    '${KEY_UP}':        { key: 'ArrowUp',   keyCode: 38 },
    '${KEY_DOWN}':      { key: 'ArrowDown', keyCode: 40 },
    '${KEY_LEFT}':      { key: 'ArrowLeft', keyCode: 37 },
    '${KEY_RIGHT}':     { key: 'ArrowRight',keyCode: 39 },
  };

  function resolveSeleniumKey(seKey) {
    return KEY_CODE_MAP[seKey] || { key: seKey, keyCode: seKey.charCodeAt(0) };
  }

  // ===========================================================================
  // 7. SELF-HEALING
  // ===========================================================================

  /**
   * Try alternative locators when the primary one fails.
   * Used by findElement when the initial resolution returns null.
   */
  async function tryAlternatives(locators, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const loc of locators) {
        const el = resolveTarget(formatTarget(loc));
        if (el) {
          recordHealingSuggestion(locators[0], loc);
          return el;
        }
      }
      await sleep(200);
    }
    throw new Error('Self-healing failed — no alternative locator matched');
  }

  function recordHealingSuggestion(original, healed) {
    chrome.runtime.sendMessage({
      type: 'SELF_HEALING',
      payload: { original, healed },
    });
  }

  // ===========================================================================
  // 8. MESSAGING BRIDGE
  // ===========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {

      case 'START_RECORDING':
        _recording = true;
        _commands  = [];
        attachListeners();
        showRecordingBadge();
        sendResponse({ ok: true });
        break;

      case 'STOP_RECORDING':
        _recording = false;
        detachListeners();
        flushPendingInput();
        removeRecordingBadge();
        hideHighlight();
        sendResponse({ ok: true, commands: _commands });
        break;

      case 'CLEAR_RECORDING':
        _commands = [];
        sendResponse({ ok: true });
        break;

      case 'GET_COMMANDS':
        sendResponse({ ok: true, commands: _commands });
        break;

      case 'PLAY_COMMAND': {
        executeCommand(msg.payload)
          .then(r  => sendResponse({ ok: true,  result: r }))
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true; // async
      }

      case 'PLAY_ALL': {
        (async () => {
          const results = [];
          for (const cmd of msg.payload.commands) {
            try {
              const r = await executeCommand(cmd);
              results.push({ ok: true, result: r });
            } catch (e) {
              results.push({ ok: false, error: e.message, command: cmd });
              if (msg.payload.stopOnError) break;
            }
          }
          sendResponse({ ok: true, results });
        })();
        return true; // async
      }

      case 'INSERT_ASSERTION': {
        const el = document.elementFromPoint(msg.payload.x, msg.payload.y);
        if (!el) { sendResponse({ ok: false, error: 'No element at coordinates' }); break; }
        const cmd = cmdAssertText(el);
        _commands.push(cmd);
        sendResponse({ ok: true, command: cmd });
        break;
      }

      case 'INSERT_SCREENSHOT':
        pushCmd(cmdScreenshot());
        sendResponse({ ok: true });
        break;

      case 'HIGHLIGHT_ELEMENT': {
        const el = resolveTarget(msg.payload.target);
        if (el) updateHighlight(el);
        sendResponse({ ok: !!el });
        break;
      }

      case 'GET_LOCATORS': {
        const el = resolveTarget(msg.payload.target);
        if (!el) { sendResponse({ ok: false, error: 'Element not found' }); break; }
        sendResponse({ ok: true, locators: buildLocatorSet(el) });
        break;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
    }
  });

  // ===========================================================================
  // 9. INIT
  // ===========================================================================

  /**
   * Notify background that content script is ready.
   * Background will respond with the current recording state so we can
   * resume if the tab was refreshed mid-recording.
   */
  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY' }, response => {
    if (chrome.runtime.lastError) return; // extension context may not be ready
    if (response && response.recording) {
      _recording = true;
      _commands  = response.commands || [];
      attachListeners();
      showRecordingBadge();
    }
  });

})(); // end SeleniumForgeRecorder IIFE
