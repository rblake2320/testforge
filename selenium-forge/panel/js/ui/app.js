/**
 * SeleniumForge — Main UI Application Controller
 * app.js
 * ============================================================
 * MVC controller that wires the sidepanel UI to:
 *   - CommandRegistry  (window.CommandRegistry)
 *   - PlaybackEngine   (window.PlaybackEngine)
 *   - ControlFlowEngine (window.ControlFlowEngine)
 *   - ExportManager    (window.ExportManager)
 *   - Chrome extension APIs (storage, tabs, runtime)
 *
 * Sections
 * --------
 *  1.  Class definition & constructor
 *  2.  Initialization
 *  3.  Workspace management
 *  4.  Suite management
 *  5.  Test case management
 *  6.  Command table editor
 *  7.  Undo / redo
 *  8.  Command autocomplete
 *  9.  Target locator helper
 * 10.  Recording integration
 * 11.  Playback integration
 * 12.  Data-driven testing UI
 * 13.  Profiles (global variables)
 * 14.  Export UI
 * 15.  Artifacts panel (log, variables, screenshots, healing)
 * 16.  Tree view (workspace sidebar)
 * 17.  Settings
 * 18.  Keyboard shortcuts
 * 19.  Chrome runtime message handling
 * 20.  Utility helpers
 *
 * No ES-module syntax — attaches to window.app.
 */

