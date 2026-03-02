package com.testforge.core;

import org.openqa.selenium.JavascriptExecutor;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.chrome.ChromeDriver;
import org.openqa.selenium.chrome.ChromeOptions;
import org.openqa.selenium.edge.EdgeDriver;
import org.openqa.selenium.edge.EdgeOptions;
import org.openqa.selenium.firefox.FirefoxDriver;
import org.openqa.selenium.firefox.FirefoxOptions;

import java.time.Duration;

/**
 * Creates and configures WebDriver instances.
 * Anti-bot detection options are applied by default based on patterns
 * proven in BestBuyPS5CheckoutTest.
 */
public class DriverFactory {

    private DriverFactory() {}

    public static WebDriver create() {
        String browser = ConfigManager.get("browser", "edge").toLowerCase();
        boolean headless = ConfigManager.getBoolean("headless");
        boolean maximized = ConfigManager.getBoolean("start.maximized");
        int pageLoadTimeout = ConfigManager.getInt("page.load.timeout", 30);

        WebDriver driver;
        if ("chrome".equals(browser)) {
            driver = createChrome(headless);
        } else if ("firefox".equals(browser)) {
            driver = createFirefox(headless);
        } else {
            driver = createEdge(headless);
        }

        if (maximized) {
            driver.manage().window().maximize();
        }
        driver.manage().timeouts().pageLoadTimeout(Duration.ofSeconds(pageLoadTimeout));
        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(
                ConfigManager.getInt("implicit.wait", 0)));

        // Remove webdriver flag to reduce bot detection
        ((JavascriptExecutor) driver).executeScript(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");

        return driver;
    }

    private static EdgeDriver createEdge(boolean headless) {
        String driverPath = ConfigManager.get("edge.driver.path");
        if (!driverPath.isBlank()) {
            System.setProperty("webdriver.edge.driver", driverPath);
        }

        EdgeOptions options = new EdgeOptions();
        applyAntiBotOptions(options);
        if (headless) {
            options.addArguments("--headless=new");
        }
        options.addArguments("--user-data-dir=C:\\Temp\\edge-selenium-profile");
        return new EdgeDriver(options);
    }

    private static ChromeDriver createChrome(boolean headless) {
        String driverPath = ConfigManager.get("chrome.driver.path");
        if (!driverPath.isBlank()) {
            System.setProperty("webdriver.chrome.driver", driverPath);
        }

        ChromeOptions options = new ChromeOptions();
        applyAntiBotOptions(options);
        if (headless) {
            options.addArguments("--headless=new");
        }
        return new ChromeDriver(options);
    }

    private static FirefoxDriver createFirefox(boolean headless) {
        String driverPath = ConfigManager.get("firefox.driver.path");
        if (!driverPath.isBlank()) {
            System.setProperty("webdriver.gecko.driver", driverPath);
        }

        FirefoxOptions options = new FirefoxOptions();
        if (headless) {
            options.addArguments("--headless");
        }
        return new FirefoxDriver(options);
    }

    /**
     * Applies anti-bot detection arguments to Chrome/Edge options.
     * Based on settings proven to work in BestBuyPS5CheckoutTest.
     */
    private static void applyAntiBotOptions(org.openqa.selenium.chromium.ChromiumOptions<?> options) {
        options.addArguments("--disable-blink-features=AutomationControlled");
        options.addArguments("--disable-infobars");
        options.addArguments("--no-sandbox");
        options.addArguments("--disable-dev-shm-usage");
        options.addArguments("--no-first-run");
        options.addArguments("--no-default-browser-check");
        options.addArguments("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0");
        options.setExperimentalOption("excludeSwitches", new String[]{"enable-automation"});
        options.setExperimentalOption("useAutomationExtension", false);
    }
}
