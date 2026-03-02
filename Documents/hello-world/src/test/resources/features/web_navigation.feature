Feature: Web Navigation
  As a user
  I want to navigate and search on websites
  So that I can verify the framework works with any site

  @smoke
  Scenario: Open Best Buy and search for PS5
    Given I open "https://www.bestbuy.com/site/searchpage.jsp?st=PlayStation+5+Console"
    Then the page title should contain "Best Buy"
    When I wait 3 seconds
    When I scroll down
    Then I should see "PlayStation" on the page
    When I take a screenshot named "bestbuy-ps5-search"

  @smoke
  Scenario: Verify Selenium documentation site loads
    Given I open "https://www.selenium.dev"
    Then the page title should contain "Selenium"
    Then I should see "Selenium" on the page
    When I take a screenshot named "selenium-homepage"
