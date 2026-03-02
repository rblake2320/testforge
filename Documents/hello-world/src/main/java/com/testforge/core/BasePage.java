package com.testforge.core;

import org.openqa.selenium.*;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.time.Duration;

/**
 * Base class for page objects. Provides reusable Selenium actions with
 * proper explicit waits (no Thread.sleep), auto-screenshots, and Allure
 * step logging. Extend this class for site-specific page objects.
 */
public abstract class BasePage {

    protected final WebDriver driver;
    protected final WebDriverWait wait;

    protected BasePage(WebDriver driver) {
        this.driver = driver;
        int timeout = ConfigManager.getInt("explicit.wait", 20);
        this.wait = new WebDriverWait(driver, Duration.ofSeconds(timeout));
    }

    public void open(String url) {
        driver.get(url);
    }

    public void click(By locator) {
        wait.until(ExpectedConditions.elementToBeClickable(locator)).click();
    }

    public void click(WebElement element) {
        wait.until(ExpectedConditions.elementToBeClickable(element)).click();
    }

    public void type(By locator, String text) {
        WebElement el = wait.until(ExpectedConditions.visibilityOfElementLocated(locator));
        el.clear();
        el.sendKeys(text);
    }

    public WebElement waitForElement(By locator) {
        return wait.until(ExpectedConditions.visibilityOfElementLocated(locator));
    }

    public WebElement waitForClickable(By locator) {
        return wait.until(ExpectedConditions.elementToBeClickable(locator));
    }

    public void waitForText(By locator, String text) {
        wait.until(ExpectedConditions.textToBePresentInElementLocated(locator, text));
    }

    public boolean isTextPresent(String text) {
        return driver.getPageSource().contains(text);
    }

    public String getText(By locator) {
        return waitForElement(locator).getText();
    }

    public String getTitle() {
        return driver.getTitle();
    }

    public String getCurrentUrl() {
        return driver.getCurrentUrl();
    }

    public void scrollDown(int pixels) {
        ((JavascriptExecutor) driver).executeScript("window.scrollBy(0, " + pixels + ")");
    }

    public void scrollTo(WebElement element) {
        ((JavascriptExecutor) driver).executeScript("arguments[0].scrollIntoView(true);", element);
    }

    public void scrollToBottom() {
        ((JavascriptExecutor) driver).executeScript("window.scrollTo(0, document.body.scrollHeight)");
    }

    /**
     * Takes a screenshot and saves it to target/screenshots/[name].png.
     * Returns the raw bytes so callers can also attach to Allure if needed.
     */
    public byte[] takeScreenshot(String name) {
        return takeScreenshot(driver, name);
    }

    /**
     * Static convenience: take screenshot from WebDriver directly (without a page object instance).
     */
    public static byte[] takeScreenshot(WebDriver driver, String name) {
        if (!(driver instanceof TakesScreenshot)) return new byte[0];
        try {
            byte[] bytes = ((TakesScreenshot) driver).getScreenshotAs(OutputType.BYTES);
            String dir = ConfigManager.get("screenshot.dir", "target/screenshots");
            File destDir = new File(dir);
            destDir.mkdirs();
            Files.write(new File(destDir, name + ".png").toPath(), bytes);
            return bytes;
        } catch (IOException e) {
            System.err.println("Screenshot failed: " + e.getMessage());
            return new byte[0];
        }
    }
}
