Feature: Wikipedia page load
  @smoke
  Scenario: Load Wikipedia and verify page title
    Given I open "https://www.wikipedia.org/"
    When I wait 2 seconds
    When I take a screenshot named "wikipedia_homepage"
    Then the page title should contain "Wikipedia"

  @smoke
  Scenario: Load Wikipedia English and verify page title
    Given I open "https://en.wikipedia.org/"
    When I wait 2 seconds
    When I take a screenshot named "wikipedia_english_homepage"
    Then the page title should contain "Wikipedia"

  @smoke
  Scenario: Load Wikipedia and verify Wikipedia in page title after refresh
    Given I open "https://www.wikipedia.org/"
    When I refresh the page
    When I wait 2 seconds
    When I take a screenshot named "wikipedia_refreshed_homepage"
    Then the page title should contain "Wikipedia"