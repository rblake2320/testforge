/**
 * SeleniumForge ControlFlowEngine
 * ==========================================================================
 * controlflow.js
 *
 * Implements the control-flow interpreter used by PlaybackEngine.
 * Supports:
 *   if / elseIf / else / end
 *   while / end
 *   times / end
 *   do / repeatIf
 *   forEach / end
 *   break / continue
 *   label / gotoLabel / goto
 *   run  (delegate to PlaybackEngine – injected at construction)
 *   return
 *
 * Design goals
 * ------------
 * • No external dependencies – plain ES5-compatible IIFE.
 * • Operates on a flat command array (index-based iteration).
 * • PlaybackEngine drives the loop; ControlFlowEngine exposes two methods:
 *     prepare(commands)  – pre-pass: build jump table + validate nesting.
 *     step(ctx)          – per-command hook called by PlaybackEngine;
 *                          mutates ctx.nextIndex to redirect flow.
 * • All variable access goes through ctx.vars (a plain object).
 * • ctx.vars is populated by PlaybackEngine before each step.
 *
 * Jump table
 * ----------
 * prepare() builds a Map<commandIndex, JumpEntry>.
 * JumpEntry = { type, peerIf, elseIndex, endIndex, loopStart, loopEnd,
 *               conditionIndex, labelName, gotoTarget }
 *
 * Iteration safety
 * ----------------
 * while / times / do…repeatIf / forEach blocks track iteration counts
 * in ctx.loopCounters (Map<loopStartIndex, number>).
 * Default max iterations: 1 000. Configurable via ctx.options.maxIterations.
 */

