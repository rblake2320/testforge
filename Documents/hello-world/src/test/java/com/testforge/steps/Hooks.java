package com.testforge.steps;

import com.testforge.core.BasePage;
import com.testforge.core.ConfigManager;
import com.testforge.core.DriverFactory;
import com.testforge.integrations.JiraClient;
import io.cucumber.java.After;
import io.cucumber.java.AfterStep;
import io.cucumber.java.Before;
import io.cucumber.java.Scenario;
import io.qameta.allure.Allure;
import org.openqa.selenium.WebDriver;

/**
 * Cucumber lifecycle hooks: set up WebDriver before each scenario,
 * take screenshot on failure, quit driver after each scenario.
 */
public class Hooks {

    // Shared driver — one instance per scenario via ThreadLocal for parallel safety
    private static final ThreadLocal<WebDriver> driverHolder = new ThreadLocal<>();

    public static WebDriver getDriver() {
        return driverHolder.get();
    }

    @Before
    public void setUp(Scenario scenario) {
        WebDriver driver = DriverFactory.create();
        driverHolder.set(driver);
        System.out.println(">> Starting scenario: " + scenario.getName());
    }

    @AfterStep
    public void afterStep(Scenario scenario) {
        if (scenario.isFailed()) {
            WebDriver driver = driverHolder.get();
            if (driver != null) {
                byte[] bytes = BasePage.takeScreenshot(driver, "FAILED-" + sanitize(scenario.getName()));
                Allure.getLifecycle().addAttachment("Screenshot on Failure", "image/png", "png", bytes);
            }
        }
    }

    @After
    public void tearDown(Scenario scenario) {
        WebDriver driver = driverHolder.get();
        if (driver != null) {
            if (scenario.isFailed()) {
                byte[] screenshot = BasePage.takeScreenshot(driver, "after-" + sanitize(scenario.getName()));
                Allure.getLifecycle().addAttachment("Final Screenshot", "image/png", "png", screenshot);

                // Auto-file a Jira bug if integration is enabled
                if (JiraClient.isEnabled()) {
                    String pageUrl = "";
                    try { pageUrl = driver.getCurrentUrl(); } catch (Exception ignored) {}

                    String shotName = "FAILED-" + sanitize(scenario.getName()) + ".png";
                    JiraClient jira = new JiraClient();
                    String issueKey = jira.createBugForTestFailure(
                            scenario.getName(),
                            "Cucumber scenario failed: " + scenario.getName(),
                            "See attached screenshot and Allure report for step details.",
                            pageUrl,
                            screenshot,
                            shotName
                    );
                    if (issueKey != null) {
                        String jiraUrl = ConfigManager.get("jira.url");
                        String link = jiraUrl + "/browse/" + issueKey;
                        System.out.println("[Jira] Bug filed: " + link);
                        Allure.getLifecycle().addAttachment(
                                "Jira Bug: " + issueKey, "text/plain", "txt", link.getBytes()
                        );
                    }
                }
            }
            driver.quit();
            driverHolder.remove();
        }
        System.out.println("<< Scenario " + (scenario.isFailed() ? "FAILED" : "PASSED")
                + ": " + scenario.getName());
    }

    private String sanitize(String name) {
        return name.replaceAll("[^a-zA-Z0-9-_]", "_").substring(0, Math.min(name.length(), 50));
    }
}
