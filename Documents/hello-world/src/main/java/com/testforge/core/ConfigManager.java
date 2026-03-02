package com.testforge.core;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;

/**
 * Loads configuration from testforge.properties.
 * System properties (-Dkey=value) override file values.
 */
public class ConfigManager {

    private static final Properties props = new Properties();

    static {
        try (InputStream in = ConfigManager.class.getClassLoader()
                .getResourceAsStream("testforge.properties")) {
            if (in != null) {
                props.load(in);
            }
        } catch (IOException e) {
            System.err.println("testforge.properties not found, using defaults");
        }
    }

    public static String get(String key) {
        // System property (-Dkey=value) wins over file
        String sysVal = System.getProperty(key);
        if (sysVal != null && !sysVal.isBlank()) {
            return sysVal;
        }
        return props.getProperty(key, "");
    }

    public static String get(String key, String defaultValue) {
        String val = get(key);
        return val.isBlank() ? defaultValue : val;
    }

    public static int getInt(String key, int defaultValue) {
        try {
            return Integer.parseInt(get(key));
        } catch (NumberFormatException e) {
            return defaultValue;
        }
    }

    public static boolean getBoolean(String key) {
        return Boolean.parseBoolean(get(key, "false"));
    }
}
