---
title: Deleting Data Read Through a Connection
summary: Permanently remove what Proprio saved from a connected app's tool calls
---

When an agent uses a connected app, such as Google Workspace, Proprio saves part of what the app returned so you can review the work later. You can delete that saved data at any time, for any connected app.

## What Proprio saves

For each tool call an agent makes through a connection, Proprio keeps:

- A short preview of the request and the result (up to about 4,000 characters, with secrets removed)
- For actions that needed approval, the preview and arguments shown on the approval card, and the result passed back to the agent
- Interactive app views that a tool showed in a task
- The transcript of the run that made the call, which can contain the full result, and of the run that received an approved action's result

This data stays until you delete it. Removing the connection alone does not delete it.

## How to delete it

You need permission to manage the connection.

**From the connection's page:**

1. Open **Connectors** and select the connection.
2. At the bottom of the **Permissions** tab, select **Delete data**.
3. Check the counts in the confirmation and select **Delete data**.

**When you remove a connection:**

1. Open **Connectors**, open the connection's menu, and select **Remove connection**.
2. Select **Also delete data read through this connection**.
3. Select **Remove connection**.

For a Google connection that Proprio set up for you, removing the connection also asks Google to end Proprio's access to that Google account. The message after removal tells you whether access was ended. If other Proprio connections still use the same Google account, Google keeps Proprio's access until you remove those too. If Proprio could not end access at Google, remove Proprio from your Google account's [third-party connections](https://myaccount.google.com/connections). Connections that use your own Google OAuth app are removed only in Proprio.

Deletion starts right away and continues in the background. It finishes even if Proprio restarts while it runs. If a step fails, for example because file storage is unavailable, Proprio keeps the request open and tries again until every step succeeds. It reports the deletion as finished only then. The connection's page shows when the data was last deleted.

## What is deleted

- Request and result previews for every call made through the connection before you asked to delete, including the copies in the connection's audit history
- Approval previews, arguments and results for those calls, on the approval card and in what was passed back to the agent
- Interactive app views from those calls
- The whole transcript of every run that called the connection or received an approved action's result, including that run's other steps and its final summary

## What is kept

- The record that each call happened: when, which tool, which agent, the outcome, the size of the data, and a fingerprint of it. Proprio needs these for its activity history and usage counts. They do not contain the data.
- **Anything your agents wrote into tasks: comments, documents and files.** This action does not remove them, even when an agent copied data from the app into them. Delete or edit those items yourself, or delete the task.
- The connection's audit activity, which records counts only.
- Transcripts of later runs that only read the context an interactive app view shared. Proprio does not record which runs read it. Delete those tasks if you need that text gone.
- Raw provider traces. An administrator must turn them on, and they expire on their own within 24 hours.

## Runs that are still working

Proprio does not change a run while it is still working. The confirmation tells you how many runs are skipped for this reason. Select **Delete data** again after they finish.

## It cannot be undone

Deleted data cannot be recovered.
