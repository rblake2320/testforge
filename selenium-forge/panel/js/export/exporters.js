/**
 * SeleniumForge Export Engine
 * Converts Selenese test cases into multiple framework formats.
 *
 * Supported formats:
 *   java-testng     - Java + Selenium 4 + TestNG (Maven project)
 *   java-junit5     - Java + Selenium 4 + JUnit 5 (Maven project)
 *   python-pytest   - Python + Selenium 4 + pytest
 *   python-unittest - Python + Selenium 4 + unittest
 *   csharp-nunit    - C# + Selenium 4 + NUnit
 *   js-webdriverio  - JavaScript + WebdriverIO
 *   js-playwright   - JavaScript + Playwright (Selenium-like API)
 *   cucumber-bdd    - Gherkin feature file + step definitions (Java)
 *   robot-framework - Robot Framework + SeleniumLibrary
 *   selenese-html   - Selenium IDE HTML (original Selenese)
 *   json            - Raw JSON (internal format)
 *
 * Usage:
 *   import { exportTestCase } from './exporters.js';
 *   const code = exportTestCase(testCase, 'python-pytest');
 *
 * Each exporter receives a normalised TestCase object:
 *   {
 *     id:       string,
 *     name:     string,
 *     baseUrl:  string,
 *     commands: Array<{ command, target, value }>
 *   }
 */

'use strict';

// ---------------------------------------------------------------------------
// Utility helpers shared by all exporters
// ---------------------------------------------------------------------------

/** Escape a string for safe inclusion in a Java/C# double-quoted string literal */
function escJava(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g,  '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Escape for Python string literals (single-quoted) */
function escPython(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  "\\'");
}

/** Escape for XML/HTML attributes */
function escHtml(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/** Escape for Robot Framework (pipe-based table) */
function escRobot(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\\/g, '\\\\');
}

/** Convert a test name to a valid Java/C# identifier */
function toJavaIdent(name) {
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1');
}

/** Convert a test name to a Python identifier (snake_case) */
function toPythonIdent(name) {
  return name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/^(\d)/, '_$1')
    .toLowerCase();
}

/** Convert a test name to a Robot Framework test name (Title Case) */
function toRobotName(name) {
  return name.replace(/_/g, ' ');
}

/**
 * Parse a Selenese "target" string like "css=#foo" or "xpath=//div"
 * into { strategy, value }.
 */
function parseTarget(target) {
  if (!target) return { strategy: 'css', value: '' };
  const prefixes = ['id=', 'name=', 'css=', 'xpath=', 'link=', 'linkText='];
  for (const p of prefixes) {
    if (target.startsWith(p)) {
      return { strategy: p.slice(0, -1), value: target.slice(p.length) };
    }
  }
  return { strategy: 'css', value: target }; // bare selector
}

/**
 * Translate a { strategy, value } locator into a Selenium 4 Java/C# `By` call.
 */
function byJava({ strategy, value }) {
  const v = escJava(value);
  switch (strategy) {
    case 'id':          return `By.id("${v}")`;
    case 'name':        return `By.name("${v}")`;
    case 'css':         return `By.cssSelector("${v}")`;
    case 'xpath':       return `By.xpath("${v}")`;
    case 'link':        return `By.linkText("${v}")`;
    case 'linkText':    return `By.partialLinkText("${v}")`;
    default:            return `By.cssSelector("${v}")`;
  }
}

/**
 * Translate a locator into a Python Selenium 4 `By` call.
 */
function byPython({ strategy, value }) {
  const v = escPython(value);
  switch (strategy) {
    case 'id':          return `By.ID, '${v}'`;
    case 'name':        return `By.NAME, '${v}'`;
    case 'css':         return `By.CSS_SELECTOR, '${v}'`;
    case 'xpath':       return `By.XPATH, '${v}'`;
    case 'link':        return `By.LINK_TEXT, '${v}'`;
    case 'linkText':    return `By.PARTIAL_LINK_TEXT, '${v}'`;
    default:            return `By.CSS_SELECTOR, '${v}'`;
  }
}

/**
 * Translate a locator into a WebdriverIO selector string.
 */
function byWdio({ strategy, value }) {
  switch (strategy) {
    case 'id':          return `#${value}`;
    case 'name':        return `[name="${value}"]`;
    case 'css':         return value;
    case 'xpath':       return value;   // wdio accepts xpath strings directly
    case 'link':        return `=${value}`; // exact link text
    case 'linkText':    return `*=${value}`;
    default:            return value;
  }
}

/**
 * Translate a locator into a Playwright locator call.
 */
function byPlaywright({ strategy, value }) {
  const v = escJava(value); // js string, escJava works
  switch (strategy) {
    case 'id':          return `page.locator('#${v}')`;
    case 'name':        return `page.locator('[name="${v}"]')`;
    case 'css':         return `page.locator('${v}')`;
    case 'xpath':       return `page.locator('xpath=${v}')`;
    case 'link':        return `page.getByRole('link', { name: '${v}' })`;
    case 'linkText':    return `page.getByText('${v}')`;
    default:            return `page.locator('${v}')`;
  }
}

/**
 * Resolve "label=Foo" / "value=bar" / "index=2" from a Selenese select value.
 */
function parseSelectValue(value) {
  if (value.startsWith('label='))  return { by: 'text',  val: value.slice(6) };
  if (value.startsWith('value='))  return { by: 'value', val: value.slice(6) };
  if (value.startsWith('index='))  return { by: 'index', val: value.slice(6) };
  return { by: 'value', val: value };
}

// ---------------------------------------------------------------------------
// Command translators — one per exporter family
// ---------------------------------------------------------------------------

// ─── Java (TestNG / JUnit5) ──────────────────────────────────────────────────

/**
 * Translate a single Selenese command to Java code lines.
 * @param {{ command: string, target: string, value: string }} cmd
 * @param {string} indent  — leading whitespace
 * @returns {string[]}
 */
