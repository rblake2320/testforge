/**
 * SeleniumForge — Background Service Worker
 * ==========================================
 * Manifest V3 service worker that acts as the central nervous system for the
 * SeleniumForge Chrome extension. All coordination between the panel/popup UI
 * and content scripts flows through here.
 *
 * Architecture Notes
 * ------------------
 * • MV3 service workers have no DOM access and may be terminated at any time.
 *   Never rely on in-memory state across message boundaries — always read from
 *   chrome.storage.local on wake-up and persist any mutations immediately.
 *
 * • The manifest declares `"type": "module"` but content scripts cannot use
 *   ES modules, so the message protocol uses plain string type discriminants.
 *   This file is self-contained (no importScripts) to stay compatible with
 *   the module worker declaration while being readable as a single unit.
 *
 * Sections
 * --------
 *  1. Constants & Storage Schema Defaults
 *  2. Storage Helpers
 *  3. Runtime State (volatile — rebuilt on each wake-up)
 *  4. Extension Lifecycle (install / startup)
 *  5. Badge Management
 *  6. Context Menu Management
 *  7. Tab Management
 *  8. Message Router (central dispatch)
 *  9. Message Handlers — Recording
 * 10. Message Handlers — Playback
 * 11. Message Handlers — Storage CRUD
 * 12. Message Handlers — Export / Downloads
 * 13. Message Handlers — Screenshots
 * 14. Message Handlers — Self-Healing
 * 15. Notification System
 * 16. Content Script Injection Helpers
 */

'use strict';

// ===========================================================================
// 1. CONSTANTS & STORAGE SCHEMA DEFAULTS
// ===========================================================================

/** Maximum execution history entries to retain in storage. */
const MAX_HISTORY_ENTRIES = 50;

/** Debounce delay (ms) for storage write-back operations. */
const STORAGE_WRITE_DEBOUNCE_MS = 300;

/**
 * The canonical default workspace stored on first install.
 * Any missing top-level key is merged in on wake-up.
 */
const DEFAULT_STORAGE = {
  workspace: {
    suites: [],
    dynamicSuites: [],
  },
  testData: [],
  profiles: [
    {
      id: 'default-profile',
      name: 'Default',
      variables: {
        baseUrl: '',
        timeout: '30000',
      },
    },
  ],
  extensionScripts: [],
  settings: {
    defaultTimeout:       30000,
    defaultSpeed:         'FAST',
    screenshotOnFailure:  true,
    selfHealingEnabled:   true,
    theme:                'light',
    showNotifications:    true,
  },
  executionHistory: [],
};

/**
 * Context menu item definitions.
 * Each entry maps to a chrome.contextMenus.create() call.
 * Items are only shown when recording is active (managed via `visible`).
 */
const CONTEXT_MENU_ITEMS = [
  {
    id:       'sf-assert-text',
    title:    'SeleniumForge: Assert Text',
    contexts: ['selection'],
  },
  {
    id:       'sf-assert-element-present',
    title:    'SeleniumForge: Assert Element Present',
    contexts: ['all'],
  },
  {
    id:       'sf-store-text',
    title:    'SeleniumForge: Store Text',
    contexts: ['selection'],
  },
  {
    id:       'sf-inspect-element',
    title:    'SeleniumForge: Inspect Element',
    contexts: ['all'],
  },
  {
    id:       'sf-wait-for-element',
    title:    'SeleniumForge: Wait For Element',
    contexts: ['all'],
  },
];

// ===========================================================================
// 2. STORAGE HELPERS
// ===========================================================================

/**
 * Read the entire extension storage, merging in any missing default keys.
 *
 * @returns {Promise<Object>} Fully-hydrated storage object.
 */
async function readStorage() {
  const raw = await chrome.storage.local.get(null);
  // Merge defaults for any keys not yet present (e.g. on first install or
  // after adding new settings keys in an update).
  const merged = { ...DEFAULT_STORAGE };
  for (const [key, defaultVal] of Object.entries(DEFAULT_STORAGE)) {
    if (raw[key] !== undefined) {
      // For plain objects (settings, workspace), shallow-merge so new keys get defaults.
      if (
        defaultVal !== null &&
        typeof defaultVal === 'object' &&
        !Array.isArray(defaultVal) &&
        typeof raw[key] === 'object' &&
        !Array.isArray(raw[key])
      ) {
        merged[key] = { ...defaultVal, ...raw[key] };
      } else {
        merged[key] = raw[key];
      }
    }
  }
  return merged;
}

/**
 * Write one or more top-level keys back to storage atomically.
 *
 * @param {Object} updates - Partial object with storage key → new value.
 * @returns {Promise<void>}
 */
async function writeStorage(updates) {
  await chrome.storage.local.set(updates);
}

/**
 * Read a single top-level key from storage.
 *
 * @param {string} key
 * @param {*}      defaultVal - Fallback if key is absent.
 * @returns {Promise<*>}
 */
async function readKey(key, defaultVal = undefined) {
  const result = await chrome.storage.local.get(key);
  return result[key] !== undefined ? result[key] : defaultVal;
}

/**
 * Append an entry to the execution history, capping at MAX_HISTORY_ENTRIES.
 *
 * @param {Object} entry
 * @returns {Promise<void>}
 */
async function appendExecutionHistory(entry) {
  const history = await readKey('executionHistory', []);
  history.unshift({ ...entry, timestamp: Date.now() });
  if (history.length > MAX_HISTORY_ENTRIES) history.length = MAX_HISTORY_ENTRIES;
  await writeStorage({ executionHistory: history });
}

