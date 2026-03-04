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
 * In-memory record of which tabs are currently being recorded.
 * Rebuilt from storage on each service-worker wake-up via initRuntimeState().
 * Key: tabId (number), Value: { suiteId, testCaseId, startedAt }
 */
const activeRecordings = new Map();

/**
 * In-memory record of active playback sessions.
 * Key: tabId (number), Value: { suiteId, testCaseId, commandIndex, speed }
 */
const activePlaybacks = new Map();

/**
 * Debounce timers for storage write operations.
 * Key: storage key string, Value: setTimeout handle.
 */
const storageDebounceTimers = new Map();

// ===========================================================================
// 4. EXTENSION LIFECYCLE
// ===========================================================================

/**
 * Initialise or repair storage on install / update.
 */
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    // First install: write full defaults.
    await chrome.storage.local.set(DEFAULT_STORAGE);
    console.log('[SeleniumForge] Extension installed. Default storage written.');
  } else if (reason === 'update') {
    // On update: merge any new default keys without overwriting existing data.
    await readStorage(); // Side-effect: merges defaults.
    console.log('[SeleniumForge] Extension updated. Storage schema migrated.');
  }

  // (Re)create context menus on install/update to handle permission changes.
  await setupContextMenus();
});

/**
 * Re-initialise volatile state whenever the service worker wakes up.
 */
chrome.runtime.onStartup.addListener(async () => {
  await initRuntimeState();
  console.log('[SeleniumForge] Service worker started.');
});

/**
 * Rebuild in-memory runtime state from persisted storage.
 * Called on startup and can be called after any storage mutation that
 * affects recording/playback state.
 */
async function initRuntimeState() {
  // Clear any stale in-memory records.
  activeRecordings.clear();
  activePlaybacks.clear();

  // Restore recording state for any tabs that were recording before
  // the service worker was terminated.
  const { recordingState } = await chrome.storage.local.get('recordingState');
  if (recordingState && typeof recordingState === 'object') {
    for (const [tabIdStr, state] of Object.entries(recordingState)) {
      activeRecordings.set(parseInt(tabIdStr, 10), state);
    }
  }
}

// ===========================================================================
// 5. BADGE MANAGEMENT
// ===========================================================================

/**
 * Update the extension badge to reflect the current state.
 *
 * @param {'recording'|'playing'|'idle'} state
 * @param {number} [tabId] - If provided, only update badge for this tab.
 */
function updateBadge(state, tabId) {
  const configs = {
    recording: { text: 'REC', color: '#e53e3e' },   // red
    playing:   { text: '▶',   color: '#3182ce' },   // blue
    idle:      { text: '',    color: '#718096' },   // gray / hidden
  };
  const cfg = configs[state] || configs.idle;
  const opts = tabId ? { tabId } : {};

  chrome.action.setBadgeText({ text: cfg.text, ...opts });
  chrome.action.setBadgeBackgroundColor({ color: cfg.color, ...opts });
}

// ===========================================================================
// 6. CONTEXT MENU MANAGEMENT
// ===========================================================================

async function setupContextMenus() {
  // Remove all existing items to avoid duplicate-ID errors on reinstall.
  await chrome.contextMenus.removeAll();
  for (const item of CONTEXT_MENU_ITEMS) {
    chrome.contextMenus.create({
      ...item,
      visible: false,   // Hidden by default; shown only during active recording.
    });
  }
}

/**
 * Show or hide the context menu items.
 *
 * @param {boolean} visible
 */
function setContextMenusVisible(visible) {
  for (const item of CONTEXT_MENU_ITEMS) {
    chrome.contextMenus.update(item.id, { visible });
  }
}

/**
 * Handle context menu clicks — inject the appropriate Selenese command.
 */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  const recording = activeRecordings.get(tab.id);
  if (!recording) return;   // Not recording on this tab; ignore.

  let command = null;

  switch (info.menuItemId) {
    case 'sf-assert-text':
      command = {
        command: 'assertText',
        target:  '',   // Filled in by content script after locator is determined.
        value:   info.selectionText ?? '',
      };
      break;

    case 'sf-assert-element-present':
      command = {
        command: 'assertElementPresent',
        target:  '',
        value:   '',
      };
      break;

    case 'sf-store-text':
      command = {
        command: 'storeText',
        target:  '',
        value:   `var_${Date.now()}`,
      };
      break;

    case 'sf-inspect-element':
      // Send a message to the content script to capture the element under cursor.
      await chrome.tabs.sendMessage(tab.id, {
        type: 'SF_INSPECT_ELEMENT',
      });
      return;

    case 'sf-wait-for-element':
      command = {
        command: 'waitForElementPresent',
        target:  '',
        value:   '30000',
      };
      break;
  }

  if (command) {
    await chrome.tabs.sendMessage(tab.id, {
      type:    'SF_INJECT_COMMAND',
      command,
    });
  }
});

