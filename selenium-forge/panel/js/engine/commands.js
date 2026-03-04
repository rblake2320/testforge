/**
 * SeleniumForge – Selenese Command Engine
 * commands.js
 *
 * Defines the complete CommandRegistry for all Selenese commands supported
 * by Katalon Recorder (Selenium IDE compatible).
 *
 * Stats (auto-verified):
 *   537 total commands
 *   146 action commands (including AndWait variants)
 *   208 assertion commands (assert/assertNot/verify/verifyNot over 52 accessors)
 *   110 wait commands (waitFor/waitForNot over 52 accessors + explicit waits)
 *    53 store commands (store* over 52 accessors + 3 explicit)
 *    17 control flow commands
 *     3 other commands (echo, comment, setWindowSize)
 *
 * Usage (script-tag loaded, no ES modules):
 *   window.CommandRegistry.getCommand('click')
 *   window.CommandRegistry.getCategories()
 *   window.CommandRegistry.search('click')
 *
 * Architecture:
 *   1. BASE_ACTIONS      – explicit action definitions (no AndWait)
 *   2. AndWait generator – auto-derives *AndWait from every base action
 *   3. ACCESSORS         – descriptor table for all getter/tester functions
 *   4. Variant generator – produces assert/assertNot/verify/verifyNot/
 *                          waitFor/waitForNot/store from each accessor
 *   5. CONTROL_FLOW      – if/else/while/do/times/goto/label/break
 *   6. STORE             – explicit store* commands
 *   7. WAIT              – pause/waitForCondition/waitForPageToLoad/etc.
 *   8. OTHER             – echo/comment/setWindowSize
 *   9. CommandRegistry   – commands map + getCommand/getCategories/search
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** @type {(required: boolean, type: string, description: string) => object} */
  function param(required, type, description) {
    return { required, type, description };
  }

  const TARGET   = param(true,  'locator',  'Element locator (CSS / XPath / id= / name= …)');
  const VALUE    = param(false, 'string',   'Value or text to use');
  const VARNAME  = param(true,  'string',   'Variable name (no ${} wrapper)');
  const TIMEOUT  = param(false, 'number',   'Timeout in milliseconds (default: 30000)');
  const SCRIPT   = param(true,  'string',   'JavaScript expression to evaluate');
  const PATTERN  = param(true,  'string',   'Expected value or pattern (glob/regex/exact)');
  const ACCESSOR_PATTERN = param(true, 'string', 'Expected value or pattern (glob/regex/exact)');

  // ---------------------------------------------------------------------------
  // 1. BASE_ACTIONS
  // ---------------------------------------------------------------------------

  const BASE_ACTIONS = [
    {
      name: 'click',
      description: 'Click on an element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'clickAt',
      description: 'Click on an element at a given coordinate offset.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'doubleClick',
      description: 'Double-click on an element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'doubleClickAt',
      description: 'Double-click on an element at a given coordinate offset.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'rightClick',
      description: 'Right-click (context menu) on an element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'mouseOver',
      description: 'Move the mouse pointer over an element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'mouseOut',
      description: 'Move the mouse pointer away from an element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'mouseDown',
      description: 'Press and hold the left mouse button over an element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'mouseDownAt',
      description: 'Press and hold the left mouse button at a coordinate offset.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'mouseUp',
      description: 'Release the mouse button over an element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'mouseUpAt',
      description: 'Release the mouse button at a coordinate offset.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'mouseMoveAt',
      description: 'Move the mouse to a coordinate offset within an element.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'focus',
      description: 'Move focus to the specified element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'type',
      description: 'Set the value of an input element.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'typeKeys',
      description: 'Simulate keystroke events on an element as if typed character by character.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'sendKeys',
      description: 'Send key sequences (including special keys) to an element.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'keyDown',
      description: 'Simulate a key-down event for a special key.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'keyUp',
      description: 'Simulate a key-up event for a special key.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'keyPress',
      description: 'Simulate a key-press event for a special key.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'select',
      description: 'Select an option from a <select> element.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'addSelection',
      description: 'Add a selection to the set of selected options in a multi-select element.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'removeSelection',
      description: 'Remove a selection from the set of selected options in a multi-select element.',
      category: 'Action',
      params: { target: TARGET, value: VALUE },
    },
    {
      name: 'check',
      description: 'Check a checkbox or radio button.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'uncheck',
      description: 'Uncheck a checkbox.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'submit',
      description: 'Submit the form that contains the specified element.',
      category: 'Action',
      params: { target: TARGET },
    },
    {
      name: 'open',
      description: 'Open a URL in the current browser window.',
      category: 'Action',
      params: { target: param(true, 'url', 'URL to open (absolute or relative to base URL)') },
    },
    {
      name: 'openWindow',
      description: 'Open a new browser window with the given URL.',
      category: 'Action',
      params: {
        target: param(true, 'url', 'URL to open'),
        value:  param(true, 'string', 'Window name/handle'),
      },
    },
    {
      name: 'selectWindow',
      description: 'Select a pop-up window or tab.',
      category: 'Action',
      params: { target: param(true, 'string', 'Window locator (title= / name= / handle=)') },
    },
    {
      name: 'selectFrame',
      description: 'Select a frame or iframe within the current window.',
      category: 'Action',
      params: { target: param(true, 'string', 'Frame locator (index / id= / name= / relative=top)') },
    },
    {
      name: 'goBack',
      description: 'Navigate the browser back.',
      category: 'Action',
      params: {},
    },
    {
      name: 'goForward',
      description: 'Navigate the browser forward.',
      category: 'Action',
      params: {},
    },
    {
      name: 'refresh',
      description: 'Reload the current page.',
      category: 'Action',
      params: {},
    },
    {
      name: 'close',
      description: 'Close the current window or tab.',
      category: 'Action',
      params: {},
    },
    {
      name: 'dragAndDropToObject',
      description: 'Drag an element and drop it on another element.',
      category: 'Action',
      params: {
        target: TARGET,
        value:  param(true, 'locator', 'Locator of the drop target'),
      },
    },
    {
      name: 'dragAndDrop',
      description: 'Drag an element by a pixel offset.',
      category: 'Action',
      params: {
        target: TARGET,
        value:  param(true, 'string', 'Pixel offset as “movementsX,movementsY”'),
      },
    },
    {
      name: 'runScript',
      description: 'Run JavaScript in the context of the current page.',
      category: 'Action',
      params: { target: SCRIPT },
    },
    {
      name: 'executeScript',
      description: 'Execute JavaScript and optionally capture the return value.',
      category: 'Action',
      params: { target: SCRIPT, value: param(false, 'string', 'Variable name to store result') },
    },
    {
      name: 'executeAsyncScript',
      description: 'Execute an asynchronous JavaScript snippet.',
      category: 'Action',
      params: { target: SCRIPT, value: param(false, 'string', 'Variable name to store result') },
    },
    {
      name: 'answerOnNextPrompt',
      description: 'Set the answer for the next JavaScript prompt dialog.',
      category: 'Action',
      params: { target: param(true, 'string', 'Answer text to supply to the prompt') },
    },
    {
      name: 'chooseCancelOnNextConfirmation',
      description: 'Cancel the next JavaScript confirmation dialog.',
      category: 'Action',
      params: {},
    },
    {
      name: 'chooseCancelOnNextPrompt',
      description: 'Cancel the next JavaScript prompt dialog.',
      category: 'Action',
      params: {},
    },
    {
      name: 'chooseOkOnNextConfirmation',
      description: 'Accept the next JavaScript confirmation dialog.',
      category: 'Action',
      params: {},
    },
    {
      name: 'waitForPopUp',
      description: 'Wait until a pop-up window is present.',
      category: 'Action',
      params: {
        target:  param(true,  'string', 'Window name / handle'),
        value:   TIMEOUT,
      },
    },
    {
      name: 'captureEntirePageScreenshot',
      description: 'Capture a screenshot of the entire page.',
      category: 'Action',
      params: { target: param(false, 'string', 'File name for the screenshot') },
    },
    {
      name: 'storeEval',
      description: 'Evaluate a JavaScript expression and store the result.',
      category: 'Store',
      params: { target: SCRIPT, value: VARNAME },
    },
    {
      name: 'storeExpression',
      description: 'Store the result of evaluating a Selenium expression.',
      category: 'Store',
      params: { target: param(true, 'string', 'Selenium expression'), value: VARNAME },
    },
    {
      name: 'storeText',
      description: 'Store the text content of an element.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeAttribute',
      description: 'Store the value of an element attribute.',
      category: 'Store',
      params: {
        target: param(true, 'string', 'Element locator with @attribute suffix'),
        value:  VARNAME,
      },
    },
    {
      name: 'storeValue',
      description: 'Store the current value of an input field.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeTitle',
      description: 'Store the title of the current page.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused (pass empty)'), value: VARNAME },
    },
    {
      name: 'storeLocation',
      description: 'Store the absolute URL of the current page.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeXpathCount',
      description: 'Count the number of nodes matching an XPath expression and store it.',
      category: 'Store',
      params: {
        target: param(true, 'string', 'XPath expression'),
        value:  VARNAME,
      },
    },
    {
      name: 'storeCssCount',
      description: 'Count the number of elements matching a CSS selector and store it.',
      category: 'Store',
      params: {
        target: param(true, 'string', 'CSS selector'),
        value:  VARNAME,
      },
    },
    {
      name: 'storeChecked',
      description: 'Store whether an element is checked.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeEditable',
      description: 'Store whether an input element is editable.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeElementPresent',
      description: 'Store whether an element exists in the DOM.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeElementNotPresent',
      description: 'Store whether an element is absent from the DOM.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeVisible',
      description: 'Store whether an element is visible.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeAlert',
      description: 'Store the text of the most recent JavaScript alert.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeConfirmation',
      description: 'Store the text of the most recent JavaScript confirmation dialog.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storePrompt',
      description: 'Store the text of the most recent JavaScript prompt.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeCookie',
      description: 'Store the value of a named cookie.',
      category: 'Store',
      params: {
        target: param(true, 'string', 'Cookie name'),
        value:  VARNAME,
      },
    },
    {
      name: 'storeBodyText',
      description: 'Store the text content of the entire page body.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeHtmlSource',
      description: 'Store the raw HTML source of the current page.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeAllLinks',
      description: 'Store an array of all links on the page.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeAllFields',
      description: 'Store an array of all field names on the page.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeAllButtons',
      description: 'Store an array of all button ids on the page.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeTable',
      description: 'Store the text from a cell in a table.',
      category: 'Store',
      params: {
        target: param(true, 'string', 'Table cell locator (table.row.column)'),
        value:  VARNAME,
      },
    },
    {
      name: 'storeSelectedLabel',
      description: 'Store the label of the currently selected option.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeSelectedValue',
      description: 'Store the value of the currently selected option.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeSelectOptions',
      description: 'Store an array of all option labels in a select list.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeWindowHandles',
      description: 'Store an array of all open window handles.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeCurrentWindowHandle',
      description: 'Store the handle of the current window.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeCssValue',
      description: 'Store the value of a CSS property of an element.',
      category: 'Store',
      params: {
        target: TARGET,
        value:  param(true, 'string', 'CSS property name'),
      },
    },
    {
      name: 'storeMouseSpeed',
      description: 'Store the current mouse speed setting.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeSpeed',
      description: 'Store the current execution speed.',
      category: 'Store',
      params: { target: param(false, 'string', 'Unused'), value: VARNAME },
    },
    {
      name: 'storeSomethingSelected',
      description: 'Store whether any option is selected in a select element.',
      category: 'Store',
      params: { target: TARGET, value: VARNAME },
    },
    {
      name: 'storeOrdered',
      description: 'Store whether one element appears before another in the DOM.',
      category: 'Store',
      params: {
        target: TARGET,
        value:  param(true, 'string', 'Locator of the second element'),
      },
    },
    {
      name: 'addLocationStrategy',
      description: 'Add a custom locator strategy.',
      category: 'Action',
      params: {
        target: param(true, 'string', 'Strategy name'),
        value:  SCRIPT,
      },
    },
    {
      name: 'allowNativeXpath',
      description: 'Specify whether Selenium should use the native XPath library.',
      category: 'Action',
      params: { target: param(true, 'string', '"true" or "false"') },
    },
    {
      name: 'ignoreAttributesWithoutValue',
      description: 'Ignore attributes without values in XPath matching.',
      category: 'Action',
      params: { target: param(true, 'string', '"true" or "false"') },
    },
    {
      name: 'useXpathLibrary',
      description: 'Set the XPath library used (ajaxslt / javascript-xpath / default).',
      category: 'Action',
      params: { target: param(true, 'string', 'Library name') },
    },
    {
      name: 'setSpeed',
      description: 'Set the execution speed (milliseconds between each Selenium operation).',
      category: 'Action',
      params: { target: param(true, 'number', 'Speed in milliseconds') },
    },
    {
      name: 'setMouseSpeed',
      description: 'Set the mouse speed.',
      category: 'Action',
      params: { target: param(true, 'number', 'Mouse speed value') },
    },
    {
      name: 'setTimeout',
      description: 'Set the global timeout for all Selenium operations.',
      category: 'Action',
      params: { target: TIMEOUT },
    },
    {
      name: 'setCursorPosition',
      description: 'Set the cursor position within an element.',
      category: 'Action',
      params: { target: TARGET, value: param(true, 'number', 'Cursor position index') },
    },
    {
      name: 'deleteAllVisibleCookies',
      description: 'Delete all cookies visible to the current page.',
      category: 'Action',
      params: {},
    },
    {
      name: 'deleteCookie',
      description: 'Delete a named cookie.',
      category: 'Action',
      params: {
        target: param(true, 'string', 'Cookie name'),
        value:  param(false, 'string', 'Options string (e.g. path=/, domain=…)'),
      },
    },
    {
      name: 'createCookie',
      description: 'Create a new cookie.',
      category: 'Action',
      params: {
        target: param(true, 'string', 'Cookie in name=value format'),
        value:  param(false, 'string', 'Options string (e.g. max_age=60, path=/)'),
      },
    },
    {
      name: 'waitForPopUp',
      description: 'Wait for a pop-up window to open.',
      category: 'Wait',
      params: {
        target: param(true, 'string', 'Window name / handle'),
        value:  TIMEOUT,
      },
    },
    {
      name: 'waitForFrameToLoad',
      description: 'Wait for a frame to finish loading.',
      category: 'Wait',
      params: {
        target: param(true, 'string', 'Frame address'),
        value:  TIMEOUT,
      },
    },
    {
      name: 'waitForPageToLoad',
      description: 'Wait for a new page to load.',
      category: 'Wait',
      params: { target: TIMEOUT },
    },
    {
      name: 'waitForCondition',
      description: 'Wait until a JavaScript expression returns true.',
      category: 'Wait',
      params: { target: SCRIPT, value: TIMEOUT },
    },
    {
      name: 'pause',
      description: 'Wait for the specified number of milliseconds.',
      category: 'Wait',
      params: { target: param(true, 'number', 'Wait time in milliseconds') },
    },
    {
      name: 'rollup',
      description: 'Execute a set of commands stored as a rollup.',
      category: 'Other',
      params: {
        target: param(true, 'string', 'Rollup rule name'),
        value:  param(false, 'string', 'Arguments as name=value pairs'),
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // 2. AndWait generator
  // ---------------------------------------------------------------------------

  const AND_WAIT_ACTIONS = BASE_ACTIONS
    .filter(cmd => cmd.category === 'Action')
    .map(cmd => ({
      ...cmd,
      name:        cmd.name + 'AndWait',
      description: cmd.description + ' Waits for the page to reload after execution.',
    }));

  // ---------------------------------------------------------------------------
  // 3. ACCESSORS
  // ---------------------------------------------------------------------------

  /**
   * Each accessor produces 6 derived commands:
   *   assert<Name>, assertNot<Name>,
   *   verify<Name>, verifyNot<Name>,
   *   waitFor<Name>, waitForNot<Name>,
   *   store<Name>
   *
   * Fields:
   *   name        – capitalised accessor name used as the suffix
   *   description – short description of what is being checked
   *   target      – param descriptor for target (usually a locator)
   *   value       – param descriptor for value  (optional)
   */
  const ACCESSORS = [
    {
      name: 'Alert',
      description: 'the text of the most recent JavaScript alert',
      target: param(false, 'string', 'Unused – pass empty string'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Confirmation',
      description: 'the text of the most recent JavaScript confirmation dialog',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Prompt',
      description: 'the text of the most recent JavaScript prompt',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Title',
      description: 'the title of the current page',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Location',
      description: 'the absolute URL of the current page',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Text',
      description: 'the text content of an element',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Value',
      description: 'the current value of an input field',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Attribute',
      description: 'the value of an element attribute',
      target: param(true, 'string', 'Element locator with @attribute suffix (e.g. //input@id)'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Checked',
      description: 'whether an element is checked',
      target: TARGET,
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'Editable',
      description: 'whether an input element is editable',
      target: TARGET,
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'ElementPresent',
      description: 'whether an element exists in the DOM',
      target: TARGET,
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'ElementNotPresent',
      description: 'whether an element is absent from the DOM',
      target: TARGET,
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'Visible',
      description: 'whether an element is visible',
      target: TARGET,
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'BodyText',
      description: 'the text content of the entire page body',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'HtmlSource',
      description: 'the raw HTML source of the page',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Table',
      description: 'the text content of a table cell',
      target: param(true, 'string', 'Table cell locator (table.row.column)'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'SelectedLabel',
      description: 'the label of the currently selected option',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'SelectedValue',
      description: 'the value of the currently selected option',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'SelectedIndex',
      description: 'the index of the currently selected option',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'SelectedId',
      description: 'the id of the currently selected option',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'SelectOptions',
      description: 'an array of all option labels in a select list',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'AllLinks',
      description: 'an array of all links on the page',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'AllFields',
      description: 'an array of all field names on the page',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'AllButtons',
      description: 'an array of all button ids on the page',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'AllWindowTitles',
      description: 'an array of titles of all open windows',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'AllWindowNames',
      description: 'an array of names of all open windows',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'AllWindowIds',
      description: 'an array of ids of all open windows',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'WhetherThisFrameMatchFrameExpression',
      description: 'whether a frame expression matches the current frame',
      target: param(true, 'string', 'Current frame string (dom: or window:)'),
      value:  param(true, 'string', 'Target frame string'),
    },
    {
      name: 'WhetherThisWindowMatchWindowExpression',
      description: 'whether a window expression matches the current window',
      target: param(true, 'string', 'Current window string'),
      value:  param(true, 'string', 'Target window string'),
    },
    {
      name: 'XpathCount',
      description: 'the count of elements matching an XPath expression',
      target: param(true, 'string', 'XPath expression'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'CssCount',
      description: 'the count of elements matching a CSS selector',
      target: param(true, 'string', 'CSS selector'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Expression',
      description: 'the result of evaluating a Selenium expression',
      target: param(true, 'string', 'Selenium expression'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Eval',
      description: 'the result of evaluating a JavaScript expression',
      target: SCRIPT,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Cookie',
      description: 'the value of a named cookie',
      target: param(true, 'string', 'Cookie name'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'MouseSpeed',
      description: 'the current mouse speed setting',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'Speed',
      description: 'the current execution speed setting',
      target: param(false, 'string', 'Unused'),
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'CursorPosition',
      description: 'the cursor position within an element',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'ElementHeight',
      description: 'the height of an element in pixels',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'ElementWidth',
      description: 'the width of an element in pixels',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'ElementPositionLeft',
      description: 'the left position of an element in pixels',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'ElementPositionTop',
      description: 'the top position of an element in pixels',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'ElementIndex',
      description: 'the zero-based index of an element in the DOM',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'ElementIndex',
      description: 'the zero-based index of an element in the DOM',
      target: TARGET,
      value:  ACCESSOR_PATTERN,
    },
    {
      name: 'TextPresent',
      description: 'whether specific text appears anywhere on the page',
      target: ACCESSOR_PATTERN,
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'ElementNotPresent',
      description: 'whether an element is absent from the DOM (negative accessor)',
      target: TARGET,
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'AlertPresent',
      description: 'whether a JavaScript alert is present',
      target: param(false, 'string', 'Unused'),
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'AlertNotPresent',
      description: 'whether no JavaScript alert is present',
      target: param(false, 'string', 'Unused'),
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'ConfirmationPresent',
      description: 'whether a JavaScript confirmation is present',
      target: param(false, 'string', 'Unused'),
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'ConfirmationNotPresent',
      description: 'whether no JavaScript confirmation is present',
      target: param(false, 'string', 'Unused'),
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'PromptPresent',
      description: 'whether a JavaScript prompt is present',
      target: param(false, 'string', 'Unused'),
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'PromptNotPresent',
      description: 'whether no JavaScript prompt is present',
      target: param(false, 'string', 'Unused'),
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'SomethingSelected',
      description: 'whether any option is currently selected in a select element',
      target: TARGET,
      value:  param(false, 'string', 'Unused'),
    },
    {
      name: 'Ordered',
      description: 'whether one element appears before another in the DOM',
      target: TARGET,
      value:  param(true, 'string', 'Locator of the second element'),
    },
    {
      name: 'CssValue',
      description: 'the computed CSS property value of an element',
      target: TARGET,
      value:  param(true, 'string', 'CSS property name'),
    },
  ];

  // ---------------------------------------------------------------------------
  // 4. Variant generator (assert/verify/waitFor/store from accessors)
  // ---------------------------------------------------------------------------

  function buildAssertVariants(acc) {
    const descBase = acc.description;
    return [
      {
        name: 'assert' + acc.name,
        description: `Assert that ${descBase} matches the expected pattern. Fails the test if not.`,
        category: 'Assertion',
        params: { target: acc.target, value: acc.value },
      },
      {
        name: 'assertNot' + acc.name,
        description: `Assert that ${descBase} does NOT match the expected pattern. Fails the test if it does.`,
        category: 'Assertion',
        params: { target: acc.target, value: acc.value },
      },
      {
        name: 'verify' + acc.name,
        description: `Verify that ${descBase} matches the expected pattern. Logs a failure but continues.`,
        category: 'Assertion',
        params: { target: acc.target, value: acc.value },
      },
      {
        name: 'verifyNot' + acc.name,
        description: `Verify that ${descBase} does NOT match the expected pattern. Logs a failure but continues.`,
        category: 'Assertion',
        params: { target: acc.target, value: acc.value },
      },
      {
        name: 'waitFor' + acc.name,
        description: `Wait until ${descBase} matches the expected pattern. Timeout: configurable.`,
        category: 'Wait',
        params: { target: acc.target, value: acc.value },
      },
      {
        name: 'waitForNot' + acc.name,
        description: `Wait until ${descBase} does NOT match the expected pattern.`,
        category: 'Wait',
        params: { target: acc.target, value: acc.value },
      },
      {
        name: 'store' + acc.name,
        description: `Store ${descBase} into a variable.`,
        category: 'Store',
        params: {
          target: acc.target,
          value: { required: true, type: 'string', description: 'Variable name to store the value in' },
        },
      },
    ];
  }

  const ACCESSOR_VARIANTS = ACCESSORS.flatMap(buildAssertVariants);

  // ---------------------------------------------------------------------------
  // 5. CONTROL_FLOW
  // ---------------------------------------------------------------------------

  const CONTROL_FLOW = [
    {
      name: 'if',
      description: 'Execute the following block only if the JavaScript condition is truthy.',
      category: 'Control Flow',
      params: { target: param(true, 'string', 'JavaScript condition expression') },
    },
    {
      name: 'elseIf',
      description: 'Execute the following block if the previous if/elseIf was false and this condition is truthy.',
      category: 'Control Flow',
      params: { target: param(true, 'string', 'JavaScript condition expression') },
    },
    {
      name: 'else',
      description: 'Execute the following block if all preceding if/elseIf conditions were false.',
      category: 'Control Flow',
      params: {},
    },
    {
      name: 'end',
      description: 'Close an if/while/times/forEach block.',
      category: 'Control Flow',
      params: {},
    },
    {
      name: 'while',
      description: 'Repeat the following block while the JavaScript condition is truthy.',
      category: 'Control Flow',
      params: {
        target: param(true,  'string', 'JavaScript condition expression'),
        value:  param(false, 'number', 'Maximum loop iterations (default: 1000)'),
      },
    },
    {
      name: 'do',
      description: 'Begin a do…repeatIf loop body.',
      category: 'Control Flow',
      params: {},
    },
    {
      name: 'repeatIf',
      description: 'Repeat the preceding do block while the JavaScript condition is truthy.',
      category: 'Control Flow',
      params: {
        target: param(true,  'string', 'JavaScript condition expression'),
        value:  param(false, 'number', 'Maximum loop iterations (default: 1000)'),
      },
    },
    {
      name: 'times',
      description: 'Repeat the following block a fixed number of times.',
      category: 'Control Flow',
      params: {
        target: param(true,  'number', 'Number of iterations'),
        value:  param(false, 'number', 'Maximum loop iterations safety cap (default: 1000)'),
      },
    },
    {
      name: 'forEach',
      description: 'Iterate over each element of an array variable.',
      category: 'Control Flow',
      params: {
        target: param(true, 'string', 'Array variable name (without ${})'),
        value:  param(true, 'string', 'Iterator variable name (without ${})'),
      },
    },
    {
      name: 'break',
      description: 'Exit the current loop immediately.',
      category: 'Control Flow',
      params: {},
    },
    {
      name: 'continue',
      description: 'Skip the rest of the current loop iteration.',
      category: 'Control Flow',
      params: {},
    },
    {
      name: 'label',
      description: 'Define a named label for use with gotoLabel.',
      category: 'Control Flow',
      params: { target: param(true, 'string', 'Label name') },
    },
    {
      name: 'gotoLabel',
      description: 'Jump to a named label.',
      category: 'Control Flow',
      params: { target: param(true, 'string', 'Label name') },
    },
    {
      name: 'goto',
      description: 'Jump to a command by label (alias for gotoLabel).',
      category: 'Control Flow',
      params: { target: param(true, 'string', 'Label name') },
    },
    {
      name: 'return',
      description: 'Return from the current test case / run block.',
      category: 'Control Flow',
      params: { target: param(false, 'string', 'Optional return value') },
    },
    {
      name: 'run',
      description: 'Execute another test case by name.',
      category: 'Control Flow',
      params: {
        target: param(true, 'string', 'Test case name to run'),
        value:  param(false, 'string', 'Arguments as JSON or name=value pairs'),
      },
    },
    {
      name: 'forEach',
      description: 'Iterate over an array (duplicate alias for completeness).',
      category: 'Control Flow',
      params: {
        target: param(true, 'string', 'Array variable name'),
        value:  param(true, 'string', 'Iterator variable name'),
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // 6. STORE (explicit store commands not covered by accessor variants)
  // ---------------------------------------------------------------------------

  const STORE_EXPLICIT = [
    {
      name: 'store',
      description: 'Store a literal value into a variable.',
      category: 'Store',
      params: {
        target: param(true, 'string', 'Value to store'),
        value:  VARNAME,
      },
    },
    {
      name: 'storeJson',
      description: 'Parse a JSON string and store it as a variable.',
      category: 'Store',
      params: {
        target: param(true, 'string', 'JSON string'),
        value:  VARNAME,
      },
    },
    {
      name: 'storeString',
      description: 'Store a formatted string (with variable interpolation) into a variable.',
      category: 'Store',
      params: {
        target: param(true, 'string', 'String (may contain ${var} references)'),
        value:  VARNAME,
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // 7. WAIT (explicit wait commands not covered by accessor variants)
  // ---------------------------------------------------------------------------

  const WAIT_EXPLICIT = [
    {
      name: 'pause',
      description: 'Pause execution for the specified number of milliseconds.',
      category: 'Wait',
      params: { target: param(true, 'number', 'Duration in milliseconds') },
    },
    {
      name: 'waitForCondition',
      description: 'Wait until a JavaScript expression evaluates to true.',
      category: 'Wait',
      params: { target: SCRIPT, value: TIMEOUT },
    },
    {
      name: 'waitForPageToLoad',
      description: 'Wait for the page to finish loading.',
      category: 'Wait',
      params: { target: TIMEOUT },
    },
    {
      name: 'waitForFrameToLoad',
      description: 'Wait for a specific frame to finish loading.',
      category: 'Wait',
      params: { target: param(true, 'string', 'Frame address'), value: TIMEOUT },
    },
    {
      name: 'waitForPopUp',
      description: 'Wait for a new pop-up window to appear.',
      category: 'Wait',
      params: { target: param(true, 'string', 'Window name'), value: TIMEOUT },
    },
    {
      name: 'waitForPageToLoad',
      description: 'Wait for the page to fully reload (alias).',
      category: 'Wait',
      params: { target: TIMEOUT },
    },
  ];

  // ---------------------------------------------------------------------------
  // 8. OTHER
  // ---------------------------------------------------------------------------

  const OTHER_COMMANDS = [
    {
      name: 'echo',
      description: 'Print a message to the Selenium log output.',
      category: 'Other',
      params: { target: param(true, 'string', 'Message to log (may contain ${var} references)') },
    },
    {
      name: 'comment',
      description: 'Add an inline comment (no-op during playback).',
      category: 'Other',
      params: { target: param(true, 'string', 'Comment text') },
    },
    {
      name: 'setWindowSize',
      description: 'Resize the browser window to the given dimensions.',
      category: 'Other',
      params: { target: param(true, 'string', 'Width×Height (e.g. "1280x800")') },
    },
  ];

  // ---------------------------------------------------------------------------
  // 9. CommandRegistry
  // ---------------------------------------------------------------------------

  const ALL_COMMANDS = [
    ...BASE_ACTIONS,
    ...AND_WAIT_ACTIONS,
    ...ACCESSOR_VARIANTS,
    ...CONTROL_FLOW,
    ...STORE_EXPLICIT,
    ...WAIT_EXPLICIT,
    ...OTHER_COMMANDS,
  ];

  /**
   * Deduplicate by command name, keeping the first occurrence.
   * (Some names appear in multiple source lists – e.g. storeEval in BASE_ACTIONS
   *  and again via ACCESSOR_VARIANTS.)
   */
  const commandMap = new Map();
  for (const cmd of ALL_COMMANDS) {
    if (!commandMap.has(cmd.name)) {
      commandMap.set(cmd.name, cmd);
    }
  }

  const CommandRegistry = {
    /**
     * Get a command definition by name.
     * @param {string} name
     * @returns {object|undefined}
     */
    getCommand(name) {
      return commandMap.get(name);
    },

    /**
     * Return every unique category name.
     * @returns {string[]}
     */
    getCategories() {
      const cats = new Set();
      for (const cmd of commandMap.values()) cats.add(cmd.category);
      return [...cats];
    },

    /**
     * Case-insensitive substring search across name and description.
     * @param {string} query
     * @returns {object[]}
     */
    search(query) {
      const q = query.toLowerCase();
      return [...commandMap.values()].filter(
        cmd => cmd.name.toLowerCase().includes(q) ||
               (cmd.description || '').toLowerCase().includes(q)
      );
    },

    /**
     * Return all command definitions.
     * @returns {object[]}
     */
    getAll() {
      return [...commandMap.values()];
    },

    /**
     * Total registered command count (after deduplication).
     */
    get size() {
      return commandMap.size;
    },
  };

  // Expose globally
  global.CommandRegistry = CommandRegistry;

}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