// ===========================================================================
// 3. RUNTIME STATE (volatile)
// ===========================================================================

/**
 * In-memory state that is re-initialised each time the service worker wakes
 * up. Never read this directly for anything that must survive a sleep cycle —
 * use storage instead.
 *
 * Fields:
 *  recordingTabId  {number|null}  - Tab currently being recorded.
 *  playbackTabId   {number|null}  - Tab currently running playback.
 *  recordingStatus {'idle'|'recording'|'playing'} - Current high-level mode.
 *  panelPorts      {Map<string, chrome.runtime.Port>} - Open panel connections.
 *  storageDebounce {Map<string, ReturnType<setTimeout>>} - Pending write timers.
 */
const runtimeState = {
  recordingTabId:  null,
  playbackTabId:   null,
  recordingStatus: 'idle',
  panelPorts:      new Map(),
  storageDebounce: new Map(),
};

/**
 * Restore volatile runtime state from storage on service worker wake-up.
 * Reads the `_runtimeState` key which is written on every state change.
 *
 * @returns {Promise<void>}
 */
async function restoreRuntimeState() {
  const persisted = await readKey('_runtimeState', {});
  if (persisted.recordingTabId  !== undefined) runtimeState.recordingTabId  = persisted.recordingTabId;
  if (persisted.playbackTabId   !== undefined) runtimeState.playbackTabId   = persisted.playbackTabId;
  if (persisted.recordingStatus !== undefined) runtimeState.recordingStatus = persisted.recordingStatus;

  // Re-apply the badge to match persisted state (badge resets on SW restart)
  await refreshBadge();
}

/**
 * Persist the mutable runtime state fields so they survive service worker
 * sleep/wake cycles.
 *
 * @returns {Promise<void>}
 */
async function persistRuntimeState() {
  await writeStorage({
    _runtimeState: {
      recordingTabId:  runtimeState.recordingTabId,
      playbackTabId:   runtimeState.playbackTabId,
      recordingStatus: runtimeState.recordingStatus,
    },
  });
}

// ===========================================================================
// 4. EXTENSION LIFECYCLE
// ===========================================================================

/**
 * Handle first-install and update events.
 * On install: seed storage with defaults and create context menu items.
 * On update:  migrate storage schema if needed.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[SeleniumForge] onInstalled:', details.reason);

  if (details.reason === 'install') {
    // Seed storage with full defaults
    await chrome.storage.local.set(DEFAULT_STORAGE);
    console.log('[SeleniumForge] Storage initialised with defaults.');
  } else if (details.reason === 'update') {
    // Merge any new default keys into existing storage without overwriting data
    const existing = await chrome.storage.local.get(null);
    const updates = {};
    for (const [key, val] of Object.entries(DEFAULT_STORAGE)) {
      if (existing[key] === undefined) {
        updates[key] = val;
      }
    }
    if (Object.keys(updates).length > 0) {
      await chrome.storage.local.set(updates);
      console.log('[SeleniumForge] Storage migrated with new keys:', Object.keys(updates));
    }
  }

  // (Re-)create context menus — safe to call on update too
  await setupContextMenus();

  await restoreRuntimeState();
});

/**
 * Runs every time the service worker wakes up (not just on install).
 * Re-hydrates runtime state and refreshes the badge.
 */
chrome.runtime.onStartup.addListener(async () => {
  console.log('[SeleniumForge] Service worker started up.');
  await restoreRuntimeState();
  await setupContextMenus();
});

// ===========================================================================
// 5. BADGE MANAGEMENT
// ===========================================================================

/**
 * Badge configuration for each recording status.
 *
 * @type {Record<string, {text: string, color: string}>}
 */
const BADGE_CONFIG = {
  idle:      { text: '',    color: '#888888' },
  recording: { text: 'REC', color: '#E53935' },  // Red
  playing:   { text: '▶',   color: '#43A047' },  // Green
};

/**
 * Update the extension action badge to reflect the current recording status.
 * Pass `failCount` to show an orange failure count instead.
 *
 * @param {string} [status]    - Override; defaults to runtimeState.recordingStatus.
 * @param {number} [failCount] - If >0, show orange failure badge instead.
 * @returns {Promise<void>}
 */
