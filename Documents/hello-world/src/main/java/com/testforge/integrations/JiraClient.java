package com.testforge.integrations;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.testforge.core.ConfigManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;

/**
 * Jira Cloud REST API v3 client.
 * Uses Java 11 HttpClient — no Atlassian library needed.
 *
 * Auth: Basic auth with email + API token (base64 encoded).
 * Get your API token: https://id.atlassian.com/manage-profile/security/api-tokens
 */
public class JiraClient {

    private final String baseUrl;
    private final String authHeader;
    private final String project;
    private final String issueType;
    private final String priority;
    private final String labels;
    private final boolean createDuplicates;
    private final String assigneeAccountId;

    private final HttpClient http;
    private final Gson gson = new Gson();

    public JiraClient() {
        this.baseUrl     = ConfigManager.get("jira.url").replaceAll("/$", "");
        this.project     = ConfigManager.get("jira.project", "TEST");
        this.issueType   = ConfigManager.get("jira.issuetype", "Bug");
        this.priority    = ConfigManager.get("jira.priority", "High");
        this.labels      = ConfigManager.get("jira.labels", "automated-test,testforge");
        this.createDuplicates    = ConfigManager.getBoolean("jira.create.duplicate");
        this.assigneeAccountId   = ConfigManager.get("jira.assignee.account.id");

        String email = ConfigManager.get("jira.email");
        String token = ConfigManager.get("jira.api.token");
        String raw   = email + ":" + token;
        this.authHeader = "Basic " + Base64.getEncoder().encodeToString(raw.getBytes(StandardCharsets.UTF_8));

        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
    }

