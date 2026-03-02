package com.testforge.runner;

import com.testforge.core.BasePage;
import com.testforge.steps.Hooks;
import io.qameta.allure.Allure;
import org.openqa.selenium.WebDriver;
import org.testng.ITestListener;
import org.testng.ITestResult;

/**
 * TestNG listener that captures a screenshot whenever a test fails.
 * Automatically attached to all tests via testng.xml listener config.
 */
public class AllureListener implements ITestListener {

    @Override
    public void onTestFailure(ITestResult result) {
        WebDriver driver = Hooks.getDriver();
        if (driver != null) {
            String name = "FAILED-" + result.getMethod().getMethodName();
            byte[] bytes = BasePage.takeScreenshot(driver, name);
            Allure.getLifecycle().addAttachment(name, "image/png", "png", bytes);
        }
    }
}