async function setBadge(status, failCount) {
  const cfg = BADGE_CONFIG[status ?? runtimeState.recordingStatus] ?? BADGE_CONFIG.idle;

  if (typeof failCount === 'number' && failCount > 0) {
    // Orange failure count overrides the normal badge
    await chrome.action.setBadgeText({ text: String(failCount) });
    await chrome.action.setBadgeBackgroundColor({ color: '#FB8C00' }); // Orange
    return;
  }

  await chrome.action.setBadgeText({ text: cfg.text });
  await chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

/**
 * Re-apply the badge based on the current (possibly freshly restored) state.
 * Called on wake-up.
 *
 * @returns {Promise<void>}
 */
async function refreshBadge() {
  await setBadge(runtimeState.recordingStatus);
}

/**
 * Clear the badge back to the idle state.
 *
 * @returns {Promise<void>}
 */
async function clearBadge() {
  await setBadge('idle');
}

// ===========================================================================
// 6. CONTEXT MENU MANAGEMENT
// ===========================================================================

/**
 * Create (or re-create) all SeleniumForge context menu items.
 * Items start hidden; they are shown/hidden dynamically when recording starts
 * or stops via updateContextMenuVisibility().
 *
 * @returns {Promise<void>}
 */
async function setupContextMenus() {
  // Remove any existing items first to avoid duplicates on update
  await chrome.contextMenus.removeAll();

  for (const item of CONTEXT_MENU_ITEMS) {
    chrome.contextMenus.create({
      ...item,
      visible: false, // Hidden by default; shown only while recording
    });
  }
}

/**
 * Show or hide all SeleniumForge context menu items.
 *
 * @param {boolean} visible
 * @returns {Promise<void>}
 */
async function updateContextMenuVisibility(visible) {
  const updates = CONTEXT_MENU_ITEMS.map(item =>
    new Promise(resolve => {
      chrome.contextMenus.update(item.id, { visible }, () => {
        // Ignore errors for missing items (e.g. during install race)
        if (chrome.runtime.lastError) {
          console.warn('[SeleniumForge] contextMenus.update:', chrome.runtime.lastError.message);
        }
        resolve();
      });
    })
  );
  await Promise.all(updates);
}

/**
 * Handle context menu item clicks.
 * Sends the appropriate recording command to the active content script.
 *
 * @param {chrome.contextMenus.OnClickData} info
 * @param {chrome.tabs.Tab}                 tab
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  // Only act if we are currently recording
  if (runtimeState.recordingStatus !== 'recording') return;

  let message = null;

  switch (info.menuItemId) {
    case 'sf-assert-text':
      // The selected text becomes the expected value; target comes from the element
      message = {
        type:    'SF_CONTEXT_MENU_COMMAND',
        command: 'assertText',
        value:   info.selectionText ?? '',
        info,
      };
      break;

    case 'sf-assert-element-present':
      message = {
        type:    'SF_CONTEXT_MENU_COMMAND',
        command: 'assertElementPresent',
        value:   '',
        info,
      };
      break;

    case 'sf-store-text':
      message = {
        type:    'SF_CONTEXT_MENU_COMMAND',
        command: 'storeText',
        value:   info.selectionText ?? '',
        info,
      };
      break;

    case 'sf-inspect-element':
      message = {
        type: 'SF_INSPECT_ELEMENT',
        info,
      };
      break;

    case 'sf-wait-for-element':
      message = {
        type:    'SF_CONTEXT_MENU_COMMAND',
        command: 'waitForElementPresent',
        value:   '',
        info,
      };
      break;

    default:
      console.warn('[SeleniumForge] Unknown context menu item:', info.menuItemId);
      return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (err) {
    console.error('[SeleniumForge] Failed to send context menu command to content script:', err);
  }
});

// ===========================================================================
// 7. TAB MANAGEMENT
// ===========================================================================

/**
 * Track URL changes for the tab being recorded so the panel can show the
 * current page URL in real time.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only care about the tab we're actively recording/playing
  if (
    tabId !== runtimeState.recordingTabId &&
    tabId !== runtimeState.playbackTabId
  ) return;

  if (changeInfo.url) {
    // Notify all open panels about the URL change
    broadcastToPanel({
      type: 'SF_TAB_URL_CHANGED',
      tabId,
      url: changeInfo.url,
    });
  }

  // When a page finishes loading during recording, record an `open` command
  // if the URL has changed (handles hard navigations, not SPA pushState).
  if (
    changeInfo.status === 'complete' &&
    tabId === runtimeState.recordingTabId &&
    changeInfo.url
  ) {
    broadcastToPanel({
      type:    'SF_NAVIGATION_RECORDED',
      command: { command: 'open', target: changeInfo.url, value: '' },
    });
  }

  // If a new page loads into the recording tab, attempt to inject the content
  // script in case it hasn't been injected yet (e.g. new tab navigated to
  // a page not covered by the manifest's match pattern).
  if (changeInfo.status === 'complete' && tabId === runtimeState.recordingTabId) {
    await ensureContentScript(tabId);

    // Re-send the recording start command so the freshly-loaded page starts
    // recording immediately (the content script loses state on full page load).
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'SF_START_RECORDING' });
    } catch (err) {
      // Content script may not be ready yet — it will announce itself via
      // SF_CONTENT_SCRIPT_READY which we handle below.
      console.warn('[SeleniumForge] Could not re-start recording on new page load:', err.message);
    }
  }
});

/**
 * When a tab is removed, clean up any references to it.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === runtimeState.recordingTabId) {
    console.log('[SeleniumForge] Recording tab was closed. Stopping recording.');
    runtimeState.recordingTabId  = null;
    runtimeState.recordingStatus = 'idle';
    await persistRuntimeState();
    await clearBadge();
    await updateContextMenuVisibility(false);
    broadcastToPanel({ type: 'SF_RECORDING_STOPPED', reason: 'tab_closed' });
  }

  if (tabId === runtimeState.playbackTabId) {
    console.log('[SeleniumForge] Playback tab was closed. Stopping playback.');
    runtimeState.playbackTabId   = null;
    runtimeState.recordingStatus = 'idle';
    await persistRuntimeState();
    await clearBadge();
    broadcastToPanel({ type: 'SF_PLAYBACK_STOPPED', reason: 'tab_closed' });
  }
});

/**
 * When a new window opens during recording (e.g. target=_blank links),
 * inject the content script and notify the panel.
 */
chrome.windows.onCreated.addListener(async (window) => {
  if (runtimeState.recordingStatus !== 'recording') return;
  if (!window.tabs || window.tabs.length === 0) return;

  const newTab = window.tabs[0];
  if (!newTab?.id) return;

  // Give the page a moment to load before injecting
  // (tabs.onUpdated 'complete' will handle injection more reliably)
  broadcastToPanel({
    type:  'SF_NEW_WINDOW_OPENED',
    tabId: newTab.id,
    url:   newTab.url ?? '',
  });
});

/**
 * Ensure the content script is injected into a given tab.
 * Silently skips chrome:// and edge:// system pages.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>} True if injection was successful or already present.
 */
async function ensureContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';

    // Skip privileged pages where injection is not allowed
    if (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url === ''
    ) {
      return false;
    }

    // Probe the content script — if it responds, it's already loaded
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'SF_PING' });
      return true; // Already present
    } catch (_) {
      // Not present — inject it
    }

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files:  ['content/recorder.js'],
    });

    await chrome.scripting.insertCSS({
      target: { tabId },
      files:  ['content/recorder.css'],
    });

    return true;
  } catch (err) {
    console.warn(`[SeleniumForge] Could not inject content script into tab ${tabId}:`, err.message);
    return false;
  }
}