function cmdToJava(cmd, indent = '        ') {
  const { command, target, value } = cmd;
  const loc  = parseTarget(target);
  const by   = byJava(loc);
  const val  = escJava(value);
  const tgt  = escJava(target);

  switch (command) {
    case 'open':
      return [`${indent}driver.get(baseUrl + "${escJava(value || target)}");`];

    case 'click':
      return [`${indent}driver.findElement(${by}).click();`];

    case 'doubleClick':
      return [
        `${indent}new Actions(driver).doubleClick(driver.findElement(${by})).perform();`,
      ];

    case 'rightClick':
      return [
        `${indent}new Actions(driver).contextClick(driver.findElement(${by})).perform();`,
      ];

    case 'mouseOver':
      return [
        `${indent}new Actions(driver).moveToElement(driver.findElement(${by})).perform();`,
      ];

    case 'type':
      return [
        `${indent}driver.findElement(${by}).clear();`,
        `${indent}driver.findElement(${by}).sendKeys("${val}");`,
      ];

    case 'sendKeys': {
      const k = javaSeleniumKey(value);
      return [`${indent}driver.findElement(${by}).sendKeys(${k});`];
    }

    case 'clear':
      return [`${indent}driver.findElement(${by}).clear();`];

    case 'select': {
      const { by: selBy, val: selVal } = parseSelectValue(value);
      const selEsc = escJava(selVal);
      const selectLine = `${indent}new Select(driver.findElement(${by}))`;
      if (selBy === 'text')  return [`${selectLine}.selectByVisibleText("${selEsc}");`];
      if (selBy === 'index') return [`${selectLine}.selectByIndex(${selVal});`];
      return [`${selectLine}.selectByValue("${selEsc}");`];
    }

    case 'check':
      return [
        `${indent}{ WebElement cb = driver.findElement(${by}); if (!cb.isSelected()) cb.click(); }`,
      ];

    case 'uncheck':
      return [
        `${indent}{ WebElement cb = driver.findElement(${by}); if (cb.isSelected()) cb.click(); }`,
      ];

    case 'submit':
      return [`${indent}driver.findElement(${by}).submit();`];

    case 'focus':
      return [
        `${indent}new Actions(driver).moveToElement(driver.findElement(${by})).perform();`,
      ];

    case 'scroll':
      return [
        `${indent}((JavascriptExecutor)driver).executeScript("window.scrollTo(${value.replace(',', ', ')})");`,
      ];

    case 'scrollTo':
      return [
        `${indent}((JavascriptExecutor)driver).executeScript("arguments[0].scrollIntoView(true);", driver.findElement(${by}));`,
      ];

    case 'dragAndDropToObject': {
      const dstLoc = parseTarget(value);
      const dstBy  = byJava(dstLoc);
      return [
        `${indent}new Actions(driver).dragAndDrop(driver.findElement(${by}), driver.findElement(${dstBy})).perform();`,
      ];
    }

    case 'waitForElementPresent':
      return [
        `${indent}new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.presenceOfElementLocated(${by}));`,
      ];

    case 'waitForElementVisible':
      return [
        `${indent}new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.visibilityOfElementLocated(${by}));`,
      ];

    case 'waitForElementNotPresent':
      return [
        `${indent}new WebDriverWait(driver, Duration.ofSeconds(10)).until(ExpectedConditions.invisibilityOfElementLocated(${by}));`,
      ];

    case 'pause':
      return [`${indent}Thread.sleep(${parseInt(value, 10) || 1000});`];

    case 'assertText': {
      const assertFn = `assertThat(driver.findElement(${by}).getText().trim(), is("${val}"))`;
      return [`${indent}${assertFn};`];
    }

    case 'assertValue':
      return [`${indent}assertThat(driver.findElement(${by}).getAttribute("value"), is("${val}"));`];

    case 'assertChecked':
      return [`${indent}assertTrue(driver.findElement(${by}).isSelected());`];

    case 'assertNotChecked':
      return [`${indent}assertFalse(driver.findElement(${by}).isSelected());`];

    case 'assertElementPresent':
      return [`${indent}assertFalse(driver.findElements(${by}).isEmpty());`];

    case 'assertElementNotPresent':
      return [`${indent}assertTrue(driver.findElements(${by}).isEmpty());`];

    case 'assertTitle':
      return [`${indent}assertThat(driver.getTitle(), is("${val}"));`];

    case 'assertLocation':
      return [`${indent}assertThat(driver.getCurrentUrl(), is("${val}"));`];

    case 'verifyText':
      return [
        `${indent}try { assertThat(driver.findElement(${by}).getText().trim(), is("${val}")); }`,
        `${indent}catch (AssertionError e) { System.err.println("verifyText failed: " + e.getMessage()); }`,
      ];

    case 'storeText':
      return [`${indent}String ${toJavaIdent(value)} = driver.findElement(${by}).getText().trim();`];

    case 'storeValue':
      return [`${indent}String ${toJavaIdent(value)} = driver.findElement(${by}).getAttribute("value");`];

    case 'storeTitle':
      return [`${indent}String ${toJavaIdent(value)} = driver.getTitle();`];

    case 'echo':
      return [`${indent}System.out.println("${val}");`];

    case 'refresh':
      return [`${indent}driver.navigate().refresh();`];

    case 'goBack':
      return [`${indent}driver.navigate().back();`];

    case 'goForward':
      return [`${indent}driver.navigate().forward();`];

    case 'executeScript':
      return [`${indent}((JavascriptExecutor)driver).executeScript("${tgt}", "${val}");`];

    case 'captureEntirePageScreenshot':
      return [
        `${indent}File scrFile = ((TakesScreenshot)driver).getScreenshotAs(OutputType.FILE);`,
        `${indent}FileUtils.copyFile(scrFile, new File("${val || 'screenshot.png'}"));`,
      ];

    case 'goBack':
      return [`${indent}driver.navigate().back();`];

    default:
      return [`${indent}// TODO: unsupported command "${command}" target="${tgt}" value="${val}"`];
  }
}

/** Map Selenium IDE key constant strings to Java Keys enum values */
function javaSeleniumKey(seKey) {
  const m = {
    '${KEY_ENTER}':     'Keys.ENTER',
    '${KEY_TAB}':       'Keys.TAB',
    '${KEY_ESCAPE}':    'Keys.ESCAPE',
    '${KEY_BACKSPACE}': 'Keys.BACK_SPACE',
    '${KEY_DELETE}':    'Keys.DELETE',
    '${KEY_UP}':        'Keys.UP',
    '${KEY_DOWN}':      'Keys.DOWN',
    '${KEY_LEFT}':      'Keys.LEFT',
    '${KEY_RIGHT}':     'Keys.RIGHT',
  };
  return m[seKey] || `Keys.chord("${escJava(seKey)}")` ;
}

// ─── Python ──────────────────────────────────────────────────────────────────

/**
 * Translate a single Selenese command to Python code lines.
 */
