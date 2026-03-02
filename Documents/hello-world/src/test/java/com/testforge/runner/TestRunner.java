package com.testforge.runner;

import io.cucumber.testng.AbstractTestNGCucumberTests;
import io.cucumber.testng.CucumberOptions;
import org.testng.annotations.DataProvider;

/**
 * Runs all Cucumber feature files using TestNG.
 * Allure integration is activated via the plugin entry.
 * Run specific tags: mvn test -Dcucumber.filter.tags="@smoke"
 */
@CucumberOptions(
        features = "src/test/resources/features",
        glue = {"com.testforge.steps"},
        plugin = {
                "pretty",
                "html:target/cucumber-reports/report.html",
                "json:target/cucumber-reports/report.json",
                "io.qameta.allure.cucumber7jvm.AllureCucumber7Jvm"
        }
        // Tag filter: pass -Dcucumber.filter.tags="@smoke" on command line
        // Cucumber 7 reads this system property automatically — no annotation needed
)
public class TestRunner extends AbstractTestNGCucumberTests {

    /**
     * Override to enable parallel scenario execution.
     * Activated via: mvn test -Dparallel=methods -DthreadCount=4
     */
    @Override
    @DataProvider(parallel = false)
    public Object[][] scenarios() {
        return super.scenarios();
    }
}