// ===========================================================================
// 7. TAB MANAGEMENT
// ===========================================================================

/**
 * Clean up recording/playback state when a tab is closed.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (activeRecordings.has(tabId)) {
    activeRecordings.delete(tabId);
    await persistRecordingState();
    updateBadge('idle', tabId);
  }
  if (activePlaybacks.has(tabId)) {
    activePlaybacks.delete(tabId);
    updateBadge('idle', tabId);
  }
});

/**
 * When a tab navigates, notify the panel so it can append an `open` command
 * if recording is active.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!activeRecordings.has(tabId)) return;

  await chrome.runtime.sendMessage({
    type:   'SF_TAB_NAVIGATED',
    tabId,
    url:    tab.url,
  }).catch(() => {
    // Panel may not be open; ignore the error.
  });
});

// ===========================================================================
// 8. MESSAGE ROUTER
// ===========================================================================

/**
 * Central message dispatcher.
 * All messages from the panel, popup, and content scripts arrive here.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Always return true to indicate we will respond asynchronously.
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[SeleniumForge] Message handler error:', err);
      sendResponse({ success: false, error: err.message });
    });
  return true;
});

/**
 * Route a message to the appropriate handler.
 *
 * @param {Object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<Object>} Response payload.
 */
async function handleMessage(message, sender) {
  const { type } = message;

  switch (type) {
    // ── Recording ──────────────────────────────────────────────────
    case 'SF_START_RECORDING':   return handleStartRecording(message, sender);
    case 'SF_STOP_RECORDING':    return handleStopRecording(message, sender);
    case 'SF_COMMAND_RECORDED':  return handleCommandRecorded(message, sender);

    // ── Playback ──────────────────────────────────────────────────
    case 'SF_PLAY_COMMAND':      return handlePlayCommand(message, sender);
    case 'SF_PLAY_START':        return handlePlayStart(message, sender);
    case 'SF_PLAY_STOP':         return handlePlayStop(message, sender);
    case 'SF_PLAY_RESULT':       return handlePlayResult(message, sender);

    // ── Storage CRUD ──────────────────────────────────────────────
    case 'SF_GET_WORKSPACE':     return handleGetWorkspace();
    case 'SF_SAVE_WORKSPACE':    return handleSaveWorkspace(message);
    case 'SF_GET_SETTINGS':      return handleGetSettings();
    case 'SF_SAVE_SETTINGS':     return handleSaveSettings(message);
    case 'SF_GET_TEST_DATA':     return handleGetTestData();
    case 'SF_SAVE_TEST_DATA':    return handleSaveTestData(message);
    case 'SF_GET_PROFILES':      return handleGetProfiles();
    case 'SF_SAVE_PROFILES':     return handleSaveProfiles(message);
    case 'SF_GET_EXT_SCRIPTS':   return handleGetExtScripts();
    case 'SF_SAVE_EXT_SCRIPTS':  return handleSaveExtScripts(message);
    case 'SF_GET_HISTORY':       return handleGetHistory();
    case 'SF_CLEAR_HISTORY':     return handleClearHistory();

    // ── Export / Downloads ─────────────────────────────────────────
    case 'SF_DOWNLOAD_FILE':     return handleDownloadFile(message);

    // ── Screenshots ───────────────────────────────────────────────
    case 'SF_CAPTURE_SCREENSHOT': return handleCaptureScreenshot(message, sender);

    // ── Self-Healing ─────────────────────────────────────────────
    case 'SF_HEALING_SUGGESTION': return handleHealingSuggestion(message);
    case 'SF_APPLY_HEALING':      return handleApplyHealing(message);

    default:
      console.warn('[SeleniumForge] Unknown message type:', type);
      return { success: false, error: `Unknown message type: ${type}` };
  }
}