function cmdToPython(cmd, indent = '        ') {
  const { command, target, value } = cmd;
  const loc = parseTarget(target);
  const by  = byPython(loc);
  const val = escPython(value);
  const tgt = escPython(target);

  switch (command) {
    case 'open':
      return [`${indent}self.driver.get(self.base_url + '${escPython(value || target)}')`];

    case 'click':
      return [`${indent}self.driver.find_element(${by}).click()`];

    case 'doubleClick':
      return [
        `${indent}ActionChains(self.driver).double_click(self.driver.find_element(${by})).perform()`,
      ];

    case 'rightClick':
      return [
        `${indent}ActionChains(self.driver).context_click(self.driver.find_element(${by})).perform()`,
      ];

    case 'mouseOver':
      return [
        `${indent}ActionChains(self.driver).move_to_element(self.driver.find_element(${by})).perform()`,
      ];

    case 'type':
      return [
        `${indent}self.driver.find_element(${by}).clear()`,
        `${indent}self.driver.find_element(${by}).send_keys('${val}')`,
      ];

    case 'sendKeys': {
      const k = pythonSeleniumKey(value);
      return [`${indent}self.driver.find_element(${by}).send_keys(${k})`];
    }

    case 'clear':
      return [`${indent}self.driver.find_element(${by}).clear()`];

    case 'select': {
      const { by: selBy, val: selVal } = parseSelectValue(value);
      const selEsc = escPython(selVal);
      const sel = `Select(self.driver.find_element(${by}))`;
      if (selBy === 'text')  return [`${indent}${sel}.select_by_visible_text('${selEsc}')`];
      if (selBy === 'index') return [`${indent}${sel}.select_by_index(${selVal})`];
      return [`${indent}${sel}.select_by_value('${selEsc}')`];
    }

    case 'check':
      return [
        `${indent}cb = self.driver.find_element(${by})`,
        `${indent}if not cb.is_selected(): cb.click()`,
      ];

    case 'uncheck':
      return [
        `${indent}cb = self.driver.find_element(${by})`,
        `${indent}if cb.is_selected(): cb.click()`,
      ];

    case 'submit':
      return [`${indent}self.driver.find_element(${by}).submit()`];

    case 'focus':
      return [
        `${indent}ActionChains(self.driver).move_to_element(self.driver.find_element(${by})).perform()`,
      ];

    case 'scroll':
      return [`${indent}self.driver.execute_script('window.scrollTo(${value})')`];

    case 'scrollTo':
      return [
        `${indent}self.driver.execute_script('arguments[0].scrollIntoView(true)', self.driver.find_element(${by}))`,
      ];

    case 'dragAndDropToObject': {
      const dstLoc = parseTarget(value);
      const dstBy  = byPython(dstLoc);
      return [
        `${indent}ActionChains(self.driver).drag_and_drop(self.driver.find_element(${by}), self.driver.find_element(${dstBy})).perform()`,
      ];
    }

    case 'waitForElementPresent':
      return [
        `${indent}WebDriverWait(self.driver, 10).until(EC.presence_of_element_located((${by})))`,
      ];

    case 'waitForElementVisible':
      return [
        `${indent}WebDriverWait(self.driver, 10).until(EC.visibility_of_element_located((${by})))`,
      ];

    case 'waitForElementNotPresent':
      return [
        `${indent}WebDriverWait(self.driver, 10).until(EC.invisibility_of_element_located((${by})))`,
      ];

    case 'pause':
      return [`${indent}time.sleep(${(parseInt(value, 10) || 1000) / 1000})`];

    case 'assertText':
      return [
        `${indent}assert self.driver.find_element(${by}).text.strip() == '${val}', \\`,
        `${indent}    f'assertText failed for ${tgt}'`,
      ];

    case 'assertValue':
      return [
        `${indent}assert self.driver.find_element(${by}).get_attribute('value') == '${val}'`,
      ];

    case 'assertChecked':
      return [`${indent}assert self.driver.find_element(${by}).is_selected()`];

    case 'assertNotChecked':
      return [`${indent}assert not self.driver.find_element(${by}).is_selected()`];

    case 'assertElementPresent':
      return [`${indent}assert len(self.driver.find_elements(${by})) > 0`];

    case 'assertElementNotPresent':
      return [`${indent}assert len(self.driver.find_elements(${by})) == 0`];

    case 'assertTitle':
      return [`${indent}assert self.driver.title == '${val}'`];

    case 'assertLocation':
      return [`${indent}assert self.driver.current_url == '${val}'`];

    case 'verifyText':
      return [
        `${indent}try:`,
        `${indent}    assert self.driver.find_element(${by}).text.strip() == '${val}'`,
        `${indent}except AssertionError as e:`,
        `${indent}    print(f'verifyText failed: {e}')`,
      ];

    case 'storeText':
      return [`${indent}${toPythonIdent(value)} = self.driver.find_element(${by}).text.strip()`];

    case 'storeValue':
      return [`${indent}${toPythonIdent(value)} = self.driver.find_element(${by}).get_attribute('value')`];

    case 'storeTitle':
      return [`${indent}${toPythonIdent(value)} = self.driver.title`];

    case 'echo':
      return [`${indent}print('${val}')`];

    case 'refresh':
      return [`${indent}self.driver.refresh()`];

    case 'goBack':
      return [`${indent}self.driver.back()`];

    case 'goForward':
      return [`${indent}self.driver.forward()`];

    case 'executeScript':
      return [`${indent}self.driver.execute_script('${escPython(target)}', '${val}')`];

    case 'captureEntirePageScreenshot':
      return [`${indent}self.driver.save_screenshot('${val || 'screenshot.png'}')`];

    default:
      return [`${indent}# TODO: unsupported command '${command}' target='${tgt}' value='${val}'`];
  }
}

function pythonSeleniumKey(seKey) {
  const m = {
    '${KEY_ENTER}':     'Keys.ENTER',
    '${KEY_TAB}':       'Keys.TAB',
    '${KEY_ESCAPE}':    'Keys.ESCAPE',
    '${KEY_BACKSPACE}': 'Keys.BACK_SPACE',
    '${KEY_DELETE}':    'Keys.DELETE',
    '${KEY_UP}':        'Keys.UP',
    '${KEY_DOWN}':      'Keys.DOWN',
    '${KEY_LEFT}':      'Keys.LEFT',
    '${KEY_RIGHT}':     'Keys.RIGHT',
  };
  return m[seKey] || `'${escPython(seKey)}'`;
}

// ─── C# / NUnit ───────────────────────────────────────────────────────────────

/**
 * Translate a single Selenese command to C# code lines.
 */
