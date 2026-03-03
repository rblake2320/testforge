Feature: Web Navigation
  As a user
  I want to navigate to websites
  So that I can verify the framework works with any site

  @smoke
  Scenario: Verify PlayStation 5 information on Wikipedia
    Given I open "https://en.wikipedia.org/wiki/PlayStation_5"
    Then the page title should contain "PlayStation 5"
    Then I should see "Sony" on the page
    When I scroll down
    When I take a screenshot named "ps5-wikipedia"

  @smoke
  Scenario: Verify Selenium documentation site loads
    Given I open "https://www.selenium.dev"
    Then the page title should contain "Selenium"
    Then I should see "Selenium" on the page
    When I take a screenshot named "selenium-homepage"
