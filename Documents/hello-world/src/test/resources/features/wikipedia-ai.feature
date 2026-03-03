Feature: Wikipedia Artificial Intelligence

  @smoke
  Scenario: Search for Artificial Intelligence on Wikipedia
    Given I open "https://www.wikipedia.org/"
    When I type "Artificial Intelligence" into the element with id "searchInput"
    When I click element with id "searchButton"
    When I wait 2 seconds
    Then the page title should contain "Artificial intelligence"
    Then I should see "Artificial intelligence" on the page
    When I take a screenshot named "wikipedia-ai-article"

  @smoke
  Scenario: Open AI article directly and verify content
    Given I open "https://en.wikipedia.org/wiki/Artificial_intelligence"
    When I wait 1 seconds
    Then the element with id "firstHeading" should contain "Artificial intelligence"
    Then I should see "Machine learning" on the page
    When I take a screenshot named "wikipedia-ai-content"