function cmdToCSharp(cmd, indent = '            ') {
  const { command, target, value } = cmd;
  const loc = parseTarget(target);
  const by  = byJava(loc);  // C# By syntax identical to Java
  const val = escJava(value);
  const tgt = escJava(target);

  switch (command) {
    case 'open':
      return [`${indent}driver.Navigate().GoToUrl(baseUrl + "${escJava(value || target)}");`];

    case 'click':
      return [`${indent}driver.FindElement(${by}).Click();`];

    case 'doubleClick':
      return [
        `${indent}new Actions(driver).DoubleClick(driver.FindElement(${by})).Perform();`,
      ];

    case 'rightClick':
      return [
        `${indent}new Actions(driver).ContextClick(driver.FindElement(${by})).Perform();`,
      ];

    case 'mouseOver':
      return [
        `${indent}new Actions(driver).MoveToElement(driver.FindElement(${by})).Perform();`,
      ];

    case 'type':
      return [
        `${indent}driver.FindElement(${by}).Clear();`,
        `${indent}driver.FindElement(${by}).SendKeys("${val}");`,
      ];

    case 'sendKeys': {
      const k = csharpSeleniumKey(value);
      return [`${indent}driver.FindElement(${by}).SendKeys(${k});`];
    }

    case 'clear':
      return [`${indent}driver.FindElement(${by}).Clear();`];

    case 'select': {
      const { by: selBy, val: selVal } = parseSelectValue(value);
      const selEsc = escJava(selVal);
      const sel = `new SelectElement(driver.FindElement(${by}))`;
      if (selBy === 'text')  return [`${indent}${sel}.SelectByText("${selEsc}");`];
      if (selBy === 'index') return [`${indent}${sel}.SelectByIndex(${selVal});`];
      return [`${indent}${sel}.SelectByValue("${selEsc}");`];
    }

    case 'check':
      return [
        `${indent}{ var cb = driver.FindElement(${by}); if (!cb.Selected) cb.Click(); }`,
      ];

    case 'uncheck':
      return [
        `${indent}{ var cb = driver.FindElement(${by}); if (cb.Selected) cb.Click(); }`,
      ];

    case 'submit':
      return [`${indent}driver.FindElement(${by}).Submit();`];

    case 'focus':
      return [
        `${indent}new Actions(driver).MoveToElement(driver.FindElement(${by})).Perform();`,
      ];

    case 'scroll':
      return [
        `${indent}((IJavaScriptExecutor)driver).ExecuteScript("window.scrollTo(${value})");`,
      ];

    case 'scrollTo':
      return [
        `${indent}((IJavaScriptExecutor)driver).ExecuteScript("arguments[0].scrollIntoView(true);", driver.FindElement(${by}));`,
      ];

    case 'dragAndDropToObject': {
      const dstLoc = parseTarget(value);
      const dstBy  = byJava(dstLoc);
      return [
        `${indent}new Actions(driver).DragAndDrop(driver.FindElement(${by}), driver.FindElement(${dstBy})).Perform();`,
      ];
    }

    case 'waitForElementPresent':
      return [
        `${indent}new WebDriverWait(driver, TimeSpan.FromSeconds(10)).Until(SeleniumExtras.WaitHelpers.ExpectedConditions.ElementExists(${by}));`,
      ];

    case 'waitForElementVisible':
      return [
        `${indent}new WebDriverWait(driver, TimeSpan.FromSeconds(10)).Until(SeleniumExtras.WaitHelpers.ExpectedConditions.ElementIsVisible(${by}));`,
      ];

    case 'waitForElementNotPresent':
      return [
        `${indent}new WebDriverWait(driver, TimeSpan.FromSeconds(10)).Until(SeleniumExtras.WaitHelpers.ExpectedConditions.InvisibilityOfElementLocated(${by}));`,
      ];

    case 'pause':
      return [`${indent}Thread.Sleep(${parseInt(value, 10) || 1000});`];

    case 'assertText':
      return [`${indent}Assert.That(driver.FindElement(${by}).Text.Trim(), Is.EqualTo("${val}"));`];

    case 'assertValue':
      return [`${indent}Assert.That(driver.FindElement(${by}).GetAttribute("value"), Is.EqualTo("${val}"));`];

    case 'assertChecked':
      return [`${indent}Assert.That(driver.FindElement(${by}).Selected, Is.True);`];

    case 'assertNotChecked':
      return [`${indent}Assert.That(driver.FindElement(${by}).Selected, Is.False);`];

    case 'assertElementPresent':
      return [`${indent}Assert.That(driver.FindElements(${by}).Count, Is.GreaterThan(0));`];

    case 'assertElementNotPresent':
      return [`${indent}Assert.That(driver.FindElements(${by}).Count, Is.EqualTo(0));`];

    case 'assertTitle':
      return [`${indent}Assert.That(driver.Title, Is.EqualTo("${val}"));`];

    case 'assertLocation':
      return [`${indent}Assert.That(driver.Url, Is.EqualTo("${val}"));`];

    case 'verifyText':
      return [
        `${indent}try { Assert.That(driver.FindElement(${by}).Text.Trim(), Is.EqualTo("${val}")); }`,
        `${indent}catch (AssertionException e) { Console.Error.WriteLine("verifyText failed: " + e.Message); }`,
      ];

    case 'storeText':
      return [`${indent}string ${toJavaIdent(value)} = driver.FindElement(${by}).Text.Trim();`];

    case 'storeValue':
      return [`${indent}string ${toJavaIdent(value)} = driver.FindElement(${by}).GetAttribute("value");`];

    case 'storeTitle':
      return [`${indent}string ${toJavaIdent(value)} = driver.Title;`];

    case 'echo':
      return [`${indent}Console.WriteLine("${val}");`];

    case 'refresh':
      return [`${indent}driver.Navigate().Refresh();`];

    case 'goBack':
      return [`${indent}driver.Navigate().Back();`];

    case 'goForward':
      return [`${indent}driver.Navigate().Forward();`];

    case 'executeScript':
      return [`${indent}((IJavaScriptExecutor)driver).ExecuteScript("${tgt}", "${val}");`];

    case 'captureEntirePageScreenshot':
      return [
        `${indent}Screenshot ss = ((ITakesScreenshot)driver).GetScreenshot();`,
        `${indent}ss.SaveAsFile("${val || 'screenshot.png'}");`,
      ];

    default:
      return [`${indent}// TODO: unsupported command "${command}" target="${tgt}" value="${val}"`];
  }
}

function csharpSeleniumKey(seKey) {
  const m = {
    '${KEY_ENTER}':     'Keys.Enter',
    '${KEY_TAB}':       'Keys.Tab',
    '${KEY_ESCAPE}':    'Keys.Escape',
    '${KEY_BACKSPACE}': 'Keys.Backspace',
    '${KEY_DELETE}':    'Keys.Delete',
    '${KEY_UP}':        'Keys.ArrowUp',
    '${KEY_DOWN}':      'Keys.ArrowDown',
    '${KEY_LEFT}':      'Keys.ArrowLeft',
    '${KEY_RIGHT}':     'Keys.ArrowRight',
  };
  return m[seKey] || `"${escJava(seKey)}"`;
}

// ─── JavaScript / WebdriverIO ─────────────────────────────────────────────────

/**
 * Translate a single Selenese command to WebdriverIO (async) code lines.
 */
