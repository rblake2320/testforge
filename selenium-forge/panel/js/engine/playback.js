/**
 * SeleniumForge PlaybackEngine
 * ============================================================
 * Manages execution of Selenese test cases and test suites.
 *
 * Responsibilities:
 *  - Execute single commands, test cases, and test suites
 *  - Speed control, pause/resume, stop
 *  - Breakpoint support and step-by-step debugging
 *  - Variable substitution (${varName}, javascript{expr})
 *  - Built-in key constants (${KEY_ENTER}, etc.)
 *  - Command dispatch via chrome.tabs.sendMessage
 *  - AndWait / open / window / frame handling
 *  - Per-command timeout (default 30 s, settable via setTimeout command)
 *  - Self-healing: on locator failure, ask content script for alternatives
 *  - Rich event system for UI subscribers
 *  - Execution log generation
 *  - Integration with ControlFlowEngine for branching/loops
 *
 * Usage:
 *   const engine = new PlaybackEngine();
 *   engine.on('log', ({level, message}) => console.log(message));
 *   await engine.runTestCase(testCase, tabId);
 *
 * No ES-module syntax – attaches to window.PlaybackEngine.
 */

(function (global) {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────

  /** Execution speed presets (milliseconds delay between commands). */
  const SPEED = {
    SLOW:    2000,
    MEDIUM:  1000,
    FAST:    300,
    FASTEST: 0,
  };

  /** Default per-command timeout in milliseconds. */
  const DEFAULT_TIMEOUT_MS = 30000;

  /**
   * Built-in key constant variables.
   * These are substituted when ${KEY_*} appears in target/value.
   */
  const KEY_CONSTANTS = {
    KEY_ENTER:      '\uE007',
    KEY_TAB:        '\uE004',
    KEY_BACKSPACE:  '\uE003',
    KEY_DELETE:     '\uE017',
    KEY_ESC:        '\uE00C',
    KEY_ESCAPE:     '\uE00C',
    KEY_UP:         '\uE013',
    KEY_DOWN:       '\uE015',
    KEY_LEFT:       '\uE012',
    KEY_RIGHT:      '\uE014',
    KEY_HOME:       '\uE011',
    KEY_END:        '\uE010',
    KEY_PAGE_UP:    '\uE00E',
    KEY_PAGE_DOWN:  '\uE00F',
    KEY_F1:         '\uE031',
    KEY_F2:         '\uE032',
    KEY_F3:         '\uE033',
    KEY_F4:         '\uE034',
    KEY_F5:         '\uE035',
    KEY_F6:         '\uE036',
    KEY_F7:         '\uE037',
    KEY_F8:         '\uE038',
    KEY_F9:         '\uE039',
    KEY_F10:        '\uE03A',
    KEY_F11:        '\uE03B',
    KEY_F12:        '\uE03C',
    KEY_SHIFT:      '\uE008',
    KEY_CTRL:       '\uE009',
    KEY_CONTROL:    '\uE009',
    KEY_ALT:        '\uE00A',
    KEY_META:       '\uE03D',
    KEY_SPACE:      '\uE00D',
    KEY_SEMICOLON:  '\uE018',
    KEY_EQUALS:     '\uE019',
    KEY_NUMPAD0:    '\uE01A',
    KEY_NUMPAD1:    '\uE01B',
    KEY_NUMPAD2:    '\uE01C',
    KEY_NUMPAD3:    '\uE01D',
    KEY_NUMPAD4:    '\uE01E',
    KEY_NUMPAD5:    '\uE01F',
    KEY_NUMPAD6:    '\uE020',
    KEY_NUMPAD7:    '\uE021',
    KEY_NUMPAD8:    '\uE022',
    KEY_NUMPAD9:    '\uE023',
    KEY_MULTIPLY:   '\uE024',
    KEY_ADD:        '\uE025',
    KEY_SEPARATOR:  '\uE026',
    KEY_SUBTRACT:   '\uE027',
    KEY_DECIMAL:    '\uE028',
    KEY_DIVIDE:     '\uE029',
  };

  // Commands that the playback engine handles directly (not dispatched to content)
  const ENGINE_COMMANDS = new Set([
    'open', 'setTimeout', 'setSpeed', 'pause', 'echo', 'store',
    'storeText', 'storeValue', 'storeEval', 'storeAttribute',
    'storeTitle', 'storeLocation', 'storeChecked',
    'storeXpathCount', 'storeCssCount', 'storeAllLinks',
    'selectWindow', 'selectFrame', 'selectPopUp', 'deselectPopUp',
    'waitForPageToLoad', 'waitForFrameToLoad',
    'label', 'gotoLabel', 'gotoIf',
    'if', 'elseif', 'else', 'endif',
    'while', 'endwhile', 'do', 'repeatIf',
    'times', 'end', 'break',
    'loadVars', 'endLoadVars',
  ]);

  // Commands whose base form requires waiting for page load after execution
  const AND_WAIT_BASE_COMMANDS = new Set([
    'click', 'clickAt', 'doubleClick', 'submit', 'type', 'select',
    'check', 'uncheck', 'mouseDown', 'mouseUp', 'keyPress', 'keyDown',
  ]);

  // ─────────────────────────────────────────────────────────────
  // PlaybackEngine Class
  // ─────────────────────────────────────────────────────────────

  class PlaybackEngine {
    constructor(options = {}) {
      // --- Configuration ---
      this._speed         = options.speed   !== undefined ? options.speed   : SPEED.MEDIUM;
      this._timeoutMs     = options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS;

      // --- State ---
      this._state         = 'idle';   // 'idle' | 'running' | 'paused' | 'stopped'
      this._currentTabId  = null;
      this._breakpoints   = new Set(); // Set of command indices
      this._stepMode      = false;     // true = execute one command then pause

      // --- Variables ---
      // Merged: built-in constants + user-set variables
      this._vars          = Object.assign({}, KEY_CONSTANTS);

      // --- Execution context ---
      this._currentTestCase   = null;  // { name, commands[] }
      this._currentSuite      = null;  // { name, testCases[] }
      this._currentIndex      = -1;    // command index in current test case
      this._log               = [];    // array of log entry strings
      this._healingSuggestions = [];   // [{index, original, suggested}]

      // --- Pause/resume synchronization ---
      // _pauseResolve is set when we're waiting for resume; calling it unblocks execution.
      this._pauseResolve  = null;
      this._stopRequested = false;

      // --- Control flow integration ---
      // The ControlFlowEngine instance (set via attachControlFlow)
      this._controlFlow   = null;

      // --- Event listeners ---
      this._listeners     = {};

      // --- Results accumulation ---
      this._testCaseResults = null;
      this._suiteResults    = null;
    }

    // ───────────────────────────────────────────────
    // Public API – Configuration
    // ───────────────────────────────────────────────

    /** Set execution speed to one of the SPEED presets or a custom ms value. */
    setSpeed(speedMsOrPreset) {
      if (typeof speedMsOrPreset === 'string') {
        const preset = speedMsOrPreset.toUpperCase();
        if (SPEED[preset] !== undefined) {
          this._speed = SPEED[preset];
        } else {
          this._emit('log', { timestamp: this._ts(), level: 'warn',
            message: `Unknown speed preset "${speedMsOrPreset}", ignoring.` });
        }
      } else {
        this._speed = Math.max(0, Number(speedMsOrPreset) || 0);
      }
    }

    /** Set per-command timeout in milliseconds. */
    setTimeout(ms) {
      this._timeoutMs = Math.max(0, Number(ms) || DEFAULT_TIMEOUT_MS);
    }

    /** Attach a ControlFlowEngine to handle branching/loops/goto. */
    attachControlFlow(controlFlowEngine) {
      this._controlFlow = controlFlowEngine;
    }

    /** Set or clear a breakpoint at a command index. */
    toggleBreakpoint(index) {
      if (this._breakpoints.has(index)) {
        this._breakpoints.delete(index);
      } else {
        this._breakpoints.add(index);
      }
    }

    /** Replace the full breakpoint set. */
    setBreakpoints(indexSet) {
      this._breakpoints = new Set(indexSet);
    }

    // ───────────────────────────────────────────────
    // Public API – Execution Control
    // ───────────────────────────────────────────────

    /**
     * Run a single test case.
     * @param {Object} testCase  - { name: string, commands: [{command, target, value}] }
     * @param {number} tabId     - Chrome tab ID to execute commands in
     * @returns {Promise<Object>} - { passed, failed, errors }
     */
    async runTestCase(testCase, tabId) {
      this._currentTabId    = tabId;
      this._currentTestCase = testCase;
      this._currentSuite    = null;
      this._stopRequested   = false;
      this._state           = 'running';
      this._healingSuggestions = [];

      this._emit('testCaseStart', { name: testCase.name });
      this._logMsg('info', `Test case started: ${testCase.name}`);

      const result = await this._executeTestCase(testCase);

      this._emit('testCaseComplete', {
        name:   testCase.name,
        passed: result.passed,
        failed: result.failed,
        errors: result.errors,
      });
      this._logMsg('info',
        `Test case complete: ${testCase.name} — ` +
        `passed: ${result.passed}, failed: ${result.failed}, errors: ${result.errors}`);

      this._state = 'idle';
      return result;
    }

    /**
     * Run all test cases in a suite sequentially.
     * @param {Object} suite  - { name: string, testCases: [testCase, ...] }
     * @param {number} tabId
     * @returns {Promise<Object>} - { total, passed, failed }
     */
    async runTestSuite(suite, tabId) {
      this._currentTabId  = tabId;
      this._currentSuite  = suite;
      this._stopRequested = false;
      this._state         = 'running';

      const suiteResults = { total: 0, passed: 0, failed: 0 };
      this._logMsg('info', `Suite started: ${suite.name}`);

      for (const testCase of suite.testCases) {
        if (this._stopRequested) break;

        const result = await this.runTestCase(testCase, tabId);
        suiteResults.total  += 1;
        suiteResults.passed += result.failed === 0 && result.errors === 0 ? 1 : 0;
        suiteResults.failed += result.failed > 0 || result.errors > 0  ? 1 : 0;
      }

      this._emit('testSuiteComplete', { name: suite.name, results: suiteResults });
      this._logMsg('info',
        `Suite complete: ${suite.name} — ` +
        `total: ${suiteResults.total}, passed: ${suiteResults.passed}, failed: ${suiteResults.failed}`);

      this._state = 'idle';
      return suiteResults;
    }

    /**
     * Run an array of test suites sequentially.
     * @param {Array}  suites - array of suite objects
     * @param {number} tabId
     * @returns {Promise<Array>} - array of suite result objects
     */
    async runAllSuites(suites, tabId) {
      const allResults = [];
      for (const suite of suites) {
        if (this._stopRequested) break;
        const result = await this.runTestSuite(suite, tabId);
        allResults.push({ suite: suite.name, ...result });
      }
      return allResults;
    }

    /**
     * Execute a single command immediately, outside a test case run.
     * Useful for the UI "Run this command" button.
     * @param {Object} cmd   - { command, target, value }
     * @param {number} tabId
     * @returns {Promise<Object>} - { status, message, duration }
     */
    async runSingleCommand(cmd, tabId) {
      this._currentTabId  = tabId;
      this._stopRequested = false;
      // Temporarily set state so dispatch methods behave correctly.
      const prevState = this._state;
      this._state = 'running';
      const result = await this._dispatchCommand(cmd, 0);
      this._state = prevState;
      return result;
    }

    /** Pause execution (takes effect after current command finishes). */
    pause() {
      if (this._state === 'running') {
        this._state = 'paused';
        this._logMsg('info', 'Execution paused by user.');
      }
    }

    /**
     * Resume after a pause.
     * Resolves the pause promise so the execution loop continues.
     */
    resume() {
      if (this._state === 'paused' && this._pauseResolve) {
        this._state = 'running';
        this._logMsg('info', 'Execution resumed.');
        const resolve = this._pauseResolve;
        this._pauseResolve = null;
        resolve();
      }
    }

    /** Stop execution at the next opportunity. */
    stop() {
      this._stopRequested = true;
      this._state         = 'stopped';
      // If currently paused, unblock so the loop can check _stopRequested and exit.
      if (this._pauseResolve) {
        const resolve = this._pauseResolve;
        this._pauseResolve = null;
        resolve();
      }
      this._emit('stopped', {});
      this._logMsg('info', 'Execution stopped by user.');
    }

    /**
     * Enable step mode: after the next command completes, automatically pause.
     * Call resume() to advance one more step.
     */
    enableStepMode() {
      this._stepMode = true;
    }

    /** Disable step mode; execution continues at normal speed. */
    disableStepMode() {
      this._stepMode = false;
    }

    // ───────────────────────────────────────────────
    // Public API – Variables
    // ───────────────────────────────────────────────

    /** Store a variable value (also used internally by store* commands). */
    setVariable(name, value) {
      this._vars[name] = value;
      this._emit('variableUpdated', { name, value });
    }

    /** Retrieve a variable value. */
    getVariable(name) {
      return this._vars[name];
    }

    /** Return a shallow copy of all current variables. */
    getAllVariables() {
      return Object.assign({}, this._vars);
    }

    /** Clear user-set variables (preserves KEY_* built-ins). */
    clearVariables() {
      this._vars = Object.assign({}, KEY_CONSTANTS);
    }

    // ───────────────────────────────────────────────
    // Public API – Event System
    // ───────────────────────────────────────────────

    /**
     * Subscribe to an engine event.
     * @param {string}   event   - event name
     * @param {Function} handler - callback function
     */
    on(event, handler) {
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(handler);
      return this; // allow chaining
    }

    /** Unsubscribe a previously attached handler. */
    off(event, handler) {
      if (!this._listeners[event]) return this;
      this._listeners[event] = this._listeners[event].filter(h => h !== handler);
      return this;
    }

    // ───────────────────────────────────────────────
    // Public API – Misc
    // ───────────────────────────────────────────────

    /** Return the execution log as an array of strings. */
    getLog() {
      return this._log.slice();
    }

    /** Return all healing suggestions from the last run. */
    getHealingSuggestions() {
      return this._healingSuggestions.slice();
    }

    /** Current execution state string. */
    getState() {
      return this._state;
    }

    /** SPEED constants exposed for convenience. */
    static get SPEED() { return SPEED; }

    // ═══════════════════════════════════════════════════════════
    // Private – Test Case Execution Loop
    // ═══════════════════════════════════════════════════════════

    /**
     * Core execution loop for a test case.
     * Uses ControlFlowEngine (if attached) to determine the next index.
     * @private
     */
    async _executeTestCase(testCase) {
      const commands = testCase.commands || [];
      const results  = { passed: 0, failed: 0, errors: 0 };

      // Initialise control flow pre-processing for this test case.
      if (this._controlFlow) {
        this._controlFlow.preProcess(commands);
      }

      let index = 0;

      while (index < commands.length) {
        // ── Stop check ──
        if (this._stopRequested) break;

        // ── Breakpoint check ──
        if (this._breakpoints.has(index)) {
          this._state = 'paused';
          this._emit('paused', { index });
          this._logMsg('info', `Breakpoint hit at command ${index}`);
          await this._waitForResume();
          if (this._stopRequested) break;
        }

        // ── Pause check (manual pause) ──
        if (this._state === 'paused') {
          this._emit('paused', { index });
          await this._waitForResume();
          if (this._stopRequested) break;
        }

        const cmd = commands[index];
        this._currentIndex = index;

        // ── Emit commandStart ──
        this._emit('commandStart', {
          index,
          command: cmd.command,
          target:  cmd.target,
          value:   cmd.value,
        });

        // ── Dispatch command ──
        const cmdResult = await this._dispatchCommand(cmd, index);

        // ── Tally results ──
        if (cmdResult.status === 'passed') {
          results.passed++;
        } else if (cmdResult.status === 'failed') {
          results.failed++;
        } else if (cmdResult.status === 'error') {
          results.errors++;
        }

        // ── Emit commandComplete ──
        this._emit('commandComplete', {
          index,
          status:   cmdResult.status,
          message:  cmdResult.message,
          duration: cmdResult.duration,
        });

        // ── Log entry ──
        this._addLogEntry(index, cmd, cmdResult);

        // ── Determine next index ──
        if (this._controlFlow) {
          const next = this._controlFlow.getNextCommandIndex(index, cmdResult, this._vars);
          if (next === null || next === undefined) {
            // Control flow signals end of test case (e.g. all loops exhausted)
            break;
          }
          index = next;
        } else {
          index++;
        }

        // ── Speed delay ──
        if (this._speed > 0 && !this._stopRequested) {
          await this._delay(this._speed);
        }

        // ── Step mode – pause after each command ──
        if (this._stepMode && !this._stopRequested) {
          this._state = 'paused';
          this._emit('paused', { index });
          await this._waitForResume();
          if (this._stopRequested) break;
        }
      }

      return results;
    }

    // ═══════════════════════════════════════════════════════════
    // Private – Command Dispatch
    // ═══════════════════════════════════════════════════════════

    /**
     * Dispatch a single command:
     *  1. Substitute variables in target/value
     *  2. Route to engine handler or content script
     *  3. Wrap in timeout
     *  4. Handle AndWait suffix
     *  5. Attempt self-healing on locator failure
     * @private
     */
    async _dispatchCommand(rawCmd, index) {
      const startTime = Date.now();

      // ── Normalise ──
      const commandName = (rawCmd.command || '').trim();
      const rawTarget   = rawCmd.target || '';
      const rawValue    = rawCmd.value  || '';

      // ── Variable substitution ──
      let target = this._substituteVars(rawTarget);
      let value  = this._substituteVars(rawValue);

      // ── AndWait detection ──
      const isAndWait   = commandName.endsWith('AndWait');
      const baseCommand = isAndWait
        ? commandName.slice(0, -'AndWait'.length)
        : commandName;

      let result;

      try {
        // ── Route: engine-handled commands ──
        if (this._isEngineCommand(baseCommand)) {
          result = await this._withTimeout(
            this._handleEngineCommand(baseCommand, target, value, index, rawCmd),
            this._timeoutMs,
            baseCommand
          );
        } else {
          // ── Route: content script ──
          result = await this._withTimeout(
            this._sendToContentScript(baseCommand, target, value),
            this._timeoutMs,
            baseCommand
          );

          // ── Self-healing: if locator not found, try alternatives ──
          if (result.status !== 'passed' && result.locatorError) {
            const healed = await this._attemptHealing(index, baseCommand, target, value);
            if (healed) {
              result = healed;
            }
          }
        }

        // ── AndWait: wait for page load after successful command ──
        if (isAndWait && result.status === 'passed') {
          await this._withTimeout(
            this._waitForPageLoad(),
            this._timeoutMs,
            'waitForPageToLoad'
          );
        }

      } catch (err) {
        result = {
          status:  'error',
          message: err.message || String(err),
        };
      }

      result.duration = Date.now() - startTime;
      return result;
    }

    /**
     * Determine whether a command is handled locally by the engine.
     * @private
     */
    _isEngineCommand(commandName) {
      return ENGINE_COMMANDS.has(commandName);
    }

    // ═══════════════════════════════════════════════════════════
    // Private – Engine-Side Command Handlers
    // ═══════════════════════════════════════════════════════════

    /**
     * Handle commands that do not go to the content script.
     * @private
     */
    async _handleEngineCommand(command, target, value, index, rawCmd) {
      switch (command) {

        // ── Navigation ──
        case 'open':
          return await this._handleOpen(target);

        // ── Echo (log a message) ──
        case 'echo':
          this._logMsg('info', `[echo] ${target}`);
          return { status: 'passed', message: target };

        // ── Timeout configuration ──
        case 'setTimeout': {
          const ms = parseInt(target, 10);
          if (!isNaN(ms)) {
            this._timeoutMs = ms;
            return { status: 'passed', message: `Timeout set to ${ms}ms` };
          }
          return { status: 'error', message: `Invalid timeout value: "${target}"` };
        }

        // ── Speed configuration ──
        case 'setSpeed': {
          this.setSpeed(target);
          return { status: 'passed', message: `Speed set to ${target}` };
        }

        // ── Pause (in-script pause command, not user pause) ──
        case 'pause': {
          const ms = parseInt(target, 10);
          if (!isNaN(ms) && ms > 0) {
            await this._delay(ms);
          }
          return { status: 'passed', message: `Paused ${target}ms` };
        }

        // ── Store variable ──
        case 'store':
          // store | value | variableName
          this.setVariable(value, target);
          return { status: 'passed', message: `Stored "${target}" → ${value}` };

        // ── storeEval ──
        case 'storeEval': {
          const evalResult = await this._evaluateJsInTab(target);
          if (evalResult.error) {
            return { status: 'error', message: evalResult.error };
          }
          this.setVariable(value, evalResult.result);
          return { status: 'passed', message: `Stored eval result → ${value}` };
        }

        // ── storeTitle ──
        case 'storeTitle': {
          const evalResult = await this._evaluateJsInTab('document.title');
          if (evalResult.error) return { status: 'error', message: evalResult.error };
          this.setVariable(target, evalResult.result);
          return { status: 'passed', message: `Stored title → ${target}` };
        }

        // ── storeLocation ──
        case 'storeLocation': {
          const evalResult = await this._evaluateJsInTab('window.location.href');
          if (evalResult.error) return { status: 'error', message: evalResult.error };
          this.setVariable(target, evalResult.result);
          return { status: 'passed', message: `Stored location → ${target}` };
        }

        // ── storeText / storeValue / storeAttribute / storeChecked / store*Count ──
        case 'storeText':
        case 'storeValue':
        case 'storeAttribute':
        case 'storeChecked':
        case 'storeXpathCount':
        case 'storeCssCount':
        case 'storeAllLinks': {
          // Delegate to content script for DOM access; re-label the command.
          const r = await this._sendToContentScript(command, target, value);
          if (r.status === 'passed' && r.storedValue !== undefined) {
            this.setVariable(value, r.storedValue);
          }
          return r;
        }

        // ── Window / Frame selection (pass to content script) ──
        case 'selectWindow':
        case 'selectFrame':
        case 'selectPopUp':
        case 'deselectPopUp': {
          return await this._handleWindowFrame(command, target, value);
        }

        // ── Wait for page load ──
        case 'waitForPageToLoad':
          await this._waitForPageLoad(parseInt(target, 10) || this._timeoutMs);
          return { status: 'passed', message: 'Page loaded' };

        case 'waitForFrameToLoad':
          // Frame load is handled in the content script context
          return await this._sendToContentScript(command, target, value);

        // ── Control flow commands – handled by ControlFlowEngine ──
        case 'label':
        case 'gotoLabel':
        case 'gotoIf':
        case 'if':
        case 'elseif':
        case 'else':
        case 'endif':
        case 'while':
        case 'endwhile':
        case 'do':
        case 'repeatIf':
        case 'times':
        case 'end':
        case 'break':
        case 'loadVars':
        case 'endLoadVars':
          // These are structural; the ControlFlowEngine intercepts them via
          // getNextCommandIndex. We just return passed so the loop advances.
          return { status: 'passed', message: `[control flow] ${command}` };

        default:
          return { status: 'error', message: `Unknown engine command: "${command}"` };
      }
    }

    // ─────────────────────────────────────────────────────────
    // open command
    // ─────────────────────────────────────────────────────────

    /**
     * Handle the `open` command: navigate the current tab to a URL.
     * Supports absolute URLs and relative paths (prepended with page origin).
     * @private
     */
    async _handleOpen(url) {
      if (!this._currentTabId) {
        return { status: 'error', message: 'No active tab ID set for open command.' };
      }

      // Resolve relative URL against the current tab's URL if needed
      let resolvedUrl = url;
      if (!/^https?:\/\//i.test(url) && !url.startsWith('file://')) {
        try {
          const tabInfo = await this._getTabInfo(this._currentTabId);
          const origin  = new URL(tabInfo.url).origin;
          resolvedUrl   = origin + (url.startsWith('/') ? url : '/' + url);
        } catch (_) {
          // Best-effort; use as-is
        }
      }

      return new Promise((resolve) => {
        chrome.tabs.update(this._currentTabId, { url: resolvedUrl }, () => {
          if (chrome.runtime.lastError) {
            resolve({ status: 'error', message: chrome.runtime.lastError.message });
            return;
          }
          // Wait for page to finish loading
          const onUpdated = (tabId, changeInfo) => {
            if (tabId === this._currentTabId && changeInfo.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(onUpdated);
              resolve({ status: 'passed', message: `Navigated to ${resolvedUrl}` });
            }
          };
          chrome.tabs.onUpdated.addListener(onUpdated);

          // Safety timeout
          global.setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve({ status: 'passed', message: `Navigation initiated (timeout reached)` });
          }, this._timeoutMs);
        });
      });
    }

    // ─────────────────────────────────────────────────────────
    // Window / Frame handling
    // ─────────────────────────────────────────────────────────

    /**
     * Handle window and frame selection commands.
     * @private
     */
    async _handleWindowFrame(command, target, value) {
      if (command === 'selectWindow') {
        // target can be 'null' (main window), 'name=windowName', or a tab title
        if (!target || target === 'null') {
          // Focus main window – just update to current tab
          return { status: 'passed', message: 'Selected main window' };
        }
        // Try to find a matching tab by title or window handle
        const tabs = await this._queryTabs(target);
        if (tabs.length > 0) {
          this._currentTabId = tabs[0].id;
          return { status: 'passed', message: `Selected window: ${target}` };
        }
        return { status: 'error', message: `Window not found: ${target}` };
      }

      // selectFrame, deselectPopUp etc. – send to content script
      return await this._sendToContentScript(command, target, value);
    }

    // ─────────────────────────────────────────────────────────
    // Content Script Communication
    // ─────────────────────────────────────────────────────────

    /**
     * Send a command to the content script running in the current tab.
     * Returns a normalised result object: { status, message, [storedValue], [locatorError] }
     * @private
     */
    _sendToContentScript(command, target, value) {
      return new Promise((resolve) => {
        if (!this._currentTabId) {
          resolve({ status: 'error', message: 'No active tab ID for content script dispatch.' });
          return;
        }

        const message = {
          type:    'SF_PLAY_COMMAND',
          command: command,
          target:  target,
          value:   value,
        };

        try {
          chrome.tabs.sendMessage(this._currentTabId, message, (response) => {
            if (chrome.runtime.lastError) {
              resolve({
                status:  'error',
                message: chrome.runtime.lastError.message || 'Content script not responding.',
              });
              return;
            }

            if (!response) {
              resolve({ status: 'error', message: 'No response from content script.' });
              return;
            }

            // Normalise response fields
            resolve({
              status:       response.status       || 'error',
              message:      response.message      || '',
              storedValue:  response.storedValue,
              locatorError: response.locatorError || false,
              screenshot:   response.screenshot,
            });
          });
        } catch (err) {
          resolve({ status: 'error', message: String(err) });
        }
      });
    }

    // ─────────────────────────────────────────────────────────
    // Page Load Waiting
    // ─────────────────────────────────────────────────────────

    /**
     * Wait for the current tab to finish loading (status === 'complete').
     * Resolves immediately if already complete.
     * @private
     */
    _waitForPageLoad(timeoutMs) {
      const deadline = timeoutMs || this._timeoutMs;
      return new Promise((resolve) => {
        if (!this._currentTabId) {
          resolve();
          return;
        }

        // Check current status first
        chrome.tabs.get(this._currentTabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            resolve();
            return;
          }
          if (tab.status === 'complete') {
            resolve();
            return;
          }

          const timer = global.setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve(); // resolve anyway on timeout
          }, deadline);

          const listener = (tabId, changeInfo) => {
            if (tabId === this._currentTabId && changeInfo.status === 'complete') {
              global.clearTimeout(timer);
              chrome.tabs.onUpdated.removeListener(listener);
              // Brief additional delay for JS to settle after load
              global.setTimeout(resolve, 100);
            }
          };

          chrome.tabs.onUpdated.addListener(listener);
        });
      });
    }

    // ─────────────────────────────────────────────────────────
    // JavaScript Evaluation in Tab
    // ─────────────────────────────────────────────────────────

    /**
     * Evaluate a JavaScript expression in the context of the current tab.
     * Used for storeEval, storeTitle, condition evaluation, etc.
     * @private
     */
    _evaluateJsInTab(expression) {
      return new Promise((resolve) => {
        if (!this._currentTabId) {
          resolve({ error: 'No active tab for JS evaluation.' });
          return;
        }
        try {
          chrome.scripting.executeScript(
            {
              target: { tabId: this._currentTabId },
              func: function (expr) {
                try {
                  /* eslint-disable no-eval */
                  const result = eval(expr); // eslint-disable-line no-eval
                  return { result: result };
                } catch (e) {
                  return { error: e.message };
                }
              },
              args: [expression],
            },
            (injectionResults) => {
              if (chrome.runtime.lastError) {
                resolve({ error: chrome.runtime.lastError.message });
                return;
              }
              if (!injectionResults || !injectionResults[0]) {
                resolve({ error: 'No result from script injection.' });
                return;
              }
              resolve(injectionResults[0].result || { error: 'Unknown error' });
            }
          );
        } catch (err) {
          resolve({ error: String(err) });
        }
      });
    }

    // ─────────────────────────────────────────────────────────
    // Self-Healing
    // ─────────────────────────────────────────────────────────

    /**
     * When a locator fails, ask the content script to suggest alternative locators.
     * If one works, record the suggestion and return the successful result.
     * @private
     */
    async _attemptHealing(index, command, failedTarget, value) {
      if (!this._currentTabId) return null;

      this._logMsg('warn', `Self-healing: looking for alternatives to locator "${failedTarget}"`);

      return new Promise((resolve) => {
        const message = {
          type:          'SF_GET_HEALING_SUGGESTIONS',
          command:       command,
          failedTarget:  failedTarget,
          value:         value,
        };

        chrome.tabs.sendMessage(this._currentTabId, message, (response) => {
          if (chrome.runtime.lastError || !response || !response.alternatives) {
            resolve(null);
            return;
          }

          const alternatives = response.alternatives;
          if (!alternatives.length) {
            resolve(null);
            return;
          }

          // Try each alternative in order
          let tryIndex = 0;
          const tryNext = () => {
            if (tryIndex >= alternatives.length) {
              resolve(null);
              return;
            }
            const alt = alternatives[tryIndex++];
            this._sendToContentScript(command, alt, value).then((result) => {
              if (result.status === 'passed') {
                const suggestion = {
                  index,
                  original:  failedTarget,
                  suggested: alt,
                };
                this._healingSuggestions.push(suggestion);
                this._emit('healingSuggestion', suggestion);
                this._logMsg('info',
                  `Self-healing succeeded: "${failedTarget}" → "${alt}"`);
                resolve(result);
              } else {
                tryNext();
              }
            });
          };
          tryNext();
        });
      });
    }

    // ═══════════════════════════════════════════════════════════
    // Private – Variable Substitution
    // ═══════════════════════════════════════════════════════════

    /**
     * Substitute all ${varName} references and javascript{expr} blocks in a string.
     *
     * Supported patterns:
     *   ${varName}              → this._vars['varName']
     *   javascript{expression}  → evaluated JS string
     *   storedVars['name']      → within JS expressions (patched automatically)
     *
     * @param {string} str
     * @returns {string}
     * @private
     */
    _substituteVars(str) {
      if (!str || typeof str !== 'string') return str;

      // 1. javascript{...} evaluation (synchronous via Function())
      str = str.replace(/javascript\{([\s\S]*?)\}/g, (_, expr) => {
        try {
          // Patch storedVars references so expressions like storedVars['x'] work
          const storedVars = this._vars; // eslint-disable-line no-unused-vars
          /* eslint-disable no-new-func */
          const fn     = new Function('storedVars', `return (${expr})`);
          const result = fn(this._vars);
          return result !== undefined ? String(result) : '';
        } catch (e) {
          this._logMsg('warn', `javascript{} evaluation error: ${e.message}`);
          return '';
        }
      });

      // 2. ${varName} substitution
      str = str.replace(/\$\{([^}]+)\}/g, (match, name) => {
        if (Object.prototype.hasOwnProperty.call(this._vars, name)) {
          return String(this._vars[name]);
        }
        // Leave unresolved placeholders as-is (could be dynamic)
        this._logMsg('warn', `Variable not found: ${match}`);
        return match;
      });

      return str;
    }

    // ═══════════════════════════════════════════════════════════
    // Private – Timeout Wrapper
    // ═══════════════════════════════════════════════════════════

    /**
     * Race a promise against a timeout.
     * @param {Promise} promise
     * @param {number}  ms
     * @param {string}  commandName  - used in the timeout error message
     * @private
     */
    _withTimeout(promise, ms, commandName) {
      if (ms <= 0) return promise;

      return new Promise((resolve, reject) => {
        const timer = global.setTimeout(() => {
          reject(new Error(`Command "${commandName}" timed out after ${ms}ms`));
        }, ms);

        promise.then(
          (result) => { global.clearTimeout(timer); resolve(result); },
          (err)    => { global.clearTimeout(timer); reject(err); }
        );
      });
    }

    // ═══════════════════════════════════════════════════════════
    // Private – Pause / Resume Machinery
    // ═══════════════════════════════════════════════════════════

    /**
     * Block execution until resume() is called (or stop() clears the promise).
     * @private
     */
    _waitForResume() {
      return new Promise((resolve) => {
        this._pauseResolve = resolve;
      });
    }

    // ═══════════════════════════════════════════════════════════
    // Private – Chrome API Helpers
    // ═══════════════════════════════════════════════════════════

    /** Promisify chrome.tabs.get */
    _getTabInfo(tabId) {
      return new Promise((resolve, reject) => {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(tab);
        });
      });
    }

    /**
     * Attempt to find tabs matching a window handle description.
     * Supports "title=..." and bare title strings.
     * @private
     */
    _queryTabs(target) {
      return new Promise((resolve) => {
        let queryOptions = {};
        if (target.startsWith('title=')) {
          queryOptions.title = target.slice('title='.length);
        } else if (target.startsWith('name=')) {
          // Window name is not directly queryable; fall back to title search
          queryOptions.title = target.slice('name='.length);
        } else {
          queryOptions.title = target;
        }
        chrome.tabs.query(queryOptions, (tabs) => {
          resolve(tabs || []);
        });
      });
    }

    // ═══════════════════════════════════════════════════════════
    // Private – Logging & Events
    // ═══════════════════════════════════════════════════════════

    /**
     * Emit an event to all registered listeners.
     * @private
     */
    _emit(event, data) {
      const handlers = this._listeners[event];
      if (!handlers || !handlers.length) return;
      for (const handler of handlers) {
        try { handler(data); } catch (_) { /* don't let listener errors kill the loop */ }
      }
    }

    /**
     * Append a structured log entry for a command execution.
     * Format: [HH:MM:SS.mmm] [STATUS] command | target | value (message)
     * @private
     */
    _addLogEntry(index, cmd, result) {
      const ts      = this._ts();
      const status  = (result.status || 'unknown').toUpperCase().padEnd(6);
      const command = (cmd.command || '').padEnd(25);
      const target  = cmd.target || '';
      const value   = cmd.value  || '';
      const msg     = result.message ? ` (${result.message})` : '';
      const entry   = `[${ts}] [${status}] #${index} ${command} | ${target} | ${value}${msg}`;
      this._log.push(entry);

      // Also emit to log event subscribers
      this._emit('log', {
        timestamp: ts,
        level:     result.status === 'passed' ? 'info' : result.status === 'failed' ? 'warn' : 'error',
        message:   entry,
      });
    }

    /**
     * Emit a plain log message (not tied to a command).
     * @private
     */
    _logMsg(level, message) {
      const ts    = this._ts();
      const entry = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}`;
      this._log.push(entry);
      this._emit('log', { timestamp: ts, level, message: entry });
    }

    /**
     * Return a compact timestamp string: HH:MM:SS.mmm
     * @private
     */
    _ts() {
      const now = new Date();
      const hh  = String(now.getHours()).padStart(2, '0');
      const mm  = String(now.getMinutes()).padStart(2, '0');
      const ss  = String(now.getSeconds()).padStart(2, '0');
      const ms  = String(now.getMilliseconds()).padStart(3, '0');
      return `${hh}:${mm}:${ss}.${ms}`;
    }

    /**
     * Promisify setTimeout as a delay.
     * @private
     */
    _delay(ms) {
      return new Promise((resolve) => global.setTimeout(resolve, ms));
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Attach to global scope
  // ─────────────────────────────────────────────────────────────
  // Note: SPEED constants are already exposed via static get SPEED()

  global.PlaybackEngine = PlaybackEngine;

}(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this));
