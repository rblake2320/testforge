package com.example;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.openqa.selenium.By;
import org.openqa.selenium.WebDriver;
import org.openqa.selenium.WebElement;
import org.openqa.selenium.edge.EdgeDriver;
import org.openqa.selenium.edge.EdgeOptions;
import org.openqa.selenium.support.ui.ExpectedConditions;
import org.openqa.selenium.support.ui.WebDriverWait;

import java.time.Duration;

import static org.junit.Assert.*;

public class SeleniumFormTest {

    private WebDriver driver;
    private WebDriverWait wait;

    @Before
    public void setUp() {
        System.setProperty("webdriver.edge.driver", "C:\\ProgramData\\chocolatey\\bin\\msedgedriver.exe");
        EdgeOptions options = new EdgeOptions();
        // options.addArguments("--headless"); // uncomment to run without opening browser
        driver = new EdgeDriver(options);
        wait = new WebDriverWait(driver, Duration.ofSeconds(10));
        driver.manage().window().maximize();
    }

    @Test
    public void testFillAndSubmitForm() {
        // Navigate to a sample form page
        driver.get("https://www.selenium.dev/selenium/web/web-form.html");

        // Verify page title
        String title = driver.getTitle();
        assertTrue("Page title should contain 'Web form'", title.contains("Web form"));

        // Fill in text input
        WebElement textInput = wait.until(
            ExpectedConditions.visibilityOfElementLocated(By.id("my-text-id"))
        );
        textInput.clear();
        textInput.sendKeys("Hello Selenium");

        // Fill in password field
        WebElement passwordInput = driver.findElement(By.name("my-password"));
        passwordInput.sendKeys("secret123");

        // Fill in textarea
        WebElement textarea = driver.findElement(By.name("my-textarea"));
        textarea.sendKeys("This is a Selenium test using Microsoft Edge.");

        // Submit the form
        WebElement submitBtn = driver.findElement(By.cssSelector("button[type='submit']"));
        submitBtn.click();

        // Verify submission was successful
        WebElement message = wait.until(
            ExpectedConditions.visibilityOfElementLocated(By.id("message"))
        );
        assertEquals("Form submitted successfully", "Received!", message.getText());

        System.out.println("Test passed: Form filled and submitted successfully.");
    }

    @After
    public void tearDown() {
        if (driver != null) {
            driver.quit();
        }
    }
}
