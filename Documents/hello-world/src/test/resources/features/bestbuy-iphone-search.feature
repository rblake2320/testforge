Feature: Best Buy iPhone Search

  @smoke
  Scenario: Search for iPhone 16 on Best Buy
    Given I open "https://www.bestbuy.com/site/searchpage.jsp?st=iPhone+16"
    When I wait 3 seconds
    Then the page title should contain "Best Buy"
    Then I should see "iPhone" on the page
    When I scroll down
    Then I should see "Apple" on the page
    When I take a screenshot named "bestbuy-iphone-results"
