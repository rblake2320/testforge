<div align="center">

# TestForge

**Record it. Write it. Run it. Report it.**

A monorepo housing two complementary test automation tools:
a Java/Selenium BDD framework and a Chrome extension that records browser actions
and exports them as ready-to-run test code.

[![TestForge CI](https://github.com/rblake2320/testforge/actions/workflows/testforge.yml/badge.svg)](https://github.com/rblake2320/testforge/actions/workflows/testforge.yml)
[![SeleniumForge CI](https://github.com/rblake2320/testforge/actions/workflows/selenium-forge.yml/badge.svg)](https://github.com/rblake2320/testforge/actions/workflows/selenium-forge.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

</div>

---

## What's Inside

| Module | Path | Description |
|--------|------|-------------|
| **TestForge Framework** | [`Documents/hello-world/`](Documents/hello-world/) | Java Selenium + Cucumber BDD + Allure reporting + Jira integration. Write tests in plain Gherkin, run them against any website, get rich HTML reports with automatic bug filing. |
| **SeleniumForge Extension** | [`selenium-forge/`](selenium-forge/) | Chrome extension that records browser interactions and exports them as Selenium test code for 9 frameworks — including Cucumber/Gherkin BDD projects compatible with the framework above. |

They work independently or together: record a test flow with SeleniumForge, export as Cucumber BDD, drop the `.feature` and step files into the framework, run with `mvn test`.

---

## Quick Start — TestForge Framework

**Prerequisites:** Java 11+, Maven 3.6+, Chrome or Edge installed.

```bash
git clone https://github.com/rblake2320/testforge.git
cd testforge/Documents/hello-world
mvn test                                          # run @smoke tests
mvn test -Dcucumber.filter.tags="@regression"     # run @regression tests
mvn allure:serve                                  # open HTML report
```

Write tests in plain English — no Java required:

```gherkin
@smoke
Scenario: Login page loads
  Given I open "https://example.com/login"
  Then the page title should contain "Login"
  When I type "admin" into the element with id "username"
  When I click element with css "button[type='submit']"
  Then I should see "Welcome" on the page
```

Full documentation: [Documents/hello-world/README.md](Documents/hello-world/README.md)

---

## Quick Start — SeleniumForge Chrome Extension

```bash
cd testforge/selenium-forge
```

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked** and select the `selenium-forge/` folder
4. Click the SeleniumForge icon in your toolbar

Record a test, then export to Cucumber BDD, Java TestNG, Python pytest, C# NUnit, JavaScript Mocha, Robot Framework, or raw JSON.

Full documentation: [selenium-forge/README.md](selenium-forge/README.md)

---

## CI / CD

### TestForge Framework
Runs on every push to `master` that touches `Documents/hello-world/`, on a weekday schedule (Mon-Fri 6 AM UTC), and via manual dispatch with configurable tags and browser.

- Allure HTML report and failure screenshots uploaded as artifacts
- Jira bug auto-filing when secrets are configured (gracefully skipped when absent)

### SeleniumForge Extension
Runs on every push to `master` that touches `selenium-forge/`, and on pull requests.

- Validates JSON syntax (manifest.json)
- Runs Node.js syntax checks on all JavaScript files
- Verifies all manifest-referenced files exist
- Packages the extension as a zip artifact

---

## Repository Structure

```
testforge/
├── .github/
│   ├── workflows/
│   │   ├── testforge.yml           # Java framework CI
│   │   └── selenium-forge.yml      # Chrome extension CI
│   └── dependabot.yml              # Automated dependency updates
├── Documents/
│   └── hello-world/                # Java Selenium + Cucumber framework
│       ├── pom.xml
│       ├── src/
│       └── README.md
├── selenium-forge/                 # Chrome extension recorder/exporter
│   ├── manifest.json
│   ├── background/
│   ├── content/
│   ├── panel/
│   └── README.md
├── LICENSE                         # Apache 2.0
├── CONTRIBUTING.md
├── SECURITY.md
├── .editorconfig
└── README.md                       # ← you are here
```

---

## Configuration

### Jira Integration (Framework)

The framework auto-creates Jira bugs with screenshots when tests fail. To enable:

1. Get an API token from [Atlassian](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Set GitHub Actions secrets (for CI) or pass on the command line (for local):

| Secret / Property | Purpose |
|---|---|
| `JIRA_ENABLED` | Set to `true` to activate |
| `JIRA_URL` | e.g. `https://yourteam.atlassian.net` |
| `JIRA_PROJECT` | Project key, e.g. `TF` |
| `JIRA_EMAIL` | Your Atlassian email |
| `JIRA_API_TOKEN` | API token (never commit this) |

If these secrets are absent, Jira integration is disabled and tests still pass normally.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Browser automation | Selenium WebDriver 4.27 |
| BDD test format | Cucumber 7.34 + Gherkin |
| Test runner | TestNG 7.12 |
| Reporting | Allure 2.33 |
| Driver management | WebDriverManager 5.9.2 |
| Jira integration | Java 11 HttpClient + REST API v3 |
| Extension UI | Vanilla JS, Chrome Extension Manifest V3 |
| CI | GitHub Actions |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for details.