// ===========================================================================
// 8. MESSAGE ROUTER (central dispatch)
// ===========================================================================

/**
 * Broadcast a message to all connected panel ports.
 *
 * @param {Object} message
 */
function broadcastToPanel(message) {
  for (const [portId, port] of runtimeState.panelPorts) {
    try {
      port.postMessage(message);
    } catch (err) {
      console.warn(`[SeleniumForge] Failed to post to panel port ${portId}:`, err.message);
      runtimeState.panelPorts.delete(portId);
    }
  }
}

/**
 * Handle long-lived connections from the panel (side panel / popup).
 * These ports allow the background to push messages to the UI without polling.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sf-panel') return;

  const portId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  runtimeState.panelPorts.set(portId, port);
  console.log(`[SeleniumForge] Panel connected (${portId}).`);

  // Clean up when the port disconnects
  port.onDisconnect.addListener(() => {
    runtimeState.panelPorts.delete(portId);
    console.log(`[SeleniumForge] Panel disconnected (${portId}).`);
  });

  // Allow panel to send messages over the port as well
  port.onMessage.addListener((message) => {
    handleMessage(message, { tab: null }, (response) => {
      try { port.postMessage({ _responseFor: message.type, ...response }); }
      catch (_) {}
    });
  });
});

/**
 * Primary one-shot message listener.
 * All chrome.runtime.sendMessage() calls from both content scripts and the
 * panel arrive here.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Wake-up guard: restore runtime state before processing any message
  // (service workers can receive messages immediately after being woken).
  restoreRuntimeState().then(() => {
    handleMessage(message, sender, sendResponse);
  });

  // Return true to indicate the response will be sent asynchronously
  return true;
});

/**
 * Dispatch a message to the appropriate handler based on `message.type`.
 *
 * @param {Object}                            message
 * @param {chrome.runtime.MessageSender}      sender
 * @param {function(Object): void}            sendResponse
 */
function handleMessage(message, sender, sendResponse) {
  const { type } = message;

  if (!type) {
    sendResponse({ error: 'Missing message type.' });
    return;
  }

  // ── Recording ──────────────────────────────────────────────────────────────
  if (type === 'SF_START_RECORDING')     { handleStartRecording(message, sender, sendResponse);  return; }
  if (type === 'SF_STOP_RECORDING')      { handleStopRecording(message, sender, sendResponse);   return; }
  if (type === 'SF_START_PICKER')        { handleStartPicker(message, sender, sendResponse);     return; }
  if (type === 'SF_COMMAND_RECORDED')    { handleCommandRecorded(message, sender, sendResponse); return; }
  if (type === 'SF_CONTENT_SCRIPT_READY'){ handleContentScriptReady(message, sender, sendResponse); return; }
  if (type === 'SF_PAGE_NAVIGATED')      { handlePageNavigated(message, sender, sendResponse);   return; }
  if (type === 'SF_SELECT_FRAME')        { handleSelectFrame(message, sender, sendResponse);     return; }
  if (type === 'SF_SELECT_WINDOW')       { handleSelectWindow(message, sender, sendResponse);    return; }

  // ── Playback ───────────────────────────────────────────────────────────────
  if (type === 'SF_START_PLAYBACK')      { handleStartPlayback(message, sender, sendResponse);   return; }
  if (type === 'SF_STOP_PLAYBACK')       { handleStopPlayback(message, sender, sendResponse);    return; }
  if (type === 'SF_COMMAND_RESULT')      { handleCommandResult(message, sender, sendResponse);   return; }
  if (type === 'SF_PLAYBACK_COMPLETE')   { handlePlaybackComplete(message, sender, sendResponse); return; }

  // ── Storage CRUD ──────────────────────────────────────────────────────────
  if (type === 'SF_GET_WORKSPACE')       { handleGetWorkspace(message, sender, sendResponse);    return; }
  if (type === 'SF_SAVE_WORKSPACE')      { handleSaveWorkspace(message, sender, sendResponse);   return; }
  if (type === 'SF_GET_SETTINGS')        { handleGetSettings(message, sender, sendResponse);     return; }
  if (type === 'SF_SAVE_SETTINGS')       { handleSaveSettings(message, sender, sendResponse);    return; }
  if (type === 'SF_GET_PROFILES')        { handleGetProfiles(message, sender, sendResponse);     return; }
  if (type === 'SF_SAVE_PROFILES')       { handleSaveProfiles(message, sender, sendResponse);    return; }
  if (type === 'SF_GET_TEST_DATA')       { handleGetTestData(message, sender, sendResponse);     return; }
  if (type === 'SF_SAVE_TEST_DATA')      { handleSaveTestData(message, sender, sendResponse);    return; }
  if (type === 'SF_GET_SCRIPTS')         { handleGetScripts(message, sender, sendResponse);      return; }
  if (type === 'SF_SAVE_SCRIPTS')        { handleSaveScripts(message, sender, sendResponse);     return; }
  if (type === 'SF_GET_HISTORY')         { handleGetHistory(message, sender, sendResponse);      return; }
  if (type === 'SF_CLEAR_HISTORY')       { handleClearHistory(message, sender, sendResponse);    return; }

  // ── Export / Downloads ────────────────────────────────────────────────────
  if (type === 'SF_DOWNLOAD_FILE')       { handleDownloadFile(message, sender, sendResponse);    return; }

  // ── Screenshots ───────────────────────────────────────────────────────────
  if (type === 'SF_CAPTURE_SCREENSHOT')  { handleCaptureScreenshot(message, sender, sendResponse); return; }
  if (type === 'SF_SCREENSHOT_RESULT')   { handleScreenshotResult(message, sender, sendResponse);  return; }

  // ── Self-Healing ──────────────────────────────────────────────────────────
  if (type === 'SF_HEALING_SUGGESTION')  { handleHealingSuggestion(message, sender, sendResponse); return; }

  // ── Utility ───────────────────────────────────────────────────────────────
  if (type === 'SF_PING')                { sendResponse({ pong: true });                          return; }
  if (type === 'SF_GET_RUNTIME_STATE')   { handleGetRuntimeState(message, sender, sendResponse);  return; }
  if (type === 'SF_SET_BADGE_FAIL')      { handleSetBadgeFail(message, sender, sendResponse);     return; }

  console.warn('[SeleniumForge] Unhandled message type:', type);
  sendResponse({ error: `Unknown message type: ${type}` });
}

