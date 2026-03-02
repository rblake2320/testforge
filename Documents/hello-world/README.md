# TestForge

A general-purpose Java Selenium test automation framework. Write tests in plain English, run them against any website, and get rich HTML reports with automatic Jira bug filing on failure.

## Features

- **Plain language tests** — Gherkin `.feature` files, no Java required to write tests
- **Any website** — generic step library covers navigation, clicks, forms, assertions, screenshots
- **Allure reports** — rich HTML report with screenshots, step-by-step results, history
- **Jira integration** — auto-creates bugs with screenshots attached when tests fail
- **Parallel execution** — run test suites concurrently via TestNG
- **Tag filtering** — `@smoke`, `@regression`, or any custom tag
- **Multi-browser** — Edge, Chrome, Firefox; configurable via properties or command line

## Quick Start

**Prerequisites:** Java 11+, Maven 3.6+, Edge/Chrome/Firefox installed.

```bash
git clone https://github.com/rblake2320/testforge.git
cd testforge/Documents/hello-world
mvn test
```

## Writing Tests

Create a `.feature` file in `src/test/resources/features/`:

```gherkin
Feature: Login page smoke test

  @smoke
  Scenario: Page loads and shows login form
    Given I open "https://example.com/login"
    Then the page title should contain "Login"
    Then I should see "Username" on the page
    When I type "testuser" into the element with id "username"
    When I type "password123" into the element with id "password"
    When I click element with css "button[type='submit']"
    When I take a screenshot named "after-login"
    Then I should see "Welcome" on the page
```

No Java code needed — the step library handles it.

## Available Steps

| Step | Description |
|------|-------------|
| `Given I open {string}` | Navigate to a URL |
| `When I click on {string}` | Click element by visible text |
| `When I click on {string} button` | Click button by text |
| `When I click element with id {string}` | Click by id attribute |
| `When I click element with css {string}` | Click by CSS selector |
| `When I type {string} into the {string} field` | Type into field by label/placeholder |
| `When I type {string} into the element with id {string}` | Type into field by id |
| `When I type {string} into element with css {string}` | Type into field by CSS |
| `When I search for {string}` | Type into search field and press Enter |
| `When I wait {int} seconds` | Explicit pause |
| `When I scroll down` | Scroll page down |
| `When I take a screenshot named {string}` | Capture screenshot |
| `When I navigate back` | Browser back |
| `When I refresh the page` | Browser refresh |
| `Then I should see {string} on the page` | Assert text visible |
| `Then I should not see {string} on the page` | Assert text not visible |
| `Then the page title should contain {string}` | Assert page title |
| `Then the URL should contain {string}` | Assert current URL |
| `Then the element with id {string} should contain {string}` | Assert element text |

## Run Commands

```bash
# Run all tests
mvn test

# Run only @smoke tagged tests
mvn test -Dcucumber.filter.tags="@smoke"

# Run only @regression tagged tests
mvn test -Dcucumber.filter.tags="@regression"

# Run in parallel (4 threads)
mvn test -Dparallel=methods -DthreadCount=4

# Use Chrome instead of Edge
mvn test -Dbrowser=chrome

# Run headless
mvn test -Dheadless=true

# Open Allure HTML report
mvn allure:serve
```

## Configuration

Edit `src/main/resources/testforge.properties`:

```properties
# Browser: edge, chrome, firefox
browser=edge

# Driver paths (blank = WebDriverManager auto-detects)
edge.driver.path=

# Timeouts (seconds)
explicit.wait=20
page.load.timeout=30

# Run headless
headless=false

# Screenshot output directory
screenshot.dir=target/screenshots
```

Any property can be overridden on the command line: `mvn test -Dbrowser=chrome -Dheadless=true`

## Jira Integration

Auto-files a bug with a screenshot attached whenever a test fails.

1. Get an API token: https://id.atlassian.com/manage-profile/security/api-tokens
2. Update `testforge.properties`:

```properties
jira.enabled=true
jira.url=https://your-instance.atlassian.net
jira.project=YOUR-PROJECT-KEY
jira.email=your-email@example.com
jira.api.token=your-api-token
jira.issuetype=Task
```

> **Note:** Set `jira.issuetype=Bug` if your project has a Bug issue type. The default Jira template uses `Task`.

Deduplication is on by default — re-running a failing test adds a comment to the existing open bug instead of creating a new one.

**Never commit your API token.** Pass it at runtime instead:
```bash
mvn test -Djira.enabled=true -Djira.api.token=your-token
```

## Project Structure

```
src/
  main/
    java/com/testforge/
      core/
        ConfigManager.java      # Properties loader with command-line overrides
        DriverFactory.java      # WebDriver creation (Edge/Chrome/Firefox + anti-bot)
        BasePage.java           # Page Object base: click, type, wait, screenshot
      integrations/
        JiraClient.java         # Jira Cloud REST API v3 client
    resources/
      testforge.properties      # All configuration
  test/
    java/com/testforge/
      steps/
        CommonSteps.java        # All generic Gherkin step definitions
        Hooks.java              # Driver lifecycle + screenshot on failure
      runner/
        TestRunner.java         # Cucumber + TestNG + Allure runner
        AllureListener.java     # Screenshot on TestNG failure
        JiraResultListener.java # Jira bug creation on TestNG failure
    resources/
      features/                 # Your .feature files go here
        web_navigation.feature  # Sample navigation tests
        form_fill.feature       # Sample form tests
      testng.xml                # Suite config (parallel settings)
```

## Tech Stack

| Component | Library | Version |
|-----------|---------|---------|
| Browser automation | Selenium WebDriver | 4.27.0 |
| BDD test format | Cucumber | 7.34.2 |
| Test runner | TestNG | 7.12.0 |
| HTML reporting | Allure | 2.33.0 |
| Driver management | WebDriverManager | 5.9.2 |
| Jira API | Java 11 HttpClient | built-in |
| JSON | Gson | 2.13.0 |