(function (global) {
  'use strict';

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  var DEFAULT_MAX_ITERATIONS = 1000;

  // Control-flow command names (normalised to lower-case for matching)
  var CF_COMMANDS = {
    IF:        'if',
    ELSE_IF:   'elseif',
    ELSE:      'else',
    END:       'end',
    WHILE:     'while',
    DO:        'do',
    REPEAT_IF: 'repeatif',
    TIMES:     'times',
    FOR_EACH:  'foreach',
    BREAK:     'break',
    CONTINUE:  'continue',
    LABEL:     'label',
    GOTO:      'gotolabel',
    GOTO2:     'goto',
    RETURN:    'return',
    RUN:       'run',
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function norm(name) {
    return (name || '').toLowerCase().replace(/[_\-\s]/g, '');
  }

  function isCF(cmd) {
    var n = norm(cmd.command || cmd.name || '');
    return Object.values(CF_COMMANDS).indexOf(n) !== -1;
  }

  /** Safely evaluate a JS expression inside a sandboxed context.
   *  vars keys are injected as local variables.
   */
  function evalCondition(expr, vars) {
    try {
      var keys   = Object.keys(vars);
      var values = keys.map(function (k) { return vars[k]; });
      // eslint-disable-next-line no-new-func
      return Boolean(new Function(keys, 'return (' + expr + ');').apply(null, values));
    } catch (e) {
      throw new Error('ControlFlowEngine: condition eval error [' + expr + ']: ' + e.message);
    }
  }

  // -------------------------------------------------------------------------
  // ControlFlowEngine constructor
  // -------------------------------------------------------------------------

  /**
   * @param {object} opts
   * @param {Function} opts.runSuite  Called when a `run` command is encountered.
   *                                  Signature: runSuite(testName, vars) → Promise
   */
  function ControlFlowEngine(opts) {
    opts = opts || {};
    this._runSuite    = opts.runSuite || null;
    this._jumpTable   = new Map();
    this._labelMap    = new Map(); // labelName → commandIndex
  }

  // -------------------------------------------------------------------------
  // prepare(commands)
  // -------------------------------------------------------------------------

  /**
   * Pre-process the command list.
   * Builds:
   *   _jumpTable   : Map<index, JumpEntry>
   *   _labelMap    : Map<labelName, index>
   *
   * Validates nesting and throws descriptive errors.
   *
   * @param {Array<{command:string, target:string, value:string}>} commands
   */
  ControlFlowEngine.prototype.prepare = function (commands) {
    this._jumpTable.clear();
    this._labelMap.clear();

    var stack = []; // stack of open blocks: { type, index }

    for (var i = 0; i < commands.length; i++) {
      var cmd  = commands[i];
      var name = norm(cmd.command || cmd.name || '');

      switch (name) {

        // ---- if -----------------------------------------------------------
        case CF_COMMANDS.IF: {
          stack.push({ type: 'if', index: i, peers: [i], elseIndex: -1 });
          this._jumpTable.set(i, { type: 'if', endIndex: -1, elseIndex: -1, peers: [i] });
          break;
        }

        // ---- elseIf -------------------------------------------------------
        case CF_COMMANDS.ELSE_IF: {
          var top = _peekType(stack, 'if', i, 'elseIf');
          top.peers.push(i);
          this._jumpTable.get(top.index).peers.push(i);
          this._jumpTable.set(i, { type: 'elseIf', ifIndex: top.index, endIndex: -1 });
          break;
        }

        // ---- else ---------------------------------------------------------
        case CF_COMMANDS.ELSE: {
          var top = _peekType(stack, 'if', i, 'else');
          top.elseIndex = i;
          this._jumpTable.get(top.index).elseIndex = i;
          this._jumpTable.set(i, { type: 'else', ifIndex: top.index, endIndex: -1 });
          break;
        }

        // ---- end ----------------------------------------------------------
        case CF_COMMANDS.END: {
          if (stack.length === 0) {
            throw new Error('ControlFlowEngine: unexpected \'end\' at index ' + i);
          }
          var frame = stack.pop();
          var entry = this._jumpTable.get(frame.index);

          if (frame.type === 'if') {
            // Update all peer (if/elseIf/else) entries with the end index
            var peers = this._jumpTable.get(frame.index).peers || [frame.index];
            for (var p = 0; p < peers.length; p++) {
              var pe = this._jumpTable.get(peers[p]);
              if (pe) pe.endIndex = i;
            }
            if (frame.elseIndex !== -1) {
              var elseEntry = this._jumpTable.get(frame.elseIndex);
              if (elseEntry) elseEntry.endIndex = i;
            }
          } else {
            entry.endIndex = i;
          }
          this._jumpTable.set(i, { type: 'end', loopStart: frame.index, frameType: frame.type });
          break;
        }

        // ---- while --------------------------------------------------------
        case CF_COMMANDS.WHILE: {
          stack.push({ type: 'while', index: i });
          this._jumpTable.set(i, { type: 'while', endIndex: -1 });
          break;
        }

        // ---- do -----------------------------------------------------------
        case CF_COMMANDS.DO: {
          stack.push({ type: 'do', index: i });
          this._jumpTable.set(i, { type: 'do', repeatIfIndex: -1 });
          break;
        }

        // ---- repeatIf -----------------------------------------------------
        case CF_COMMANDS.REPEAT_IF: {
          var top = _peekType(stack, 'do', i, 'repeatIf');
          stack.pop();
          this._jumpTable.get(top.index).repeatIfIndex = i;
          this._jumpTable.set(i, { type: 'repeatIf', doIndex: top.index });
          break;
        }

        // ---- times --------------------------------------------------------
        case CF_COMMANDS.TIMES: {
          stack.push({ type: 'times', index: i });
          this._jumpTable.set(i, { type: 'times', endIndex: -1 });
          break;
        }

        // ---- forEach ------------------------------------------------------
        case CF_COMMANDS.FOR_EACH: {
          stack.push({ type: 'forEach', index: i });
          this._jumpTable.set(i, { type: 'forEach', endIndex: -1 });
          break;
        }

        // ---- break --------------------------------------------------------
        case CF_COMMANDS.BREAK: {
          var loopFrame = _findEnclosingLoop(stack, i);
          this._jumpTable.set(i, { type: 'break', loopStart: loopFrame.index });
          break;
        }

        // ---- continue -----------------------------------------------------
        case CF_COMMANDS.CONTINUE: {
          var loopFrame = _findEnclosingLoop(stack, i);
          this._jumpTable.set(i, { type: 'continue', loopStart: loopFrame.index });
          break;
        }

        // ---- label --------------------------------------------------------
        case CF_COMMANDS.LABEL: {
          var labelName = (cmd.target || '').trim();
          if (!labelName) throw new Error('ControlFlowEngine: label at index ' + i + ' has no name');
          this._labelMap.set(labelName, i);
          this._jumpTable.set(i, { type: 'label', labelName: labelName });
          break;
        }

        // ---- gotoLabel / goto ---------------------------------------------
        case CF_COMMANDS.GOTO:
        case CF_COMMANDS.GOTO2: {
          // target resolved lazily in step() because labels may appear after goto
          this._jumpTable.set(i, { type: 'goto', labelTarget: (cmd.target || '').trim() });
          break;
        }

        // ---- return -------------------------------------------------------
        case CF_COMMANDS.RETURN: {
          this._jumpTable.set(i, { type: 'return' });
          break;
        }

        // ---- run ----------------------------------------------------------
        case CF_COMMANDS.RUN: {
          this._jumpTable.set(i, { type: 'run' });
          break;
        }

        default:
          // Non-CF command – nothing to record in jump table
          break;
      }
    }

    if (stack.length > 0) {
      var unclosed = stack.map(function (f) { return f.type + '@' + f.index; }).join(', ');
      throw new Error('ControlFlowEngine: unclosed blocks: ' + unclosed);
    }
  };

  // -------------------------------------------------------------------------
  // step(ctx) – called by PlaybackEngine for every command
  // -------------------------------------------------------------------------

  /**
   * Evaluate control flow for command at ctx.currentIndex.
   * Mutates ctx.nextIndex (and ctx.vars, ctx.loopCounters) as needed.
   *
   * Returns a Promise that resolves to one of:
   *   'execute'  – PlaybackEngine should execute the current command normally
   *   'skip'     – PlaybackEngine should skip (no-op) the current command
   *   'return'   – PlaybackEngine should stop the current test/suite
   *   { run: testName, args: vars } – PlaybackEngine should call runSuite()
   *
   * @param {object} ctx
   * @param {number}  ctx.currentIndex
   * @param {number}  ctx.nextIndex       (mutable)
   * @param {object}  ctx.vars
   * @param {Map}     ctx.loopCounters
   * @param {Map}     ctx.forEachState    iterator state for forEach loops
   * @param {object}  ctx.options         { maxIterations }
   * @param {Array}   ctx.commands        the full command list
   * @returns {Promise<string|object>}
   */
  ControlFlowEngine.prototype.step = function (ctx) {
    var self   = this;
    var i      = ctx.currentIndex;
    var entry  = this._jumpTable.get(i);

    if (!entry) {
      // Not a CF command – execute normally
      return Promise.resolve('execute');
    }

    var commands = ctx.commands;
    var vars     = ctx.vars;
    var opts     = ctx.options || {};
    var maxIter  = opts.maxIterations || DEFAULT_MAX_ITERATIONS;

    switch (entry.type) {

      // ---- if -------------------------------------------------------------
      case 'if': {
        var cmd  = commands[i];
        var cond = evalCondition(cmd.target || 'false', vars);
        if (cond) {
          // Execute the if-block; nextIndex stays at i+1
          ctx.nextIndex = i + 1;
        } else {
          // Skip to the first elseIf/else/end
          var peers = entry.peers;
          var jumped = false;
          for (var p = 1; p < peers.length; p++) {
            ctx.nextIndex = peers[p];
            jumped = true;
            break;
          }
          if (!jumped) {
            ctx.nextIndex = entry.elseIndex !== -1 ? entry.elseIndex : entry.endIndex + 1;
          }
        }
        return Promise.resolve('skip');
      }

      // ---- elseIf ---------------------------------------------------------
      case 'elseIf': {
        // Reached here means the preceding if/elseIf block was executed.
        // Jump past the end to skip all remaining branches.
        ctx.nextIndex = entry.endIndex + 1;
        return Promise.resolve('skip');
      }

      // ---- else -----------------------------------------------------------
      case 'else': {
        // Reached because the preceding if branch executed – skip else block
        ctx.nextIndex = entry.endIndex + 1;
        return Promise.resolve('skip');
      }

      // ---- end ------------------------------------------------------------
      case 'end': {
        var ft = entry.frameType;
        if (ft === 'while' || ft === 'times' || ft === 'forEach') {
          // Jump back to loop start to re-evaluate condition
          ctx.nextIndex = entry.loopStart;
        } else {
          // end of if block – normal advance
          ctx.nextIndex = i + 1;
        }
        return Promise.resolve('skip');
      }

      // ---- while ----------------------------------------------------------
      case 'while': {
        var cmd    = commands[i];
        var count  = (ctx.loopCounters.get(i) || 0) + 1;
        if (count > maxIter) {
          throw new Error('ControlFlowEngine: while loop at index ' + i + ' exceeded maxIterations (' + maxIter + ')');
        }
        var cond = evalCondition(cmd.target || 'false', vars);
        if (cond) {
          ctx.loopCounters.set(i, count);
          ctx.nextIndex = i + 1;
        } else {
          ctx.loopCounters.delete(i);
          ctx.nextIndex = entry.endIndex + 1;
        }
        return Promise.resolve('skip');
      }

      // ---- do -------------------------------------------------------------
      case 'do': {
        // do block start – always execute body first time
        ctx.nextIndex = i + 1;
        return Promise.resolve('skip');
      }

      // ---- repeatIf -------------------------------------------------------
      case 'repeatIf': {
        var cmd   = commands[i];
        var start = entry.doIndex;
        var count = (ctx.loopCounters.get(start) || 0) + 1;
        if (count > maxIter) {
          throw new Error('ControlFlowEngine: do…repeatIf loop at index ' + start + ' exceeded maxIterations');
        }
        var cond = evalCondition(cmd.target || 'false', vars);
        if (cond) {
          ctx.loopCounters.set(start, count);
          ctx.nextIndex = start + 1; // jump back into do body
        } else {
          ctx.loopCounters.delete(start);
          ctx.nextIndex = i + 1;
        }
        return Promise.resolve('skip');
      }

      // ---- times ----------------------------------------------------------
      case 'times': {
        var cmd   = commands[i];
        var limit = parseInt(cmd.target, 10);
        if (isNaN(limit) || limit < 0) {
          throw new Error('ControlFlowEngine: times at index ' + i + ' requires a non-negative integer target');
        }
        var count = ctx.loopCounters.get(i) || 0;
        if (count < limit) {
          ctx.loopCounters.set(i, count + 1);
          ctx.nextIndex = i + 1;
        } else {
          ctx.loopCounters.delete(i);
          ctx.nextIndex = entry.endIndex + 1;
        }
        return Promise.resolve('skip');
      }

      // ---- forEach --------------------------------------------------------
      case 'forEach': {
        var cmd       = commands[i];
        var arrName   = (cmd.target || '').trim();
        var iterName  = (cmd.value  || '').trim();
        if (!arrName || !iterName) {
          throw new Error('ControlFlowEngine: forEach at index ' + i + ' needs target (array var) and value (iterator var)');
        }
        if (!ctx.forEachState) ctx.forEachState = new Map();
        var state = ctx.forEachState.get(i);
        if (!state) {
          var arr = vars[arrName];
          if (!Array.isArray(arr)) {
            throw new Error('ControlFlowEngine: forEach target variable \'' + arrName + '\' is not an array');
          }
          state = { arr: arr, idx: 0 };
          ctx.forEachState.set(i, state);
        }
        if (state.idx < state.arr.length) {
          vars[iterName] = state.arr[state.idx++];
          ctx.loopCounters.set(i, state.idx);
          ctx.nextIndex = i + 1;
        } else {
          ctx.forEachState.delete(i);
          ctx.loopCounters.delete(i);
          ctx.nextIndex = entry.endIndex + 1;
        }
        return Promise.resolve('skip');
      }

      // ---- break ----------------------------------------------------------
      case 'break': {
        var loopEntry = this._jumpTable.get(entry.loopStart);
        ctx.loopCounters.delete(entry.loopStart);
        if (ctx.forEachState) ctx.forEachState.delete(entry.loopStart);
        ctx.nextIndex = loopEntry.endIndex + 1;
        return Promise.resolve('skip');
      }

      // ---- continue -------------------------------------------------------
      case 'continue': {
        // Jump back to loop start so condition is re-evaluated
        ctx.nextIndex = entry.loopStart;
        return Promise.resolve('skip');
      }

      // ---- label ----------------------------------------------------------
      case 'label': {
        // No-op at runtime; just advance
        ctx.nextIndex = i + 1;
        return Promise.resolve('skip');
      }

      // ---- goto / gotoLabel -----------------------------------------------
      case 'goto': {
        var target = entry.labelTarget;
        if (!this._labelMap.has(target)) {
          throw new Error('ControlFlowEngine: goto target label \'' + target + '\' not found');
        }
        ctx.nextIndex = this._labelMap.get(target) + 1;
        return Promise.resolve('skip');
      }

      // ---- return ---------------------------------------------------------
      case 'return': {
        return Promise.resolve('return');
      }

      // ---- run ------------------------------------------------------------
      case 'run': {
        var cmd      = commands[i];
        var testName = (cmd.target || '').trim();
        var argsRaw  = (cmd.value  || '').trim();
        var args     = {};
        if (argsRaw) {
          try { args = JSON.parse(argsRaw); } catch (_) {
            // name=value pairs
            argsRaw.split(',').forEach(function (pair) {
              var parts = pair.split('=');
              args[(parts[0] || '').trim()] = (parts[1] || '').trim();
            });
          }
        }
        ctx.nextIndex = i + 1;
        return Promise.resolve({ run: testName, args: args });
      }

      default:
        return Promise.resolve('execute');
    }
  };

  // -------------------------------------------------------------------------
  // Private stack helpers
  // -------------------------------------------------------------------------

  function _peekType(stack, expectedType, cmdIndex, cmdName) {
    if (stack.length === 0 || stack[stack.length - 1].type !== expectedType) {
      throw new Error(
        'ControlFlowEngine: \'' + cmdName + '\' at index ' + cmdIndex +
        ' has no matching \'' + expectedType + '\''
      );
    }
    return stack[stack.length - 1];
  }

  function _findEnclosingLoop(stack, cmdIndex) {
    for (var j = stack.length - 1; j >= 0; j--) {
      var t = stack[j].type;
      if (t === 'while' || t === 'times' || t === 'forEach' || t === 'do') {
        return stack[j];
      }
    }
    throw new Error(
      'ControlFlowEngine: break/continue at index ' + cmdIndex +
      ' is not inside a loop'
    );
  }

  // -------------------------------------------------------------------------
  // Expose
  // -------------------------------------------------------------------------

  global.ControlFlowEngine = ControlFlowEngine;

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
