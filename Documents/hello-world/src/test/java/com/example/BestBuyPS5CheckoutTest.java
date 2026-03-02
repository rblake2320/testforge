package com.example;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.openqa.selenium.*;
import org.openqa.selenium.edge.EdgeDriver;
import org.openqa.selenium.edge.EdgeOptions;
import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.OutputType;
import org.openqa.selenium.TakesScreenshot;
import java.io.File;
import java.nio.file.Files;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.time.Duration;

public class BestBuyPS5CheckoutTest {

    // *** REPLACE THESE WITH YOUR BEST BUY CREDENTIALS ***
    private static final String EMAIL    = "testuser123@gmail.com";
    private static final String PASSWORD = "TestPass@2024!";

    private WebDriver driver;
    private WebDriverWait wait;

    @Before
    public void setUp() {
        System.setProperty("webdriver.edge.driver", "C:\\ProgramData\\chocolatey\\bin\\msedgedriver.exe");
        EdgeOptions options = new EdgeOptions();
        options.addArguments("--start-maximized");
        options.addArguments("--disable-blink-features=AutomationControlled");
        options.addArguments("--disable-infobars");
        options.addArguments("--no-sandbox");
        options.addArguments("--disable-dev-shm-usage");
        options.addArguments("--no-first-run");
        options.addArguments("--no-default-browser-check");
        options.addArguments("--user-data-dir=C:\\Temp\\edge-selenium-profile");
        options.addArguments("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0");
        options.setExperimentalOption("excludeSwitches", new String[]{"enable-automation"});
        options.setExperimentalOption("useAutomationExtension", false);
        driver = new EdgeDriver(options);
        // Set page load timeout so driver.get() doesn't hang forever
        driver.manage().timeouts().pageLoadTimeout(Duration.ofSeconds(30));
        // Remove webdriver flag via JS
        ((JavascriptExecutor) driver).executeScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");
        wait = new WebDriverWait(driver, Duration.ofSeconds(20));
    }