// ===========================================================================
// 9. MESSAGE HANDLERS — RECORDING
// ===========================================================================

/**
 * SF_START_RECORDING
 * Sent by the panel when the user clicks the Record button.
 *
 * Payload: { tabId?: number }
 *
 * If `tabId` is omitted, we use the currently active tab in the focused window.
 */
async function handleStartRecording(message, sender, sendResponse) {
  try {
    let tabId = message.tabId;

    // Resolve to active tab if not specified
    if (!tabId) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) {
        sendResponse({ ok: false, error: 'No active tab found.' });
        return;
      }
      tabId = activeTab.id;
    }

    // Inject content script if not already present
    const injected = await ensureContentScript(tabId);
    if (!injected) {
      sendResponse({ ok: false, error: 'Cannot inject content script into this page (protected URL).' });
      return;
    }

    // Update runtime state
    runtimeState.recordingTabId  = tabId;
    runtimeState.recordingStatus = 'recording';
    await persistRuntimeState();

    // Update badge and context menu
    await setBadge('recording');
    await updateContextMenuVisibility(true);

    // Tell the content script to start recording
    await chrome.tabs.sendMessage(tabId, { type: 'SF_START_RECORDING' });

    sendResponse({ ok: true, tabId });
  } catch (err) {
    console.error('[SeleniumForge] handleStartRecording error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_STOP_RECORDING
 * Sent by the panel when the user clicks Stop.
 *
 * Payload: {}
 */
async function handleStopRecording(message, sender, sendResponse) {
  try {
    const tabId = runtimeState.recordingTabId;

    runtimeState.recordingStatus = 'idle';
    runtimeState.recordingTabId  = null;
    await persistRuntimeState();

    await clearBadge();
    await updateContextMenuVisibility(false);

    // Tell the content script to stop (best-effort; tab may already be gone)
    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'SF_STOP_RECORDING' });
      } catch (_) {}
    }

    sendResponse({ ok: true });
  } catch (err) {
    console.error('[SeleniumForge] handleStopRecording error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_COMMAND_RECORDED
 * Content script → background → panel.
 * Forwards a newly-recorded command to all open panel connections.
 *
 * Payload: { command: SeleniumCommand }
 */
function handleCommandRecorded(message, sender, sendResponse) {
  // Forward to panel immediately
  broadcastToPanel({
    type:    'SF_COMMAND_RECORDED',
    command: message.command,
    tabId:   sender.tab?.id,
  });
  sendResponse({ ok: true });
}

/**
 * SF_START_PICKER
 * Forwarded from the panel — tell the content script to enter element-inspect mode.
 */
async function handleStartPicker(message, sender, sendResponse) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { sendResponse({ ok: false, error: 'No active tab' }); return; }
    await ensureContentScript(tab.id);
    chrome.tabs.sendMessage(tab.id, { type: 'SF_INSPECT_ELEMENT' }, (resp) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, tabId: tab.id });
      }
    });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

/**
 * SF_CONTENT_SCRIPT_READY
 * Fired by the content script when it first loads.
 * If we're actively recording this tab, re-send the start command.
 *
 * Payload: { url: string }
 */
async function handleContentScriptReady(message, sender, sendResponse) {
  const tabId = sender.tab?.id;
  broadcastToPanel({
    type:  'SF_CONTENT_SCRIPT_READY',
    tabId,
    url:   message.url,
  });

  // Re-arm recording if this is the recording tab loading a new page
  if (tabId && tabId === runtimeState.recordingTabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'SF_START_RECORDING' });
    } catch (err) {
      console.warn('[SeleniumForge] handleContentScriptReady: re-arm failed:', err.message);
    }
  }

  sendResponse({ ok: true });
}

/**
 * SF_PAGE_NAVIGATED
 * Fired by the content script after a SPA navigation (popstate, pushState).
 *
 * Payload: { url: string }
 */