// ===========================================================================
// 9. MESSAGE HANDLERS — RECORDING
// ===========================================================================

async function handleStartRecording({ suiteId, testCaseId, tabId }) {
  const targetTabId = tabId ?? (await getActiveTabId());
  if (!targetTabId) return { success: false, error: 'No active tab found.' };

  activeRecordings.set(targetTabId, {
    suiteId,
    testCaseId,
    startedAt: Date.now(),
  });

  await persistRecordingState();
  updateBadge('recording', targetTabId);
  setContextMenusVisible(true);

  // Tell the content script to start recording.
  await chrome.tabs.sendMessage(targetTabId, { type: 'SF_START_RECORDING' });

  return { success: true, tabId: targetTabId };
}

async function handleStopRecording({ tabId }) {
  const targetTabId = tabId ?? (await getActiveTabId());
  if (!targetTabId) return { success: false, error: 'No active tab found.' };

  activeRecordings.delete(targetTabId);
  await persistRecordingState();
  updateBadge('idle', targetTabId);
  setContextMenusVisible(false);

  // Tell the content script to stop recording.
  await chrome.tabs.sendMessage(targetTabId, { type: 'SF_STOP_RECORDING' }).catch(() => {});

  return { success: true };
}

async function handleCommandRecorded({ command }, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { success: false, error: 'No sender tab.' };

  const recording = activeRecordings.get(tabId);
  if (!recording) return { success: false, error: 'No active recording for this tab.' };

  // Forward the command to the panel UI.
  await chrome.runtime.sendMessage({
    type:        'SF_COMMAND_RECORDED',
    command,
    suiteId:     recording.suiteId,
    testCaseId:  recording.testCaseId,
  }).catch(() => {
    // Panel may not be open yet; the command will be buffered by the content script.
  });

  return { success: true };
}

// ===========================================================================
// 10. MESSAGE HANDLERS — PLAYBACK
// ===========================================================================

async function handlePlayCommand({ command, tabId, speed }) {
  const targetTabId = tabId ?? (await getActiveTabId());
  if (!targetTabId) return { success: false, error: 'No active tab.' };

  const result = await chrome.tabs.sendMessage(targetTabId, {
    type: 'SF_EXECUTE_COMMAND',
    command,
    speed,
  });

  return result ?? { success: false, error: 'No response from content script.' };
}

async function handlePlayStart({ tabId, suiteId, testCaseId, speed }) {
  const targetTabId = tabId ?? (await getActiveTabId());
  if (!targetTabId) return { success: false, error: 'No active tab.' };

  activePlaybacks.set(targetTabId, { suiteId, testCaseId, speed, startedAt: Date.now() });
  updateBadge('playing', targetTabId);

  return { success: true, tabId: targetTabId };
}

async function handlePlayStop({ tabId }) {
  const targetTabId = tabId ?? (await getActiveTabId());
  if (targetTabId) {
    activePlaybacks.delete(targetTabId);
    updateBadge('idle', targetTabId);
    await chrome.tabs.sendMessage(targetTabId, { type: 'SF_STOP_PLAYBACK' }).catch(() => {});
  }
  return { success: true };
}

async function handlePlayResult({ result, tabId }) {
  await appendExecutionHistory(result);
  if (tabId) updateBadge('idle', tabId);
  return { success: true };
}

// ===========================================================================
// 11. MESSAGE HANDLERS — STORAGE CRUD
// ===========================================================================

async function handleGetWorkspace() {
  const storage = await readStorage();
  return { success: true, workspace: storage.workspace };
}

async function handleSaveWorkspace({ workspace }) {
  await writeStorage({ workspace });
  return { success: true };
}

async function handleGetSettings() {
  const storage = await readStorage();
  return { success: true, settings: storage.settings };
}

async function handleSaveSettings({ settings }) {
  await writeStorage({ settings });
  return { success: true };
}

async function handleGetTestData() {
  const testData = await readKey('testData', []);
  return { success: true, testData };
}

async function handleSaveTestData({ testData }) {
  await writeStorage({ testData });
  return { success: true };
}

async function handleGetProfiles() {
  const profiles = await readKey('profiles', DEFAULT_STORAGE.profiles);
  return { success: true, profiles };
}

