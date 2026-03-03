Feature: GitHub homepage
  @smoke
  Scenario: Load GitHub homepage
    Given I open "https://github.com"
    When I wait 2 seconds
    Then the page title should contain "GitHub"
    Then I should see "Sign in" on the page
    When I take a screenshot named "github_homepage"
    Then the URL should contain "github.com"

  @smoke
  Scenario: Verify Sign in button on GitHub homepage
    Given I open "https://github.com"
    When I wait 1 seconds
    Then I should see "Sign in" on the page
    When I take a screenshot named "github_signin_button"
    When I click on "Sign in"
    When I wait 2 seconds
    Then the URL should contain "login"

  @smoke
  Scenario: Refresh GitHub homepage
    Given I open "https://github.com"
    When I wait 1 seconds
    Then I should see "Sign in" on the page
    When I refresh the page
    When I wait 2 seconds
    Then the page title should contain "GitHub"
    When I take a screenshot named "github_homepage_refreshed"