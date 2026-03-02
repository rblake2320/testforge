package com.testforge.steps;

import io.cucumber.java.en.*;
import io.qameta.allure.Allure;
import io.qameta.allure.Step;
import org.openqa.selenium.*;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;
import com.testforge.core.BasePage;
import com.testforge.core.ConfigManager;

import java.time.Duration;

import static org.testng.Assert.*;

/**
 * Generic Gherkin step definitions that work with any website.
 * Add site-specific steps in separate step classes extending these patterns.
 */
public class CommonSteps {

    private WebDriver driver() {
        return Hooks.getDriver();
    }

    private WebDriverWait getWait() {
        int timeout = ConfigManager.getInt("explicit.wait", 20);
        return new WebDriverWait(driver(), Duration.ofSeconds(timeout));
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    @Given("I open {string}")
    @Step("Open URL: {0}")
    public void iOpen(String url) {
        driver().get(url);
    }

    @When("I navigate back")
    @Step("Navigate back")
    public void iNavigateBack() {
        driver().navigate().back();
    }

    @When("I refresh the page")
    @Step("Refresh page")
    public void iRefreshThePage() {
        driver().navigate().refresh();
    }

    // ── Clicks ────────────────────────────────────────────────────────────────

    @When("I click on {string}")
    @Step("Click on: {0}")
    public void iClickOn(String text) {
        WebElement el = getWait().until(ExpectedConditions.elementToBeClickable(
                By.xpath("//*[normalize-space(text())='" + text + "' or @value='" + text
                        + "' or @aria-label='" + text + "' or @title='" + text + "']")
        ));
        el.click();
    }

    @When("I click on {string} button")
    @Step("Click button: {0}")
    public void iClickOnButton(String text) {
        WebElement btn = getWait().until(ExpectedConditions.elementToBeClickable(
                By.xpath("//button[contains(translate(normalize-space(.),"
                        + "'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'"
                        + text.toLowerCase() + "')]")
        ));
        btn.click();
    }

    @When("I click on {string} link")
    @Step("Click link: {0}")
    public void iClickOnLink(String text) {
        WebElement link = getWait().until(ExpectedConditions.elementToBeClickable(
                By.xpath("//a[contains(normalize-space(text()),'" + text + "')]")
        ));
        link.click();
    }

    @When("I click element with id {string}")
    @Step("Click element by id: {0}")
    public void iClickElementWithId(String id) {
        getWait().until(ExpectedConditions.elementToBeClickable(By.id(id))).click();
    }

    @When("I click element with css {string}")
    @Step("Click element by css: {0}")
    public void iClickElementWithCss(String css) {
        getWait().until(ExpectedConditions.elementToBeClickable(By.cssSelector(css))).click();
    }

    // ── Input ─────────────────────────────────────────────────────────────────

    @When("I type {string} into the {string} field")
    @Step("Type '{0}' into field '{1}'")
    public void iTypeIntoField(String value, String fieldLabel) {
        WebElement el = getWait().until(ExpectedConditions.visibilityOfElementLocated(
                By.xpath("//input[@placeholder='" + fieldLabel + "' or @name='" + fieldLabel
                        + "' or @id='" + fieldLabel + "' or @aria-label='" + fieldLabel + "']")
        ));
        el.clear();
        el.sendKeys(value);
    }

    @When("I type {string} into the element with id {string}")
    @Step("Type '{0}' into id='{1}'")
    public void iTypeIntoId(String value, String id) {
        WebElement el = getWait().until(ExpectedConditions.visibilityOfElementLocated(By.id(id)));
        el.clear();
        el.sendKeys(value);
    }

    @When("I type {string} into the element with css {string}")
    @Step("Type '{0}' into css='{1}'")
    public void iTypeIntoCss(String value, String css) {
        WebElement el = getWait().until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector(css)));
        el.clear();
        el.sendKeys(value);
    }

    @When("I search for {string}")
    @Step("Search for: {0}")
    public void iSearchFor(String query) {
        // Try common search box patterns
        WebElement searchBox = getWait().until(ExpectedConditions.visibilityOfElementLocated(
                By.xpath("//input[@type='search' or @role='searchbox' or @name='q' or @name='search'"
                        + " or contains(@placeholder,'earch')]")
        ));
        searchBox.clear();
        searchBox.sendKeys(query);
        searchBox.sendKeys(Keys.ENTER);
    }

    @When("I press Enter")
    @Step("Press Enter")
    public void iPressEnter() {
        driver().switchTo().activeElement().sendKeys(Keys.ENTER);
    }

    // ── Scroll & Wait ─────────────────────────────────────────────────────────

    @When("I scroll down")
    @Step("Scroll down")
    public void iScrollDown() {
        ((JavascriptExecutor) driver()).executeScript("window.scrollBy(0, 600)");
    }

    @When("I scroll to the bottom")
    @Step("Scroll to bottom")
    public void iScrollToBottom() {
        ((JavascriptExecutor) driver()).executeScript("window.scrollTo(0, document.body.scrollHeight)");
    }

    @When("I wait {int} seconds")
    @Step("Wait {0} seconds")
    public void iWaitSeconds(int seconds) throws InterruptedException {
        Thread.sleep(seconds * 1000L);
    }

    // ── Screenshots ───────────────────────────────────────────────────────────

    @When("I take a screenshot named {string}")
    @Step("Take screenshot: {0}")
    public void iTakeAScreenshotNamed(String name) {
        byte[] bytes = BasePage.takeScreenshot(driver(), name);
        Allure.getLifecycle().addAttachment(name, "image/png", "png", bytes);
    }

    // ── Assertions ────────────────────────────────────────────────────────────

    @Then("I should see {string} on the page")
    @Step("Page should contain: {0}")
    public void iShouldSeeOnThePage(String text) {
        getWait().until(driver -> driver.getPageSource().contains(text));
        assertTrue(driver().getPageSource().contains(text),
                "Expected page to contain: " + text);
    }

    @Then("I should not see {string} on the page")
    @Step("Page should NOT contain: {0}")
    public void iShouldNotSeeOnThePage(String text) {
        assertFalse(driver().getPageSource().contains(text),
                "Expected page NOT to contain: " + text);
    }

    @Then("the page title should contain {string}")
    @Step("Page title should contain: {0}")
    public void thePageTitleShouldContain(String expected) {
        getWait().until(ExpectedConditions.titleContains(expected));
        assertTrue(driver().getTitle().contains(expected),
                "Expected title to contain: " + expected + " but was: " + driver().getTitle());
    }

    @Then("the URL should contain {string}")
    @Step("URL should contain: {0}")
    public void theUrlShouldContain(String expected) {
        getWait().until(ExpectedConditions.urlContains(expected));
        assertTrue(driver().getCurrentUrl().contains(expected),
                "Expected URL to contain: " + expected + " but was: " + driver().getCurrentUrl());
    }

    @Then("the element with id {string} should contain {string}")
    @Step("Element '{0}' should contain: {1}")
    public void theElementWithIdShouldContain(String id, String expected) {
        WebElement el = getWait().until(ExpectedConditions.visibilityOfElementLocated(By.id(id)));
        assertTrue(el.getText().contains(expected),
                "Expected element #" + id + " to contain: " + expected + " but was: " + el.getText());
    }

    @Then("the element with css {string} should contain {string}")
    @Step("Element '{0}' should contain: {1}")
    public void theElementWithCssShouldContain(String css, String expected) {
        WebElement el = getWait().until(ExpectedConditions.visibilityOfElementLocated(By.cssSelector(css)));
        assertTrue(el.getText().contains(expected),
                "Expected element " + css + " to contain: " + expected + " but was: " + el.getText());
    }
}