(function (global) {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────

  const STORAGE_KEY_WORKSPACE = 'workspace';
  const STORAGE_KEY_SETTINGS  = 'settings';
  const STORAGE_KEY_TESTDATA  = 'testData';
  const STORAGE_KEY_PROFILES  = 'profiles';
  const STORAGE_KEY_SCRIPTS   = 'extensionScripts';
  const SAVE_DEBOUNCE_MS      = 500;

  const DEFAULT_SETTINGS = {
    defaultTimeout:      30000,
    speed:               'MEDIUM',
    selfHealing:         true,
    screenshotOnFailure: false,
    theme:               'light',
    highlightColor:      '#ff6b35',
  };

  // CSS classes applied to command rows during playback
  const ROW_STATE = {
    running:    'row-running',
    passed:     'row-passed',
    failed:     'row-failed',
    error:      'row-error',
    breakpoint: 'row-breakpoint',
    selected:   'row-selected',
  };

  // ─────────────────────────────────────────────────────────────
  // Helpers (module-private)
  // ─────────────────────────────────────────────────────────────

  /** Generate a short unique id */
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** Escape HTML for safe innerHTML insertion */
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Debounce: returns a function that delays invocation by `wait` ms */
  function debounce(fn, wait) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /** Deep clone via JSON (sufficient for plain data objects) */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /** Normalize a test-case command to {command, target, value} */
  function normCmd(c) {
    return {
      command:    String(c.command    || ''),
      target:     String(c.target     || ''),
      value:      String(c.value      || ''),
      breakpoint: !!c.breakpoint,
      comment:    String(c.comment    || ''),
    };
  }

  /** Create a blank test case */
  function blankTestCase(name) {
    return { id: uid(), name: name || 'Untitled Test', commands: [] };
  }

  /** Create a blank suite */
  function blankSuite(name) {
    return { id: uid(), name: name || 'Untitled Suite', testCases: [] };
  }

  /** Safely call chrome.storage.local.get, returns promise */
  async function storageGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(result);
        });
      } catch (e) { reject(e); }
    });
  }

  /** Safely call chrome.storage.local.set, returns promise */
  async function storageSet(items) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  /** Send a message to the background service worker, returns promise */
  async function sendToBackground(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: true });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  /** Format a timestamp as HH:MM:SS.mmm */
  function fmtTime(ms) {
    const d = new Date(ms);
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  // ─────────────────────────────────────────────────────────────
  // Simple fuzzy search: returns true if all chars of `query`
  // appear in order inside `str` (case-insensitive)
  // ─────────────────────────────────────────────────────────────
  function fuzzyMatch(query, str) {
    if (!query) return true;
    query = query.toLowerCase();
    str   = str.toLowerCase();
    let qi = 0;
    for (let i = 0; i < str.length && qi < query.length; i++) {
      if (str[i] === query[qi]) qi++;
    }
    return qi === query.length;
  }

  // ═══════════════════════════════════════════════════════════
  // SeleniumForgeApp — Main Controller Class
  // ═══════════════════════════════════════════════════════════

  class SeleniumForgeApp {

    constructor() {
      // ── Model ────────────────────────────────────────────
      /** @type {{ suites: Array, dynamicSuites: Array }} */
      this.workspace       = { suites: [], dynamicSuites: [] };
      /** @type {Array<{id, name, type, rows}>} */
      this.testData        = [];
      /** @type {Array<{id, name, variables: Object, active: boolean}>} */
      this.profiles        = [];
      /** @type {Array<{id, name, code}>} */
      this.extensionScripts = [];
      /** @type {Object} */
      this.settings        = Object.assign({}, DEFAULT_SETTINGS);

      // ── Selection ────────────────────────────────────────
      /** @type {Object|null} currently open suite */
      this.currentSuite        = null;
      /** @type {Object|null} currently open test case */
      this.currentTestCase     = null;
      /** @type {number} selected command row index (-1 = none) */
      this.selectedCommandIndex = -1;
      /** @type {number[]} multi-selected command indices */
      this.selectedCommandIndices = [];

      // ── Execution state ──────────────────────────────────
      this.isRecording     = false;
      this.isPlaying       = false;
      /** @type {PlaybackEngine|null} */
      this._playbackEngine = null;

      // ── Clipboard / undo ─────────────────────────────────
      /** @type {Array} copied command objects */
      this.clipboard   = [];
      /** @type {Array} undo history (each entry is a snapshot of commands[]) */
      this.undoStack   = [];
      /** @type {Array} redo history */
      this.redoStack   = [];

      // ── Autocomplete ──────────────────────────────────────
      this._autocompleteVisible     = false;
      this._autocompleteItems       = [];
      this._autocompleteIndex       = -1;
      this._autocompleteTargetCell  = null;

      // ── Target picker ─────────────────────────────────────
      this._pickerActive = false;

      // ── Inline editing ────────────────────────────────────
      /** Currently active inline editor: { rowIndex, field, el } */
      this._activeEditor = null;

      // ── Persist debounce ─────────────────────────────────
      this._debouncedSave = debounce(this._persistWorkspace.bind(this), SAVE_DEBOUNCE_MS);

      // ── Playback row state map ────────────────────────────
      /** index → 'running'|'passed'|'failed'|'error' */
      this._rowStates = {};

      // ── Tree node expansion state ─────────────────────────
      /** suiteId → expanded (bool) */
      this._treeExpanded = {};

      // ── Execution result badges ───────────────────────────
      /** testCaseId → 'passed'|'failed' */
      this._resultBadges = {};

      // ── DOM cache (populated in _cacheDom) ───────────────
      this._dom = {};

      // ── Active sidebar tab ───────────────────────────────
      this._activeTreeTab = 'suites';

      // ── Self-healing list ────────────────────────────────
      /** @type {Array<{index, original, suggested, testCaseId}>} */
      this._healingSuggestions = [];
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 2 – Initialization
    // ═══════════════════════════════════════════════════════════

    /**
     * Boot the application. Called once on DOMContentLoaded.
     * Loads persisted data, wires all event handlers, renders tree.
     */
    async init() {
      this._cacheDom();
      this._applyTheme(this.settings.theme);

      try {
        await this.loadWorkspace();
        await this._loadSettings();
        await this._loadTestData();
        await this._loadProfiles();
        await this._loadExtensionScripts();
      } catch (e) {
        console.warn('[SeleniumForge] Storage load error:', e);
      }

      this._bindToolbar();
      this._bindTreeTabs();
      this._bindCommandTable();
      this._bindArtifactTabs();
      this._bindExportDialog();
      this._bindSettingsDialog();
      this._bindGlobalKeyboard();
      this._bindRuntimeMessages();
      this._bindStorageChange();
      this._bindContextMenu();

      this.renderTree();
      this._renderDataTab();
      this._renderProfilesTab();
      this._renderExtensionsTab();

      // Select first test case if available
      const firstSuite = this.workspace.suites[0];
      if (firstSuite) {
        const firstTC = firstSuite.testCases[0];
        if (firstTC) this.openTestCase(firstSuite, firstTC);
      }

      this._updateToolbarState();
      console.info('[SeleniumForge] App initialized');
    }

    /**
     * Cache frequently-accessed DOM elements to avoid repeated queries.
     * @private
     */
    _cacheDom() {
      const q  = (id) => document.getElementById(id);
      const qs = (sel) => document.querySelector(sel);

      this._dom = {
        // Toolbar
        btnRecord:      q('btn-record'),
        btnPlay:        q('btn-play-tc'),
        btnPlaySuite:   q('btn-play-suite'),
        btnPlayAll:     q('btn-play-all'),
        btnPause:       q('btn-pause'),
        btnStop:        q('btn-stop'),
        btnStep:        q('btn-step'),
        btnAddCmd:      q('btn-insert-cmd'),
        btnDeleteCmd:   q('btn-del-cmd'),
        btnUndo:        q('btn-undo'),
        btnRedo:        q('btn-redo'),
        btnSettings:    q('btn-settings'),
        btnExport:      q('btn-export'),
        speedSelect:    q('speed-select'),
        statusBar:      q('status-bar'),

        // Tree sidebar
        treeTabs:       qs('.tree-tabs'),
        treeContainer:  q('suite-tree'),
        btnAddSuite:    q('btn-add-suite'),
        btnDeleteSuite: q('btn-delete-suite'),

        // Command table area
        testCaseTitle:  q('test-case-title'),
        commandTable:   q('cmd-table'),
        commandTbody:   qs('#cmd-table tbody') || qs('#cmd-tbody'),

        // Autocomplete dropdown
        autocompleteDropdown: q('suggest-dropdown'),

        // Target picker
        btnPickTarget:  q('btn-pick-target'),

        // Detail / reference panel
        detailCommand: q('det-command'),
        detailTarget:  q('det-target'),
        detailValue:   q('det-value'),
        detailComment: q('detail-comment'),
        referencePane: q('apanel-reference'),

        // Artifact tabs
        artifactTabs:      qs('.artifacts-tabs'),
        logContainer:      q('apanel-log'),
        variablesContainer: q('apanel-variables'),
        screenshotsContainer: q('apanel-screenshots'),
        healingContainer:  q('apanel-healing'),

        // Export dialog
        exportDialog:       q('export-modal'),
        exportFormatSelect: q('export-format-select'),
        exportScopeSelect:  q('export-scope-select'),
        exportPreview:      q('export-preview'),
        btnExportConfirm:   q('export-download'),
        btnExportClose:     q('export-close'),

        // Settings dialog
        settingsDialog:     q('settings-modal'),
        settingTimeout:     q('setting-timeout'),
        settingSpeed:       q('setting-speed'),
        settingSelfHeal:    q('setting-selfheal'),
        settingScreenshot:  q('setting-screenshot'),
        settingTheme:       q('setting-theme'),
        btnSettingsSave:    q('btn-settings-save'),
        btnSettingsClose:   q('settings-close'),

        // Data-driven tab
        dataTab:            q('panel-data'),
        btnAddData:         q('btn-add-data'),

        // Profiles tab
        profilesTab:        q('panel-profiles'),
        btnAddProfile:      q('btn-add-profile'),

        // Extensions tab
        extensionsTab:      q('panel-extensions'),
        btnAddExtension:    q('btn-add-extension'),
      };
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 3 – Workspace Management
    // ═══════════════════════════════════════════════════════════

    /** Load workspace from chrome.storage.local */
    async loadWorkspace() {
      const result = await storageGet([STORAGE_KEY_WORKSPACE]);
      const stored = result[STORAGE_KEY_WORKSPACE];
      if (stored && typeof stored === 'object') {
        this.workspace = stored;
        if (!Array.isArray(this.workspace.suites))       this.workspace.suites = [];
        if (!Array.isArray(this.workspace.dynamicSuites)) this.workspace.dynamicSuites = [];
      }
    }

    /** Persist workspace to chrome.storage.local immediately */
    async _persistWorkspace() {
      try {
        await storageSet({ [STORAGE_KEY_WORKSPACE]: this.workspace });
      } catch (e) {
        console.error('[SeleniumForge] Save workspace error:', e);
      }
    }

    /** Trigger a debounced save */
    saveWorkspace() {
      this._debouncedSave();
    }

    /** Export the entire workspace as a JSON download */
    exportWorkspace() {
      const json = JSON.stringify(this.workspace, null, 2);
      this._downloadText(json, 'seleniumforge-workspace.json', 'application/json');
    }

    /**
     * Import a suite from JSON text.
     * @param {string} json
     */
    importSuite(json) {
      let data;
      try { data = JSON.parse(json); } catch (e) {
        this._showStatus('Import failed: invalid JSON', 'error');
        return;
      }

      // Accept a single suite object or a workspace envelope
      let suitesToAdd = [];
      if (Array.isArray(data)) {
        suitesToAdd = data;
      } else if (data && Array.isArray(data.suites)) {
        suitesToAdd = data.suites;
      } else if (data && data.name && Array.isArray(data.testCases)) {
        suitesToAdd = [data];
      } else {
        this._showStatus('Import failed: unrecognised format', 'error');
        return;
      }

      suitesToAdd.forEach(s => {
        const suite = {
          id: uid(),
          name: s.name || 'Imported Suite',
          testCases: (s.testCases || []).map(tc => ({
            id: uid(),
            name: tc.name || 'Untitled Test',
            commands: (tc.commands || []).map(normCmd),
          })),
        };
        this.workspace.suites.push(suite);
      });

      this.saveWorkspace();
      this.renderTree();
      this._showStatus(`Imported ${suitesToAdd.length} suite(s)`, 'success');
    }

    async _loadSettings() {
      const result = await storageGet([STORAGE_KEY_SETTINGS]);
      if (result[STORAGE_KEY_SETTINGS]) {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, result[STORAGE_KEY_SETTINGS]);
      }
      this._applySettingsToUI();
    }

    async _saveSettings() {
      await storageSet({ [STORAGE_KEY_SETTINGS]: this.settings });
    }

    async _loadTestData() {
      const result = await storageGet([STORAGE_KEY_TESTDATA]);
      this.testData = result[STORAGE_KEY_TESTDATA] || [];
    }

    async _saveTestData() {
      await storageSet({ [STORAGE_KEY_TESTDATA]: this.testData });
    }

    async _loadProfiles() {
      const result = await storageGet([STORAGE_KEY_PROFILES]);
      this.profiles = result[STORAGE_KEY_PROFILES] || [];
    }

    async _saveProfiles() {
      await storageSet({ [STORAGE_KEY_PROFILES]: this.profiles });
    }

    async _loadExtensionScripts() {
      const result = await storageGet([STORAGE_KEY_SCRIPTS]);
      this.extensionScripts = result[STORAGE_KEY_SCRIPTS] || [];
    }

    async _saveExtensionScripts() {
      await storageSet({ [STORAGE_KEY_SCRIPTS]: this.extensionScripts });
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 4 – Suite Management
    // ═══════════════════════════════════════════════════════════

    /**
     * Add a new test suite.
     * @param {string} [name]
     * @returns {Object} the new suite
     */
    addSuite(name) {
      const suite = blankSuite(name || `Suite ${this.workspace.suites.length + 1}`);
      this.workspace.suites.push(suite);
      this.saveWorkspace();
      this.renderTree();
      this._selectSuite(suite);
      return suite;
    }

    /**
     * Delete a suite by id.
     * @param {string} suiteId
     */
    deleteSuite(suiteId) {
      const idx = this.workspace.suites.findIndex(s => s.id === suiteId);
      if (idx === -1) return;
      this.workspace.suites.splice(idx, 1);
      if (this.currentSuite && this.currentSuite.id === suiteId) {
        this.currentSuite    = null;
        this.currentTestCase = null;
        this._renderCommandTable();
        this._updateTestCaseTitle();
      }
      this.saveWorkspace();
      this.renderTree();
    }

    /**
     * Rename a suite.
     * @param {string} suiteId
     * @param {string} newName
     */
    renameSuite(suiteId, newName) {
      const suite = this._suiteById(suiteId);
      if (!suite) return;
      suite.name = newName.trim() || suite.name;
      if (this.currentSuite && this.currentSuite.id === suiteId) {
        this.currentSuite.name = suite.name;
      }
      this.saveWorkspace();
      this.renderTree();
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 5 – Test Case Management
    // ═══════════════════════════════════════════════════════════

    /**
     * Add a new test case to a suite.
     * @param {string} suiteId
     * @param {string} [name]
     * @returns {Object} the new test case
     */
    addTestCase(suiteId, name) {
      const suite = this._suiteById(suiteId);
      if (!suite) return null;
      const tc = blankTestCase(name || `Test ${suite.testCases.length + 1}`);
      suite.testCases.push(tc);
      this.saveWorkspace();
      this.renderTree();
      this.openTestCase(suite, tc);
      return tc;
    }

    /**
     * Delete a test case from its suite.
     * @param {string} suiteId
     * @param {string} testCaseId
     */
    deleteTestCase(suiteId, testCaseId) {
      const suite = this._suiteById(suiteId);
      if (!suite) return;
      const idx = suite.testCases.findIndex(tc => tc.id === testCaseId);
      if (idx === -1) return;
      suite.testCases.splice(idx, 1);
      if (this.currentTestCase && this.currentTestCase.id === testCaseId) {
        const next = suite.testCases[idx] || suite.testCases[idx - 1] || null;
        if (next) this.openTestCase(suite, next);
        else {
          this.currentTestCase = null;
          this._renderCommandTable();
          this._updateTestCaseTitle();
        }
      }
      this.saveWorkspace();
      this.renderTree();
    }

    /**
     * Rename a test case.
     */
    renameTestCase(suiteId, testCaseId, newName) {
      const tc = this._testCaseById(suiteId, testCaseId);
      if (!tc) return;
      tc.name = newName.trim() || tc.name;
      if (this.currentTestCase && this.currentTestCase.id === testCaseId) {
        this.currentTestCase.name = tc.name;
        this._updateTestCaseTitle();
      }
      this.saveWorkspace();
      this.renderTree();
    }

    /**
     * Duplicate a test case within a suite.
     */
    duplicateTestCase(suiteId, testCaseId) {
      const suite = this._suiteById(suiteId);
      const tc    = this._testCaseById(suiteId, testCaseId);
      if (!suite || !tc) return;
      const copy = clone(tc);
      copy.id   = uid();
      copy.name = tc.name + ' (copy)';
      const idx = suite.testCases.findIndex(t => t.id === testCaseId);
      suite.testCases.splice(idx + 1, 0, copy);
      this.saveWorkspace();
      this.renderTree();
      this.openTestCase(suite, copy);
    }

    /**
     * Move a test case between suites (or reorder within the same suite).
     */
    moveTestCase(fromSuiteId, toSuiteId, testCaseId, toIndex) {
      const fromSuite = this._suiteById(fromSuiteId);
      const toSuite   = this._suiteById(toSuiteId);
      if (!fromSuite || !toSuite) return;

      const fromIdx = fromSuite.testCases.findIndex(tc => tc.id === testCaseId);
      if (fromIdx === -1) return;
      const [tc] = fromSuite.testCases.splice(fromIdx, 1);

      const insertAt = (toIndex !== undefined)
        ? Math.min(toIndex, toSuite.testCases.length)
        : toSuite.testCases.length;
      toSuite.testCases.splice(insertAt, 0, tc);

      this.saveWorkspace();
      this.renderTree();
    }

    /**
     * Open a test case in the editor.
     */
    openTestCase(suite, testCase) {
      this.currentSuite    = suite;
      this.currentTestCase = testCase;
      this.selectedCommandIndex   = -1;
      this.selectedCommandIndices = [];
      this._rowStates = {};
      this._commitActiveEditor();
      this._renderCommandTable();
      this._updateTestCaseTitle();
      this._updateTreeSelection();
      this._clearDetailPanel();
      this._showStatus(`Opened: ${testCase.name}`);
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 6 – Command Table Editor
    // ═══════════════════════════════════════════════════════════

    /**
     * Full re-render of the command table for the current test case.
     */
    _renderCommandTable() {
      const tbody = this._dom.commandTbody;
      if (!tbody) return;

      if (!this.currentTestCase) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Open or create a test case to begin.</td></tr>';
        return;
      }

      const commands = this.currentTestCase.commands;
      if (!commands.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No commands yet. Click <strong>+ Add</strong> or start recording.</td></tr>';
        return;
      }

      // Build rows using DocumentFragment for performance
      const frag = document.createDocumentFragment();
      commands.forEach((cmd, index) => {
        frag.appendChild(this._buildCommandRow(cmd, index));
      });

      tbody.innerHTML = '';
      tbody.appendChild(frag);

      // Re-apply row states (playback colours etc.)
      Object.entries(this._rowStates).forEach(([idx, state]) => {
        this._applyRowState(parseInt(idx, 10), state);
      });
    }

    /**
     * Build a single TR element for a command row.
     * @private
     */
    _buildCommandRow(cmd, index) {
      const tr = document.createElement('tr');
      tr.dataset.index = index;

      // Apply state classes
      const stateClass = this._rowStates[index];
      if (stateClass) tr.classList.add(ROW_STATE[stateClass]);
      if (cmd.breakpoint) tr.classList.add(ROW_STATE.breakpoint);
      if (this.selectedCommandIndices.includes(index)) tr.classList.add(ROW_STATE.selected);

      tr.innerHTML = `
        <td class="col-num">
          <span class="bp-dot${cmd.breakpoint ? ' active' : ''}" title="Toggle breakpoint"></span>
          <span class="row-num">${index + 1}</span>
        </td>
        <td class="col-cmd" data-field="command" data-index="${index}">
          <span class="cell-text">${esc(cmd.command)}</span>
        </td>
        <td class="col-target" data-field="target" data-index="${index}">
          <span class="cell-text">${esc(cmd.target)}</span>
          ${cmd.target ? `<button class="btn-pick-inline" data-index="${index}" title="Pick element">&#8982;</button>` : ''}
        </td>
        <td class="col-value" data-field="value" data-index="${index}">
          <span class="cell-text">${esc(cmd.value)}</span>
        </td>
      `;

      return tr;
    }

    /**
     * Add a command at the end (or after the currently selected row).
     * @param {string} [command]
     * @param {string} [target]
     * @param {string} [value]
     */
    addCommand(command, target, value) {
      if (!this.currentTestCase) return;
      const insertAt = this.selectedCommandIndex >= 0
        ? this.selectedCommandIndex + 1
        : this.currentTestCase.commands.length;
      this.insertCommand(insertAt, command || '', target || '', value || '');
    }

    /**
     * Insert a command at a specific index.
     */
    insertCommand(index, command, target, value) {
      if (!this.currentTestCase) return;
      this._snapshotUndo();
      const cmd = normCmd({ command, target, value });
      this.currentTestCase.commands.splice(index, 0, cmd);
      this._renderCommandTable();
      this.selectCommand(index);
      this.saveWorkspace();
    }

    /**
     * Delete command(s) at given indices.
     * @param {number|number[]} indices
     */
    deleteCommands(indices) {
      if (!this.currentTestCase) return;
      const idxArray = Array.isArray(indices) ? indices : [indices];
      if (!idxArray.length) return;
      this._snapshotUndo();
      // Remove from highest to lowest to preserve indices
      idxArray.slice().sort((a, b) => b - a).forEach(i => {
        this.currentTestCase.commands.splice(i, 1);
      });
      this.selectedCommandIndex   = -1;
      this.selectedCommandIndices = [];
      this._renderCommandTable();
      this._clearDetailPanel();
      this.saveWorkspace();
    }

    /** Delete the currently selected command(s) */
    deleteCommand(index) {
      const targets = this.selectedCommandIndices.length > 1
        ? this.selectedCommandIndices
        : [index !== undefined ? index : this.selectedCommandIndex];
      this.deleteCommands(targets.filter(i => i >= 0));
    }

    /**
     * Update a single field of a command.
     * @param {number} index
     * @param {'command'|'target'|'value'|'comment'} field
     * @param {string} newValue
     */
    updateCommand(index, field, newValue) {
      if (!this.currentTestCase) return;
      const cmd = this.currentTestCase.commands[index];
      if (!cmd) return;
      this._snapshotUndo();
      cmd[field] = newValue;
      // Patch just the affected cell rather than full re-render
      this._patchCell(index, field, newValue);
      this.saveWorkspace();
    }

    /**
     * Reorder a command via drag-drop.
     * @param {number} fromIndex
     * @param {number} toIndex
     */
    moveCommand(fromIndex, toIndex) {
      if (!this.currentTestCase) return;
      const commands = this.currentTestCase.commands;
      if (fromIndex === toIndex) return;
      if (fromIndex < 0 || fromIndex >= commands.length) return;
      if (toIndex   < 0 || toIndex   >= commands.length) return;
      this._snapshotUndo();
      const [cmd] = commands.splice(fromIndex, 1);
      commands.splice(toIndex, 0, cmd);
      this._renderCommandTable();
      this.selectCommand(toIndex);
      this.saveWorkspace();
    }

    /**
     * Select (highlight) a command row.
     * @param {number} index
     */
    selectCommand(index) {
      this.selectedCommandIndex   = index;
      this.selectedCommandIndices = [index];
      this._highlightSelectedRows();
      this._showCommandInDetail(index);
      this._updateReference(index);
    }

    /**
     * Toggle breakpoint on a command.
     * @param {number} index
     */
    toggleBreakpoint(index) {
      if (!this.currentTestCase) return;
      const cmd = this.currentTestCase.commands[index];
      if (!cmd) return;
      cmd.breakpoint = !cmd.breakpoint;
      const tr   = this._rowByIndex(index);
      const dot  = tr && tr.querySelector('.bp-dot');
      if (dot) dot.classList.toggle('active', cmd.breakpoint);
      if (tr)  tr.classList.toggle(ROW_STATE.breakpoint, cmd.breakpoint);
      this.saveWorkspace();
    }

    /**
     * Copy selected commands to clipboard.
     * @param {number[]} [indices]
     */
    copyCommands(indices) {
      if (!this.currentTestCase) return;
      const idxArray = indices || this.selectedCommandIndices;
      this.clipboard = idxArray
        .filter(i => i >= 0 && i < this.currentTestCase.commands.length)
        .map(i => clone(this.currentTestCase.commands[i]));
      this._showStatus(`Copied ${this.clipboard.length} command(s)`);
    }

    /**
     * Paste commands from clipboard.
     * @param {number} [afterIndex] – insert after this index (-1 = append)
     */
    pasteCommands(afterIndex) {
      if (!this.currentTestCase || !this.clipboard.length) return;
      this._snapshotUndo();
      const insertAt = (afterIndex !== undefined && afterIndex >= 0)
        ? afterIndex + 1
        : (this.selectedCommandIndex >= 0 ? this.selectedCommandIndex + 1 : this.currentTestCase.commands.length);

      const fresh = this.clipboard.map(c => ({ ...clone(c), breakpoint: false }));
      this.currentTestCase.commands.splice(insertAt, 0, ...fresh);
      this._renderCommandTable();
      // Select pasted range
      this.selectedCommandIndices = fresh.map((_, i) => insertAt + i);
      this.selectedCommandIndex   = insertAt;
      this._highlightSelectedRows();
      this.saveWorkspace();
    }

    /**
     * Patch a single table cell text without full re-render.
     * @private
     */
    _patchCell(index, field, value) {
      const tr = this._rowByIndex(index);
      if (!tr) return;
      const td = tr.querySelector(`[data-field="${field}"]`);
      if (!td) return;
      const span = td.querySelector('.cell-text');
      if (span) span.textContent = value;
    }

    /**
     * Apply playback state styling to a row.
     * @param {number} index
     * @param {'running'|'passed'|'failed'|'error'|null} state
     */
    _applyRowState(index, state) {
      const tr = this._rowByIndex(index);
      if (!tr) return;
      // Remove all state classes first
      Object.values(ROW_STATE).forEach(cls => tr.classList.remove(cls));
      if (cmd => cmd.breakpoint) {
        const cmd = this.currentTestCase && this.currentTestCase.commands[index];
        if (cmd && cmd.breakpoint) tr.classList.add(ROW_STATE.breakpoint);
      }
      if (state && ROW_STATE[state]) {
        tr.classList.add(ROW_STATE[state]);
      }
      this._rowStates[index] = state;
    }

    /** Scroll the command table so the given row is visible */
    _scrollToRow(index) {
      const tr = this._rowByIndex(index);
      if (tr) {
        requestAnimationFrame(() =>
          tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        );
      }
    }

    /** Return the TR element for a command index */
    _rowByIndex(index) {
      const tbody = this._dom.commandTbody;
      if (!tbody) return null;
      return tbody.querySelector(`tr[data-index="${index}"]`);
    }

    _highlightSelectedRows() {
      const tbody = this._dom.commandTbody;
      if (!tbody) return;
      tbody.querySelectorAll('tr').forEach(tr => {
        tr.classList.remove(ROW_STATE.selected);
        const i = parseInt(tr.dataset.index, 10);
        if (this.selectedCommandIndices.includes(i)) {
          tr.classList.add(ROW_STATE.selected);
        }
      });
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 7 – Undo / Redo
    // ═══════════════════════════════════════════════════════════

    /** Take a snapshot of the current commands array for undo */
    _snapshotUndo() {
      if (!this.currentTestCase) return;
      this.undoStack.push({
        testCaseId: this.currentTestCase.id,
        commands:   clone(this.currentTestCase.commands),
      });
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
      this._updateUndoRedoButtons();
    }

    undo() {
      if (!this.currentTestCase || !this.undoStack.length) return;
      const snapshot = this.undoStack.pop();
      if (snapshot.testCaseId !== this.currentTestCase.id) {
        this.undoStack.push(snapshot); // wrong test case, put it back
        return;
      }
      this.redoStack.push({
        testCaseId: this.currentTestCase.id,
        commands:   clone(this.currentTestCase.commands),
      });
      this.currentTestCase.commands = snapshot.commands;
      this._renderCommandTable();
      this.saveWorkspace();
      this._updateUndoRedoButtons();
    }

    redo() {
      if (!this.currentTestCase || !this.redoStack.length) return;
      const snapshot = this.redoStack.pop();
      if (snapshot.testCaseId !== this.currentTestCase.id) {
        this.redoStack.push(snapshot);
        return;
      }
      this.undoStack.push({
        testCaseId: this.currentTestCase.id,
        commands:   clone(this.currentTestCase.commands),
      });
      this.currentTestCase.commands = snapshot.commands;
      this._renderCommandTable();
      this.saveWorkspace();
      this._updateUndoRedoButtons();
    }

    _updateUndoRedoButtons() {
      if (this._dom.btnUndo) this._dom.btnUndo.disabled = !this.undoStack.length;
      if (this._dom.btnRedo) this._dom.btnRedo.disabled = !this.redoStack.length;
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 8 – Command Autocomplete
    // ═══════════════════════════════════════════════════════════

    /**
     * Show the autocomplete dropdown for a command cell.
     * @param {string} query – current cell text
     * @param {HTMLElement} cellEl – the TD element being edited
     */
    _showAutocomplete(query, cellEl) {
      const registry = global.CommandRegistry;
      if (!registry) return;

      const all = registry.getCategories
        ? Object.values(registry.getCategories()).flat()
        : (registry._commands ? Object.values(registry._commands) : []);

      const results = all
        .filter(c => fuzzyMatch(query, c.name) || fuzzyMatch(query, c.description || ''))
        .slice(0, 20);

      const dropdown = this._dom.autocompleteDropdown;
      if (!dropdown) return;

      if (!results.length) { this._hideAutocomplete(); return; }

      dropdown.innerHTML = results.map((c, i) => `
        <div class="ac-item${i === this._autocompleteIndex ? ' ac-active' : ''}"
             data-command="${esc(c.name)}"
             data-index="${i}">
          <span class="ac-name">${esc(c.name)}</span>
          <span class="ac-desc">${esc((c.description || '').slice(0, 60))}</span>
        </div>
      `).join('');

      this._autocompleteItems = results;
      this._autocompleteTargetCell = cellEl;
      this._autocompleteVisible = true;
      dropdown.style.display = 'block';

      // Position dropdown below the cell
      const rect = cellEl.getBoundingClientRect();
      dropdown.style.top  = (rect.bottom + window.scrollY) + 'px';
      dropdown.style.left = (rect.left   + window.scrollX) + 'px';
      dropdown.style.width = Math.max(260, rect.width) + 'px';
    }

    _hideAutocomplete() {
      this._autocompleteVisible = false;
      this._autocompleteIndex   = -1;
      this._autocompleteItems   = [];
      const dropdown = this._dom.autocompleteDropdown;
      if (dropdown) dropdown.style.display = 'none';
    }

    _autocompleteNavigate(direction) {
      if (!this._autocompleteVisible) return;
      const max = this._autocompleteItems.length - 1;
      this._autocompleteIndex = Math.max(0, Math.min(max,
        this._autocompleteIndex + direction));
      // Highlight active item
      const dropdown = this._dom.autocompleteDropdown;
      if (!dropdown) return;
      dropdown.querySelectorAll('.ac-item').forEach((el, i) => {
        el.classList.toggle('ac-active', i === this._autocompleteIndex);
        if (i === this._autocompleteIndex) {
          el.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    _autocompleteSelect() {
      if (!this._autocompleteVisible) return;
      const item = this._autocompleteItems[this._autocompleteIndex];
      if (item && this._activeEditor) {
        this._activeEditor.el.textContent = item.name;
        this._activeEditor.value = item.name;
        // Move focus to target cell
        const tr = this._rowByIndex(this._activeEditor.rowIndex);
        if (tr) {
          const targetCell = tr.querySelector('[data-field="target"]');
          if (targetCell) this._startEditing(targetCell);
        }
      }
      this._hideAutocomplete();
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 9 – Target Locator Helper
    // ═══════════════════════════════════════════════════════════

    /**
     * Enter element-picker mode for a target cell.
     * @param {number} commandIndex
     */
    async startTargetPicker(commandIndex) {
      if (this._pickerActive) return;
      this._pickerActive = true;
      this._pickerCommandIndex = commandIndex;
      this._showStatus('Click an element on the page to pick its locator…', 'info');

      // Tell the background to activate picker in the active tab
      const resp = await sendToBackground({ type: 'SF_START_PICKER' });
      if (!resp.ok) {
        this._pickerActive = false;
        this._showStatus('Could not activate element picker', 'error');
      }
    }

    /**
     * Called when the content script sends locator suggestions.
     * @param {Array<string>} locators
     */
    _onLocatorSuggestions(locators) {
      this._pickerActive = false;
      if (!locators || !locators.length) {
        this._showStatus('No locators found for element', 'warn');
        return;
      }
      this._showLocatorDropdown(locators, this._pickerCommandIndex);
    }

    /**
     * Show a dropdown of locator alternatives.
     * @param {string[]} locators
     * @param {number} commandIndex
     */
    _showLocatorDropdown(locators, commandIndex) {
      // Reuse the autocomplete dropdown for locator selection
      const dropdown = this._dom.autocompleteDropdown;
      if (!dropdown) return;

      dropdown.innerHTML = '<div class="ac-header">Select a locator:</div>' +
        locators.map((loc, i) => `
          <div class="ac-item" data-locator="${esc(loc)}" data-cmd-index="${commandIndex}">
            <span class="ac-name">${esc(loc)}</span>
          </div>
        `).join('');

      dropdown.style.display = 'block';
      dropdown.style.top  = '50%';
      dropdown.style.left = '20px';
      dropdown.style.width = '340px';

      // Click handler for locator items
      dropdown.querySelectorAll('[data-locator]').forEach(el => {
        el.addEventListener('click', () => {
          const locator = el.dataset.locator;
          const idx     = parseInt(el.dataset.cmdIndex, 10);
          this.updateCommand(idx, 'target', locator);
          this._hideAutocomplete();
          this._showStatus('Locator applied');
        });
      });
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 10 – Recording Integration
    // ═══════════════════════════════════════════════════════════

    async startRecording() {
      if (!this.currentTestCase) {
        // Prompt to create a test case if none open
        const suiteName = 'Recorded Suite';
        const tcName    = 'Recorded Test';
        let suite = this.workspace.suites.find(s => s.name === suiteName);
        if (!suite) suite = this.addSuite(suiteName);
        this.addTestCase(suite.id, tcName);
      }

      const resp = await sendToBackground({ type: 'SF_START_RECORDING' });
      if (resp && resp.ok === false) {
        this._showStatus('Recording could not start: ' + (resp.error || 'unknown error'), 'error');
        return;
      }
      this.isRecording = true;
      this._updateToolbarState();
      this._showStatus('Recording…', 'recording');
      this._setBadge('REC', '#e53e3e');
    }

    async stopRecording() {
      await sendToBackground({ type: 'SF_STOP_RECORDING' });
      this.isRecording = false;
      this._updateToolbarState();
      this._showStatus('Recording stopped');
      this._clearBadge();
    }

    /** Called when a command arrives from the content script recorder */
    onCommandRecorded(cmd) {
      if (!this.currentTestCase) return;
      const normalized = normCmd(cmd);
      this.currentTestCase.commands.push(normalized);
      this.saveWorkspace();

      // Append row efficiently (full render only if tbody is empty)
      const tbody = this._dom.commandTbody;
      if (!tbody) return;

      const emptyRow = tbody.querySelector('.empty-row');
      if (emptyRow) emptyRow.remove();

      const index = this.currentTestCase.commands.length - 1;
      const tr    = this._buildCommandRow(normalized, index);
      tbody.appendChild(tr);
      this._scrollToRow(index);
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 11 – Playback Integration
    // ═══════════════════════════════════════════════════════════

    /**
     * Get the ID of the active Chrome tab, used for playback dispatch.
     * @private
     * @returns {Promise<number|null>}
     */
    async _getActiveTabId() {
      return new Promise(resolve => {
        try {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            resolve(tabs && tabs[0] ? tabs[0].id : null);
          });
        } catch (e) { resolve(null); }
      });
    }

    /**
     * Create and configure a PlaybackEngine with all event bindings.
     * @private
     */
    _createEngine() {
      const engine = new global.PlaybackEngine({
        speed:   this._speedMs(),
        timeout: this.settings.defaultTimeout,
      });

      // Attach control flow
      if (global.ControlFlowEngine) {
        engine.attachControlFlow(new global.ControlFlowEngine());
      }

      // Inject active profile variables
      this._injectProfileVariables(engine);

      // ── Event bindings ──

      engine.on('commandStart', ({ index }) => {
        // Clear previous running row
        if (this._lastRunningIndex !== undefined) {
          const prev = this._rowStates[this._lastRunningIndex];
          if (prev === 'running') this._applyRowState(this._lastRunningIndex, null);
        }
        this._applyRowState(index, 'running');
        this._lastRunningIndex = index;
        this._scrollToRow(index);
      });

      engine.on('commandComplete', ({ index, status }) => {
        const state = status === 'passed' ? 'passed'
          : status === 'failed' ? 'failed'
          : status === 'error'  ? 'error'
          : null;
        this._applyRowState(index, state);
      });

      engine.on('log', (entry) => {
        this.appendLog(entry);
      });

      engine.on('variableUpdated', ({ name, value }) => {
        this.updateVariables(engine.getAllVariables());
      });

      engine.on('healingSuggestion', (suggestion) => {
        this.addHealingSuggestion({
          ...suggestion,
          testCaseId: this.currentTestCase && this.currentTestCase.id,
        });
      });

      engine.on('paused', ({ index }) => {
        this._applyRowState(index, 'running');
        this._updatePlayPauseButtons(true /* paused */);
        this._showStatus('Paused at step ' + (index + 1));
      });

      engine.on('testCaseComplete', ({ name, passed, failed, errors }) => {
        const ok = failed === 0 && errors === 0;
        if (this.currentTestCase) {
          this._resultBadges[this.currentTestCase.id] = ok ? 'passed' : 'failed';
        }
        this.renderTree();
        this._showStatus(`${name}: ${ok ? 'PASSED' : 'FAILED'} (${passed}p/${failed}f/${errors}e)`);
      });

      engine.on('testSuiteComplete', ({ name, results }) => {
        const ok = results.failed === 0;
        this._showStatus(`Suite "${name}" complete — ${results.passed}/${results.total} passed`);
        this.appendLog({
          level: ok ? 'info' : 'error',
          message: `Suite "${name}" finished: ${results.passed} passed, ${results.failed} failed`,
          timestamp: Date.now(),
        });
      });

      engine.on('stopped', () => {
        this._onPlaybackFinished();
      });

      return engine;
    }

    _speedMs() {
      const presets = { SLOW: 2000, MEDIUM: 1000, FAST: 300, FASTEST: 0 };
      const s = (this._dom.speedSelect && this._dom.speedSelect.value)
        || this.settings.speed;
      return presets[s] !== undefined ? presets[s] : 1000;
    }

    /** Play the current test case */
    async playTestCase() {
      if (!this.currentTestCase || this.isPlaying) return;

      const tabId = await this._getActiveTabId();
      if (!tabId) {
        this._showStatus('No active tab found', 'error');
        return;
      }

      this.isPlaying = true;
      this._rowStates = {};
      this._renderCommandTable();
      this._updateToolbarState();
      this.clearLog();

      this._playbackEngine = this._createEngine();

      // Sync breakpoints
      const bpSet = new Set(
        this.currentTestCase.commands
          .map((c, i) => c.breakpoint ? i : -1)
          .filter(i => i >= 0)
      );
      this._playbackEngine.setBreakpoints(bpSet);

      try {
        await this._playbackEngine.runTestCase(this.currentTestCase, tabId);
      } catch (e) {
        console.error('[SeleniumForge] Playback error:', e);
        this.appendLog({ level: 'error', message: 'Playback error: ' + e.message, timestamp: Date.now() });
      } finally {
        this._onPlaybackFinished();
      }
    }

    /** Play the entire current suite */
    async playTestSuite() {
      if (!this.currentSuite || this.isPlaying) return;

      const tabId = await this._getActiveTabId();
      if (!tabId) { this._showStatus('No active tab', 'error'); return; }

      this.isPlaying = true;
      this._updateToolbarState();
      this.clearLog();
      this._playbackEngine = this._createEngine();

      try {
        await this._playbackEngine.runTestSuite(this.currentSuite, tabId);
      } catch (e) {
        console.error('[SeleniumForge] Suite playback error:', e);
      } finally {
        this._onPlaybackFinished();
      }
    }

    /** Play all suites */
    async playAll() {
      if (this.isPlaying) return;

      const tabId = await this._getActiveTabId();
      if (!tabId) { this._showStatus('No active tab', 'error'); return; }

      this.isPlaying = true;
      this._updateToolbarState();
      this.clearLog();
      this._playbackEngine = this._createEngine();

      try {
        await this._playbackEngine.runAllSuites(this.workspace.suites, tabId);
      } catch (e) {
        console.error('[SeleniumForge] Full run error:', e);
      } finally {
        this._onPlaybackFinished();
      }
    }

    pauseExecution() {
      if (this._playbackEngine) this._playbackEngine.pause();
      this._updatePlayPauseButtons(true);
    }

    resumeExecution() {
      if (this._playbackEngine) this._playbackEngine.resume();
      this._updatePlayPauseButtons(false);
      this._showStatus('Running…');
    }

    stopExecution() {
      if (this._playbackEngine) this._playbackEngine.stop();
      this._onPlaybackFinished();
    }

    /**
     * Execute a single command at a given index immediately.
     * @param {number} index
     */
    async executeSingleCommand(index) {
      if (!this.currentTestCase || this.isPlaying) return;
      const cmd = this.currentTestCase.commands[index];
      if (!cmd) return;

      const tabId = await this._getActiveTabId();
      if (!tabId) return;

      const engine = this._createEngine();
      this._applyRowState(index, 'running');

      try {
        const result = await engine.runSingleCommand(cmd, tabId);
        const state  = result.status === 'passed' ? 'passed'
          : result.status === 'failed' ? 'failed'
          : 'error';
        this._applyRowState(index, state);
        this.appendLog({
          level:   state === 'passed' ? 'info' : 'error',
          message: `[Step ${index + 1}] ${cmd.command}: ${result.message || state}`,
          timestamp: Date.now(),
        });
      } catch (e) {
        this._applyRowState(index, 'error');
      }
    }

    _onPlaybackFinished() {
      this.isPlaying   = false;
      this._playbackEngine = null;
      this._lastRunningIndex = undefined;
      this._updateToolbarState();
      this._showStatus('Ready');
    }

    _updatePlayPauseButtons(paused) {
      if (this._dom.btnPause)  this._dom.btnPause.style.display  = paused ? 'none'  : '';
      if (this._dom.btnPlay)   this._dom.btnPlay.style.display   = '';
      const resumeBtn = document.getElementById('btn-resume');
      if (resumeBtn) resumeBtn.style.display = paused ? '' : 'none';
    }

    _injectProfileVariables(engine) {
      const activeProfile = this.profiles.find(p => p.active);
      if (activeProfile && activeProfile.variables) {
        Object.entries(activeProfile.variables).forEach(([k, v]) => {
          engine.setVariable(k, v);
        });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 12 – Data-Driven Testing UI
    // ═══════════════════════════════════════════════════════════

    /** Show file picker to load CSV or JSON test data */
    loadTestData() {
      const input = document.createElement('input');
      input.type   = 'file';
      input.accept = '.csv,.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const text = ev.target.result;
          const ext  = file.name.split('.').pop().toLowerCase();
          let rows;
          try {
            if (ext === 'json') {
              rows = JSON.parse(text);
              if (!Array.isArray(rows)) rows = [rows];
            } else {
              rows = this._parseCsv(text);
            }
          } catch (err) {
            this._showStatus('Data parse error: ' + err.message, 'error');
            return;
          }
          const entry = { id: uid(), name: file.name, type: ext, rows };
          this.testData.push(entry);
          this._saveTestData();
          this._renderDataTab();
          this._showStatus(`Loaded data: ${file.name} (${rows.length} rows)`);
        };
        reader.readAsText(file);
      };
      input.click();
    }

    /** Remove a test data set by id */
    removeTestData(id) {
      this.testData = this.testData.filter(d => d.id !== id);
      this._saveTestData();
      this._renderDataTab();
    }

    /**
     * Insert loadVars/endLoadVars commands in the current test case for a data set.
     */
    useDataInTestCase(dataId, testCaseId) {
      const data = this.testData.find(d => d.id === dataId);
      if (!data) return;
      const tc = testCaseId
        ? this._findTestCaseAnywhere(testCaseId)
        : this.currentTestCase;
      if (!tc) return;
      this._snapshotUndo();
      tc.commands.unshift(normCmd({ command: 'loadVars', target: data.name, value: '' }));
      tc.commands.push(normCmd({ command: 'endLoadVars', target: data.name, value: '' }));
      if (tc === this.currentTestCase) this._renderCommandTable();
      this.saveWorkspace();
    }

    /** Show a modal preview of a data set */
    previewData(dataId) {
      const data = this.testData.find(d => d.id === dataId);
      if (!data || !data.rows.length) return;

      const headers = data.type === 'json'
        ? Object.keys(data.rows[0] || {})
        : Object.keys(data.rows[0] || {});

      let html = '<table class="data-preview-table"><thead><tr>'
        + headers.map(h => `<th>${esc(h)}</th>`).join('')
        + '</tr></thead><tbody>'
        + data.rows.slice(0, 50).map(row =>
            '<tr>' + headers.map(h => `<td>${esc(row[h] || '')}</td>`).join('') + '</tr>'
          ).join('')
        + '</tbody></table>';

      this._showModal('Data Preview: ' + data.name, html);
    }

    /** Minimal CSV parser → array of objects */
    _parseCsv(text) {
      const lines = text.trim().split('\n');
      if (!lines.length) return [];
      const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
      return lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        const row  = {};
        headers.forEach((h, i) => { row[h] = vals[i] || ''; });
        return row;
      });
    }

    _renderDataTab() {
      const container = this._dom.dataTab;
      if (!container) return;
      if (!this.testData.length) {
        container.innerHTML = '<p class="empty-msg">No test data loaded. Click <strong>+ Add Data</strong> to load a CSV or JSON file.</p>';
        return;
      }
      container.innerHTML = this.testData.map(d => `
        <div class="data-entry" data-id="${d.id}">
          <span class="data-icon">${d.type === 'json' ? '{ }' : 'CSV'}</span>
          <span class="data-name">${esc(d.name)}</span>
          <span class="data-count">${d.rows.length} rows</span>
          <button class="btn-sm" data-action="preview" data-id="${d.id}">Preview</button>
          <button class="btn-sm" data-action="use"     data-id="${d.id}">Use</button>
          <button class="btn-sm btn-danger" data-action="remove" data-id="${d.id}">✕</button>
        </div>
      `).join('');
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 13 – Profiles (Global Variables)
    // ═══════════════════════════════════════════════════════════

    /**
     * Add a new variable profile.
     * @param {string} name
     * @returns {Object} the new profile
     */
    addProfile(name) {
      const profile = {
        id: uid(),
        name: name || 'Profile ' + (this.profiles.length + 1),
        variables: {},
        active: this.profiles.length === 0,
      };
      this.profiles.push(profile);
      this._saveProfiles();
      this._renderProfilesTab();
      return profile;
    }

    deleteProfile(id) {
      this.profiles = this.profiles.filter(p => p.id !== id);
      this._saveProfiles();
      this._renderProfilesTab();
    }

    addVariable(profileId, name, value) {
      const p = this.profiles.find(p => p.id === profileId);
      if (!p) return;
      p.variables[name] = value;
      this._saveProfiles();
      this._renderProfilesTab();
    }

    removeVariable(profileId, name) {
      const p = this.profiles.find(p => p.id === profileId);
      if (!p) return;
      delete p.variables[name];
      this._saveProfiles();
      this._renderProfilesTab();
    }

    setActiveProfile(id) {
      this.profiles.forEach(p => { p.active = p.id === id; });
      this._saveProfiles();
      this._renderProfilesTab();
    }

    _renderProfilesTab() {
      const container = this._dom.profilesTab;
      if (!container) return;
      if (!this.profiles.length) {
        container.innerHTML = '<p class="empty-msg">No profiles. Click <strong>+ Add Profile</strong>.</p>';
        return;
      }
      container.innerHTML = this.profiles.map(p => `
        <div class="profile-entry${p.active ? ' active' : ''}" data-profile-id="${p.id}">
          <div class="profile-header">
            <span class="profile-name">${esc(p.name)}</span>
            <button class="btn-sm" data-action="set-active" data-id="${p.id}">${p.active ? '★ Active' : 'Set Active'}</button>
            <button class="btn-sm" data-action="add-var" data-id="${p.id}">+ Var</button>
            <button class="btn-sm btn-danger" data-action="delete-profile" data-id="${p.id}">✕</button>
          </div>
          <table class="profile-vars-table">
            ${Object.entries(p.variables).map(([k, v]) => `
              <tr>
                <td class="var-name">${esc(k)}</td>
                <td class="var-value">${esc(v)}</td>
                <td><button class="btn-sm btn-danger" data-action="remove-var"
                    data-profile-id="${p.id}" data-var-name="${esc(k)}">✕</button></td>
              </tr>
            `).join('')}
          </table>
        </div>
      `).join('');
    }

    _renderExtensionsTab() {
      const container = this._dom.extensionsTab;
      if (!container) return;
      if (!this.extensionScripts.length) {
        container.innerHTML = '<p class="empty-msg">No extension scripts. Click <strong>+ Add</strong>.</p>';
        return;
      }
      container.innerHTML = this.extensionScripts.map(s => `
        <div class="ext-entry" data-id="${s.id}">
          <span class="ext-name">${esc(s.name)}</span>
          <button class="btn-sm btn-danger" data-action="delete-ext" data-id="${s.id}">✕</button>
        </div>
      `).join('');
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 14 – Export UI
    // ═══════════════════════════════════════════════════════════

    /** Open the export dialog */
    showExportDialog() {
      const dialog = this._dom.exportDialog;
      if (!dialog) return;
      dialog.style.display = 'flex';
      this._populateExportFormats();
      this._updateExportPreview();
    }

    _populateExportFormats() {
      const select = this._dom.exportFormatSelect;
      if (!select || !global.ExportManager) return;
      const formats = global.ExportManager.getFormats
        ? global.ExportManager.getFormats()
        : [
            { id: 'java-testng',   label: 'Java + TestNG' },
            { id: 'java-junit5',   label: 'Java + JUnit 5' },
            { id: 'python-pytest', label: 'Python + pytest' },
            { id: 'csharp-nunit', label: 'C# + NUnit' },
            { id: 'js-mocha',     label: 'JavaScript + Mocha' },
            { id: 'cucumber',     label: 'Cucumber / Gherkin' },
            { id: 'robot',        label: 'Robot Framework' },
            { id: 'selenese',     label: 'Selenese HTML' },
            { id: 'json',         label: 'JSON (reimport)' },
          ];
      select.innerHTML = formats.map(f =>
        `<option value="${f.id}">${esc(f.label)}</option>`
      ).join('');
    }

    /** Update the code preview panel */
    _updateExportPreview() {
      const preview  = this._dom.exportPreview;
      const format   = this._dom.exportFormatSelect && this._dom.exportFormatSelect.value;
      const scope    = this._dom.exportScopeSelect  && this._dom.exportScopeSelect.value;
      if (!preview || !format || !global.ExportManager) return;

      try {
        let result;
        if (scope === 'testcase' && this.currentTestCase) {
          result = global.ExportManager.export(this.currentTestCase, format);
        } else if (scope === 'suite' && this.currentSuite) {
          result = global.ExportManager.exportSuite(this.currentSuite, format);
        } else {
          result = global.ExportManager.exportProject(this.workspace.suites, format);
        }

        if (typeof result === 'string') {
          preview.textContent = result;
        } else if (result && result.files) {
          // Multi-file: show all files concatenated with separators
          preview.textContent = result.files
            .map(f => `// ── ${f.path} ──\n${f.content}`)
            .join('\n\n');
        }
      } catch (e) {
        preview.textContent = '// Export error: ' + e.message;
      }
    }

    /**
     * Execute the export — generate code and trigger download(s).
     */
    executeExport() {
      const format = this._dom.exportFormatSelect && this._dom.exportFormatSelect.value;
      const scope  = this._dom.exportScopeSelect  && this._dom.exportScopeSelect.value;
      if (!format || !global.ExportManager) return;

      let result;
      let baseName;

      try {
        if (scope === 'testcase' && this.currentTestCase) {
          result   = global.ExportManager.exportAsFiles(this.currentTestCase, format);
          baseName = this.currentTestCase.name;
        } else if (scope === 'suite' && this.currentSuite) {
          result   = global.ExportManager.exportSuite(this.currentSuite, format);
          baseName = this.currentSuite.name;
          if (typeof result === 'string') {
            result = { files: [{ path: baseName + '.' + this._extForFormat(format), content: result }] };
          }
        } else {
          result   = global.ExportManager.exportProject(this.workspace.suites, format);
          baseName = 'seleniumforge-project';
        }
      } catch (e) {
        this._showStatus('Export error: ' + e.message, 'error');
        return;
      }

      if (!result || !result.files) {
        this._showStatus('Export produced no files', 'error');
        return;
      }

      if (result.files.length === 1) {
        this._downloadText(result.files[0].content, result.files[0].path, 'text/plain');
      } else {
        // Multiple files: download each
        result.files.forEach(file => {
          this._downloadText(file.content, file.path, 'text/plain');
        });
      }

      this._showStatus(`Exported ${result.files.length} file(s)`);
      this._closeExportDialog();
    }

    _extForFormat(format) {
      const map = {
        'java-testng':   'java',
        'java-junit5':   'java',
        'python-pytest': 'py',
        'csharp-nunit':  'cs',
        'js-mocha':      'js',
        'cucumber':      'feature',
        'robot':         'robot',
        'selenese':      'html',
        'json':          'json',
      };
      return map[format] || 'txt';
    }

    _closeExportDialog() {
      if (this._dom.exportDialog) this._dom.exportDialog.style.display = 'none';
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 15 – Artifacts Panel
    // ═══════════════════════════════════════════════════════════

    /**
     * Append a log entry to the log tab.
     * @param {{level:string, message:string, timestamp?:number}} entry
     */
    appendLog(entry) {
      const container = this._dom.logContainer;
      if (!container) return;

      const level = (entry.level || 'info').toLowerCase();
      const ts    = entry.timestamp ? fmtTime(entry.timestamp) : '';
      const div   = document.createElement('div');
      div.className = `log-entry log-${level}`;
      div.innerHTML = `<span class="log-ts">${esc(ts)}</span><span class="log-msg">${esc(entry.message)}</span>`;
      container.appendChild(div);

      // Auto-scroll
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }

    clearLog() {
      if (this._dom.logContainer) this._dom.logContainer.innerHTML = '';
    }

    /** Filter log entries by level (show/hide) */
    filterLog(level) {
      const container = this._dom.logContainer;
      if (!container) return;
      container.querySelectorAll('.log-entry').forEach(el => {
        if (!level || el.classList.contains('log-' + level)) {
          el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      });
    }

    /**
     * Show command reference documentation in the reference pane.
     * @param {number} commandIndex
     */
    _updateReference(commandIndex) {
      const pane = this._dom.referencePane;
      if (!pane || !this.currentTestCase) return;
      const cmd = this.currentTestCase.commands[commandIndex];
      if (!cmd || !cmd.command) { pane.innerHTML = ''; return; }

      const registry = global.CommandRegistry;
      const def = registry && registry.getCommand ? registry.getCommand(cmd.command) : null;
      if (!def) { pane.innerHTML = `<em>No documentation for "${esc(cmd.command)}"</em>`; return; }

      const targetInfo = def.target
        ? `<dt>Target</dt><dd><code>${esc(def.target.type)}</code>${def.target.required ? ' (required)' : ' (optional)'} — ${esc(def.target.description)}</dd>`
        : '';
      const valueInfo = def.value && def.value.type !== 'string'
        ? `<dt>Value</dt><dd><code>${esc(def.value.type)}</code>${def.value.required ? ' (required)' : ' (optional)'} — ${esc(def.value.description)}</dd>`
        : '';
      const deprecated = def.deprecated
        ? `<p class="ref-deprecated">⚠ Deprecated${def.deprecatedBy ? ` — use ${esc(def.deprecatedBy)} instead` : ''}</p>`
        : '';

      pane.innerHTML = `
        <h3 class="ref-cmd">${esc(def.name)}</h3>
        ${deprecated}
        <p class="ref-desc">${esc(def.description)}</p>
        <dl class="ref-params">
          ${targetInfo}
          ${valueInfo}
        </dl>
        <span class="ref-category">${esc(def.category)}</span>
      `;
    }

    /**
     * Update the variables table in the Variables tab.
     * @param {Object} vars – key/value pairs
     */
    updateVariables(vars) {
      const container = this._dom.variablesContainer;
      if (!container) return;

      // Filter out KEY_* built-ins for cleaner display
      const userVars = Object.entries(vars).filter(([k]) => !k.startsWith('KEY_'));
      if (!userVars.length) {
        container.innerHTML = '<p class="empty-msg">No variables set.</p>';
        return;
      }

      container.innerHTML = '<table class="vars-table"><tbody>'
        + userVars.map(([k, v]) =>
            `<tr><td class="var-name">${esc(k)}</td><td class="var-val">${esc(String(v))}</td></tr>`
          ).join('')
        + '</tbody></table>';
    }

    /**
     * Add a screenshot to the Screenshots tab.
     * @param {string} dataUrl – base64 data URL
     * @param {string} [label]
     */
    addScreenshot(dataUrl, label) {
      const container = this._dom.screenshotsContainer;
      if (!container) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'screenshot-entry';
      wrapper.innerHTML = `
        <div class="screenshot-label">${esc(label || fmtTime(Date.now()))}</div>
        <img class="screenshot-img" src="${dataUrl}" alt="screenshot" />
      `;
      container.appendChild(wrapper);
    }

    /**
     * Add a self-healing suggestion to the Healing tab.
     * @param {{index:number, original:string, suggested:string, testCaseId:string}} suggestion
     */
    addHealingSuggestion(suggestion) {
      this._healingSuggestions.push(suggestion);
      this._renderHealingTab();
    }

    /** Apply an approved healing fix to the test case */
    approveHealing(index) {
      const s = this._healingSuggestions[index];
      if (!s) return;
      const tc = this._findTestCaseAnywhere(s.testCaseId) || this.currentTestCase;
      if (!tc) return;
      const cmd = tc.commands[s.index];
      if (cmd) {
        cmd.target = s.suggested;
        if (tc === this.currentTestCase) {
          this._patchCell(s.index, 'target', s.suggested);
        }
        this.saveWorkspace();
        this._showStatus('Healing applied to step ' + (s.index + 1));
      }
      this._healingSuggestions.splice(index, 1);
      this._renderHealingTab();
    }

    rejectHealing(index) {
      this._healingSuggestions.splice(index, 1);
      this._renderHealingTab();
    }

    _renderHealingTab() {
      const container = this._dom.healingContainer;
      if (!container) return;
      if (!this._healingSuggestions.length) {
        container.innerHTML = '<p class="empty-msg">No healing suggestions.</p>';
        return;
      }
      container.innerHTML = this._healingSuggestions.map((s, i) => `
        <div class="healing-entry">
          <div class="healing-step">Step ${s.index + 1}</div>
          <div class="healing-original"><strong>Original:</strong> ${esc(s.original)}</div>
          <div class="healing-suggested"><strong>Suggested:</strong> ${esc(s.suggested)}</div>
          <button class="btn-sm btn-success" data-action="approve-heal" data-index="${i}">Apply</button>
          <button class="btn-sm btn-danger"  data-action="reject-heal"  data-index="${i}">Dismiss</button>
        </div>
      `).join('');
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 16 – Tree View
    // ═══════════════════════════════════════════════════════════

    /**
     * Full re-render of the suite/test-case tree.
     */
    renderTree() {
      const container = this._dom.treeContainer;
      if (!container) return;

      if (this._activeTreeTab === 'suites') {
        this._renderSuiteTree(container);
      } else if (this._activeTreeTab === 'data') {
        this._renderDataTab();
      } else if (this._activeTreeTab === 'profiles') {
        this._renderProfilesTab();
      } else if (this._activeTreeTab === 'extensions') {
        this._renderExtensionsTab();
      }
    }

    _renderSuiteTree(container) {
      if (!this.workspace.suites.length) {
        container.innerHTML = '<p class="empty-msg">No suites yet. Click <strong>+ Suite</strong>.</p>';
        return;
      }

      const frag = document.createDocumentFragment();

      this.workspace.suites.forEach(suite => {
        const suiteEl = document.createElement('div');
        suiteEl.className = 'tree-suite';
        suiteEl.dataset.suiteId = suite.id;

        const expanded = this._treeExpanded[suite.id] !== false; // default expanded
        const arrow    = expanded ? '▾' : '▸';
        const badge    = suite.testCases.length ? `<span class="tree-count">${suite.testCases.length}</span>` : '';

        suiteEl.innerHTML = `
          <div class="tree-suite-row${this.currentSuite && this.currentSuite.id === suite.id ? ' active' : ''}">
            <span class="tree-arrow">${arrow}</span>
            <span class="tree-suite-name">${esc(suite.name)}</span>
            ${badge}
            <span class="tree-actions">
              <button class="tree-btn" data-action="add-tc"     data-suite-id="${suite.id}" title="Add test case">+</button>
              <button class="tree-btn" data-action="rename-suite" data-suite-id="${suite.id}" title="Rename">✎</button>
              <button class="tree-btn tree-btn-danger" data-action="delete-suite" data-suite-id="${suite.id}" title="Delete">✕</button>
            </span>
          </div>
        `;

        if (expanded) {
          const tcList = document.createElement('div');
          tcList.className = 'tree-tc-list';

          suite.testCases.forEach(tc => {
            const badge = this._resultBadges[tc.id];
            const tcEl  = document.createElement('div');
            tcEl.className = 'tree-tc-row' +
              (this.currentTestCase && this.currentTestCase.id === tc.id ? ' active' : '') +
              (badge ? ` result-${badge}` : '');
            tcEl.dataset.tcId    = tc.id;
            tcEl.dataset.suiteId = suite.id;

            tcEl.innerHTML = `
              <span class="tree-tc-icon">▷</span>
              <span class="tree-tc-name">${esc(tc.name)}</span>
              ${badge ? `<span class="result-dot result-dot-${badge}"></span>` : ''}
              <span class="tree-tc-actions">
                <button class="tree-btn" data-action="rename-tc"
                        data-suite-id="${suite.id}" data-tc-id="${tc.id}" title="Rename">✎</button>
                <button class="tree-btn" data-action="duplicate-tc"
                        data-suite-id="${suite.id}" data-tc-id="${tc.id}" title="Duplicate">⎘</button>
                <button class="tree-btn tree-btn-danger" data-action="delete-tc"
                        data-suite-id="${suite.id}" data-tc-id="${tc.id}" title="Delete">✕</button>
              </span>
            `;
            tcList.appendChild(tcEl);
          });

          suiteEl.appendChild(tcList);
        }

        frag.appendChild(suiteEl);
      });

      container.innerHTML = '';
      container.appendChild(frag);
    }

    _updateTreeSelection() {
      const container = this._dom.treeContainer;
      if (!container) return;

      container.querySelectorAll('.tree-suite-row').forEach(el => {
        const sid = el.closest('.tree-suite') && el.closest('.tree-suite').dataset.suiteId;
        el.classList.toggle('active', !!(this.currentSuite && this.currentSuite.id === sid));
      });

      container.querySelectorAll('.tree-tc-row').forEach(el => {
        el.classList.toggle('active', !!(this.currentTestCase && this.currentTestCase.id === el.dataset.tcId));
      });
    }

    _selectSuite(suite) {
      this.currentSuite = suite;
      this._updateTreeSelection();
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 17 – Settings
    // ═══════════════════════════════════════════════════════════

    showSettingsDialog() {
      const dialog = this._dom.settingsDialog;
      if (!dialog) return;
      this._applySettingsToUI();
      dialog.style.display = 'flex';
    }

    _applySettingsToUI() {
      const d = this._dom;
      if (d.settingTimeout)    d.settingTimeout.value    = this.settings.defaultTimeout;
      if (d.settingSpeed)      d.settingSpeed.value      = this.settings.speed;
      if (d.settingSelfHeal)   d.settingSelfHeal.checked = this.settings.selfHealing;
      if (d.settingScreenshot) d.settingScreenshot.checked = this.settings.screenshotOnFailure;
      if (d.settingTheme)      d.settingTheme.value      = this.settings.theme;
    }

    _readSettingsFromUI() {
      const d = this._dom;
      if (d.settingTimeout)    this.settings.defaultTimeout      = parseInt(d.settingTimeout.value, 10) || 30000;
      if (d.settingSpeed)      this.settings.speed               = d.settingSpeed.value;
      if (d.settingSelfHeal)   this.settings.selfHealing         = d.settingSelfHeal.checked;
      if (d.settingScreenshot) this.settings.screenshotOnFailure = d.settingScreenshot.checked;
      if (d.settingTheme)      this.settings.theme               = d.settingTheme.value;
    }

    saveSettings() {
      this._readSettingsFromUI();
      this._saveSettings();
      this._applyTheme(this.settings.theme);
      if (this._dom.settingsDialog) this._dom.settingsDialog.style.display = 'none';
      this._showStatus('Settings saved');
    }

    _applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme || 'light');
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 18 – Keyboard Shortcuts
    // ═══════════════════════════════════════════════════════════

    _bindGlobalKeyboard() {
      document.addEventListener('keydown', (e) => {
        // Ignore shortcuts when user is typing in an input/textarea
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
            e.target.isContentEditable) {
          // Only handle Escape
          if (e.key === 'Escape') {
            this._commitActiveEditor(true /* cancel */);
            this._hideAutocomplete();
          }
          return;
        }

        const ctrl = e.ctrlKey || e.metaKey;

        if (ctrl && e.key === 'z') { e.preventDefault(); this.undo(); return; }
        if (ctrl && e.key === 'y') { e.preventDefault(); this.redo(); return; }
        if (ctrl && e.key === 'c') { e.preventDefault(); this.copyCommands(); return; }
        if (ctrl && e.key === 'v') { e.preventDefault(); this.pasteCommands(); return; }
        if (ctrl && e.key === 'a') { e.preventDefault(); this._selectAllCommands(); return; }

        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          this.deleteCommand();
          return;
        }

        if (e.key === 'F5')  { e.preventDefault(); this.playTestCase(); return; }
        if (e.key === 'F6')  { e.preventDefault(); this.playTestSuite(); return; }
        if (e.key === 'F8')  { e.preventDefault(); this.stopExecution(); return; }
        if (e.key === 'F9')  { e.preventDefault(); this.pauseExecution(); return; }

        // Arrow keys for row navigation
        if (e.key === 'ArrowDown')  { e.preventDefault(); this._moveRowSelection(1);  return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); this._moveRowSelection(-1); return; }

        // Autocomplete navigation
        if (this._autocompleteVisible) {
          if (e.key === 'ArrowDown')  { e.preventDefault(); this._autocompleteNavigate(1);  return; }
          if (e.key === 'ArrowUp')    { e.preventDefault(); this._autocompleteNavigate(-1); return; }
          if (e.key === 'Enter')      { e.preventDefault(); this._autocompleteSelect();     return; }
          if (e.key === 'Escape')     { this._hideAutocomplete(); return; }
        }
      });
    }

    _moveRowSelection(delta) {
      if (!this.currentTestCase) return;
      const max   = this.currentTestCase.commands.length - 1;
      const newIdx = Math.max(0, Math.min(max, this.selectedCommandIndex + delta));
      this.selectCommand(newIdx);
      this._scrollToRow(newIdx);
    }

    _selectAllCommands() {
      if (!this.currentTestCase) return;
      this.selectedCommandIndices = this.currentTestCase.commands.map((_, i) => i);
      this.selectedCommandIndex   = this.selectedCommandIndices[0] || 0;
      this._highlightSelectedRows();
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 19 – Chrome Runtime Message Handling
    // ═══════════════════════════════════════════════════════════

    _bindRuntimeMessages() {
      try {
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
          this._handleRuntimeMessage(msg, sender, sendResponse);
          return true; // keep channel open for async responses
        });
      } catch (e) {
        console.warn('[SeleniumForge] Could not bind runtime messages:', e);
      }
    }

    _handleRuntimeMessage(msg, sender, sendResponse) {
      switch (msg.type) {
        case 'SF_COMMAND_RECORDED':
          this.onCommandRecorded(msg.command);
          sendResponse({ ok: true });
          break;

        case 'SF_LOCATOR_SUGGESTIONS':
          this._onLocatorSuggestions(msg.locators);
          sendResponse({ ok: true });
          break;

        case 'SF_SCREENSHOT':
          this.addScreenshot(msg.dataUrl, msg.label);
          sendResponse({ ok: true });
          break;

        case 'SF_HEALING_SUGGESTION':
          this.addHealingSuggestion(msg.suggestion);
          sendResponse({ ok: true });
          break;

        case 'SF_LOG':
          this.appendLog(msg.entry);
          sendResponse({ ok: true });
          break;

        case 'SF_PLAYBACK_STATE':
          if (msg.state === 'paused')  this._updatePlayPauseButtons(true);
          if (msg.state === 'resumed') this._updatePlayPauseButtons(false);
          if (msg.state === 'stopped') this._onPlaybackFinished();
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: 'Unknown message type: ' + msg.type });
      }
    }

    _bindStorageChange() {
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          if (changes[STORAGE_KEY_WORKSPACE]) {
            // Reload workspace if changed externally (e.g., by another panel)
            const newVal = changes[STORAGE_KEY_WORKSPACE].newValue;
            if (newVal && JSON.stringify(newVal) !== JSON.stringify(this.workspace)) {
              this.workspace = newVal;
              this.renderTree();
            }
          }
        });
      } catch (e) {
        console.warn('[SeleniumForge] Could not bind storage change listener:', e);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 20 – Event Binding Helpers
    // ═══════════════════════════════════════════════════════════

    _bindToolbar() {
      const d = this._dom;

      d.btnRecord    && d.btnRecord.addEventListener('click',    () => this.isRecording ? this.stopRecording()  : this.startRecording());
      d.btnPlay      && d.btnPlay.addEventListener('click',      () => this.playTestCase());
      d.btnPlaySuite && d.btnPlaySuite.addEventListener('click', () => this.playTestSuite());
      d.btnPlayAll   && d.btnPlayAll.addEventListener('click',   () => this.playAll());
      d.btnPause     && d.btnPause.addEventListener('click',     () => this.pauseExecution());
      d.btnStop      && d.btnStop.addEventListener('click',      () => this.stopExecution());
      d.btnAddCmd    && d.btnAddCmd.addEventListener('click',    () => this.addCommand());
      d.btnDeleteCmd && d.btnDeleteCmd.addEventListener('click', () => this.deleteCommand());
      d.btnUndo      && d.btnUndo.addEventListener('click',      () => this.undo());
      d.btnRedo      && d.btnRedo.addEventListener('click',      () => this.redo());
      d.btnSettings  && d.btnSettings.addEventListener('click',  () => this.showSettingsDialog());
      d.btnExport    && d.btnExport.addEventListener('click',    () => this.showExportDialog());

      // Step button (run current command)
      const btnStep = document.getElementById('btn-step');
      if (btnStep) btnStep.addEventListener('click', () => {
        if (this.selectedCommandIndex >= 0) {
          this.executeSingleCommand(this.selectedCommandIndex);
        }
      });

      // Resume button (shown when paused)
      const btnResume = document.getElementById('btn-resume');
      if (btnResume) btnResume.addEventListener('click', () => this.resumeExecution());

      // Suite buttons
      d.btnAddSuite    && d.btnAddSuite.addEventListener('click',    () => {
        const name = prompt('Suite name:');
        if (name) this.addSuite(name);
      });
      d.btnDeleteSuite && d.btnDeleteSuite.addEventListener('click', () => {
        if (this.currentSuite) {
          if (confirm(`Delete suite "${this.currentSuite.name}"?`)) {
            this.deleteSuite(this.currentSuite.id);
          }
        }
      });

      // Speed select
      d.speedSelect && d.speedSelect.addEventListener('change', () => {
        if (this._playbackEngine) {
          this._playbackEngine.setSpeed(this._speedMs());
        }
      });

      // Data / profiles / extensions "add" buttons
      d.btnAddData      && d.btnAddData.addEventListener('click',      () => this.loadTestData());
      d.btnAddProfile   && d.btnAddProfile.addEventListener('click',   () => {
        const name = prompt('Profile name:');
        if (name) this.addProfile(name);
      });
      d.btnAddExtension && d.btnAddExtension.addEventListener('click', () => {
        const name = prompt('Extension script name:');
        if (name) {
          const script = { id: uid(), name, code: '' };
          this.extensionScripts.push(script);
          this._saveExtensionScripts();
          this._renderExtensionsTab();
        }
      });
    }

    _bindTreeTabs() {
      const tabs = this._dom.treeTabs;
      if (!tabs) return;

      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        this._activeTreeTab = btn.dataset.tab;
        tabs.querySelectorAll('[data-tab]').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        this.renderTree();
      });

      // Delegate tree item clicks
      const container = this._dom.treeContainer;
      if (!container) return;

      container.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (btn) {
          this._handleTreeAction(btn.dataset.action, btn.dataset);
          return;
        }

        // Click on a suite row — toggle expand
        const suiteRow = e.target.closest('.tree-suite-row');
        if (suiteRow) {
          const sid = suiteRow.closest('.tree-suite').dataset.suiteId;
          this._treeExpanded[sid] = !this._treeExpanded[sid];
          this.renderTree();
          return;
        }

        // Click on a test case row — open it
        const tcRow = e.target.closest('.tree-tc-row');
        if (tcRow) {
          const suite = this._suiteById(tcRow.dataset.suiteId);
          const tc    = suite && suite.testCases.find(t => t.id === tcRow.dataset.tcId);
          if (suite && tc) this.openTestCase(suite, tc);
        }
      });
    }

    _handleTreeAction(action, data) {
      switch (action) {
        case 'add-tc': {
          const name = prompt('Test case name:');
          if (name) this.addTestCase(data.suiteId, name);
          break;
        }
        case 'rename-suite': {
          const suite = this._suiteById(data.suiteId);
          if (!suite) break;
          const name = prompt('New suite name:', suite.name);
          if (name) this.renameSuite(data.suiteId, name);
          break;
        }
        case 'delete-suite': {
          const suite = this._suiteById(data.suiteId);
          if (!suite) break;
          if (confirm(`Delete suite "${suite.name}"?`)) {
            this.deleteSuite(data.suiteId);
          }
          break;
        }
        case 'rename-tc': {
          const tc = this._testCaseById(data.suiteId, data.tcId);
          if (!tc) break;
          const name = prompt('New test case name:', tc.name);
          if (name) this.renameTestCase(data.suiteId, data.tcId, name);
          break;
        }
        case 'duplicate-tc':
          this.duplicateTestCase(data.suiteId, data.tcId);
          break;

        case 'delete-tc': {
          const tc = this._testCaseById(data.suiteId, data.tcId);
          if (!tc) break;
          if (confirm(`Delete test case "${tc.name}"?`)) {
            this.deleteTestCase(data.suiteId, data.tcId);
          }
          break;
        }
        // Data tab actions
        case 'preview':      this.previewData(data.id);        break;
        case 'use':          this.useDataInTestCase(data.id);  break;
        case 'remove':       this.removeTestData(data.id);     break;
        // Profile tab actions
        case 'set-active':     this.setActiveProfile(data.id); break;
        case 'add-var': {
          const varName  = prompt('Variable name:');
          const varValue = varName ? prompt('Value:') : null;
          if (varName && varValue !== null) this.addVariable(data.id, varName, varValue);
          break;
        }
        case 'delete-profile': this.deleteProfile(data.id);   break;
        case 'remove-var':     this.removeVariable(data.profileId, data.varName); break;
        // Extensions
        case 'delete-ext': {
          this.extensionScripts = this.extensionScripts.filter(s => s.id !== data.id);
          this._saveExtensionScripts();
          this._renderExtensionsTab();
          break;
        }
      }
    }

    _bindCommandTable() {
      const tbody = this._dom.commandTbody;
      if (!tbody) return;

      // ── Click: select row, toggle breakpoint, inline pick ──
      tbody.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-index]');
        if (!tr) return;
        const index = parseInt(tr.dataset.index, 10);

        // Breakpoint dot
        if (e.target.classList.contains('bp-dot')) {
          this.toggleBreakpoint(index);
          return;
        }

        // Inline pick button
        if (e.target.classList.contains('btn-pick-inline')) {
          this.startTargetPicker(index);
          return;
        }

        // Multi-select with Shift/Ctrl
        if (e.shiftKey && this.selectedCommandIndex >= 0) {
          const min = Math.min(this.selectedCommandIndex, index);
          const max = Math.max(this.selectedCommandIndex, index);
          this.selectedCommandIndices = Array.from(
            { length: max - min + 1 }, (_, i) => min + i
          );
          this._highlightSelectedRows();
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          if (this.selectedCommandIndices.includes(index)) {
            this.selectedCommandIndices = this.selectedCommandIndices.filter(i => i !== index);
          } else {
            this.selectedCommandIndices.push(index);
          }
          this._highlightSelectedRows();
          return;
        }

        this.selectCommand(index);
      });

      // ── Double-click: start inline edit ──
      tbody.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td[data-field]');
        if (!td) return;
        this._startEditing(td);
      });

      // ── Drag & drop for reordering ──
      tbody.addEventListener('dragstart', (e) => {
        const tr = e.target.closest('tr[data-index]');
        if (!tr) return;
        this._dragFromIndex = parseInt(tr.dataset.index, 10);
        e.dataTransfer.effectAllowed = 'move';
        tr.classList.add('dragging');
      });

      tbody.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const tr = e.target.closest('tr[data-index]');
        tbody.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        if (tr) tr.classList.add('drag-over');
      });

      tbody.addEventListener('drop', (e) => {
        e.preventDefault();
        const tr = e.target.closest('tr[data-index]');
        tbody.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        tbody.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
        if (!tr || this._dragFromIndex === undefined) return;
        const toIndex = parseInt(tr.dataset.index, 10);
        if (toIndex !== this._dragFromIndex) {
          this.moveCommand(this._dragFromIndex, toIndex);
        }
        this._dragFromIndex = undefined;
      });

      tbody.addEventListener('dragend', () => {
        tbody.querySelectorAll('.dragging, .drag-over').forEach(el => {
          el.classList.remove('dragging', 'drag-over');
        });
      });

      // ── Autocomplete dropdown clicks ──
      const dropdown = this._dom.autocompleteDropdown;
      if (dropdown) {
        dropdown.addEventListener('mousedown', (e) => {
          e.preventDefault(); // prevent blur before click
          const item = e.target.closest('[data-command]');
          if (item) {
            this._autocompleteIndex = parseInt(item.dataset.index, 10);
            this._autocompleteSelect();
          }
        });
      }
    }

    // ── Inline cell editing ──────────────────────────────────────

    _startEditing(td) {
      this._commitActiveEditor();
      const rowIndex = parseInt(td.dataset.index, 10);
      const field    = td.dataset.field;
      const cmd      = this.currentTestCase && this.currentTestCase.commands[rowIndex];
      if (!cmd) return;

      const span = td.querySelector('.cell-text');
      if (!span) return;

      // Make span editable
      span.contentEditable = 'true';
      span.focus();

      // Move cursor to end
      const range = document.createRange();
      range.selectNodeContents(span);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      this._activeEditor = { rowIndex, field, el: span, originalValue: cmd[field] };

      // Show autocomplete for command field
      if (field === 'command') {
        this._showAutocomplete(span.textContent, td);
      }

      // Key handlers on the span
      span.addEventListener('keydown', this._onEditorKeydown.bind(this), { once: false });
      span.addEventListener('input',   () => {
        if (field === 'command') {
          this._showAutocomplete(span.textContent, td);
        }
      });
      span.addEventListener('blur',    () => {
        // Small delay to allow autocomplete click to fire first
        setTimeout(() => this._commitActiveEditor(), 80);
      }, { once: true });
    }

    _onEditorKeydown(e) {
      if (this._autocompleteVisible) {
        if (e.key === 'ArrowDown')  { e.preventDefault(); this._autocompleteNavigate(1);  return; }
        if (e.key === 'ArrowUp')    { e.preventDefault(); this._autocompleteNavigate(-1); return; }
        if (e.key === 'Enter')      { e.preventDefault(); this._autocompleteSelect();     return; }
        if (e.key === 'Escape')     { this._hideAutocomplete(); return; }
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        this._commitActiveEditor();
        this._advanceEditorToNext();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this._commitActiveEditor();
        this._advanceEditorToNextField();
      }
      if (e.key === 'Escape') {
        this._commitActiveEditor(true);
      }
    }

    _commitActiveEditor(cancel = false) {
      const ed = this._activeEditor;
      if (!ed) return;
      this._activeEditor = null;
      this._hideAutocomplete();

      ed.el.contentEditable = 'false';

      if (!cancel) {
        const newValue = ed.el.textContent.trim();
        if (newValue !== ed.originalValue) {
          this.updateCommand(ed.rowIndex, ed.field, newValue);
        }
      } else {
        ed.el.textContent = ed.originalValue;
      }
    }

    _advanceEditorToNext() {
      const ed = this._activeEditor;
      if (!ed || !this.currentTestCase) return;
      const nextIdx = ed.rowIndex + 1;
      if (nextIdx < this.currentTestCase.commands.length) {
        const tr = this._rowByIndex(nextIdx);
        if (tr) {
          const td = tr.querySelector(`[data-field="${ed.field}"]`);
          if (td) this._startEditing(td);
        }
      }
    }

    _advanceEditorToNextField() {
      const ed = this._activeEditor;
      if (!ed) return;
      const fields = ['command', 'target', 'value'];
      const curIdx = fields.indexOf(ed.field);
      const nextField = fields[curIdx + 1] || fields[0];
      const tr = this._rowByIndex(ed.rowIndex);
      if (tr) {
        const td = tr.querySelector(`[data-field="${nextField}"]`);
        if (td) this._startEditing(td);
      }
    }

    _bindArtifactTabs() {
      const tabs = this._dom.artifactTabs;
      if (!tabs) return;
      tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tab]');
        if (!btn) return;
        const tabId = btn.dataset.tab;
        tabs.querySelectorAll('[data-tab]').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        // Show/hide panels
        ['apanel-log', 'apanel-variables', 'apanel-screenshots', 'apanel-healing', 'apanel-reference']
          .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = el.id === tabId ? '' : 'none';
          });
      });

      // Healing tab delegate buttons
      const healingContainer = this._dom.healingContainer;
      if (healingContainer) {
        healingContainer.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-action]');
          if (!btn) return;
          const index = parseInt(btn.dataset.index, 10);
          if (btn.dataset.action === 'approve-heal') this.approveHealing(index);
          if (btn.dataset.action === 'reject-heal')  this.rejectHealing(index);
        });
      }
    }

    _bindExportDialog() {
      const d = this._dom;
      d.btnExportConfirm && d.btnExportConfirm.addEventListener('click', () => this.executeExport());
      d.btnExportClose   && d.btnExportClose.addEventListener('click',   () => this._closeExportDialog());
      d.exportFormatSelect && d.exportFormatSelect.addEventListener('change', () => this._updateExportPreview());
      d.exportScopeSelect  && d.exportScopeSelect.addEventListener('change',  () => this._updateExportPreview());
    }

    _bindSettingsDialog() {
      const d = this._dom;
      d.btnSettingsSave  && d.btnSettingsSave.addEventListener('click',  () => this.saveSettings());
      d.btnSettingsClose && d.btnSettingsClose.addEventListener('click', () => {
        if (d.settingsDialog) d.settingsDialog.style.display = 'none';
      });
    }

    _bindContextMenu() {
      const tbody = this._dom.commandTbody;
      if (!tbody) return;

      tbody.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const tr = e.target.closest('tr[data-index]');
        if (!tr) return;
        const index = parseInt(tr.dataset.index, 10);
        if (!this.selectedCommandIndices.includes(index)) {
          this.selectCommand(index);
        }
        this._showContextMenu(e.clientX, e.clientY, index);
      });

      document.addEventListener('click', () => this._hideContextMenu());
    }

    _showContextMenu(x, y, index) {
      this._hideContextMenu();
      const menu = document.createElement('div');
      menu.id = 'cmd-context-menu';
      menu.className = 'context-menu';
      menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9999`;

      const multi = this.selectedCommandIndices.length > 1;
      menu.innerHTML = `
        <div class="ctx-item" data-ctx="insert-above">Insert above</div>
        <div class="ctx-item" data-ctx="insert-below">Insert below</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-ctx="copy">${multi ? 'Copy selected' : 'Copy'}</div>
        <div class="ctx-item" data-ctx="paste">Paste</div>
        <div class="ctx-item" data-ctx="duplicate">Duplicate</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-ctx="toggle-bp">Toggle breakpoint</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item ctx-danger" data-ctx="delete">${multi ? 'Delete selected' : 'Delete'}</div>
      `;

      menu.addEventListener('click', (e) => {
        const item = e.target.closest('[data-ctx]');
        if (!item) return;
        this._handleContextAction(item.dataset.ctx, index);
        this._hideContextMenu();
      });

      document.body.appendChild(menu);
    }

    _hideContextMenu() {
      const existing = document.getElementById('cmd-context-menu');
      if (existing) existing.remove();
    }

    _handleContextAction(action, index) {
      switch (action) {
        case 'insert-above':  this.insertCommand(index,     '', '', ''); break;
        case 'insert-below':  this.insertCommand(index + 1, '', '', ''); break;
        case 'copy':          this.copyCommands(); break;
        case 'paste':         this.pasteCommands(index); break;
        case 'duplicate': {
          const idxs = this.selectedCommandIndices.length > 1
            ? this.selectedCommandIndices : [index];
          const copies = idxs.map(i => clone(this.currentTestCase.commands[i]));
          const insertAt = Math.max(...idxs) + 1;
          this._snapshotUndo();
          this.currentTestCase.commands.splice(insertAt, 0, ...copies);
          this._renderCommandTable();
          this.saveWorkspace();
          break;
        }
        case 'toggle-bp':     this.toggleBreakpoint(index); break;
        case 'delete':        this.deleteCommand(index);    break;
      }
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 20 – Utility Helpers
    // ═══════════════════════════════════════════════════════════

    _showStatus(message, level = 'info') {
      const bar = this._dom.statusBar;
      if (!bar) return;
      bar.textContent = message;
      bar.className   = `status-bar status-${level}`;
    }

    _updateTestCaseTitle() {
      const el = this._dom.testCaseTitle;
      if (!el) return;
      el.textContent = this.currentTestCase
        ? `${this.currentSuite ? this.currentSuite.name + ' / ' : ''}${this.currentTestCase.name}`
        : 'No test case selected';
    }

    _updateToolbarState() {
      const d   = this._dom;
      const has = !!this.currentTestCase;
      const rec = this.isRecording;
      const play = this.isPlaying;

      if (d.btnRecord)     { d.btnRecord.textContent  = rec  ? '⏹ Stop Rec' : '⏺ Record'; d.btnRecord.classList.toggle('recording', rec); }
      if (d.btnPlay)       d.btnPlay.disabled       = !has || play;
      if (d.btnPlaySuite)  d.btnPlaySuite.disabled  = !this.currentSuite || play;
      if (d.btnPlayAll)    d.btnPlayAll.disabled    = play;
      if (d.btnPause)      d.btnPause.disabled      = !play;
      if (d.btnStop)       d.btnStop.disabled       = !play;
      if (d.btnStep)       d.btnStep.disabled       = !has || play;
      if (d.btnAddCmd)     d.btnAddCmd.disabled     = !has || play;
      if (d.btnDeleteCmd)  d.btnDeleteCmd.disabled  = !has || play;
      if (d.btnUndo)       d.btnUndo.disabled       = !this.undoStack.length;
      if (d.btnRedo)       d.btnRedo.disabled       = !this.redoStack.length;
    }

    _showCommandInDetail(index) {
      if (!this.currentTestCase) return;
      const cmd = this.currentTestCase.commands[index];
      if (!cmd) return;
      const d = this._dom;
      if (d.detailCommand) d.detailCommand.textContent = cmd.command;
      if (d.detailTarget)  d.detailTarget.textContent  = cmd.target;
      if (d.detailValue)   d.detailValue.textContent   = cmd.value;
      if (d.detailComment) d.detailComment.textContent = cmd.comment || '';
    }

    _clearDetailPanel() {
      const d = this._dom;
      ['detailCommand', 'detailTarget', 'detailValue', 'detailComment'].forEach(k => {
        if (d[k]) d[k].textContent = '';
      });
    }

    _downloadText(content, filename, mimeType) {
      const blob = new Blob([content], { type: mimeType || 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }

    _showModal(title, bodyHtml) {
      let modal = document.getElementById('sf-generic-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'sf-generic-modal';
        modal.className = 'modal-overlay';
        modal.innerHTML = `
          <div class="modal-box">
            <div class="modal-header">
              <h2 id="sf-modal-title"></h2>
              <button id="sf-modal-close" class="modal-close-btn">✕</button>
            </div>
            <div id="sf-modal-body" class="modal-body"></div>
          </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#sf-modal-close').addEventListener('click', () => {
          modal.style.display = 'none';
        });
      }
      modal.querySelector('#sf-modal-title').textContent = title;
      modal.querySelector('#sf-modal-body').innerHTML    = bodyHtml;
      modal.style.display = 'flex';
    }

    _suiteById(id) {
      return this.workspace.suites.find(s => s.id === id) || null;
    }

    _testCaseById(suiteId, testCaseId) {
      const suite = this._suiteById(suiteId);
      return suite ? suite.testCases.find(tc => tc.id === testCaseId) || null : null;
    }

    _findTestCaseAnywhere(testCaseId) {
      for (const suite of this.workspace.suites) {
        const tc = suite.testCases.find(t => t.id === testCaseId);
        if (tc) return tc;
      }
      return null;
    }

    _setBadge(text, color) {
      try {
        chrome.action.setBadgeText({ text });
        chrome.action.setBadgeBackgroundColor({ color });
      } catch (e) { /* ignore in non-extension context */ }
    }

    _clearBadge() {
      try {
        chrome.action.setBadgeText({ text: '' });
      } catch (e) { /* ignore */ }
    }

  } // end class SeleniumForgeApp

  // ─────────────────────────────────────────────────────────────
  // Bootstrap
  // ─────────────────────────────────────────────────────────────
  global.SeleniumForgeApp = SeleniumForgeApp;

  document.addEventListener('DOMContentLoaded', () => {
    global.app = new SeleniumForgeApp();
    global.app.init().catch(console.error);
  });

})(window);
