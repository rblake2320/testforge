Feature: GitHub Homepage

  @smoke
  Scenario: Verify GitHub homepage loads correctly
    Given I open "https://github.com"
    Then I should see "Sign in" on the page
    Then the page title should contain "GitHub"
    When I take a screenshot named "github-homepage"

  @smoke
  Scenario: GitHub homepage has build software tagline
    Given I open "https://github.com"
    Then I should see "Build and ship software" on the page
    Then I should see "Sign up" on the page
    When I take a screenshot named "github-tagline"