    /**
     * Returns true if Jira integration is enabled in config.
     */
    public static boolean isEnabled() {
        return ConfigManager.getBoolean("jira.enabled");
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Creates a Bug for a test failure.
     *
     * @param testName       The test/scenario name
     * @param failureMessage The assertion or exception message
     * @param stackTrace     Full stack trace
     * @param pageUrl        URL where the failure occurred (may be empty)
     * @param screenshot     Screenshot bytes to attach (may be empty)
     * @param screenshotName Filename for the attachment (e.g. "FAILED-login.png")
     * @return The created issue key (e.g. "TEST-42"), or null if creation failed
     */
    public String createBugForTestFailure(String testName, String failureMessage,
            String stackTrace, String pageUrl,
            byte[] screenshot, String screenshotName) {

        String summary = "[TestForge] Test Failed: " + truncate(testName, 200);

        // Check for existing open bug with same summary (de-duplicate)
        if (!createDuplicates) {
            String existing = findOpenIssueByTestName(testName);
            if (existing != null) {
                System.out.println("[Jira] Existing open bug found: " + existing + " — skipping duplicate creation.");
                addComment(existing, "Test failed again.\n\nURL: " + pageUrl
                        + "\n\nError: " + failureMessage);
                if (screenshot != null && screenshot.length > 0) {
                    addAttachment(existing, screenshot, screenshotName);
                }
                return existing;
            }
        }

        String issueKey = createIssue(summary, failureMessage, stackTrace, pageUrl);
        if (issueKey == null) return null;

        System.out.println("[Jira] Bug created: " + baseUrl + "/browse/" + issueKey);

        if (screenshot != null && screenshot.length > 0) {
            addAttachment(issueKey, screenshot, screenshotName);
        }
        return issueKey;
    }

    /**
     * Creates a Jira issue and returns its key (e.g. "TEST-42").
     */
    public String createIssue(String summary, String errorMessage, String stackTrace, String pageUrl) {
        JsonObject body = buildCreateBody(summary, errorMessage, stackTrace, pageUrl);
        String json = gson.toJson(body);

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/rest/api/3/issue"))
                    .header("Authorization", authHeader)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());

            if (resp.statusCode() == 201) {
                JsonObject result = gson.fromJson(resp.body(), JsonObject.class);
                return result.get("key").getAsString();
            } else {
                System.err.println("[Jira] Create issue failed (" + resp.statusCode() + "): " + resp.body());
                return null;
            }
        } catch (IOException | InterruptedException e) {
            System.err.println("[Jira] Create issue error: " + e.getMessage());
            Thread.currentThread().interrupt();
            return null;
        }
    }

    /**
     * Adds a comment to an existing issue.
     */
    public void addComment(String issueKey, String commentText) {
        // ADF body for a comment
        JsonObject body = new JsonObject();
        JsonObject content = new JsonObject();
        content.addProperty("version", 1);
        content.addProperty("type", "doc");
        JsonArray docContent = new JsonArray();
        JsonObject para = new JsonObject();
        para.addProperty("type", "paragraph");
        JsonArray paraContent = new JsonArray();
        JsonObject textNode = new JsonObject();
        textNode.addProperty("type", "text");
        textNode.addProperty("text", commentText);
        paraContent.add(textNode);
        para.add("content", paraContent);
        docContent.add(para);
        content.add("content", docContent);
        body.add("body", content);

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/rest/api/3/issue/" + issueKey + "/comment"))
                    .header("Authorization", authHeader)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body)))
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 201) {
                System.err.println("[Jira] Add comment failed (" + resp.statusCode() + "): " + resp.body());
            }
        } catch (IOException | InterruptedException e) {
            System.err.println("[Jira] Add comment error: " + e.getMessage());
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Attaches a file (e.g. screenshot) to an existing issue.
     */
    public void addAttachment(String issueKey, byte[] fileBytes, String filename) {
        String boundary = "----TestForgeBoundary" + System.currentTimeMillis();
        byte[] multipartBody = buildMultipartBody(boundary, fileBytes, filename);

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/rest/api/3/issue/" + issueKey + "/attachments"))
                    .header("Authorization", authHeader)
                    .header("X-Atlassian-Token", "no-check")
                    .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(multipartBody))
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() == 200) {
                System.out.println("[Jira] Screenshot attached to " + issueKey);
            } else {
                System.err.println("[Jira] Attach file failed (" + resp.statusCode() + "): " + resp.body());
            }
        } catch (IOException | InterruptedException e) {
            System.err.println("[Jira] Attach file error: " + e.getMessage());
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Transitions an issue to a new status.
     * You can find transition IDs via: GET /rest/api/3/issue/{issueKey}/transitions
     */
    public void transitionIssue(String issueKey, String transitionId) {
        JsonObject body = new JsonObject();
        JsonObject transition = new JsonObject();
        transition.addProperty("id", transitionId);
        body.add("transition", transition);

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/rest/api/3/issue/" + issueKey + "/transitions"))
                    .header("Authorization", authHeader)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(gson.toJson(body)))
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() != 204) {
                System.err.println("[Jira] Transition failed (" + resp.statusCode() + "): " + resp.body());
            }
        } catch (IOException | InterruptedException e) {
            System.err.println("[Jira] Transition error: " + e.getMessage());
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Lists available transitions for an issue (useful for finding transition IDs).
     */
    public String getTransitions(String issueKey) {
        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/rest/api/3/issue/" + issueKey + "/transitions"))
                    .header("Authorization", authHeader)
                    .header("Accept", "application/json")
                    .GET()
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            return resp.body();
        } catch (IOException | InterruptedException e) {
            System.err.println("[Jira] Get transitions error: " + e.getMessage());
            Thread.currentThread().interrupt();
            return null;
        }
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    /**
     * Searches for an open bug with the same test name to avoid duplicates.
     */
    private String findOpenIssueByTestName(String testName) {
        String safeName = testName.replace("\"", "\\\"").replace("'", "\\'");
        String jql = "project=" + project + " AND summary~\"" + truncate(safeName, 100)
                + "\" AND statusCategory != Done ORDER BY created DESC";
        String encodedJql;
        try {
            encodedJql = java.net.URLEncoder.encode(jql, "UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            return null;
        }

        try {
            HttpRequest req = HttpRequest.newBuilder()
                    .uri(URI.create(baseUrl + "/rest/api/3/search?jql=" + encodedJql + "&maxResults=1&fields=summary,status"))
                    .header("Authorization", authHeader)
                    .header("Accept", "application/json")
                    .GET()
                    .build();

            HttpResponse<String> resp = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (resp.statusCode() == 200) {
                JsonObject result = gson.fromJson(resp.body(), JsonObject.class);
                JsonArray issues = result.getAsJsonArray("issues");
                if (issues != null && issues.size() > 0) {
                    return issues.get(0).getAsJsonObject().get("key").getAsString();
                }
            }
        } catch (IOException | InterruptedException e) {
            System.err.println("[Jira] Search error: " + e.getMessage());
            Thread.currentThread().interrupt();
        }
        return null;
    }

    /**
     * Builds the JSON body for creating a Jira issue.
     * Uses Atlassian Document Format (ADF) for the description — required by Jira Cloud REST API v3.
     */
    private JsonObject buildCreateBody(String summary, String errorMessage, String stackTrace, String pageUrl) {
        JsonObject body = new JsonObject();
        JsonObject fields = new JsonObject();

        // Project
        JsonObject proj = new JsonObject();
        proj.addProperty("key", project);
        fields.add("project", proj);

        // Summary
        fields.addProperty("summary", summary);

        // Issue type
        JsonObject type = new JsonObject();
        type.addProperty("name", issueType);
        fields.add("issuetype", type);

        // Priority (optional — omit if not configured or project doesn't support it)
        if (!priority.isBlank()) {
            JsonObject prio = new JsonObject();
            prio.addProperty("name", priority);
            fields.add("priority", prio);
        }

        // Labels
        JsonArray labelArray = new JsonArray();
        for (String label : labels.split(",")) {
            String trimmed = label.trim();
            if (!trimmed.isEmpty()) labelArray.add(trimmed);
        }
        fields.add("labels", labelArray);

        // Assignee (optional)
        if (!assigneeAccountId.isBlank()) {
            JsonObject assignee = new JsonObject();
            assignee.addProperty("id", assigneeAccountId);
            fields.add("assignee", assignee);
        }

        // Description in Atlassian Document Format (ADF) — required for Jira Cloud API v3
        fields.add("description", buildAdfDescription(errorMessage, stackTrace, pageUrl));

        body.add("fields", fields);
        return body;
    }

    /**
     * Builds an ADF description with error message, stack trace, and URL.
     */
    private JsonObject buildAdfDescription(String errorMessage, String stackTrace, String pageUrl) {
        JsonObject doc = new JsonObject();
        doc.addProperty("version", 1);
        doc.addProperty("type", "doc");
        JsonArray content = new JsonArray();

        // Heading: Error Details
        content.add(buildAdfHeading("Test Failure Details", 2));

        // Error message paragraph
        if (errorMessage != null && !errorMessage.isBlank()) {
            content.add(buildAdfParagraph("Error: " + truncate(errorMessage, 500)));
        }

        // Page URL
        if (pageUrl != null && !pageUrl.isBlank()) {
            content.add(buildAdfParagraph("Page URL: " + pageUrl));
        }

        // Stack trace in code block
        if (stackTrace != null && !stackTrace.isBlank()) {
            content.add(buildAdfHeading("Stack Trace", 3));
            content.add(buildAdfCodeBlock(truncate(stackTrace, 3000)));
        }

        // Automated by TestForge
        content.add(buildAdfParagraph("— Created automatically by TestForge"));

        doc.add("content", content);
        return doc;
    }

    private JsonObject buildAdfHeading(String text, int level) {
        JsonObject heading = new JsonObject();
        heading.addProperty("type", "heading");
        JsonObject attrs = new JsonObject();
        attrs.addProperty("level", level);
        heading.add("attrs", attrs);
        JsonArray inner = new JsonArray();
        JsonObject textNode = new JsonObject();
        textNode.addProperty("type", "text");
        textNode.addProperty("text", text);
        inner.add(textNode);
        heading.add("content", inner);
        return heading;
    }

    private JsonObject buildAdfParagraph(String text) {
        JsonObject para = new JsonObject();
        para.addProperty("type", "paragraph");
        JsonArray inner = new JsonArray();
        JsonObject textNode = new JsonObject();
        textNode.addProperty("type", "text");
        textNode.addProperty("text", text);
        inner.add(textNode);
        para.add("content", inner);
        return para;
    }

    private JsonObject buildAdfCodeBlock(String code) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "codeBlock");
        JsonObject attrs = new JsonObject();
        attrs.addProperty("language", "java");
        block.add("attrs", attrs);
        JsonArray inner = new JsonArray();
        JsonObject textNode = new JsonObject();
        textNode.addProperty("type", "text");
        textNode.addProperty("text", code);
        inner.add(textNode);
        block.add("content", inner);
        return block;
    }

    /**
     * Builds a multipart/form-data body for file attachment.
     */
    private byte[] buildMultipartBody(String boundary, byte[] fileBytes, String filename) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            String header = "--" + boundary + "\r\n"
                    + "Content-Disposition: form-data; name=\"file\"; filename=\"" + filename + "\"\r\n"
                    + "Content-Type: image/png\r\n\r\n";
            out.write(header.getBytes(StandardCharsets.UTF_8));
            out.write(fileBytes);
            out.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
            return out.toByteArray();
        } catch (IOException e) {
            System.err.println("[Jira] Failed to build multipart body: " + e.getMessage());
            return new byte[0];
        }
    }

    private String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "...";
    }
}