function cmdToWdio(cmd, indent = '    ') {
  const { command, target, value } = cmd;
  const loc = parseTarget(target);
  const sel = `'${byWdio(loc).replace(/'/g, "\\'")}'`;
  const val = value.replace(/'/g, "\\'");

  switch (command) {
    case 'open':
      return [`${indent}await browser.url(baseUrl + '${(value || target).replace(/'/g, "\\'")}')`];

    case 'click':
      return [`${indent}await $(${sel}).click()`];

    case 'doubleClick':
      return [`${indent}await $(${sel}).doubleClick()`];

    case 'rightClick':
      return [`${indent}await $(${sel}).click({ button: 2 })`];

    case 'mouseOver':
      return [`${indent}await $(${sel}).moveTo()`];

    case 'type':
      return [
        `${indent}await $(${sel}).clearValue()`,
        `${indent}await $(${sel}).setValue('${val}')`,
      ];

    case 'sendKeys':
      return [`${indent}await $(${sel}).keys('${val}')`];

    case 'clear':
      return [`${indent}await $(${sel}).clearValue()`];

    case 'select': {
      const { by: selBy, val: selVal } = parseSelectValue(value);
      const sv = selVal.replace(/'/g, "\\'");
      if (selBy === 'text')  return [`${indent}await $(${sel}).selectByVisibleText('${sv}')`];
      if (selBy === 'index') return [`${indent}await $(${sel}).selectByIndex(${selVal})`];
      return [`${indent}await $(${sel}).selectByAttribute('value', '${sv}')`];
    }

    case 'check':
      return [`${indent}if (!(await $(${sel}).isSelected())) await $(${sel}).click()`];

    case 'uncheck':
      return [`${indent}if (await $(${sel}).isSelected()) await $(${sel}).click()`];

    case 'submit':
      return [`${indent}await $(${sel}).submit()`];

    case 'waitForElementPresent':
      return [`${indent}await $(${sel}).waitForExist({ timeout: 10000 })`];

    case 'waitForElementVisible':
      return [`${indent}await $(${sel}).waitForDisplayed({ timeout: 10000 })`];

    case 'waitForElementNotPresent':
      return [`${indent}await $(${sel}).waitForExist({ timeout: 10000, reverse: true })`];

    case 'pause':
      return [`${indent}await browser.pause(${parseInt(value, 10) || 1000})`];

    case 'assertText':
      return [`${indent}expect(await $(${sel}).getText()).toBe('${val}')`];

    case 'assertValue':
      return [`${indent}expect(await $(${sel}).getValue()).toBe('${val}')`];

    case 'assertChecked':
      return [`${indent}expect(await $(${sel}).isSelected()).toBe(true)`];

    case 'assertNotChecked':
      return [`${indent}expect(await $(${sel}).isSelected()).toBe(false)`];

    case 'assertElementPresent':
      return [`${indent}await $(${sel}).waitForExist()`];

    case 'assertTitle':
      return [`${indent}expect(await browser.getTitle()).toBe('${val}')`];

    case 'assertLocation':
      return [`${indent}expect(await browser.getUrl()).toBe('${val}')`];

    case 'storeText':
      return [`${indent}const ${value.replace(/[^a-zA-Z0-9_]/g,'_')} = await $(${sel}).getText()`];

    case 'storeTitle':
      return [`${indent}const ${value.replace(/[^a-zA-Z0-9_]/g,'_')} = await browser.getTitle()`];

    case 'echo':
      return [`${indent}console.log('${val}')`];

    case 'refresh':
      return [`${indent}await browser.refresh()`];

    case 'goBack':
      return [`${indent}await browser.back()`];

    case 'goForward':
      return [`${indent}await browser.forward()`];

    case 'executeScript':
      return [`${indent}await browser.execute('${target.replace(/'/g,"\\'")}')`];

    default:
      return [`${indent}// TODO: unsupported command '${command}'`];
  }
}

// ─── JavaScript / Playwright ──────────────────────────────────────────────────

/**
 * Translate a single Selenese command to Playwright (async) code lines.
 */
function cmdToPlaywright(cmd, indent = '  ') {
  const { command, target, value } = cmd;
  const loc    = parseTarget(target);
  const locStr = byPlaywright(loc);
  const val    = value.replace(/'/g, "\\'");

  switch (command) {
    case 'open':
      return [`${indent}await page.goto(baseUrl + '${(value || target).replace(/'/g, "\\'")}')`];

    case 'click':
      return [`${indent}await ${locStr}.click()`];

    case 'doubleClick':
      return [`${indent}await ${locStr}.dblclick()`];

    case 'rightClick':
      return [`${indent}await ${locStr}.click({ button: 'right' })`];

    case 'mouseOver':
      return [`${indent}await ${locStr}.hover()`];

    case 'type':
      return [
        `${indent}await ${locStr}.fill('${val}')`,
      ];

    case 'sendKeys':
      return [`${indent}await page.keyboard.press('${val}')`];

    case 'clear':
      return [`${indent}await ${locStr}.fill('')`];

    case 'select': {
      const { by: selBy, val: selVal } = parseSelectValue(value);
      const sv = selVal.replace(/'/g, "\\'");
      if (selBy === 'text')  return [`${indent}await ${locStr}.selectOption({ label: '${sv}' })`];
      if (selBy === 'index') return [`${indent}await ${locStr}.selectOption({ index: ${selVal} })`];
      return [`${indent}await ${locStr}.selectOption('${sv}')`];
    }

    case 'check':
      return [`${indent}await ${locStr}.check()`];

    case 'uncheck':
      return [`${indent}await ${locStr}.uncheck()`];

    case 'waitForElementPresent':
      return [`${indent}await ${locStr}.waitFor({ state: 'attached' })`];

    case 'waitForElementVisible':
      return [`${indent}await ${locStr}.waitFor({ state: 'visible' })`];

    case 'waitForElementNotPresent':
      return [`${indent}await ${locStr}.waitFor({ state: 'detached' })`];

    case 'pause':
      return [`${indent}await page.waitForTimeout(${parseInt(value, 10) || 1000})`];

    case 'assertText':
      return [`${indent}await expect(${locStr}).toHaveText('${val}')`];

    case 'assertValue':
      return [`${indent}await expect(${locStr}).toHaveValue('${val}')`];

    case 'assertChecked':
      return [`${indent}await expect(${locStr}).toBeChecked()`];

    case 'assertNotChecked':
      return [`${indent}await expect(${locStr}).not.toBeChecked()`];

    case 'assertElementPresent':
      return [`${indent}await expect(${locStr}).toBeVisible()`];

    case 'assertTitle':
      return [`${indent}await expect(page).toHaveTitle('${val}')`];

    case 'assertLocation':
      return [`${indent}await expect(page).toHaveURL('${val}')`];

    case 'storeText':
      return [`${indent}const ${value.replace(/[^a-zA-Z0-9_]/g,'_')} = await ${locStr}.textContent()`];

    case 'storeTitle':
      return [`${indent}const ${value.replace(/[^a-zA-Z0-9_]/g,'_')} = await page.title()`];

    case 'echo':
      return [`${indent}console.log('${val}')`];

    case 'refresh':
      return [`${indent}await page.reload()`];

    case 'goBack':
      return [`${indent}await page.goBack()`];

    case 'goForward':
      return [`${indent}await page.goForward()`];

    case 'executeScript':
      return [`${indent}await page.evaluate('${target.replace(/'/g,"\\'")}')`];

    case 'captureEntirePageScreenshot':
      return [`${indent}await page.screenshot({ path: '${val || 'screenshot.png'}', fullPage: true })`];

    default:
      return [`${indent}// TODO: unsupported command '${command}'`];
  }
}

// ─── Cucumber BDD (Gherkin + Java step defs) ─────────────────────────────────

/**
 * Convert a command to a Gherkin step line.
 */
function cmdToGherkin(cmd) {
  const { command, target, value } = cmd;
  const loc  = parseTarget(target);
  const desc = locatorDescription(loc);

  switch (command) {
    case 'open':          return `  Given I navigate to "${value || target}"`;
    case 'click':         return `  When I click on ${desc}`;
    case 'doubleClick':   return `  When I double-click on ${desc}`;
    case 'rightClick':    return `  When I right-click on ${desc}`;
    case 'mouseOver':     return `  When I hover over ${desc}`;
    case 'type':          return `  When I type "${value}" into ${desc}`;
    case 'clear':         return `  When I clear ${desc}`;
    case 'select':        return `  When I select "${value}" from ${desc}`;
    case 'check':         return `  When I check ${desc}`;
    case 'uncheck':       return `  When I uncheck ${desc}`;
    case 'submit':        return `  When I submit the form ${desc}`;
    case 'pause':         return `  And I wait for ${value} milliseconds`;
    case 'waitForElementPresent':  return `  Then ${desc} should be present`;
    case 'waitForElementVisible':  return `  Then ${desc} should be visible`;
    case 'waitForElementNotPresent': return `  Then ${desc} should not be present`;
    case 'assertText':    return `  Then the text of ${desc} should be "${value}"`;
    case 'assertValue':   return `  Then the value of ${desc} should be "${value}"`;
    case 'assertChecked': return `  Then ${desc} should be checked`;
    case 'assertTitle':   return `  Then the page title should be "${value}"`;
    case 'assertLocation': return `  Then the current URL should be "${value}"`;
    case 'refresh':       return `  When I refresh the page`;
    case 'goBack':        return `  When I navigate back`;
    case 'goForward':     return `  When I navigate forward`;
    case 'echo':          return `  And I log "${value}"`;
    default:              return `  And I perform "${command}" on ${desc}`;
  }
}

function locatorDescription({ strategy, value }) {
  switch (strategy) {
    case 'id':       return `the element with id "${value}"`;
    case 'name':     return `the element named "${value}"`;
    case 'link':     return `the link "${value}"`;
    case 'linkText': return `the partial link "${value}"`;
    default:         return `the element "${value}"`;
  }
}

// ─── Robot Framework ──────────────────────────────────────────────────────────

/**
 * Translate a single Selenese command to Robot Framework keyword lines.
 */
function cmdToRobot(cmd, indent = '    ') {
  const { command, target, value } = cmd;
  const loc    = parseTarget(target);
  const rfLoc  = robotLocator(loc);
  const val    = escRobot(value);

  switch (command) {
    case 'open':
      return [`${indent}Go To    ${escRobot(value || target)}`];

    case 'click':
      return [`${indent}Click Element    ${rfLoc}`];

    case 'doubleClick':
      return [`${indent}Double Click Element    ${rfLoc}`];

    case 'mouseOver':
      return [`${indent}Mouse Over    ${rfLoc}`];

    case 'type':
      return [
        `${indent}Clear Element Text    ${rfLoc}`,
        `${indent}Input Text    ${rfLoc}    ${val}`,
      ];

    case 'sendKeys':
      return [`${indent}Press Keys    ${rfLoc}    ${robotKey(value)}`];

    case 'clear':
      return [`${indent}Clear Element Text    ${rfLoc}`];

    case 'select': {
      const { by: selBy, val: selVal } = parseSelectValue(value);
      const sv = escRobot(selVal);
      if (selBy === 'text')  return [`${indent}Select From List By Label    ${rfLoc}    ${sv}`];
      if (selBy === 'index') return [`${indent}Select From List By Index    ${rfLoc}    ${sv}`];
      return [`${indent}Select From List By Value    ${rfLoc}    ${sv}`];
    }

    case 'check':
      return [`${indent}Select Checkbox    ${rfLoc}`];

    case 'uncheck':
      return [`${indent}Unselect Checkbox    ${rfLoc}`];

    case 'submit':
      return [`${indent}Submit Form    ${rfLoc}`];

    case 'waitForElementPresent':
      return [`${indent}Wait Until Element Is Enabled    ${rfLoc}    timeout=10s`];

    case 'waitForElementVisible':
      return [`${indent}Wait Until Element Is Visible    ${rfLoc}    timeout=10s`];

    case 'waitForElementNotPresent':
      return [`${indent}Wait Until Element Is Not Visible    ${rfLoc}    timeout=10s`];

    case 'pause':
      return [`${indent}Sleep    ${(parseInt(value, 10) || 1000) / 1000}s`];

    case 'assertText':
      return [`${indent}Element Text Should Be    ${rfLoc}    ${val}`];

    case 'assertValue':
      return [`${indent}Textfield Value Should Be    ${rfLoc}    ${val}`];

    case 'assertChecked':
      return [`${indent}Checkbox Should Be Selected    ${rfLoc}`];

    case 'assertNotChecked':
      return [`${indent}Checkbox Should Not Be Selected    ${rfLoc}`];

    case 'assertElementPresent':
      return [`${indent}Page Should Contain Element    ${rfLoc}`];

    case 'assertElementNotPresent':
      return [`${indent}Page Should Not Contain Element    ${rfLoc}`];

    case 'assertTitle':
      return [`${indent}Title Should Be    ${val}`];

    case 'assertLocation':
      return [`${indent}Location Should Be    ${val}`];

    case 'storeText': {
      const varName = `\${${value}}`;
      return [`${indent}${varName}=    Get Text    ${rfLoc}`];
    }

    case 'storeTitle': {
      const varName = `\${${value}}`;
      return [`${indent}${varName}=    Get Title`];
    }

    case 'echo':
      return [`${indent}Log    ${val}`];

    case 'refresh':
      return [`${indent}Reload Page`];

    case 'goBack':
      return [`${indent}Go Back`];

    case 'executeScript':
      return [`${indent}Execute Javascript    ${escRobot(target)}`];

    case 'captureEntirePageScreenshot':
      return [`${indent}Capture Page Screenshot    ${val || 'screenshot.png'}`];

    default:
      return [`${indent}# TODO: unsupported command "${command}" target="${escRobot(target)}" value="${val}"`];
  }
}

function robotLocator({ strategy, value }) {
  switch (strategy) {
    case 'id':    return `id:${value}`;
    case 'name':  return `name:${value}`;
    case 'css':   return `css:${value}`;
    case 'xpath': return `xpath:${value}`;
    case 'link':  return `link:${value}`;
    default:      return `css:${value}`;
  }
}

function robotKey(seKey) {
  const m = {
    '${KEY_ENTER}':     'ENTER',
    '${KEY_TAB}':       'TAB',
    '${KEY_ESCAPE}':    'ESCAPE',
    '${KEY_BACKSPACE}': 'BACKSPACE',
    '${KEY_DELETE}':    'DELETE',
    '${KEY_UP}':        'UP',
    '${KEY_DOWN}':      'DOWN',
    '${KEY_LEFT}':      'LEFT',
    '${KEY_RIGHT}':     'RIGHT',
  };
  return m[seKey] || seKey;
}

// ---------------------------------------------------------------------------
// Top-level exporters
// ---------------------------------------------------------------------------

// ─── Java TestNG ─────────────────────────────────────────────────────────────

function exportJavaTestNG(tc) {
  const cls   = toJavaIdent(tc.name);
  const cmds  = tc.commands.flatMap(c => cmdToJava(c)).join('\n');
  return [
    'package tests;',
    '',
    'import org.openqa.selenium.*;',
    'import org.openqa.selenium.chrome.ChromeDriver;',
    'import org.openqa.selenium.interactions.Actions;',
    'import org.openqa.selenium.support.ui.*;',
    'import org.openqa.selenium.support.ui.ExpectedConditions;',
    'import static org.hamcrest.MatcherAssert.assertThat;',
    'import static org.hamcrest.Matchers.*;',
    'import static org.testng.Assert.*;',
    'import org.testng.annotations.*;',
    'import org.apache.commons.io.FileUtils;',
    'import java.io.File;',
    'import java.time.Duration;',
    '',
    `public class ${cls} {`,
    '',
    '    private WebDriver driver;',
    `    private final String baseUrl = "${escJava(tc.baseUrl || '')}";`,
    '',
    '    @BeforeMethod',
    '    public void setUp() {',
    '        driver = new ChromeDriver();',
    '        driver.manage().window().maximize();',
    '        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));',
    '    }',
    '',
    '    @AfterMethod',
    '    public void tearDown() {',
    '        if (driver != null) driver.quit();',
    '    }',
    '',
    `    @Test`,
    `    public void ${cls}Test() throws InterruptedException {`,
    cmds,
    '    }',
    '}',
  ].join('\n');
}

// ─── Java JUnit5 ─────────────────────────────────────────────────────────────

function exportJavaJUnit5(tc) {
  const cls  = toJavaIdent(tc.name);
  const cmds = tc.commands.flatMap(c => cmdToJava(c)).join('\n');
  return [
    'package tests;',
    '',
    'import org.openqa.selenium.*;',
    'import org.openqa.selenium.chrome.ChromeDriver;',
    'import org.openqa.selenium.interactions.Actions;',
    'import org.openqa.selenium.support.ui.*;',
    'import org.openqa.selenium.support.ui.ExpectedConditions;',
    'import static org.hamcrest.MatcherAssert.assertThat;',
    'import static org.hamcrest.Matchers.*;',
    'import static org.junit.jupiter.api.Assertions.*;',
    'import org.junit.jupiter.api.*;',
    'import org.apache.commons.io.FileUtils;',
    'import java.io.File;',
    'import java.time.Duration;',
    '',
    `public class ${cls} {`,
    '',
    '    private WebDriver driver;',
    `    private final String baseUrl = "${escJava(tc.baseUrl || '')}";`,
    '',
    '    @BeforeEach',
    '    public void setUp() {',
    '        driver = new ChromeDriver();',
    '        driver.manage().window().maximize();',
    '        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));',
    '    }',
    '',
    '    @AfterEach',
    '    public void tearDown() {',
    '        if (driver != null) driver.quit();',
    '    }',
    '',
    '    @Test',
    `    public void ${cls}Test() throws InterruptedException {`,
    cmds,
    '    }',
    '}',
  ].join('\n');
}

// ─── Python pytest ────────────────────────────────────────────────────────────

function exportPythonPytest(tc) {
  const fn   = toPythonIdent(tc.name);
  const cmds = tc.commands.flatMap(c => cmdToPython(c)).join('\n');
  return [
    'import pytest',
    'import time',
    'from selenium import webdriver',
    'from selenium.webdriver.common.by import By',
    'from selenium.webdriver.common.keys import Keys',
    'from selenium.webdriver.common.action_chains import ActionChains',
    'from selenium.webdriver.support.ui import Select, WebDriverWait',
    'from selenium.webdriver.support import expected_conditions as EC',
    '',
    `BASE_URL = '${escPython(tc.baseUrl || '')}'`,
    '',
    '',
    '@pytest.fixture(scope="function")',
    'def driver():',
    '    _driver = webdriver.Chrome()',
    '    _driver.maximize_window()',
    '    _driver.implicitly_wait(10)',
    '    yield _driver',
    '    _driver.quit()',
    '',
    '',
    `def test_${fn}(driver):`,
    `    driver.base_url = BASE_URL  # attach for convenience`,
    cmds.split('\n').map(l => l.startsWith('        ') ? l : `    ${l}`).join('\n'),
  ].join('\n');
}

// ─── Python unittest ──────────────────────────────────────────────────────────

function exportPythonUnittest(tc) {
  const cls  = tc.name.replace(/[^a-zA-Z0-9]/g, '_');
  const fn   = toPythonIdent(tc.name);
  const cmds = tc.commands.flatMap(c => cmdToPython(c)).join('\n');
  return [
    'import unittest',
    'import time',
    'from selenium import webdriver',
    'from selenium.webdriver.common.by import By',
    'from selenium.webdriver.common.keys import Keys',
    'from selenium.webdriver.common.action_chains import ActionChains',
    'from selenium.webdriver.support.ui import Select, WebDriverWait',
    'from selenium.webdriver.support import expected_conditions as EC',
    '',
    '',
    `class ${cls}(unittest.TestCase):`,
    '',
    `    base_url = '${escPython(tc.baseUrl || '')}'`,
    '',
    '    def setUp(self):',
    '        self.driver = webdriver.Chrome()',
    '        self.driver.maximize_window()',
    '        self.driver.implicitly_wait(10)',
    '',
    '    def tearDown(self):',
    '        self.driver.quit()',
    '',
    `    def test_${fn}(self):`,
    cmds,
    '',
    '',
    "if __name__ == '__main__':",
    '    unittest.main()',
  ].join('\n');
}

// ─── C# NUnit ─────────────────────────────────────────────────────────────────

function exportCSharpNUnit(tc) {
  const cls  = toJavaIdent(tc.name);
  const cmds = tc.commands.flatMap(c => cmdToCSharp(c)).join('\n');
  return [
    'using NUnit.Framework;',
    'using OpenQA.Selenium;',
    'using OpenQA.Selenium.Chrome;',
    'using OpenQA.Selenium.Interactions;',
    'using OpenQA.Selenium.Support.UI;',
    'using SeleniumExtras.WaitHelpers;',
    'using System;',
    'using System.IO;',
    '',
    'namespace Tests',
    '{',
    `    [TestFixture]`,
    `    public class ${cls}`,
    '    {',
    '        private IWebDriver driver;',
    `        private readonly string baseUrl = "${escJava(tc.baseUrl || '')}";`,
    '',
    '        [SetUp]',
    '        public void SetUp()',
    '        {',
    '            driver = new ChromeDriver();',
    '            driver.Manage().Window.Maximize();',
    '            driver.Manage().Timeouts().ImplicitWait = TimeSpan.FromSeconds(10);',
    '        }',
    '',
    '        [TearDown]',
    '        public void TearDown()',
    '        {',
    '            driver?.Quit();',
    '        }',
    '',
    `        [Test]`,
    `        public void ${cls}Test()`,
    '        {',
    cmds,
    '        }',
    '    }',
    '}',
  ].join('\n');
}

// ─── JavaScript WebdriverIO ───────────────────────────────────────────────────

function exportJsWebdriverIO(tc) {
  const fn   = tc.name.replace(/[^a-zA-Z0-9_]/g, '_');
  const cmds = tc.commands.flatMap(c => cmdToWdio(c)).join('\n');
  return [
    `const baseUrl = '${tc.baseUrl || ''}';`,
    '',
    `describe('${tc.name.replace(/'/g, "\\'")}'  , () => {`,
    `  it('${fn}', async () => {`,
    cmds,
    '  });',
    '});',
  ].join('\n');
}

// ─── JavaScript Playwright ────────────────────────────────────────────────────

function exportJsPlaywright(tc) {
  const fn   = tc.name.replace(/[^a-zA-Z0-9_]/g, '_');
  const cmds = tc.commands.flatMap(c => cmdToPlaywright(c)).join('\n');
  return [
    "const { test, expect } = require('@playwright/test');",
    '',
    `const baseUrl = '${tc.baseUrl || ''}';`,
    '',
    `test('${tc.name.replace(/'/g, "\\'")}'  , async ({ page }) => {`,
    cmds,
    '});',
  ].join('\n');
}

// ─── Cucumber BDD ─────────────────────────────────────────────────────────────

function exportCucumberBDD(tc) {
  const cls      = toJavaIdent(tc.name);
  const scenario = tc.name;
  const steps    = tc.commands.map(cmdToGherkin).join('\n');

  const feature = [
    `Feature: ${scenario}`,
    '',
    `  Scenario: ${scenario}`,
    steps,
  ].join('\n');

  // Generate Java step definitions
  const stepDefs = generateCucumberStepDefs(tc.commands, cls);

  return `${'='.repeat(60)}\n// FEATURE FILE: ${cls}.feature\n${'='.repeat(60)}\n${feature}\n\n${'='.repeat(60)}\n// STEP DEFINITIONS: ${cls}Steps.java\n${'='.repeat(60)}\n${stepDefs}`;
}

function generateCucumberStepDefs(commands, cls) {
  const lines = [
    'package steps;',
    '',
    'import io.cucumber.java.en.*;',
    'import io.cucumber.java.Before;',
    'import io.cucumber.java.After;',
    'import org.openqa.selenium.*;',
    'import org.openqa.selenium.chrome.ChromeDriver;',
    'import org.openqa.selenium.interactions.Actions;',
    'import org.openqa.selenium.support.ui.*;',
    'import static org.hamcrest.MatcherAssert.assertThat;',
    'import static org.hamcrest.Matchers.*;',
    'import java.time.Duration;',
    '',
    `public class ${cls}Steps {`,
    '    private WebDriver driver;',
    '',
    '    @Before',
    '    public void setUp() {',
    '        driver = new ChromeDriver();',
    '        driver.manage().window().maximize();',
    '        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));',
    '    }',
    '',
    '    @After',
    '    public void tearDown() { if (driver != null) driver.quit(); }',
    '',
  ];

  // Emit one step method per command (de-duplication is beyond scope here)
  commands.forEach((cmd, i) => {
    const gherkin = cmdToGherkin(cmd).trim();
    const keyword = gherkin.split(' ')[0];  // Given/When/Then/And
    const text    = gherkin.slice(keyword.length + 1);
    const ann     = keyword === 'And' ? '@When' : `@${keyword}`;
    const method  = `step${i + 1}`;
    const javaLines = cmdToJava(cmd, '        ');

    lines.push(`    ${ann}("${escJava(text)}")`);
    lines.push(`    public void ${method}() throws InterruptedException {`);
    javaLines.forEach(l => lines.push(l));
    lines.push('    }');
    lines.push('');
  });

  lines.push('}');
  return lines.join('\n');
}

// ─── Robot Framework ──────────────────────────────────────────────────────────

function exportRobotFramework(tc) {
  const testName = toRobotName(tc.name);
  const cmds     = tc.commands.flatMap(c => cmdToRobot(c)).join('\n');
  return [
    '*** Settings ***',
    'Library    SeleniumLibrary',
    '',
    '*** Variables ***',
    `\${BASE_URL}    ${escRobot(tc.baseUrl || '')}`,
    '',
    '*** Test Cases ***',
    testName,
    cmds,
    '',
    '*** Keywords ***',
    '# Add reusable keywords here',
  ].join('\n');
}

// ─── Selenese HTML ────────────────────────────────────────────────────────────

function exportSeleneseHTML(tc) {
  const rows = tc.commands.map(({ command, target, value }) => [
    '<tr>',
    `    <td>${escHtml(command)}</td>`,
    `    <td>${escHtml(target)}</td>`,
    `    <td>${escHtml(value)}</td>`,
    '</tr>',
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"',
    '    "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">',
    '<head>',
    `<meta content="text/html; charset=UTF-8" http-equiv="content-type" />`,
    `<title>${escHtml(tc.name)}</title>`,
    '</head>',
    '<body>',
    `<table cellpadding="1" cellspacing="1" border="1">`,
    `<thead><tr><td rowspan="1" colspan="3">${escHtml(tc.name)}</td></tr></thead>`,
    '<tbody>',
    rows,
    '</tbody>',
    '</table>',
    '</body>',
    '</html>',
  ].join('\n');
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

function exportJSON(tc) {
  return JSON.stringify(tc, null, 2);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a TestCase to source code in the requested format.
 *
 * @param {object} testCase  — { id, name, baseUrl, commands }
 * @param {string} format    — one of the supported format keys
 * @returns {string}         — the generated source code
 */
function exportTestCase(testCase, format) {
  switch (format) {
    case 'java-testng':     return exportJavaTestNG(testCase);
    case 'java-junit5':     return exportJavaJUnit5(testCase);
    case 'python-pytest':   return exportPythonPytest(testCase);
    case 'python-unittest': return exportPythonUnittest(testCase);
    case 'csharp-nunit':    return exportCSharpNUnit(testCase);
    case 'js-webdriverio':  return exportJsWebdriverIO(testCase);
    case 'js-playwright':   return exportJsPlaywright(testCase);
    case 'cucumber-bdd':    return exportCucumberBDD(testCase);
    case 'robot-framework': return exportRobotFramework(testCase);
    case 'selenese-html':   return exportSeleneseHTML(testCase);
    case 'json':            return exportJSON(testCase);
    default:
      throw new Error(`Unknown export format: "${format}". Supported: java-testng, java-junit5, python-pytest, python-unittest, csharp-nunit, js-webdriverio, js-playwright, cucumber-bdd, robot-framework, selenese-html, json`);
  }
}

/**
 * Return all supported format keys.
 * @returns {string[]}
 */
function getSupportedFormats() {
  return [
    'java-testng',
    'java-junit5',
    'python-pytest',
    'python-unittest',
    'csharp-nunit',
    'js-webdriverio',
    'js-playwright',
    'cucumber-bdd',
    'robot-framework',
    'selenese-html',
    'json',
  ];
}

// ---------------------------------------------------------------------------
// Module export  (supports both ES modules and plain <script> inclusion)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { exportTestCase, getSupportedFormats };
} else if (typeof window !== 'undefined') {
  window.SeleniumForgeExporters = { exportTestCase, getSupportedFormats };
}