function handlePageNavigated(message, sender, sendResponse) {
  broadcastToPanel({
    type:  'SF_PAGE_NAVIGATED',
    url:   message.url,
    tabId: sender.tab?.id,
  });
  sendResponse({ ok: true });
}

/**
 * SF_SELECT_FRAME
 * Fired by the content script when a selectFrame command should be recorded.
 *
 * Payload: { locator: string }
 */
function handleSelectFrame(message, sender, sendResponse) {
  broadcastToPanel({
    type:    'SF_COMMAND_RECORDED',
    command: { command: 'selectFrame', target: message.locator, value: '' },
    tabId:   sender.tab?.id,
  });
  sendResponse({ ok: true });
}

/**
 * SF_SELECT_WINDOW
 * Fired by the content script when a selectWindow command should be recorded.
 *
 * Payload: { locator: string }
 */
function handleSelectWindow(message, sender, sendResponse) {
  broadcastToPanel({
    type:    'SF_COMMAND_RECORDED',
    command: { command: 'selectWindow', target: message.locator, value: '' },
    tabId:   sender.tab?.id,
  });
  sendResponse({ ok: true });
}

// ===========================================================================
// 10. MESSAGE HANDLERS — PLAYBACK
// ===========================================================================

/**
 * SF_START_PLAYBACK
 * Sent by the panel to begin executing a test case.
 *
 * Payload: { tabId?: number, testCase: Object, settings: Object }
 */
