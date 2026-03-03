Feature: Search for Cloudflare Workers on Google
  @smoke
  Scenario: Search for Cloudflare Workers
    Given I open "https://www.google.com"
    When I type "Cloudflare Workers" into element with css "input[name='q']"
    When I wait 2 seconds
    When I click element with css "input[name='btnK'], button[type='submit']"
    When I wait 2 seconds
    Then I should see "Cloudflare" on the page
    Then the URL should contain "google.com/search"
    When I take a screenshot named "google-cloudflare-results"
