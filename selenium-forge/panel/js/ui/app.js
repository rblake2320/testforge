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

  const STORAGE_KEY_WORKSPACE = 'sf_workspace';
  const STORAGE_KEY_SETTINGS  = 'sf_settings';
  const STORAGE_KEY_TESTDATA  = 'sf_testdata';
  const STORAGE_KEY_PROFILES  = 'sf_profiles';
  const STORAGE_KEY_SCRIPTS   = 'sf_scripts';
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
        btnPlay:        q('btn-play'),
        btnPlaySuite:   q('btn-play-suite'),
        btnPlayAll:     q('btn-play-all'),
        btnPause:       q('btn-pause'),
        btnStop:        q('btn-stop'),
        btnStep:        q('btn-step'),
        btnAddCmd:      q('btn-add-cmd'),
        btnDeleteCmd:   q('btn-delete-cmd'),
        btnUndo:        q('btn-undo'),
        btnRedo:        q('btn-redo'),
        btnSettings:    q('btn-settings'),
        btnExport:      q('btn-export'),
        speedSelect:    q('speed-select'),
        statusBar:      q('status-bar'),

        // Tree sidebar
        treeTabs:       qs('.tree-tabs'),
        treeContainer:  q('tree-container'),
        btnAddSuite:    q('btn-add-suite'),
        btnDeleteSuite: q('btn-delete-suite'),

        // Command table area
        testCaseTitle:  q('test-case-title'),
        commandTable:   q('command-table'),
        commandTbody:   qs('#command-table tbody'),

        // Autocomplete dropdown
        autocompleteDropdown: q('autocomplete-dropdown'),

        // Target picker
        btnPickTarget:  q('btn-pick-target'),

        // Detail / reference panel
        detailCommand: q('detail-command'),
        detailTarget:  q('detail-target'),
        detailValue:   q('detail-value'),
        detailComment: q('detail-comment'),
        referencePane: q('reference-pane'),

        // Artifact tabs
        artifactTabs:      qs('.artifact-tabs'),
        logContainer:      q('log-container'),
        variablesContainer: q('variables-container'),
        screenshotsContainer: q('screenshots-container'),
        healingContainer:  q('healing-container'),

        // Export dialog
        exportDialog:       q('export-dialog'),
        exportFormatSelect: q('export-format-select'),
        exportScopeSelect:  q('export-scope-select'),
        exportPreview:      q('export-preview'),
        btnExportConfirm:   q('btn-export-confirm'),
        btnExportClose:     q('btn-export-close'),

        // Settings dialog
        settingsDialog:     q('settings-dialog'),
        settingTimeout:     q('setting-timeout'),
        settingSpeed:       q('setting-speed'),
        settingSelfHeal:    q('setting-selfheal'),
        settingScreenshot:  q('setting-screenshot'),
        settingTheme:       q('setting-theme'),
        btnSettingsSave:    q('btn-settings-save'),
        btnSettingsClose:   q('btn-settings-close'),

        // Data-driven tab
        dataTab:            q('data-tab'),
        btnAddData:         q('btn-add-data'),

        // Profiles tab
        profilesTab:        q('profiles-tab'),
        btnAddProfile:      q('btn-add-profile'),

        // Extensions tab
        extensionsTab:      q('extensions-tab'),
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
      const targets = indices || this.selectedCommandIndices;
      if (!targets.length) return;
      this.clipboard = targets
        .filter(i => i >= 0 && i < this.currentTestCase.commands.length)
        .map(i => clone(this.currentTestCase.commands[i]));
      this._showStatus(`Copied ${this.clipboard.length} command(s)`);
    }

    /** Paste clipboard commands after the current selection */
    pasteCommands() {
      if (!this.currentTestCase || !this.clipboard.length) return;
      this._snapshotUndo();
      const insertAt = this.selectedCommandIndex >= 0
        ? this.selectedCommandIndex + 1
        : this.currentTestCase.commands.length;
      const copies = this.clipboard.map(c => clone(c));
      this.currentTestCase.commands.splice(insertAt, 0, ...copies);
      this._renderCommandTable();
      this.selectCommand(insertAt);
      this.saveWorkspace();
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 7 – Undo / Redo
    // ═══════════════════════════════════════════════════════════

    /** Save current commands snapshot to undo stack */
    _snapshotUndo() {
      if (!this.currentTestCase) return;
      this.undoStack.push(clone(this.currentTestCase.commands));
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = [];
      this._updateUndoButtons();
    }

    undo() {
      if (!this.currentTestCase || !this.undoStack.length) return;
      this.redoStack.push(clone(this.currentTestCase.commands));
      this.currentTestCase.commands = this.undoStack.pop();
      this._renderCommandTable();
      this._clearDetailPanel();
      this.saveWorkspace();
      this._updateUndoButtons();
    }

    redo() {
      if (!this.currentTestCase || !this.redoStack.length) return;
      this.undoStack.push(clone(this.currentTestCase.commands));
      this.currentTestCase.commands = this.redoStack.pop();
      this._renderCommandTable();
      this._clearDetailPanel();
      this.saveWorkspace();
      this._updateUndoButtons();
    }

    _updateUndoButtons() {
      if (this._dom.btnUndo) this._dom.btnUndo.disabled = !this.undoStack.length;
      if (this._dom.btnRedo) this._dom.btnRedo.disabled = !this.redoStack.length;
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 8 – Command Autocomplete
    // ═══════════════════════════════════════════════════════════

    /**
     * Show autocomplete dropdown for the command cell.
     * @param {HTMLElement} cell  – the <td> being edited
     * @param {string}      query – current text
     */
    _showAutocomplete(cell, query) {
      const CR = window.CommandRegistry;
      if (!CR) return;

      const all = CR.getAllNames ? CR.getAllNames() : Object.keys(CR.commands || {});
      const matches = all.filter(name => fuzzyMatch(query, name)).slice(0, 12);

      if (!matches.length) {
        this._hideAutocomplete();
        return;
      }

      const dd = this._dom.autocompleteDropdown;
      if (!dd) return;

      this._autocompleteItems       = matches;
      this._autocompleteIndex       = -1;
      this._autocompleteTargetCell  = cell;
      this._autocompleteVisible     = true;

      dd.innerHTML = matches
        .map((m, i) => `<div class="ac-item" data-index="${i}">${esc(m)}</div>`)
        .join('');

      // Position below the cell
      const rect = cell.getBoundingClientRect();
      dd.style.top    = `${rect.bottom + window.scrollY}px`;
      dd.style.left   = `${rect.left   + window.scrollX}px`;
      dd.style.width  = `${Math.max(rect.width, 180)}px`;
      dd.style.display = 'block';
    }

    _hideAutocomplete() {
      this._autocompleteVisible = false;
      if (this._dom.autocompleteDropdown) {
        this._dom.autocompleteDropdown.style.display = 'none';
      }
    }

    _autocompleteSelectByIndex(i) {
      const items = this._dom.autocompleteDropdown &&
                    this._dom.autocompleteDropdown.querySelectorAll('.ac-item');
      if (!items) return;
      items.forEach((el, idx) => el.classList.toggle('ac-active', idx === i));
    }

    /**
     * Commit an autocomplete selection into the command field.
     * @param {number} index
     */
    _autocompleteCommit(index) {
      if (index < 0 || index >= this._autocompleteItems.length) return;
      const value = this._autocompleteItems[index];
      const cell  = this._autocompleteTargetCell;
      if (!cell) return;

      const rowIndex = parseInt(cell.dataset.index, 10);
      this.updateCommand(rowIndex, 'command', value);
      this._hideAutocomplete();

      // Move focus to target cell
      const tr = this._rowByIndex(rowIndex);
      if (tr) {
        const targetCell = tr.querySelector('[data-field="target"]');
        if (targetCell) this._openEditor(targetCell);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 9 – Target Locator Helper
    // ═══════════════════════════════════════════════════════════

    /**
     * Activate the element-picker in the active tab.
     * @param {number} [commandIndex]  – if given, fills that row's target.
     */
    async activatePicker(commandIndex) {
      if (this._pickerActive) return;
      this._pickerActive = true;
      if (this._dom.btnPickTarget) {
        this._dom.btnPickTarget.classList.add('active');
      }

      const response = await sendToBackground({
        type:         'START_PICKER',
        commandIndex: commandIndex !== undefined ? commandIndex : this.selectedCommandIndex,
      });

      if (!response.ok) {
        this._pickerActive = false;
        this._showStatus('Picker failed: ' + (response.error || 'unknown'), 'error');
        if (this._dom.btnPickTarget) this._dom.btnPickTarget.classList.remove('active');
      }
    }

    /** Called when background sends back PICKER_RESULT */
    _onPickerResult(data) {
      this._pickerActive = false;
      if (this._dom.btnPickTarget) this._dom.btnPickTarget.classList.remove('active');

      if (data.target && data.commandIndex >= 0) {
        this.updateCommand(data.commandIndex, 'target', data.target);
        this.selectCommand(data.commandIndex);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 10 – Recording Integration
    // ═══════════════════════════════════════════════════════════

    /** Toggle recording on / off */
    async toggleRecording() {
      if (!this.currentTestCase) {
        this._showStatus('Open a test case before recording.', 'warn');
        return;
      }

      if (this.isRecording) {
        await this._stopRecording();
      } else {
        await this._startRecording();
      }
    }

    async _startRecording() {
      const response = await sendToBackground({ type: 'START_RECORDING' });
      if (response.ok) {
        this.isRecording = true;
        this._updateToolbarState();
        this._showStatus('Recording…', 'recording');
      } else {
        this._showStatus('Could not start recording: ' + (response.error || ''), 'error');
      }
    }

    async _stopRecording() {
      const response = await sendToBackground({ type: 'STOP_RECORDING' });
      this.isRecording = false;
      this._updateToolbarState();
      this._showStatus(response.ok ? 'Recording stopped.' : 'Stop failed.');
    }

    /**
     * Called when background pushes a recorded command.
     * @param {{ command: string, target: string, value: string }} cmd
     */
    _onRecordedCommand(cmd) {
      if (!this.currentTestCase) return;
      const normalised = normCmd(cmd);
      this.currentTestCase.commands.push(normalised);
      this._renderCommandTable();
      this.saveWorkspace();
      // Scroll to bottom
      if (this._dom.commandTbody) {
        const lastRow = this._dom.commandTbody.lastElementChild;
        if (lastRow) lastRow.scrollIntoView({ block: 'nearest' });
      }
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 11 – Playback Integration
    // ═══════════════════════════════════════════════════════════

    /** Play the current test case */
    async playTestCase() {
      if (!this.currentTestCase) {
        this._showStatus('No test case selected.', 'warn');
        return;
      }
      await this._runPlayback('testCase', this.currentSuite, this.currentTestCase);
    }

    /** Play the current suite */
    async playSuite() {
      if (!this.currentSuite) {
        this._showStatus('No suite selected.', 'warn');
        return;
      }
      await this._runPlayback('suite', this.currentSuite);
    }

    /** Play all suites */
    async playAll() {
      await this._runPlayback('all');
    }

    /** Step (execute one command then pause) */
    async stepCommand() {
      if (this._playbackEngine) {
        this._playbackEngine.step();
      }
    }

    /** Pause running playback */
    pausePlayback() {
      if (this._playbackEngine) this._playbackEngine.pause();
    }

    /** Stop running playback */
    stopPlayback() {
      if (this._playbackEngine) this._playbackEngine.stop();
    }

    /**
     * Internal: instantiate PlaybackEngine and run.
     * @private
     */
    async _runPlayback(mode, suite, testCase) {
      if (this.isPlaying) return;

      const PE = window.PlaybackEngine;
      if (!PE) {
        this._showStatus('PlaybackEngine not loaded.', 'error');
        return;
      }

      this.isPlaying = true;
      this._updateToolbarState();
      this._clearArtifacts();
      this._rowStates = {};

      // Resolve test data binding
      const activeProfile  = this.profiles.find(p => p.active) || null;
      const testDataSource = this._resolveTestData();

      this._playbackEngine = new PE({
        mode,
        suite:          suite        || null,
        testCase:       testCase     || null,
        workspace:      this.workspace,
        settings:       this.settings,
        profile:        activeProfile,
        testDataSource: testDataSource,

        onCommandStart:  (idx)       => this._onCommandStart(idx),
        onCommandResult: (idx, res)  => this._onCommandResult(idx, res),
        onTestCaseStart: (suite, tc) => this._onTestCaseStart(suite, tc),
        onTestCaseEnd:   (suite, tc, result) => this._onTestCaseEnd(suite, tc, result),
        onLog:           (msg, level) => this._appendLog(msg, level),
        onVariable:      (name, val) => this._appendVariable(name, val),
        onScreenshot:    (dataUrl)   => this._appendScreenshot(dataUrl),
        onHealingSuggestion: (data)  => this._appendHealingSuggestion(data),
        onFinish:        (summary)   => this._onPlaybackFinish(summary),
      });

      try {
        await this._playbackEngine.run();
      } catch (e) {
        this._showStatus('Playback error: ' + e.message, 'error');
        console.error('[SeleniumForge] Playback error:', e);
        this._onPlaybackFinish({ ok: false, error: e.message });
      }
    }

    _onCommandStart(index) {
      // Clear previous 'running' state
      Object.keys(this._rowStates).forEach(i => {
        if (this._rowStates[i] === 'running') delete this._rowStates[i];
      });
      this._rowStates[index] = 'running';
      this._applyRowState(index, 'running');

      // Keep row in view
      const tr = this._rowByIndex(index);
      if (tr) tr.scrollIntoView({ block: 'nearest' });
    }

    _onCommandResult(index, result) {
      const state = result.ok ? 'passed' : (result.error ? 'error' : 'failed');
      this._rowStates[index] = state;
      this._applyRowState(index, state);
    }

    _onTestCaseStart(suite, tc) {
      if (this.currentSuite && this.currentSuite.id !== suite.id) {
        this.openTestCase(suite, tc);
      } else if (this.currentTestCase && this.currentTestCase.id !== tc.id) {
        this.openTestCase(suite, tc);
      }
      this._rowStates = {};
      this._renderCommandTable();
      this._showStatus(`Running: ${tc.name}`);
    }

    _onTestCaseEnd(suite, tc, result) {
      this._resultBadges[tc.id] = result.ok ? 'passed' : 'failed';
      this.renderTree();
    }

    _onPlaybackFinish(summary) {
      this.isPlaying        = false;
      this._playbackEngine  = null;
      this._updateToolbarState();

      const ok  = summary && summary.ok !== false;
      const msg = ok
        ? `Playback complete. Passed: ${summary.passed || 0}, Failed: ${summary.failed || 0}`
        : `Playback stopped. ${summary.error || ''}`;
      this._showStatus(msg, ok ? 'success' : 'error');
    }

    _applyRowState(index, state) {
      const tr = this._rowByIndex(index);
      if (!tr) return;
      // Remove all state classes first
      Object.values(ROW_STATE).forEach(cls => tr.classList.remove(cls));
      // Re-add sticky classes
      const cmd = this.currentTestCase && this.currentTestCase.commands[index];
      if (cmd && cmd.breakpoint) tr.classList.add(ROW_STATE.breakpoint);
      if (this.selectedCommandIndices.includes(index)) tr.classList.add(ROW_STATE.selected);
      if (state && ROW_STATE[state]) tr.classList.add(ROW_STATE[state]);
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 12 – Data-Driven Testing UI
    // ═══════════════════════════════════════════════════════════

    _renderDataTab() {
      const container = this._dom.dataTab;
      if (!container) return;

      if (!this.testData.length) {
        container.innerHTML = '<p class="empty-msg">No data sets. Click <strong>+ Add</strong>.</p>';
        return;
      }

      container.innerHTML = this.testData.map((ds, di) => `
        <div class="data-set" data-id="${ds.id}">
          <div class="data-set-header">
            <span class="data-set-name">${esc(ds.name)}</span>
            <button class="btn-ds-delete" data-id="${ds.id}" title="Delete">✕</button>
          </div>
          <table class="data-table">
            <thead><tr>${(ds.rows[0] || []).map((h, i) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${ds.rows.slice(1).map(row =>
              `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`
            ).join('')}</tbody>
          </table>
        </div>
      `).join('');

      container.querySelectorAll('.btn-ds-delete').forEach(btn => {
        btn.addEventListener('click', () => this._deleteDataSet(btn.dataset.id));
      });
    }

    _deleteDataSet(id) {
      this.testData = this.testData.filter(ds => ds.id !== id);
      this._saveTestData();
      this._renderDataTab();
    }

    /** Open a file picker to import CSV as a data set */
    importTestDataCSV() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.csv,text/csv';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const rows = text.trim().split('\n').map(line =>
          line.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''))
        );
        const ds = { id: uid(), name: file.name.replace(/\.csv$/i, ''), type: 'csv', rows };
        this.testData.push(ds);
        this._saveTestData();
        this._renderDataTab();
        this._showStatus(`Imported: ${ds.name}`);
      };
      input.click();
    }

    _resolveTestData() {
      const bound = this.currentTestCase && this.currentTestCase.testDataId;
      if (!bound) return null;
      return this.testData.find(ds => ds.id === bound) || null;
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 13 – Profiles (Global Variables)
    // ═══════════════════════════════════════════════════════════

    _renderProfilesTab() {
      const container = this._dom.profilesTab;
      if (!container) return;

      if (!this.profiles.length) {
        container.innerHTML = '<p class="empty-msg">No profiles. Click <strong>+ Add</strong>.</p>';
        return;
      }

      container.innerHTML = this.profiles.map((p, pi) => `
        <div class="profile ${p.active ? 'profile-active' : ''}" data-id="${p.id}">
          <div class="profile-header">
            <label class="profile-radio">
              <input type="radio" name="active-profile" value="${p.id}" ${p.active ? 'checked' : ''}>
              <span>${esc(p.name)}</span>
            </label>
            <button class="btn-profile-delete" data-id="${p.id}" title="Delete">✕</button>
          </div>
          <div class="profile-vars">
            ${Object.entries(p.variables || {}).map(([k, v]) =>
              `<div class="profile-var"><span class="var-key">${esc(k)}</span><span class="var-val">${esc(String(v))}</span></div>`
            ).join('')}
          </div>
        </div>
      `).join('');

      container.querySelectorAll('input[name="active-profile"]').forEach(radio => {
        radio.addEventListener('change', () => {
          this.profiles.forEach(p => p.active = (p.id === radio.value));
          this._saveProfiles();
          this._renderProfilesTab();
        });
      });

      container.querySelectorAll('.btn-profile-delete').forEach(btn => {
        btn.addEventListener('click', () => {
          this.profiles = this.profiles.filter(p => p.id !== btn.dataset.id);
          this._saveProfiles();
          this._renderProfilesTab();
        });
      });
    }

    addProfile(name, variables) {
      const profile = { id: uid(), name: name || 'Profile 1', variables: variables || {}, active: false };
      this.profiles.push(profile);
      this._saveProfiles();
      this._renderProfilesTab();
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 14 – Export UI
    // ═══════════════════════════════════════════════════════════

    openExportDialog() {
      const dlg = this._dom.exportDialog;
      if (!dlg) return;
      this._refreshExportPreview();
      dlg.style.display = 'flex';
    }

    _closeExportDialog() {
      if (this._dom.exportDialog) this._dom.exportDialog.style.display = 'none';
    }

    _refreshExportPreview() {
      const format = this._dom.exportFormatSelect && this._dom.exportFormatSelect.value;
      const scope  = this._dom.exportScopeSelect  && this._dom.exportScopeSelect.value;
      const EM = window.ExportManager;
      if (!EM) {
        if (this._dom.exportPreview) this._dom.exportPreview.textContent = 'ExportManager not loaded.';
        return;
      }

      let target;
      if (scope === 'testcase') target = this.currentTestCase;
      else if (scope === 'suite') target = this.currentSuite;
      else target = this.workspace;

      try {
        const preview = EM.export(format, target, { preview: true });
        if (this._dom.exportPreview) this._dom.exportPreview.textContent = preview;
      } catch (e) {
        if (this._dom.exportPreview) this._dom.exportPreview.textContent = 'Error: ' + e.message;
      }
    }

    _doExport() {
      const format = this._dom.exportFormatSelect && this._dom.exportFormatSelect.value;
      const scope  = this._dom.exportScopeSelect  && this._dom.exportScopeSelect.value;
      const EM = window.ExportManager;
      if (!EM) return;

      let target;
      if (scope === 'testcase') target = this.currentTestCase;
      else if (scope === 'suite') target = this.currentSuite;
      else target = this.workspace;

      try {
        const output   = EM.export(format, target);
        const ext      = EM.extension ? EM.extension(format) : 'txt';
        const filename = `seleniumforge-export.${ext}`;
        this._downloadText(output, filename, 'text/plain');
        this._closeExportDialog();
        this._showStatus(`Exported as ${format}`);
      } catch (e) {
        this._showStatus('Export error: ' + e.message, 'error');
      }
    }

    _bindExportDialog() {
      const dlg = this._dom.exportDialog;
      if (!dlg) return;

      if (this._dom.exportFormatSelect) {
        this._dom.exportFormatSelect.addEventListener('change', () => this._refreshExportPreview());
      }
      if (this._dom.exportScopeSelect) {
        this._dom.exportScopeSelect.addEventListener('change', () => this._refreshExportPreview());
      }
      if (this._dom.btnExportConfirm) {
        this._dom.btnExportConfirm.addEventListener('click', () => this._doExport());
      }
      if (this._dom.btnExportClose) {
        this._dom.btnExportClose.addEventListener('click', () => this._closeExportDialog());
      }
      // Close on backdrop click
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) this._closeExportDialog();
      });
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 15 – Artifacts Panel
    // ═══════════════════════════════════════════════════════════

    _clearArtifacts() {
      ['logContainer', 'variablesContainer', 'screenshotsContainer', 'healingContainer'].forEach(key => {
        if (this._dom[key]) this._dom[key].innerHTML = '';
      });
      this._healingSuggestions = [];
    }

    _appendLog(message, level) {
      const container = this._dom.logContainer;
      if (!container) return;
      const div = document.createElement('div');
      div.className = `log-line log-${level || 'info'}`;
      div.textContent = `[${fmtTime(Date.now())}] ${message}`;
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
    }

    _appendVariable(name, value) {
      const container = this._dom.variablesContainer;
      if (!container) return;
      // Update existing or add new
      let existing = container.querySelector(`[data-var="${CSS.escape(name)}"]`);
      if (!existing) {
        existing = document.createElement('div');
        existing.className = 'var-row';
        existing.dataset.var = name;
        container.appendChild(existing);
      }
      existing.innerHTML = `<span class="var-key">${esc(name)}</span><span class="var-val">${esc(String(value))}</span>`;
    }

    _appendScreenshot(dataUrl) {
      const container = this._dom.screenshotsContainer;
      if (!container) return;
      const img = document.createElement('img');
      img.src = dataUrl;
      img.className = 'screenshot-thumb';
      img.addEventListener('click', () => window.open(dataUrl, '_blank'));
      container.appendChild(img);
    }

    _appendHealingSuggestion(data) {
      this._healingSuggestions.push(data);
      const container = this._dom.healingContainer;
      if (!container) return;
      const div = document.createElement('div');
      div.className = 'healing-item';
      div.innerHTML = `
        <span class="heal-cmd">${esc(data.command)} #${data.index + 1}</span>
        <span class="heal-orig">Original: <code>${esc(data.original)}</code></span>
        <span class="heal-sug">Suggested: <code>${esc(data.suggested)}</code></span>
        <button class="btn-heal-accept" data-index="${this._healingSuggestions.length - 1}">Accept</button>
        <button class="btn-heal-skip"   data-index="${this._healingSuggestions.length - 1}">Skip</button>
      `;
      container.appendChild(div);

      div.querySelector('.btn-heal-accept').addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        this._acceptHealingSuggestion(idx);
      });
      div.querySelector('.btn-heal-skip').addEventListener('click', (e) => {
        e.target.closest('.healing-item').remove();
      });
    }

    _acceptHealingSuggestion(suggestionIndex) {
      const s = this._healingSuggestions[suggestionIndex];
      if (!s || !this.currentTestCase) return;
      this.updateCommand(s.index, 'target', s.suggested);
      const item = this._dom.healingContainer &&
                   this._dom.healingContainer.querySelector(`[data-index="${suggestionIndex}"]`);
      if (item) item.closest('.healing-item').remove();
      this._showStatus(`Healed command #${s.index + 1}`, 'success');
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 16 – Tree View (workspace sidebar)
    // ═══════════════════════════════════════════════════════════

    /**
     * Full re-render of the suite/test-case tree.
     */
    renderTree() {
      const container = this._dom.treeContainer;
      if (!container) return;

      const activeTab = this._activeTreeTab;
      let suites;

      if (activeTab === 'dynamic') {
        suites = this.workspace.dynamicSuites || [];
      } else {
        suites = this.workspace.suites || [];
      }

      if (!suites.length) {
        container.innerHTML = '<p class="tree-empty">No suites. Click <strong>+ Suite</strong>.</p>';
        return;
      }

      const frag = document.createDocumentFragment();
      suites.forEach(suite => {
        frag.appendChild(this._buildSuiteNode(suite));
      });

      container.innerHTML = '';
      container.appendChild(frag);
    }

    _buildSuiteNode(suite) {
      const expanded = this._treeExpanded[suite.id] !== false; // default expanded
      const div = document.createElement('div');
      div.className = 'suite-node';
      div.dataset.suiteId = suite.id;

      const hasTestCases = suite.testCases && suite.testCases.length;
      const activeId = this.currentTestCase && this.currentTestCase.id;

      div.innerHTML = `
        <div class="suite-header ${this.currentSuite && this.currentSuite.id === suite.id ? 'suite-selected' : ''}">
          <span class="suite-toggle">${expanded ? '▾' : '▸'}</span>
          <span class="suite-name" title="${esc(suite.name)}">${esc(suite.name)}</span>
          <span class="suite-count">${suite.testCases ? suite.testCases.length : 0}</span>
          <button class="btn-tc-add" data-suite-id="${suite.id}" title="Add test case">+</button>
          <button class="btn-suite-rename" data-suite-id="${suite.id}" title="Rename">✎</button>
          <button class="btn-suite-delete" data-suite-id="${suite.id}" title="Delete">✕</button>
        </div>
        <div class="tc-list" style="display:${expanded ? 'block' : 'none'}">
          ${!hasTestCases ? '<p class="tc-empty">No test cases.</p>' : ''}
          ${(suite.testCases || []).map(tc => `
            <div class="tc-item ${tc.id === activeId ? 'tc-selected' : ''}" data-suite-id="${suite.id}" data-tc-id="${tc.id}">
              <span class="tc-name" title="${esc(tc.name)}">${esc(tc.name)}</span>
              ${this._resultBadges[tc.id] ? `<span class="result-badge result-${this._resultBadges[tc.id]}">${this._resultBadges[tc.id]}</span>` : ''}
              <button class="btn-tc-rename" data-suite-id="${suite.id}" data-tc-id="${tc.id}" title="Rename">✎</button>
              <button class="btn-tc-delete" data-suite-id="${suite.id}" data-tc-id="${tc.id}" title="Delete">✕</button>
              <button class="btn-tc-dupe"   data-suite-id="${suite.id}" data-tc-id="${tc.id}" title="Duplicate">⎘</button>
            </div>
          `).join('')}
        </div>
      `;

      // Suite header click → expand/collapse
      div.querySelector('.suite-header').addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        this._treeExpanded[suite.id] = !this._treeExpanded[suite.id];
        this.renderTree();
        this._selectSuite(suite);
      });

      // Test case click → open
      div.querySelectorAll('.tc-item').forEach(tcEl => {
        tcEl.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          const tc = suite.testCases.find(t => t.id === tcEl.dataset.tcId);
          if (tc) this.openTestCase(suite, tc);
        });
      });

      // Buttons
      div.querySelectorAll('.btn-tc-add').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.addTestCase(btn.dataset.suiteId);
        });
      });
      div.querySelectorAll('.btn-suite-rename').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const newName = prompt('Rename suite:', suite.name);
          if (newName) this.renameSuite(btn.dataset.suiteId, newName);
        });
      });
      div.querySelectorAll('.btn-suite-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (confirm(`Delete suite "${suite.name}"?`)) this.deleteSuite(btn.dataset.suiteId);
        });
      });
      div.querySelectorAll('.btn-tc-rename').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tc = suite.testCases.find(t => t.id === btn.dataset.tcId);
          if (!tc) return;
          const newName = prompt('Rename test case:', tc.name);
          if (newName) this.renameTestCase(btn.dataset.suiteId, btn.dataset.tcId, newName);
        });
      });
      div.querySelectorAll('.btn-tc-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tc = suite.testCases.find(t => t.id === btn.dataset.tcId);
          if (!tc) return;
          if (confirm(`Delete "${tc.name}"?`)) this.deleteTestCase(btn.dataset.suiteId, btn.dataset.tcId);
        });
      });
      div.querySelectorAll('.btn-tc-dupe').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.duplicateTestCase(btn.dataset.suiteId, btn.dataset.tcId);
        });
      });

      return div;
    }

    _selectSuite(suite) {
      this.currentSuite = suite;
      this._updateTreeSelection();
    }

    _updateTreeSelection() {
      const container = this._dom.treeContainer;
      if (!container) return;
      container.querySelectorAll('.suite-header').forEach(el => {
        el.classList.toggle('suite-selected',
          el.closest('.suite-node').dataset.suiteId === (this.currentSuite && this.currentSuite.id));
      });
      container.querySelectorAll('.tc-item').forEach(el => {
        el.classList.toggle('tc-selected',
          el.dataset.tcId === (this.currentTestCase && this.currentTestCase.id));
      });
    }

    _bindTreeTabs() {
      const tabs = this._dom.treeTabs;
      if (!tabs) return;
      tabs.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (!tab) return;
        tabs.querySelectorAll('[data-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this._activeTreeTab = tab.dataset.tab;
        this.renderTree();
      });
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 17 – Settings
    // ═══════════════════════════════════════════════════════════

    openSettingsDialog() {
      this._applySettingsToUI();
      if (this._dom.settingsDialog) this._dom.settingsDialog.style.display = 'flex';
    }

    _closeSettingsDialog() {
      if (this._dom.settingsDialog) this._dom.settingsDialog.style.display = 'none';
    }

    _applySettingsToUI() {
      const s  = this.settings;
      const d  = this._dom;
      if (d.settingTimeout)    d.settingTimeout.value   = s.defaultTimeout;
      if (d.settingSpeed)      d.settingSpeed.value     = s.speed;
      if (d.settingSelfHeal)   d.settingSelfHeal.checked  = s.selfHealing;
      if (d.settingScreenshot) d.settingScreenshot.checked = s.screenshotOnFailure;
      if (d.settingTheme)      d.settingTheme.value     = s.theme;
      if (d.speedSelect)       d.speedSelect.value      = s.speed;
    }

    _saveSettingsFromUI() {
      const d = this._dom;
      this.settings.defaultTimeout      = parseInt(d.settingTimeout && d.settingTimeout.value, 10) || 30000;
      this.settings.speed               = (d.settingSpeed && d.settingSpeed.value) || 'MEDIUM';
      this.settings.selfHealing         = !!(d.settingSelfHeal && d.settingSelfHeal.checked);
      this.settings.screenshotOnFailure = !!(d.settingScreenshot && d.settingScreenshot.checked);
      this.settings.theme               = (d.settingTheme && d.settingTheme.value) || 'light';
      this._applyTheme(this.settings.theme);
      this._saveSettings();
      this._closeSettingsDialog();
      this._showStatus('Settings saved.');
    }

    _applyTheme(theme) {
      document.documentElement.dataset.theme = theme || 'light';
    }

    _bindSettingsDialog() {
      const dlg = this._dom.settingsDialog;
      if (!dlg) return;
      if (this._dom.btnSettingsSave)  this._dom.btnSettingsSave.addEventListener('click', () => this._saveSettingsFromUI());
      if (this._dom.btnSettingsClose) this._dom.btnSettingsClose.addEventListener('click', () => this._closeSettingsDialog());
      dlg.addEventListener('click', (e) => { if (e.target === dlg) this._closeSettingsDialog(); });
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 18 – Keyboard Shortcuts
    // ═══════════════════════════════════════════════════════════

    _bindGlobalKeyboard() {
      document.addEventListener('keydown', (e) => {
        // Don't intercept if focus is in an input/textarea
        const tag = document.activeElement && document.activeElement.tagName;
        const inInput = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT');

        if (e.key === 'Escape') {
          this._hideAutocomplete();
          this._commitActiveEditor();
          return;
        }

        if (this._autocompleteVisible) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._autocompleteIndex = Math.min(this._autocompleteIndex + 1, this._autocompleteItems.length - 1);
            this._autocompleteSelectByIndex(this._autocompleteIndex);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._autocompleteIndex = Math.max(this._autocompleteIndex - 1, 0);
            this._autocompleteSelectByIndex(this._autocompleteIndex);
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            if (this._autocompleteIndex >= 0) this._autocompleteCommit(this._autocompleteIndex);
            else this._hideAutocomplete();
            return;
          }
        }

        if (!inInput) {
          if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
              case 'z': e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); break;
              case 'y': e.preventDefault(); this.redo(); break;
              case 'c': e.preventDefault(); this.copyCommands(); break;
              case 'v': e.preventDefault(); this.pasteCommands(); break;
              case 'a': e.preventDefault(); this._selectAllCommands(); break;
            }
          }
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            this.deleteCommand();
          }
          if (e.key === 'F5')  { e.preventDefault(); this.playTestCase(); }
          if (e.key === 'F6')  { e.preventDefault(); this.stepCommand(); }
          if (e.key === 'F7')  { e.preventDefault(); this.pausePlayback(); }
          if (e.key === 'F8')  { e.preventDefault(); this.stopPlayback(); }
          if (e.key === 'F9')  { e.preventDefault(); this.toggleBreakpoint(this.selectedCommandIndex); }
          if (e.key === 'F2')  { e.preventDefault(); this.addCommand(); }
        }
      });
    }

    _selectAllCommands() {
      if (!this.currentTestCase) return;
      this.selectedCommandIndices = this.currentTestCase.commands.map((_, i) => i);
      this.selectedCommandIndex   = this.selectedCommandIndices[0] || -1;
      this._highlightSelectedRows();
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 19 – Chrome Runtime Message Handling
    // ═══════════════════════════════════════════════════════════

    _bindRuntimeMessages() {
      if (!chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        this._handleRuntimeMessage(msg);
        sendResponse({ ok: true });
        return false;
      });
    }

    _handleRuntimeMessage(msg) {
      switch (msg.type) {
        case 'RECORDED_COMMAND':
          this._onRecordedCommand(msg.command);
          break;
        case 'PICKER_RESULT':
          this._onPickerResult(msg);
          break;
        case 'PLAYBACK_LOG':
          this._appendLog(msg.message, msg.level);
          break;
        case 'PLAYBACK_VARIABLE':
          this._appendVariable(msg.name, msg.value);
          break;
        case 'PLAYBACK_SCREENSHOT':
          this._appendScreenshot(msg.dataUrl);
          break;
        case 'PLAYBACK_HEALING':
          this._appendHealingSuggestion(msg);
          break;
        case 'RECORDING_STARTED':
          this.isRecording = true;
          this._updateToolbarState();
          break;
        case 'RECORDING_STOPPED':
          this.isRecording = false;
          this._updateToolbarState();
          break;
        default:
          break;
      }
    }

    _bindStorageChange() {
      if (!chrome || !chrome.storage) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        // Re-load workspace if another panel changed it
        if (changes[STORAGE_KEY_WORKSPACE]) {
          const newVal = changes[STORAGE_KEY_WORKSPACE].newValue;
          if (newVal) this.workspace = newVal;
          this.renderTree();
        }
      });
    }

    // ═══════════════════════════════════════════════════════════
    // SECTION 20 – Utility Helpers
    // ═══════════════════════════════════════════════════════════

    _dom = {};

    /** Show text in the status bar */
    _showStatus(message, type) {
      const bar = this._dom.statusBar;
      if (!bar) return;
      bar.textContent = message;
      bar.className   = 'status-bar' + (type ? ' status-' + type : '');
    }

    /** Update test case title label */
    _updateTestCaseTitle() {
      if (this._dom.testCaseTitle) {
        this._dom.testCaseTitle.textContent = this.currentTestCase
          ? this.currentTestCase.name
          : 'No Test Case Selected';
      }
    }

    /** Update toolbar button disabled / active states */
    _updateToolbarState() {
      const d  = this._dom;
      const tc = !!this.currentTestCase;
      const pl = this.isPlaying;
      const rc = this.isRecording;

      if (d.btnRecord)    { d.btnRecord.classList.toggle('active', rc); d.btnRecord.disabled = pl; }
      if (d.btnPlay)      { d.btnPlay.disabled     = !tc || pl || rc; }
      if (d.btnPlaySuite) { d.btnPlaySuite.disabled = !this.currentSuite || pl || rc; }
      if (d.btnPlayAll)   { d.btnPlayAll.disabled   = pl || rc; }
      if (d.btnPause)     { d.btnPause.disabled     = !pl; }
      if (d.btnStop)      { d.btnStop.disabled      = !pl; }
      if (d.btnStep)      { d.btnStep.disabled      = !pl; }
      if (d.btnAddCmd)    { d.btnAddCmd.disabled    = !tc || pl; }
      if (d.btnDeleteCmd) { d.btnDeleteCmd.disabled = !tc || pl || this.selectedCommandIndex < 0; }
      this._updateUndoButtons();
    }

    _rowByIndex(index) {
      const tbody = this._dom.commandTbody;
      return tbody && tbody.querySelector(`tr[data-index="${index}"]`);
    }

    _suiteById(id) {
      return this.workspace.suites.find(s => s.id === id) || null;
    }

    _testCaseById(suiteId, tcId) {
      const suite = this._suiteById(suiteId);
      return suite ? (suite.testCases.find(tc => tc.id === tcId) || null) : null;
    }

    _highlightSelectedRows() {
      const tbody = this._dom.commandTbody;
      if (!tbody) return;
      tbody.querySelectorAll('tr').forEach(tr => {
        const idx = parseInt(tr.dataset.index, 10);
        tr.classList.toggle(ROW_STATE.selected, this.selectedCommandIndices.includes(idx));
      });
    }

    _showCommandInDetail(index) {
      if (!this.currentTestCase) return;
      const cmd = this.currentTestCase.commands[index];
      const d   = this._dom;
      if (!cmd) {
        this._clearDetailPanel();
        return;
      }
      if (d.detailCommand) d.detailCommand.textContent = cmd.command;
      if (d.detailTarget)  d.detailTarget.textContent  = cmd.target;
      if (d.detailValue)   d.detailValue.textContent   = cmd.value;
      if (d.detailComment) d.detailComment.textContent = cmd.comment;
    }

    _clearDetailPanel() {
      ['detailCommand', 'detailTarget', 'detailValue', 'detailComment'].forEach(k => {
        if (this._dom[k]) this._dom[k].textContent = '';
      });
      if (this._dom.referencePane) this._dom.referencePane.innerHTML = '';
    }

    _updateReference(index) {
      const CR = window.CommandRegistry;
      const d  = this._dom;
      if (!CR || !d.referencePane || !this.currentTestCase) return;
      const cmd = this.currentTestCase.commands[index];
      if (!cmd) return;
      const info = CR.getInfo ? CR.getInfo(cmd.command) : null;
      if (!info) {
        d.referencePane.innerHTML = '';
        return;
      }
      d.referencePane.innerHTML = `
        <strong>${esc(info.name || cmd.command)}</strong>
        <p>${esc(info.description || '')}</p>
        ${info.targetLabel ? `<p><strong>Target:</strong> ${esc(info.targetLabel)}</p>` : ''}
        ${info.valueLabel  ? `<p><strong>Value:</strong> ${esc(info.valueLabel)}</p>`  : ''}
      `;
    }

    _bindToolbar() {
      const d = this._dom;
      if (d.btnRecord)    d.btnRecord.addEventListener('click',    () => this.toggleRecording());
      if (d.btnPlay)      d.btnPlay.addEventListener('click',      () => this.playTestCase());
      if (d.btnPlaySuite) d.btnPlaySuite.addEventListener('click', () => this.playSuite());
      if (d.btnPlayAll)   d.btnPlayAll.addEventListener('click',   () => this.playAll());
      if (d.btnPause)     d.btnPause.addEventListener('click',     () => this.pausePlayback());
      if (d.btnStop)      d.btnStop.addEventListener('click',      () => this.stopPlayback());
      if (d.btnStep)      d.btnStep.addEventListener('click',      () => this.stepCommand());
      if (d.btnAddCmd)    d.btnAddCmd.addEventListener('click',    () => this.addCommand());
      if (d.btnDeleteCmd) d.btnDeleteCmd.addEventListener('click', () => this.deleteCommand());
      if (d.btnUndo)      d.btnUndo.addEventListener('click',      () => this.undo());
      if (d.btnRedo)      d.btnRedo.addEventListener('click',      () => this.redo());
      if (d.btnSettings)  d.btnSettings.addEventListener('click',  () => this.openSettingsDialog());
      if (d.btnExport)    d.btnExport.addEventListener('click',    () => this.openExportDialog());
      if (d.btnAddSuite)  d.btnAddSuite.addEventListener('click',  () => this.addSuite());
      if (d.btnAddData)   d.btnAddData.addEventListener('click',   () => this.importTestDataCSV());
      if (d.btnAddProfile) d.btnAddProfile.addEventListener('click', () => {
        const name = prompt('Profile name:');
        if (name) this.addProfile(name);
      });
      if (d.speedSelect)  d.speedSelect.addEventListener('change', () => {
        this.settings.speed = d.speedSelect.value;
        this._saveSettings();
      });
    }

    _bindCommandTable() {
      const tbody = this._dom.commandTbody;
      const table = this._dom.commandTable;
      if (!tbody || !table) return;

      // Row selection
      tbody.addEventListener('click', (e) => {
        const tr = e.target.closest('tr');
        if (!tr || !tr.dataset.index) return;
        const index = parseInt(tr.dataset.index, 10);

        // Breakpoint toggle via dot
        if (e.target.classList.contains('bp-dot')) {
          this.toggleBreakpoint(index);
          return;
        }

        // Inline pick target
        if (e.target.classList.contains('btn-pick-inline')) {
          this.activatePicker(parseInt(e.target.dataset.index, 10));
          return;
        }

        // Multi-select with Shift/Ctrl
        if (e.shiftKey && this.selectedCommandIndex >= 0) {
          const min = Math.min(this.selectedCommandIndex, index);
          const max = Math.max(this.selectedCommandIndex, index);
          this.selectedCommandIndices = [];
          for (let i = min; i <= max; i++) this.selectedCommandIndices.push(i);
          this._highlightSelectedRows();
        } else if (e.ctrlKey || e.metaKey) {
          const pos = this.selectedCommandIndices.indexOf(index);
          if (pos >= 0) this.selectedCommandIndices.splice(pos, 1);
          else          this.selectedCommandIndices.push(index);
          this.selectedCommandIndex = index;
          this._highlightSelectedRows();
        } else {
          this.selectCommand(index);
        }

        this._updateToolbarState();
      });

      // Double-click to inline edit
      tbody.addEventListener('dblclick', (e) => {
        const cell = e.target.closest('td[data-field]');
        if (!cell) return;
        this._openEditor(cell);
      });

      // Drag-and-drop reorder
      this._bindCommandDragDrop(tbody);
    }

    _bindCommandDragDrop(tbody) {
      let dragIndex = null;

      tbody.addEventListener('dragstart', (e) => {
        const tr = e.target.closest('tr[data-index]');
        if (!tr) return;
        dragIndex = parseInt(tr.dataset.index, 10);
        e.dataTransfer.effectAllowed = 'move';
        tr.classList.add('dragging');
      });

      tbody.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const tr = e.target.closest('tr[data-index]');
        if (tr) tr.classList.add('drag-over');
      });

      tbody.addEventListener('dragleave', (e) => {
        const tr = e.target.closest('tr[data-index]');
        if (tr) tr.classList.remove('drag-over');
      });

      tbody.addEventListener('drop', (e) => {
        e.preventDefault();
        const tr = e.target.closest('tr[data-index]');
        if (!tr || dragIndex === null) return;
        const toIndex = parseInt(tr.dataset.index, 10);
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over', 'dragging'));
        if (dragIndex !== toIndex) this.moveCommand(dragIndex, toIndex);
        dragIndex = null;
      });

      tbody.addEventListener('dragend', () => {
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over', 'dragging'));
        dragIndex = null;
      });

      // Make rows draggable
      const observer = new MutationObserver(() => {
        tbody.querySelectorAll('tr[data-index]').forEach(tr => {
          if (!tr.draggable) tr.draggable = true;
        });
      });
      observer.observe(tbody, { childList: true });
      tbody.querySelectorAll('tr[data-index]').forEach(tr => { tr.draggable = true; });
    }

    _bindArtifactTabs() {
      const tabs = this._dom.artifactTabs;
      if (!tabs) return;
      tabs.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-artifact-tab]');
        if (!tab) return;
        const targetId = tab.dataset.artifactTab;
        tabs.querySelectorAll('[data-artifact-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        ['logContainer','variablesContainer','screenshotsContainer','healingContainer'].forEach(k => {
          if (this._dom[k]) this._dom[k].style.display = 'none';
        });
        const map = {
          log:         'logContainer',
          variables:   'variablesContainer',
          screenshots: 'screenshotsContainer',
          healing:     'healingContainer',
        };
        const key = map[targetId];
        if (key && this._dom[key]) this._dom[key].style.display = 'block';
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
        if (!this.selectedCommandIndices.includes(index)) this.selectCommand(index);
        this._showContextMenu(e.clientX, e.clientY);
      });

      document.addEventListener('click', () => this._hideContextMenu());
    }

    _showContextMenu(x, y) {
      let menu = document.getElementById('cmd-context-menu');
      if (!menu) {
        menu = document.createElement('div');
        menu.id = 'cmd-context-menu';
        menu.className = 'context-menu';
        menu.innerHTML = `
          <div data-action="add">Add command</div>
          <div data-action="copy">Copy</div>
          <div data-action="paste">Paste</div>
          <div data-action="delete">Delete</div>
          <div data-action="breakpoint">Toggle breakpoint</div>
          <hr>
          <div data-action="duplicate">Duplicate test case</div>
        `;
        menu.addEventListener('click', (e) => {
          const action = e.target.dataset.action;
          switch (action) {
            case 'add':        this.addCommand(); break;
            case 'copy':       this.copyCommands(); break;
            case 'paste':      this.pasteCommands(); break;
            case 'delete':     this.deleteCommand(); break;
            case 'breakpoint': this.toggleBreakpoint(this.selectedCommandIndex); break;
            case 'duplicate': {
              if (this.currentSuite && this.currentTestCase)
                this.duplicateTestCase(this.currentSuite.id, this.currentTestCase.id);
              break;
            }
          }
          this._hideContextMenu();
        });
        document.body.appendChild(menu);
      }
      menu.style.display = 'block';
      menu.style.left    = x + 'px';
      menu.style.top     = y + 'px';
    }

    _hideContextMenu() {
      const menu = document.getElementById('cmd-context-menu');
      if (menu) menu.style.display = 'none';
    }

    // ── Inline Editor ─────────────────────────────────────────

    _openEditor(cell) {
      this._commitActiveEditor();
      const field    = cell.dataset.field;
      const rowIndex = parseInt(cell.dataset.index, 10);
      const cmd      = this.currentTestCase && this.currentTestCase.commands[rowIndex];
      if (!cmd) return;

      const input = document.createElement('input');
      input.type  = 'text';
      input.value = cmd[field] || '';
      input.className = 'cell-editor';

      cell.innerHTML = '';
      cell.appendChild(input);
      input.focus();
      input.select();

      this._activeEditor = { rowIndex, field, el: input };

      // Autocomplete on command field
      if (field === 'command') {
        input.addEventListener('input', () => {
          this._showAutocomplete(cell, input.value);
        });
      }

      input.addEventListener('blur',  () => this._commitActiveEditor());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._commitActiveEditor(); }
        if (e.key === 'Tab')   {
          e.preventDefault();
          this._commitActiveEditor();
          this._focusNextCell(cell);
        }
        if (e.key === 'Escape') {
          this._activeEditor = null;
          this._renderCommandTable();
        }
      });
    }

    _commitActiveEditor() {
      const ae = this._activeEditor;
      if (!ae) return;
      this._activeEditor = null;
      const newValue = ae.el.value;
      this.updateCommand(ae.rowIndex, ae.field, newValue);
      this._hideAutocomplete();
    }

    _patchCell(index, field, value) {
      const tr = this._rowByIndex(index);
      if (!tr) return;
      const cell = tr.querySelector(`[data-field="${field}"]`);
      if (!cell) return;

      // Don't overwrite if it's currently being edited
      if (cell.querySelector('.cell-editor')) return;

      const span = cell.querySelector('.cell-text');
      if (span) {
        span.textContent = value;
      } else {
        this._renderCommandTable();
      }
    }

    _focusNextCell(currentCell) {
      const fields = ['command', 'target', 'value'];
      const curField = currentCell.dataset.field;
      const curIdx   = parseInt(currentCell.dataset.index, 10);
      const fi       = fields.indexOf(curField);

      let nextField = fields[fi + 1];
      let nextIndex = curIdx;

      if (!nextField) {
        nextField = fields[0];
        nextIndex = curIdx + 1;
      }

      const nextRow = this._rowByIndex(nextIndex);
      if (!nextRow) return;
      const nextCell = nextRow.querySelector(`[data-field="${nextField}"]`);
      if (nextCell) this._openEditor(nextCell);
    }

    // ── Extensions tab ────────────────────────────────────────

    _renderExtensionsTab() {
      const container = this._dom.extensionsTab;
      if (!container) return;

      if (!this.extensionScripts.length) {
        container.innerHTML = '<p class="empty-msg">No extension scripts. Click <strong>+ Add</strong>.</p>';
        return;
      }

      container.innerHTML = this.extensionScripts.map((s, i) => `
        <div class="ext-item" data-id="${s.id}">
          <div class="ext-header">
            <span>${esc(s.name)}</span>
            <button class="btn-ext-delete" data-id="${s.id}">✕</button>
          </div>
          <textarea class="ext-code" data-id="${s.id}" rows="4">${esc(s.code)}</textarea>
        </div>
      `).join('');

      container.querySelectorAll('.btn-ext-delete').forEach(btn => {
        btn.addEventListener('click', () => {
          this.extensionScripts = this.extensionScripts.filter(s => s.id !== btn.dataset.id);
          this._saveExtensionScripts();
          this._renderExtensionsTab();
        });
      });

      container.querySelectorAll('.ext-code').forEach(ta => {
        ta.addEventListener('change', () => {
          const s = this.extensionScripts.find(es => es.id === ta.dataset.id);
          if (s) { s.code = ta.value; this._saveExtensionScripts(); }
        });
      });
    }

    addExtensionScript(name, code) {
      this.extensionScripts.push({ id: uid(), name: name || 'Script', code: code || '' });
      this._saveExtensionScripts();
      this._renderExtensionsTab();
    }

    // ── Download helper ───────────────────────────────────────
    _downloadText(text, filename, mimeType) {
      const blob = new Blob([text], { type: mimeType || 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

  } // end class SeleniumForgeApp

  // ─────────────────────────────────────────────────────────────
  // Bootstrap
  // ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      global.app = new SeleniumForgeApp();
      global.app.init().catch(console.error);
    });
  } else {
    global.app = new SeleniumForgeApp();
    global.app.init().catch(console.error);
  }

})(window);