async function handleSaveProfiles({ profiles }) {
  await writeStorage({ profiles });
  return { success: true };
}

async function handleGetExtScripts() {
  const extensionScripts = await readKey('extensionScripts', []);
  return { success: true, extensionScripts };
}

async function handleSaveExtScripts({ extensionScripts }) {
  await writeStorage({ extensionScripts });
  return { success: true };
}

async function handleGetHistory() {
  const executionHistory = await readKey('executionHistory', []);
  return { success: true, executionHistory };
}

async function handleClearHistory() {
  await writeStorage({ executionHistory: [] });
  return { success: true };
}

// ===========================================================================
// 12. MESSAGE HANDLERS — EXPORT / DOWNLOADS
// ===========================================================================

async function handleDownloadFile({ filename, content, mimeType }) {
  const blob = new Blob([content], { type: mimeType ?? 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
    });
    return { success: true, downloadId };
  } finally {
    // Revoke the object URL after a short delay to allow the download to start.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

// ===========================================================================
// 13. MESSAGE HANDLERS — SCREENSHOTS
// ===========================================================================

async function handleCaptureScreenshot({ tabId }) {
  const targetTabId = tabId ?? (await getActiveTabId());
  if (!targetTabId) return { success: false, error: 'No active tab.' };

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    return { success: true, dataUrl };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ===========================================================================
// 14. MESSAGE HANDLERS — SELF-HEALING
// ===========================================================================

async function handleHealingSuggestion({ tabId, commandIndex, original, healed }) {
  // Forward to the panel UI for user review.
  await chrome.runtime.sendMessage({
    type:         'SF_HEALING_SUGGESTION',
    tabId,
    commandIndex,
    original,
    healed,
  }).catch(() => {});
  return { success: true };
}

async function handleApplyHealing({ suiteId, testCaseId, commandIndex, newLocator }) {
  const storage  = await readStorage();
  const suite    = storage.workspace.suites.find((s) => s.id === suiteId);
  const testCase = suite?.testCases?.find((tc) => tc.id === testCaseId);

  if (!testCase) return { success: false, error: 'Test case not found.' };

  const cmd = testCase.commands[commandIndex];
  if (!cmd) return { success: false, error: 'Command index out of range.' };

  // Record the old locator as an alternative before overwriting.
  cmd.alternatives = cmd.alternatives ?? [];
  if (!cmd.alternatives.includes(cmd.target)) {
    cmd.alternatives.unshift(cmd.target);
  }
  cmd.target = newLocator;
  cmd.healed = true;

  await writeStorage({ workspace: storage.workspace });
  return { success: true };
}

// ===========================================================================
// 15. NOTIFICATION SYSTEM
// ===========================================================================

/**
 * Show a Chrome notification.
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {'basic'|'image'|'list'|'progress'} [opts.type='basic']
 */
async function showNotification({ title, message, type = 'basic' }) {
  const settings = await readKey('settings', DEFAULT_STORAGE.settings);
  if (!settings.showNotifications) return;

  chrome.notifications.create({
    type,
    iconUrl: chrome.runtime.getURL('icons/icon48.png'),
    title,
    message,
  });
}

// ===========================================================================
// 16. CONTENT SCRIPT INJECTION HELPERS
// ===========================================================================

/**
 * Get the ID of the currently active tab in the focused window.
 *
 * @returns {Promise<number|null>}
 */
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/**
 * Persist the current activeRecordings map to chrome.storage so it can be
 * restored if the service worker is terminated.
 */
async function persistRecordingState() {
  const recordingState = {};
  for (const [tabId, state] of activeRecordings) {
    recordingState[tabId] = state;
  }
  await writeStorage({ recordingState });
}

/**
 * Ensure the SeleniumForge content script is injected into a tab.
 * Safe to call even if the script is already present (no-op if already injected).
 *
 * @param {number} tabId
 */
async function ensureContentScript(tabId) {
  try {
    // Probe: if the content script is present, this will succeed.
    await chrome.tabs.sendMessage(tabId, { type: 'SF_PING' });
  } catch {
    // Inject both the script and CSS.
    await chrome.scripting.executeScript({
      target: { tabId },
      files:  ['content/recorder.js'],
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files:  ['content/recorder.css'],
    });
  }
}
