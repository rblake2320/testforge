Feature: Test GitHub homepage
  @smoke
  Scenario: Load GitHub homepage and verify Sign in button
    Given I open "https://github.com"
    When I take a screenshot named "github_homepage"
    Then I should see "Sign in" on the page
    Then the page title should contain "GitHub"

  @smoke
  Scenario: Verify Sign in button on GitHub homepage after refresh
    Given I open "https://github.com"
    When I refresh the page
    When I take a screenshot named "github_homepage_refreshed"
    Then I should see "Sign in" on the page
    Then the page title should contain "GitHub"

  @smoke
  Scenario: Verify GitHub homepage after navigating back
    Given I open "https://github.com"
    When I navigate back
    When I open "https://github.com"
    When I take a screenshot named "github_homepage_after_navigate_back"
    Then I should see "Sign in" on the page
    Then the page title should contain "GitHub"