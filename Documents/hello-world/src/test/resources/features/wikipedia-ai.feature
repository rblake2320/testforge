Feature: Wikipedia Artificial Intelligence

  @smoke
  Scenario: Load AI article and verify key content
    Given I open "https://en.wikipedia.org/wiki/Artificial_intelligence"
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
