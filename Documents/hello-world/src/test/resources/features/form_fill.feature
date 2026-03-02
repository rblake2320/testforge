Feature: Selenium Form Fill
  As a user
  I want to fill and submit a web form
  So that I can verify the framework handles form interactions

  @smoke
  Scenario: Fill and submit the Selenium test form
    Given I open "https://www.selenium.dev/selenium/web/web-form.html"
    Then the page title should contain "Web form"
    When I type "Hello TestForge" into the element with id "my-text-id"
    When I take a screenshot named "form-filled"
    When I click element with css "button[type='submit']"
    Then the element with id "message" should contain "Received!"
    When I take a screenshot named "form-submitted"
