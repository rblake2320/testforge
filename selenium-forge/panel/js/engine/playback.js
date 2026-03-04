/**
 * SeleniumForge PlaybackEngine
 * ============================================================

 * playback.js
 *
 * Drives sequential (and control-flow-aware) execution of a Selenese
 * test suite inside the Chrome extension panel.
 *
 * Responsibilities
 * ----------------
 * • Iterate over the command list, honouring jumps produced by
 *   ControlFlowEngine.
 * • Dispatch each Selenese command to the content-script tab via
 *   chrome.tabs.sendMessage and await its Promise-wrapped result.
 * • Apply per-command timeout, speed (delay between steps), and
 *   breakpoint support.
 * • Collect a structured log (status, duration, error) per step.
 * • Emit lifecycle events so the UI can react in real-time:
 *     playback:start, playback:step, playback:pause, playback:resume,
 *     playback:stop, playback:complete, playback:error
 * • Support single-step ("step over") mode.
 * • Support nested test runs via the ControlFlowEngine 'run' directive.
 *
 * Dependencies (loaded before this script via manifest.json):
 *   window.CommandRegistry   (commands.js)
 *   window.ControlFlowEngine (controlflow.js)
 *
 * Usage example:
 *   const engine = new PlaybackEngine({ tabId: 42 });
 *   engine.on('playback:step', e => console.log(e.detail));
 *   await engine.run(testSuite);
 *
 * Thread model:
 *   All async work is serialised through an async/await chain.
 *   No Web Workers are used.  The engine is designed to run in the
 *   extension panel page (a full browser context).
 */

