Feature: iPhone 16 Product Information

  @smoke
  Scenario: Verify iPhone 16 Wikipedia article loads
    Given I open "https://en.wikipedia.org/wiki/IPhone_16"
    Then the page title should contain "iPhone 16"
    Then I should see "Apple" on the page
    Then I should see "iPhone" on the page
    When I scroll down
    When I take a screenshot named "iphone-16-info"
