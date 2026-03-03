Feature: Google Search
  @smoke
  Scenario: Load Google and search for weather
    Given I open "https://www.google.com"
    Then the page title should contain "Google"
    When I take a screenshot named "google_homepage"
    When I type "weather" into the element with id "lst-ib"
    When I click element with id "lst-ib"
    When I wait 1 seconds
    When I click on "Google Search"
    When I take a screenshot named "google_search_results"
    Then I should see "weather" on the page

  @smoke
  Scenario: Check search results for weather
    Given I open "https://www.google.com"
    When I type "weather" into the element with id "lst-ib"
    When I click element with id "lst-ib"
    When I wait 1 seconds
    When I click on "Google Search"
    When I take a screenshot named "weather_search_results"
    Then I should see "weather forecast" on the page

  @smoke
  Scenario: Search for weather and check URL
    Given I open "https://www.google.com"
    When I type "weather" into the element with id "lst-ib"
    When I click element with id "lst-ib"
    When I wait 1 seconds
    When I click on "Google Search"
    When I take a screenshot named "weather_search_url"
    Then the URL should contain "q=weather"