(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Constants
  // ------------------------------------------------------------------

  var DEFAULT_COMMAND_TIMEOUT = 30000;  // ms
  var DEFAULT_STEP_DELAY      = 0;      // ms between commands
  var DEFAULT_MAX_ITERATIONS  = 1000;

  var STATUS = {
    PENDING:  'pending',
    RUNNING:  'running',
    PAUSED:   'paused',
    COMPLETE: 'complete',
    STOPPED:  'stopped',
    ERROR:    'error',
  };

  var STEP_STATUS = {
    PASS:    'pass',
    FAIL:    'fail',
    SKIP:    'skip',
    PENDING: 'pending',
  };

  // ------------------------------------------------------------------
  // PlaybackEngine constructor
  // ------------------------------------------------------------------

  /**
   * @param {object} opts
   * @param {number}   opts.tabId            Chrome tab id to send commands to.
   * @param {number}  [opts.commandTimeout]  Per-command timeout in ms (default 30000).
   * @param {number}  [opts.stepDelay]       Delay between steps in ms (default 0).
   * @param {number}  [opts.maxIterations]   Max loop iterations (default 1000).
   * @param {boolean} [opts.breakOnFailure]  Stop on first assertion failure (default false).
   * @param {object}  [opts.eventTarget]     EventTarget to dispatch events on (default document).
   */
  function PlaybackEngine(opts) {
    opts = opts || {};

    this.tabId           = opts.tabId || null;
    this.commandTimeout  = opts.commandTimeout  || DEFAULT_COMMAND_TIMEOUT;
    this.stepDelay       = opts.stepDelay       || DEFAULT_STEP_DELAY;
    this.maxIterations   = opts.maxIterations   || DEFAULT_MAX_ITERATIONS;
    this.breakOnFailure  = opts.breakOnFailure  || false;
    this.eventTarget     = opts.eventTarget     || (typeof document !== 'undefined' ? document : null);

    this._status         = STATUS.PENDING;
    this._log            = [];
    this._breakpoints    = new Set();
    this._pauseRequested = false;
    this._stopRequested  = false;
    this._pauseResolve   = null;  // resolve fn for the pause promise

    // Initialise control-flow engine with a back-reference for 'run' commands
    var self = this;
    this._cf = new ControlFlowEngine({
      runSuite: function (name, args) {
        return self._runNested(name, args);
      },
    });
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Execute a test suite (array of command objects).
   *
   * @param {Array<{command:string, target:string, value:string}>} commands
   * @param {object} [initialVars]  Initial variable bindings.
   * @returns {Promise<object[]>}   Resolves with the step log.
   */
  PlaybackEngine.prototype.run = async function (commands, initialVars) {
    if (this._status === STATUS.RUNNING) {
      throw new Error('PlaybackEngine: already running');
    }

    this._reset();
    this._status = STATUS.RUNNING;
    this._emit('playback:start', { commands: commands });

    var ctx = {
      commands:     commands,
      currentIndex: 0,
      nextIndex:    1,
      vars:         Object.assign({}, initialVars || {}),
      loopCounters: new Map(),
      forEachState: new Map(),
      options: {
        maxIterations: this.maxIterations,
      },
    };

    // Pre-pass: validate control flow nesting
    try {
      this._cf.prepare(commands);
    } catch (err) {
      this._status = STATUS.ERROR;
      this._emit('playback:error', { error: err.message });
      throw err;
    }

    // Main loop
    while (ctx.currentIndex < commands.length) {
      if (this._stopRequested) {
        this._status = STATUS.STOPPED;
        this._emit('playback:stop', { log: this._log });
        break;
      }

      // Breakpoint
      if (this._breakpoints.has(ctx.currentIndex)) {
        await this._doPause(ctx.currentIndex);
        if (this._stopRequested) break;
      }

      // Step delay
      if (this.stepDelay > 0) {
        await _sleep(this.stepDelay);
      }

      var cmd = commands[ctx.currentIndex];
      ctx.nextIndex = ctx.currentIndex + 1;

      // Hand off to control-flow engine
      var cfResult;
      try {
        cfResult = await this._cf.step(ctx);
      } catch (err) {
        this._recordStep(ctx.currentIndex, cmd, STEP_STATUS.FAIL, 0, err.message);
        this._status = STATUS.ERROR;
        this._emit('playback:error', { index: ctx.currentIndex, error: err.message });
        throw err;
      }

      if (cfResult === 'return') {
        // End this suite
        break;
      }

      if (typeof cfResult === 'object' && cfResult.run) {
        // Nested run
        try {
          await this._runNested(cfResult.run, cfResult.args);
        } catch (err) {
          this._recordStep(ctx.currentIndex, cmd, STEP_STATUS.FAIL, 0, err.message);
          if (this.breakOnFailure) {
            this._status = STATUS.ERROR;
            this._emit('playback:error', { index: ctx.currentIndex, error: err.message });
            throw err;
          }
        }
        ctx.currentIndex = ctx.nextIndex;
        continue;
      }

      if (cfResult === 'skip') {
        this._recordStep(ctx.currentIndex, cmd, STEP_STATUS.SKIP, 0, null);
        this._emit('playback:step', this._log[this._log.length - 1]);
        ctx.currentIndex = ctx.nextIndex;
        continue;
      }

      // Execute the command
      var stepStart = Date.now();
      var stepError = null;
      var stepPass  = STEP_STATUS.PASS;

      try {
        await this._executeCommand(cmd, ctx.vars);
      } catch (err) {
        stepError = err.message || String(err);
        stepPass  = STEP_STATUS.FAIL;
      }

      var duration = Date.now() - stepStart;
      this._recordStep(ctx.currentIndex, cmd, stepPass, duration, stepError);
      this._emit('playback:step', this._log[this._log.length - 1]);

      if (stepPass === STEP_STATUS.FAIL && this.breakOnFailure) {
        this._status = STATUS.ERROR;
        this._emit('playback:error', { index: ctx.currentIndex, error: stepError });
        throw new Error(stepError);
      }

      ctx.currentIndex = ctx.nextIndex;
    }

    if (this._status === STATUS.RUNNING) {
      this._status = STATUS.COMPLETE;
      this._emit('playback:complete', { log: this._log });
    }

    return this._log;
  };

  /**
   * Request a pause.  The engine will pause before the next command.
   */
  PlaybackEngine.prototype.pause = function () {
    if (this._status === STATUS.RUNNING) {
      this._pauseRequested = true;
    }
  };

  /**
   * Resume after a pause.
   */
  PlaybackEngine.prototype.resume = function () {
    if (this._status === STATUS.PAUSED && this._pauseResolve) {
      this._status = STATUS.RUNNING;
      this._emit('playback:resume', {});
      this._pauseResolve();
      this._pauseResolve = null;
    }
  };

  /**
   * Stop playback.
   */
  PlaybackEngine.prototype.stop = function () {
    this._stopRequested = true;
    if (this._status === STATUS.PAUSED && this._pauseResolve) {
      this._pauseResolve();
      this._pauseResolve = null;
    }
  };

  /**
   * Toggle a breakpoint at a command index.
   * @param {number} index
   */
  PlaybackEngine.prototype.toggleBreakpoint = function (index) {
    if (this._breakpoints.has(index)) {
      this._breakpoints.delete(index);
    } else {
      this._breakpoints.add(index);
    }
  };

  /**
   * Returns the current playback status string.
   * @returns {string}
   */
  PlaybackEngine.prototype.getStatus = function () {
    return this._status;
  };

  /**
   * Returns the accumulated step log.
   * @returns {object[]}
   */
  PlaybackEngine.prototype.getLog = function () {
    return this._log.slice();
  };

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  PlaybackEngine.prototype._reset = function () {
    this._log            = [];
    this._pauseRequested = false;
    this._stopRequested  = false;
    this._pauseResolve   = null;
    this._status         = STATUS.PENDING;
  };

  /**
   * Send a Selenese command to the content script.
   * @param {{command:string, target:string, value:string}} cmd
   * @param {object} vars  Current variable bindings for interpolation.
   * @returns {Promise<any>}
   */
  PlaybackEngine.prototype._executeCommand = function (cmd, vars) {
    var self    = this;
    var timeout = this.commandTimeout;

    // Interpolate ${varName} references in target and value
    var target = _interpolate(cmd.target || '', vars);
    var value  = _interpolate(cmd.value  || '', vars);

    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('Command timeout: ' + cmd.command + ' (' + timeout + 'ms)'));
      }, timeout);

      if (!self.tabId) {
        clearTimeout(timer);
        reject(new Error('PlaybackEngine: no tabId configured'));
        return;
      }

      chrome.tabs.sendMessage(
        self.tabId,
        { type: 'selenese', command: cmd.command, target: target, value: value },
        function (response) {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        }
      );
    });
  };

  /**
   * Pause execution (breakpoint or manual pause).
   */
  PlaybackEngine.prototype._doPause = function (index) {
    var self = this;
    this._status = STATUS.PAUSED;
    this._emit('playback:pause', { index: index });
    return new Promise(function (resolve) {
      self._pauseResolve = resolve;
    });
  };

  /**
   * Record a step result into the log.
   */
  PlaybackEngine.prototype._recordStep = function (index, cmd, status, duration, error) {
    this._log.push({
      index:    index,
      command:  cmd.command || cmd.name || '',
      target:   cmd.target  || '',
      value:    cmd.value   || '',
      status:   status,
      duration: duration,
      error:    error,
      ts:       Date.now(),
    });
  };

  /**
   * Dispatch a custom event on the configured eventTarget.
   */
  PlaybackEngine.prototype._emit = function (eventName, detail) {
    if (!this.eventTarget) return;
    try {
      this.eventTarget.dispatchEvent(new CustomEvent(eventName, { detail: detail, bubbles: true }));
    } catch (_) {
      // Swallow if CustomEvent is not available (e.g. in tests)
    }
  };

  /**
   * Run a nested test suite (invoked by a 'run' control-flow command).
   * @param {string} testName
   * @param {object} args
   * @returns {Promise}
   */
  PlaybackEngine.prototype._runNested = function (testName, args) {
    // Lookup the test suite by name from a registry.
    // The registry is expected to be available at window.TestRegistry.
    var registry = (typeof global.TestRegistry !== 'undefined') ? global.TestRegistry : null;
    if (!registry) {
      return Promise.reject(new Error('PlaybackEngine: TestRegistry not found (needed for run: ' + testName + ')'));
    }
    var suite = registry.getTest(testName);
    if (!suite) {
      return Promise.reject(new Error('PlaybackEngine: test not found: ' + testName));
    }
    // Create a child engine sharing the same tab and settings
    var child = new PlaybackEngine({
      tabId:           this.tabId,
      commandTimeout:  this.commandTimeout,
      stepDelay:       this.stepDelay,
      maxIterations:   this.maxIterations,
      breakOnFailure:  this.breakOnFailure,
      eventTarget:     this.eventTarget,
    });
    return child.run(suite.commands, args);
  };

  // ------------------------------------------------------------------
  // Module-level utilities
  // ------------------------------------------------------------------

  /**
   * Replace ${varName} tokens in a string with values from vars.
   * @param {string} str
   * @param {object} vars
   * @returns {string}
   */
  function _interpolate(str, vars) {
    return str.replace(/\$\{([^}]+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
    });
  }

  /**
   * Sleep for ms milliseconds.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function _sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ------------------------------------------------------------------
  // Expose
  // ------------------------------------------------------------------

  global.PlaybackEngine = PlaybackEngine;

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
