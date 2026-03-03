Feature: Search for Cloudflare Workers on Google

  @smoke
  Scenario: Search for Cloudflare Workers and verify results
    Given I open "https://www.google.com"
    When I search for "Cloudflare Workers"
    When I wait 2 seconds
    Then I should see "Cloudflare" on the page
    Then the URL should contain "google.com/search"
    When I take a screenshot named "cloudflare-workers-results"