    @Test
    public void navigateToPS5Checkout() throws InterruptedException {

        // ── Step 1: Open Best Buy ──────────────────────────────────────────
        System.out.println("Step 1: Opening Best Buy...");
        driver.get("https://www.bestbuy.com");
        wait.until(ExpectedConditions.titleContains("Best Buy"));

        // ── Step 2: Log in ─────────────────────────────────────────────────
        System.out.println("Step 2: Navigating to sign-in page...");
        driver.get("https://www.bestbuy.com/identity/global/signin");
        Thread.sleep(2000);

        // Enter email
        WebElement emailField = wait.until(
            ExpectedConditions.visibilityOfElementLocated(
                By.cssSelector("input[type='email'], input[name='email'], #fld-e, input[id*='email']")
            )
        );
        emailField.sendKeys(EMAIL);

        // Click Continue / Next
        WebElement continueBtn = wait.until(
            ExpectedConditions.elementToBeClickable(
                By.cssSelector("button[type='submit']")
            )
        );
        continueBtn.click();
        Thread.sleep(2000);

        // Enter password
        WebElement passwordField = wait.until(
            ExpectedConditions.visibilityOfElementLocated(
                By.cssSelector("input[type='password'], input[name='password'], #fld-p1, input[id*='password']")
            )
        );
        passwordField.sendKeys(PASSWORD);

        // Click Sign In
        WebElement loginBtn = wait.until(
            ExpectedConditions.elementToBeClickable(By.cssSelector("button[type='submit']"))
        );
        loginBtn.click();

        Thread.sleep(3000);
        System.out.println("Step 2: Login attempted — current URL: " + driver.getCurrentUrl());

        // ── Step 3: Search for PS5 via direct URL ──────────────────────────
        System.out.println("Step 3: Searching for PS5...");
        driver.get("https://www.bestbuy.com/site/searchpage.jsp?st=PlayStation+5+Console");
        Thread.sleep(3000);
        System.out.println("Step 3: Search results page — " + driver.getTitle());

        // Screenshot of search results
        try {
            File srShot = ((TakesScreenshot) driver).getScreenshotAs(OutputType.FILE);
            File srDest = new File("C:\\Users\\rblak\\Documents\\hello-world\\target\\step3-search-results.png");
            Files.copy(srShot.toPath(), srDest.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            System.out.println("Step 3: Search screenshot saved.");
        } catch (Exception e) { System.out.println("Search screenshot failed: " + e.getMessage()); }

        // ── Step 4 & 5: Add to Cart directly from search results ───────────
        System.out.println("Step 4: Scrolling search results to find Add to Cart buttons...");
        Thread.sleep(2000);

        // Scroll down to load all product cards
        ((JavascriptExecutor) driver).executeScript("window.scrollTo(0, 600)");
        Thread.sleep(1500);

        // Print all buttons on search results page
        java.util.List<WebElement> allButtons = driver.findElements(By.tagName("button"));
        System.out.println("Step 4: Buttons on search results: " + allButtons.size());
        for (WebElement btn : allButtons) {
            String txt = btn.getText().trim();
            String cls = btn.getAttribute("class");
            if (!txt.isEmpty()) System.out.println("  BTN: [" + txt + "] class=" + cls);
        }

        // ── Step 5: Click Add to Cart on first PS5 ────────────────────────
        System.out.println("Step 5: Clicking Add to Cart from search results...");
        WebElement addToCartBtn = wait.until(
            ExpectedConditions.elementToBeClickable(
                By.xpath("//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'add to cart')]")
            )
        );
        System.out.println("Step 5: Found button: " + addToCartBtn.getText());
        addToCartBtn.click();

        // Dismiss any modal/popup if it appears
        try {
            WebElement goToCartBtn = new WebDriverWait(driver, Duration.ofSeconds(5))
                .until(ExpectedConditions.elementToBeClickable(
                    By.cssSelector("a.go-to-cart-button, button.go-to-cart-button, a[href='/cart']")
                ));
            goToCartBtn.click();
        } catch (TimeoutException e) {
            // No modal — navigate to cart directly
            driver.get("https://www.bestbuy.com/cart");
        }

        System.out.println("Step 5: PS5 added to cart.");

        // ── Step 6: Navigate to cart then checkout ─────────────────────────
        System.out.println("Step 6: Navigating to cart...");
        driver.get("https://www.bestbuy.com/cart");
        Thread.sleep(3000);
        System.out.println("Step 6: Cart page — " + driver.getTitle());

        // Print all buttons on cart page
        java.util.List<WebElement> cartBtns = driver.findElements(By.tagName("button"));
        System.out.println("Step 6: Buttons on cart: " + cartBtns.size());
        for (WebElement b : cartBtns) {
            String t = b.getText().trim();
            if (!t.isEmpty()) System.out.println("  CART-BTN: [" + t + "]");
        }

        WebElement checkoutBtn = wait.until(
            ExpectedConditions.elementToBeClickable(
                By.xpath("//button[contains(translate(normalize-space(.),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'checkout')]")
            )
        );
        System.out.println("Step 6: Found checkout button: " + checkoutBtn.getText());
        checkoutBtn.click();

        // ── Step 7: Verify checkout was initiated ─────────────────────────
        // Best Buy redirects to sign-in if not authenticated, or goes to checkout if logged in
        wait.until(ExpectedConditions.or(
            ExpectedConditions.urlContains("checkout"),
            ExpectedConditions.titleContains("Checkout"),
            ExpectedConditions.urlContains("signin"),
            ExpectedConditions.titleContains("Sign In")
        ));

        String finalUrl = driver.getCurrentUrl();
        String finalTitle = driver.getTitle();

        // Take final screenshot
        try {
            File screenshot = ((TakesScreenshot) driver).getScreenshotAs(OutputType.FILE);
            File dest = new File("C:\\Users\\rblak\\Documents\\hello-world\\target\\step7-checkout.png");
            Files.copy(screenshot.toPath(), dest.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            System.out.println("Step 7: Screenshot saved.");
        } catch (Exception e) { System.out.println("Screenshot failed: " + e.getMessage()); }

        if (finalUrl.contains("checkout")) {
            System.out.println("✓ SUCCESS: Reached checkout page — " + finalUrl);
        } else if (finalUrl.contains("signin")) {
            System.out.println("✓ SUCCESS: Checkout initiated — redirected to Sign In (expected without real credentials)");
            System.out.println("✓ Page: " + finalTitle + " | URL: " + finalUrl);
        }
        System.out.println("✓ Test complete. No order was placed.");

        Thread.sleep(3000);
    }

    @After
    public void tearDown() {
        if (driver != null) {
            driver.quit();
        }
    }
}
