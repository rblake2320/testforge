# SeleniumForge — Test Recorder & Generator

A production-grade Chrome extension that records, plays back, and exports Selenium tests. Built as a full-featured alternative to Katalon Recorder with significant enhancements including Cucumber/Gherkin BDD export, self-healing locators, and data-driven testing.

## Features

### Recording
- **One-click recording** — Click Record, interact with any website, stop. Every action becomes a Selenese command.
- **Smart locator generation** — Generates 8 locator strategies per element (id, name, CSS, XPath, link text, data-*, aria-label, absolute XPath), ranked by stability.
- **Captures everything** — Clicks, typing, selects, checkboxes, drag-and-drop, keyboard shortcuts, alerts/prompts, frame switching, window switching.
- **Visual feedback** — Red hover highlight during recording, green flash on capture, recording badge overlay.

### 537 Selenese Commands
Full compatibility with the Selenese command set:
- **146 Actions** — click, type, select, sendKeys, open, dragAndDrop, fireEvent, mouseOver, plus all `AndWait` variants
- **208 Assertions** — assert/verify/assertNot/verifyNot for 52 accessors (Text, Value, Title, ElementPresent, Visible, Checked, etc.)
- **110 Waits** — waitFor/waitForNot variants with configurable polling and timeout
- **53 Store commands** — Store any accessor value into a variable
- **17 Control Flow** — if/elseif/else/endif, while/endwhile, do/repeatIf, times/end, gotoIf/gotoLabel, break
- **3 Utility** — echo, comment, setWindowSize

### Playback Engine
- **Speed control** — Slow (2s), Medium (1s), Fast (300ms), Fastest (0ms)
- **Pause / Resume / Stop** — Full execution control
- **Breakpoints** — Set breakpoints on any command, step through execution
- **Step-by-step mode** — Debug one command at a time
- **Variable system** — `${varName}` substitution, `javascript{expr}` evaluation, KEY_* constants
- **Command timeout** — Configurable per-command timeout (default 30s)
- **Real-time logging** — Timestamped pass/fail/error log for every command

### Self-Healing Locators
When a locator fails during playback:
1. Automatically tries all alternative locators captured during recording
2. If an alternative works, suggests the replacement
3. One-click approve/reject in the Self-Healing tab

### Data-Driven Testing
- **CSV and JSON** support
- `loadVars` / `endLoadVars` commands loop through data rows
- `${columnName}` variables auto-mapped from data file columns
- Upload and manage data files in the Test Data workspace tab

### Control Flow
- **Branching** — `if` / `elseif` / `else` / `endif` with JavaScript expressions
- **Loops** — `while` / `endwhile`, `do` / `repeatIf`, `times` / `end`
- **Labels** — `gotoIf` / `gotoLabel` / `label` for legacy compatibility
- **Break** — Exit any loop early
- Supports arbitrary nesting of all control structures

### Export to 9 Frameworks

| Format | Output |
|--------|--------|
| **Java + TestNG** (Selenium 4) | Maven project with `@Test`, `@BeforeMethod`, WebDriverWait |
| **Java + JUnit 5** (Selenium 4) | Maven project with `@Test`, `@BeforeEach`, JUnit Assertions |
| **Python + pytest** | pytest class, conftest.py, requirements.txt |
| **C# + NUnit** | NUnit test fixture, .csproj |
| **JavaScript + Mocha** | async/await tests, package.json |
| **Cucumber/Gherkin BDD** | `.feature` files + step definitions + Page Objects + TestRunner + pom.xml |
| **Robot Framework** | `.robot` files with SeleniumLibrary keywords |
| **Selenese HTML** | Classic Selenium IDE HTML table format |
| **JSON** | Raw JSON for reimport |

The **Cucumber/Gherkin BDD** export is a key upgrade — it generates a complete project structure with feature files, step definitions mapped to WebDriver calls, auto-generated Page Object classes, and a Cucumber+TestNG runner.

### Workspace Management
- **Test Suites** — Organize test cases into suites, drag-drop to reorder
- **Dynamic Test Suites** — Tag-based filtering across all test cases
- **Profiles** — Named sets of global variables (e.g., baseUrl, credentials per environment)
- **Extension Scripts** — Add custom commands and locator strategies
- **Import/Export** — Full workspace JSON backup and restore

### UI
- **Side Panel** — Full-featured panel with 4 resizable sections
- **Popup** — Quick-access popup with status, recent tests, and quick actions
- **Dark Mode** — Toggle between light and dark themes
- **Keyboard Shortcuts** — Ctrl+R (record), F5 (play), F8 (breakpoint), Ctrl+Z/Y (undo/redo)

## Installation

### From Source (Developer Mode)
1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right)
4. Click **Load unpacked**
5. Select the `selenium-forge` folder
6. The SeleniumForge icon appears in your toolbar