async function handleStartPlayback(message, sender, sendResponse) {
  try {
    let tabId = message.tabId;

    if (!tabId) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) {
        sendResponse({ ok: false, error: 'No active tab found.' });
        return;
      }
      tabId = activeTab.id;
    }

    const injected = await ensureContentScript(tabId);
    if (!injected) {
      sendResponse({ ok: false, error: 'Cannot inject content script into this page.' });
      return;
    }

    runtimeState.playbackTabId   = tabId;
    runtimeState.recordingStatus = 'playing';
    await persistRuntimeState();
    await setBadge('playing');

    // Forward the full playback command to the content script.
    // The content script's playback engine handles command-by-command execution
    // and streams results back via SF_COMMAND_RESULT messages.
    await chrome.tabs.sendMessage(tabId, {
      type:     'SF_PLAY_ALL',
      commands: message.testCase?.commands ?? [],
      settings: message.settings ?? {},
    });

    sendResponse({ ok: true, tabId });
  } catch (err) {
    console.error('[SeleniumForge] handleStartPlayback error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_STOP_PLAYBACK
 * Sent by the panel to abort an in-progress playback run.
 *
 * Payload: {}
 */
async function handleStopPlayback(message, sender, sendResponse) {
  try {
    const tabId = runtimeState.playbackTabId;

    runtimeState.recordingStatus = 'idle';
    runtimeState.playbackTabId   = null;
    await persistRuntimeState();
    await clearBadge();

    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'SF_STOP_PLAYBACK' });
      } catch (_) {}
    }

    sendResponse({ ok: true });
  } catch (err) {
    console.error('[SeleniumForge] handleStopPlayback error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_COMMAND_RESULT
 * Content script → background → panel.
 * Streams individual command execution results during playback.
 *
 * Payload: { index: number, status: 'passed'|'failed'|'skipped', message?: string }
 */
function handleCommandResult(message, sender, sendResponse) {
  broadcastToPanel({
    type:    'SF_COMMAND_RESULT',
    index:   message.index,
    status:  message.status,
    message: message.message,
    tabId:   sender.tab?.id,
  });
  sendResponse({ ok: true });
}

/**
 * SF_PLAYBACK_COMPLETE
 * Fired by the content script when all commands have been executed.
 *
 * Payload: { passed: number, failed: number, skipped: number, duration: number, testName?: string }
 */
async function handlePlaybackComplete(message, sender, sendResponse) {
  const { passed = 0, failed = 0, skipped = 0, duration = 0, testName = 'Test' } = message;

  // Update badge: show failure count if any, otherwise back to idle
  runtimeState.recordingStatus = 'idle';
  runtimeState.playbackTabId   = null;
  await persistRuntimeState();

  if (failed > 0) {
    await setBadge('idle', failed);
  } else {
    await clearBadge();
  }

  // Append to execution history
  await appendExecutionHistory({ testName, passed, failed, skipped, duration });

  // Broadcast completion to panel
  broadcastToPanel({
    type:    'SF_PLAYBACK_COMPLETE',
    passed,
    failed,
    skipped,
    duration,
    testName,
  });

  // Show desktop notification if enabled
  const settings = await readKey('settings', DEFAULT_STORAGE.settings);
  if (settings.showNotifications) {
    const allPassed = failed === 0;
    showNotification({
      title:   allPassed ? 'SeleniumForge — Tests Passed ✓' : 'SeleniumForge — Tests Failed ✗',
      message: `${testName}: ${passed} passed, ${failed} failed, ${skipped} skipped (${(duration / 1000).toFixed(1)}s)`,
      iconUrl: allPassed ? 'icons/icon48.png' : 'icons/icon48.png',
    });
  }

  sendResponse({ ok: true });
}

// ===========================================================================
// 11. MESSAGE HANDLERS — STORAGE CRUD
// ===========================================================================

/**
 * SF_GET_WORKSPACE
 * Panel requests the full workspace (suites + test cases).
 *
 * Response: { workspace: Object }
 */
async function handleGetWorkspace(message, sender, sendResponse) {
  const workspace = await readKey('workspace', DEFAULT_STORAGE.workspace);
  sendResponse({ ok: true, workspace });
}

/**
 * SF_SAVE_WORKSPACE
 * Panel sends the updated workspace after any edit.
 *
 * Payload: { workspace: Object }
 * Response: { ok: boolean }
 */
async function handleSaveWorkspace(message, sender, sendResponse) {
  try {
    await writeStorage({ workspace: message.workspace });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_GET_SETTINGS
 * Response: { settings: Object }
 */
async function handleGetSettings(message, sender, sendResponse) {
  const settings = await readKey('settings', DEFAULT_STORAGE.settings);
  sendResponse({ ok: true, settings });
}

/**
 * SF_SAVE_SETTINGS
 * Payload: { settings: Object }
 */
async function handleSaveSettings(message, sender, sendResponse) {
  try {
    // Merge with defaults to preserve any keys the panel didn't include
    const existing = await readKey('settings', DEFAULT_STORAGE.settings);
    const merged   = { ...existing, ...message.settings };
    await writeStorage({ settings: merged });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_GET_PROFILES
 * Response: { profiles: Array }
 */
async function handleGetProfiles(message, sender, sendResponse) {
  const profiles = await readKey('profiles', DEFAULT_STORAGE.profiles);
  sendResponse({ ok: true, profiles });
}

/**
 * SF_SAVE_PROFILES
 * Payload: { profiles: Array }
 */
async function handleSaveProfiles(message, sender, sendResponse) {
  try {
    await writeStorage({ profiles: message.profiles });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_GET_TEST_DATA
 * Response: { testData: Array }
 */
async function handleGetTestData(message, sender, sendResponse) {
  const testData = await readKey('testData', DEFAULT_STORAGE.testData);
  sendResponse({ ok: true, testData });
}

/**
 * SF_SAVE_TEST_DATA
 * Payload: { testData: Array }
 */
async function handleSaveTestData(message, sender, sendResponse) {
  try {
    await writeStorage({ testData: message.testData });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_GET_SCRIPTS
 * Response: { extensionScripts: Array }
 */
async function handleGetScripts(message, sender, sendResponse) {
  const extensionScripts = await readKey('extensionScripts', DEFAULT_STORAGE.extensionScripts);
  sendResponse({ ok: true, extensionScripts });
}

/**
 * SF_SAVE_SCRIPTS
 * Payload: { extensionScripts: Array }
 */
async function handleSaveScripts(message, sender, sendResponse) {
  try {
    await writeStorage({ extensionScripts: message.extensionScripts });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_GET_HISTORY
 * Response: { executionHistory: Array }
 */
async function handleGetHistory(message, sender, sendResponse) {
  const executionHistory = await readKey('executionHistory', []);
  sendResponse({ ok: true, executionHistory });
}

/**
 * SF_CLEAR_HISTORY
 * Wipes execution history.
 */
async function handleClearHistory(message, sender, sendResponse) {
  try {
    await writeStorage({ executionHistory: [] });
    sendResponse({ ok: true });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ===========================================================================
// 12. MESSAGE HANDLERS — EXPORT / DOWNLOADS
// ===========================================================================

/**
 * SF_DOWNLOAD_FILE
 * Panel requests that a generated file be downloaded to the user's filesystem.
 *
 * Payload:
 *  {
 *    filename: string,       // e.g. "LoginTest.java" or "test_suite.zip"
 *    content:  string,       // File content (plain text or base64 for binary)
 *    mimeType: string,       // e.g. "text/plain" or "application/zip"
 *    isBase64?: boolean,     // If true, `content` is a base64-encoded string
 *  }
 *
 * Response: { ok: boolean, downloadId?: number }
 */
async function handleDownloadFile(message, sender, sendResponse) {
  const { filename, content, mimeType = 'text/plain', isBase64 = false } = message;

  if (!filename || content === undefined) {
    sendResponse({ ok: false, error: 'filename and content are required.' });
    return;
  }

  try {
    let dataUrl;

    if (isBase64) {
      // Already base64 — build the data URL directly
      dataUrl = `data:${mimeType};base64,${content}`;
    } else {
      // Convert text content to base64 data URL via Uint8Array
      const encoder  = new TextEncoder();
      const bytes    = encoder.encode(content);
      const base64   = uint8ArrayToBase64(bytes);
      dataUrl        = `data:${mimeType};base64,${base64}`;
    }

    const downloadId = await chrome.downloads.download({
      url:      dataUrl,
      filename: sanitizeFilename(filename),
      saveAs:   false, // Use the user's default download folder; set true to prompt
    });

    sendResponse({ ok: true, downloadId });
  } catch (err) {
    console.error('[SeleniumForge] handleDownloadFile error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * Convert a Uint8Array to a base64 string without relying on DOM APIs.
 * (Service workers have no btoa/atob parity issues, but we keep it explicit.)
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function uint8ArrayToBase64(bytes) {
  // btoa is available in service workers (it's part of the base64 encoding API)
  let binary = '';
  const chunkSize = 8192; // Process in chunks to avoid stack overflow on large files
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Remove characters that are illegal in filenames across Windows/macOS/Linux.
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
  return name
    .replace(/[\/\\?%*:|"<>]/g, '_') // Replace illegal chars
    .replace(/\s+/g, '_')            // Spaces → underscores
    .replace(/_{2,}/g, '_')          // Collapse runs of underscores
    .slice(0, 200);                  // Truncate to a safe length
}

// ===========================================================================
// 13. MESSAGE HANDLERS — SCREENSHOTS
// ===========================================================================

/**
 * SF_CAPTURE_SCREENSHOT
 * Content script asks the background to capture the visible tab.
 * (Content scripts cannot call captureVisibleTab; only the background can.)
 *
 * Payload: { filename?: string }
 * Response: { ok: boolean, dataUrl?: string }
 */
async function handleCaptureScreenshot(message, sender, sendResponse) {
  const tabId  = sender.tab?.id ?? runtimeState.playbackTabId ?? runtimeState.recordingTabId;
  const tab    = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const winId  = tab?.windowId;

  if (!winId) {
    sendResponse({ ok: false, error: 'Could not determine window for screenshot.' });
    return;
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });

    // Optionally download the screenshot
    const filename = message.filename ?? `screenshot_${Date.now()}.png`;

    // Forward the screenshot data to the panel (for display in Screenshots tab)
    broadcastToPanel({
      type:     'SF_SCREENSHOT_CAPTURED',
      dataUrl,
      filename,
      timestamp: Date.now(),
    });

    // Also auto-download if requested
    if (message.download) {
      try {
        await chrome.downloads.download({
          url:      dataUrl,
          filename: sanitizeFilename(filename),
          saveAs:   false,
        });
      } catch (dlErr) {
        console.warn('[SeleniumForge] Screenshot download failed:', dlErr.message);
      }
    }

    sendResponse({ ok: true, dataUrl });
  } catch (err) {
    console.error('[SeleniumForge] handleCaptureScreenshot error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

/**
 * SF_SCREENSHOT_RESULT
 * Panel confirms that a screenshot was processed (e.g. stored in the UI).
 * No action required in the background beyond acknowledgment.
 */
function handleScreenshotResult(message, sender, sendResponse) {
  sendResponse({ ok: true });
}

// ===========================================================================
// 14. MESSAGE HANDLERS — SELF-HEALING
// ===========================================================================

/**
 * SF_HEALING_SUGGESTION
 * Content script → background → panel.
 * Fired when the playback engine uses an alternative locator because the
 * primary one failed.
 *
 * Payload:
 *  {
 *    commandIndex: number,
 *    original:     string,   // The locator that failed
 *    suggestion:   string,   // The alternative that worked
 *    command:      string,   // The Selenese command name
 *  }
 */
function handleHealingSuggestion(message, sender, sendResponse) {
  broadcastToPanel({
    type:         'SF_HEALING_SUGGESTION',
    commandIndex: message.commandIndex,
    original:     message.original,
    suggestion:   message.suggestion,
    command:      message.command,
    tabId:        sender.tab?.id,
  });
  sendResponse({ ok: true });
}

// ===========================================================================
// 15. MESSAGE HANDLERS — UTILITY
// ===========================================================================

/**
 * SF_GET_RUNTIME_STATE
 * Panel requests the current runtime state (recording status, active tab, etc.)
 *
 * Response: { recordingStatus, recordingTabId, playbackTabId }
 */
async function handleGetRuntimeState(message, sender, sendResponse) {
  await restoreRuntimeState(); // Ensure fresh data
  sendResponse({
    ok:              true,
    recordingStatus: runtimeState.recordingStatus,
    recordingTabId:  runtimeState.recordingTabId,
    playbackTabId:   runtimeState.playbackTabId,
  });
}

/**
 * SF_SET_BADGE_FAIL
 * Panel instructs the background to display a test failure count on the badge.
 *
 * Payload: { count: number }
 */
async function handleSetBadgeFail(message, sender, sendResponse) {
  await setBadge('idle', message.count ?? 0);
  sendResponse({ ok: true });
}

// ===========================================================================
// 16. NOTIFICATION SYSTEM
// ===========================================================================

/**
 * Display a desktop notification using the chrome.notifications API.
 * Called after playback completes if `settings.showNotifications` is true.
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.iconUrl]
 */
function showNotification({ title, message, iconUrl = 'icons/icon48.png' }) {
  const notifId = `sf-${Date.now()}`;

  chrome.notifications.create(notifId, {
    type:     'basic',
    iconUrl,
    title,
    message,
    priority: 1,
  }, (id) => {
    if (chrome.runtime.lastError) {
      console.warn('[SeleniumForge] Notification error:', chrome.runtime.lastError.message);
      return;
    }
    // Auto-dismiss after 8 seconds
    setTimeout(() => {
      chrome.notifications.clear(id, () => {});
    }, 8000);
  });
}

// Allow clicking a notification to open the side panel / popup
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith('sf-')) return;
  chrome.notifications.clear(notifId, () => {});

  // Open the side panel if available; fall back to popup
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId && chrome.sidePanel) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } else {
      await chrome.action.openPopup();
    }
  } catch (err) {
    console.warn('[SeleniumForge] Could not open panel from notification:', err.message);
  }
});

// ===========================================================================
// INIT — Run on every service worker wake-up
// ===========================================================================

/**
 * Bootstrap sequence that runs once each time the service worker is (re)started.
 * Safe to call multiple times — all operations are idempotent.
 */
(async function init() {
  console.log('[SeleniumForge] Service worker initialising…');
  try {
    await restoreRuntimeState();
    // Context menus are re-created in onInstalled; they persist across SW restarts
    // so we don't need to recreate them here.
    console.log(
      `[SeleniumForge] Ready. Status: ${runtimeState.recordingStatus}`,
      `| RecordingTab: ${runtimeState.recordingTabId}`,
      `| PlaybackTab:  ${runtimeState.playbackTabId}`
    );
  } catch (err) {
    console.error('[SeleniumForge] Init failed:', err);
  }
})();
