# Historical stable release content

This procedure applies to calendar-versioned stable release content.

## Step 8 — Emit Release-Content Cases

When Cases are enabled, every stable release-content run must materialize a
deterministic case tree. This is part of the release dogfood path, not an
optional artifact. If the API returns `403 Cases are disabled`, stop and report
that the operator must enable `experimental.enableCases`.

Use the current release issue's `PROPRIO_COMPANY_ID`, `PROPRIO_API_URL`,
`PROPRIO_API_KEY`, and `PROPRIO_RUN_ID`. Include `X-Proprio-Run-Id` on
all writes so the case activity feed can attribute the run back to the issue.

Create or upsert the parent `release` case first:

```http
POST /api/companies/:companyId/cases
{
  "caseType": "release",
  "key": "proprio-release:vYYYY.MDD.P",
  "title": "Proprio vYYYY.MDD.P release",
  "summary": "Stable release content package for Proprio vYYYY.MDD.P.",
  "status": "in_progress",
  "fields": {
    "schema_version": 1,
    "version": "vYYYY.MDD.P",
    "release_date": "YYYY-MM-DD",
    "source_ref": "git-sha-or-ref",
    "stable": true,
    "channels": ["changelog", "blog_post", "tweet_storm"],
    "artifacts": {
      "changelog_path": "releases/vYYYY.MDD.P.md",
      "github_release_url": null
    },
    "verification": {
      "typecheck": "unknown",
      "tests": "unknown",
      "build": "unknown",
      "smoke": "unknown"
    },
    "notes": null
  }
}
```

The `fields` schema intentionally uses all generic JSON value types: strings,
numbers, booleans, arrays, objects, and nulls. Send the complete fields object on
each upsert because case fields replace as a whole object.

Write the parent body document immediately after the upsert:

```http
PUT /api/cases/:releaseCaseId/documents/body
{
  "title": "Proprio vYYYY.MDD.P release body",
  "format": "markdown",
  "body": "# Proprio vYYYY.MDD.P\n\nRelease summary and links...",
  "changeSummary": "Initial release case body"
}
```

Then create or upsert these child cases with `parentCaseId` set to the release
case id:

- `blog_post`, key `proprio-release:vYYYY.MDD.P:blog-post`, status
  `in_progress`, body document key `body`
- `tweet_storm`, key `proprio-release:vYYYY.MDD.P:tweet-storm`, status
  `in_progress`, body document key `body`

Use deterministic keys exactly so rerunning the release-content flow upserts the
same three cases instead of duplicating them. After the child body documents are
written, list the resulting case identifiers and links in the release issue and
in the parent acceptance issue when one exists.

