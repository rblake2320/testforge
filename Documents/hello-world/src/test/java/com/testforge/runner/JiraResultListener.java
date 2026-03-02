package com.testforge.runner;

import com.testforge.core.BasePage;
import com.testforge.integrations.JiraClient;
import com.testforge.steps.Hooks;
import io.qameta.allure.Allure;
import org.openqa.selenium.WebDriver;
import org.testng.ITestListener;
import org.testng.ITestResult;

import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * TestNG listener that creates a Jira bug automatically when any test fails.
 * Activate by setting jira.enabled=true in testforge.properties.
 *
 * Registered in testng.xml alongside AllureListener.
 */
public class JiraResultListener implements ITestListener {

    @Override
    public void onTestFailure(ITestResult result) {
        if (!JiraClient.isEnabled()) return;

        // Cucumber scenarios run as "runScenario" via AbstractTestNGCucumberTests.
        // Hooks.java already files Jira bugs for those — skip here to avoid duplicates.
        if ("runScenario".equals(result.getMethod().getMethodName())) return;

        String testName   = result.getMethod().getMethodName();
        String failureMsg = getFailureMessage(result);
        String stackTrace = getStackTrace(result);

        // Grab current URL and screenshot from the running browser (if Selenium is active)
        WebDriver driver  = Hooks.getDriver();
        String pageUrl    = "";
        byte[] screenshot = new byte[0];
        String shotName   = "FAILED-" + testName + ".png";

        if (driver != null) {
            try { pageUrl = driver.getCurrentUrl(); } catch (Exception ignored) {}
            screenshot = BasePage.takeScreenshot(driver, "JIRA-" + testName);
            if (screenshot.length > 0) {
                Allure.getLifecycle().addAttachment("Jira Screenshot", "image/png", "png", screenshot);
            }
        }

        JiraClient jira = new JiraClient();
        String issueKey = jira.createBugForTestFailure(testName, failureMsg, stackTrace, pageUrl, screenshot, shotName);

        if (issueKey != null) {
            // Attach the Jira link to the Allure report
            String jiraUrl = com.testforge.core.ConfigManager.get("jira.url");
            Allure.getLifecycle().addAttachment(
                    "Jira Bug: " + issueKey, "text/plain", "txt",
                    (jiraUrl + "/browse/" + issueKey).getBytes()
            );
            System.out.println("[Jira] Bug filed: " + jiraUrl + "/browse/" + issueKey);
        }
    }

    private String getFailureMessage(ITestResult result) {
        Throwable t = result.getThrowable();
        return t != null ? t.getMessage() : "Unknown failure";
    }

    private String getStackTrace(ITestResult result) {
        Throwable t = result.getThrowable();
        if (t == null) return "";
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        return sw.toString();
    }
}