### Project Structure
```
selenium-forge/
├── manifest.json                    # Chrome Extension Manifest V3
├── background/
│   └── service-worker.js            # Background service worker (message routing, storage, badges)
├── content/
│   ├── recorder.js                  # Content script (recording, playback execution, self-healing)
│   └── recorder.css                 # Recording overlay styles
├── panel/
│   ├── sidepanel.html               # Main UI (full side panel interface)
│   ├── popup.html                   # Quick-access popup
│   └── js/
│       ├── engine/
│       │   ├── commands.js          # 537 Selenese command definitions with metadata
│       │   ├── playback.js          # Playback engine (execution, speed, breakpoints, variables)
│       │   └── controlflow.js       # Control flow engine (branching, loops, data-driven)
│       ├── export/
│       │   └── exporters.js         # 9 export formatters (Java, Python, C#, JS, Cucumber, Robot, etc.)
│       └── ui/
│           └── app.js               # Main UI controller (MVC wiring, all user interactions)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Architecture

```
┌─────────────────┐     chrome.runtime      ┌──────────────────┐     chrome.tabs      ┌─────────────────┐
│   Panel UI      │ ◄──── messages ────────► │  Service Worker   │ ◄─── messages ────► │ Content Script   │
│                 │                          │                   │                     │                  │
│ • sidepanel.html│                          │ • Message routing │                     │ • DOM recording  │
│ • app.js        │                          │ • Storage (CRUD)  │                     │ • Playback exec  │
│ • commands.js   │                          │ • Badge updates   │                     │ • Locator gen    │
│ • playback.js   │                          │ • Context menus   │                     │ • Self-healing   │
│ • controlflow.js│                          │ • Screenshots     │                     │ • Visual overlay │
│ • exporters.js  │                          │ • Downloads       │                     │                  │
└─────────────────┘                          └──────────────────┘                     └─────────────────┘
```

## Usage

### Record a Test
1. Click the SeleniumForge icon → Open Side Panel
2. Click **+ Add Suite** to create a test suite, then **+ Add Test Case**
3. Click the red **Record** button
4. Interact with any website — clicks, typing, selects are captured automatically
5. Click **Stop** when finished
6. Your test case appears in the command table

### Play Back
1. Select a test case in the workspace tree
2. Click **Play Test Case** (or F5)
3. Watch commands execute with real-time logging
4. Green rows = passed, Red rows = failed, Yellow = currently executing

### Export
1. Click the **Export** button in the toolbar
2. Select your target framework (e.g., Cucumber/Gherkin BDD)
3. Preview the generated code
4. Click **Download** to save the project files

### Data-Driven Testing
1. Go to the **Test Data** tab in the workspace
2. Click **+** to upload a CSV or JSON file
3. Right-click the data file → **Use in test case**
4. `loadVars` and `endLoadVars` commands are inserted
5. Use `${columnName}` in your command Target/Value fields

## Comparison with Katalon Recorder

| Feature | Katalon Recorder | SeleniumForge |
|---------|-----------------|---------------|
| Recording | ✓ | ✓ |
| Selenese commands | ~200 | 537 |
| Playback with speed control | ✓ | ✓ |
| Breakpoints & debugging | ✓ | ✓ + Step mode |
| Data-driven testing (CSV/JSON) | ✓ | ✓ |
| Control flow (if/while/goto) | ✓ | ✓ + do/repeatIf/times |
| Self-healing locators | ✓ | ✓ |
| Export to Java TestNG | ✓ | ✓ (Selenium 4) |
| Export to JUnit | ✓ | ✓ (JUnit 5) |
| Export to Python | ✓ | ✓ (pytest) |
| Export to C# | ✗ | ✓ (NUnit) |
| Export to JavaScript | ✗ | ✓ (Mocha) |
| **Export to Cucumber/Gherkin BDD** | **✗** | **✓ (Feature + Steps + Page Objects)** |
| Export to Robot Framework | ✓ | ✓ |
| Dynamic test suites (tag-based) | ✓ | ✓ |
| Profiles (global variables) | ✓ | ✓ |
| Extension scripts | ✓ | ✓ |
| Dark mode | ✗ | ✓ |
| Undo/Redo | ✗ | ✓ |
| Keyboard shortcuts | Limited | Full set |
| Side Panel support | ✗ | ✓ |

## License

Apache License 2.0

## Credits

Built with knowledge from:
- [Selenium IDE](https://github.com/SeleniumHQ/selenium-ide) — Architecture patterns
- [Katalon Recorder](https://github.com/katalon-studio/katalon-recorder) — Feature parity baseline
- [SeleniumCucumber](https://github.com/rahulrathore44/SeleniumCucumber) — BDD framework patterns
- [Selenium WebDriver](https://github.com/SeleniumHQ/selenium) — W3C WebDriver spec compliance
