---
name: release-changelog-discord-message
description: >
  Write the Discord announcement for a stable Proprio release from the release
  changelog. Use when a release issue needs a Discord draft or an updated
  discord_announcement document.
---

# Release Discord Announcement Skill

Write the Discord release announcement for the **stable** Proprio release.

This is the companion to `.agents/skills/release-changelog/SKILL.md`. That skill
writes the changelog — during the beta soak it lives at
`releases/beta/v{beta-version}.md` on the `release-notes/v{beta-version}`
branch, and after the stable ships a canonicalization PR renames it to
`releases/vYYYY.MDD.P.md` (see that skill's Channel Process section). This
skill turns that file into a concise Discord announcement and saves the draft
as the `discord_announcement` document on the release issue.

## When to use

- After `release-changelog` has produced the changelog (beta-keyed on the
  `release-notes/v{beta-version}` branch during the soak, or the
  canonicalized `releases/vYYYY.MDD.P.md` after the stable ships).
- When the release issue (the one assigned by the release routine) asks for a
  Discord announcement, or has a `discord_announcement` document that needs to
  be refreshed for a new date/version.
- Never run this in isolation. The version, date, contributor list, and
  highlight set MUST match the matching changelog file — if the changelog has
  been updated, refresh this too.

## Output

A single fenced markdown code block, ready to paste into Discord. Attached as
issue document key `discord_announcement` on the release issue, and pasted
verbatim into a comment on that issue so the human can copy it out.
When Cases are enabled, also upsert the social child case described below.

```bash
PUT /api/issues/{releaseIssueId}/documents/discord_announcement
{
  "title": "Discord announcement",
  "format": "markdown",
  "body": "<the announcement>",
  "baseRevisionId": "<latest if updating>"
}
```

If the document already exists, fetch it first and pass the current
`baseRevisionId`. Never overwrite silently — if the version has changed since
the document was last written, mention what changed in the issue comment.

## Format

Use clear, factual Proprio project language. Start with the release version and
lead with the changes users will notice or need to act on. Use the matching
changelog for the version, date, shipped changes, upgrade guidance, and credits.

```markdown
# Proprio v{VERSION}

## Highlights

- **{Shipped change}** — {What users can do or what works differently now.}

{Include any upgrade steps that readers need to take.}

[Full release notes]({release-notes URL})

{Thank the contributors listed in the changelog.}
```

- Link to the canonical stable release notes and verify the link before handing
  off the announcement for publication. During the beta soak, a draft can
  reference the beta-keyed changelog and be updated after canonicalization.
- Include the stable install command when useful. Check any other install
  channels or Docker tags against the release being announced.
- Include a roadmap item or community request when the release issue
  explicitly requests it and supplies a public source or approved copy.
- Use the changelog's contributor list as written. Omit the thank-you if the
  changelog has no contributor list.

## Workflow

1. Read the matching changelog produced by `release-changelog` — the
   beta-keyed file during the soak, `releases/vYYYY.MDD.P.md` once
   canonicalized. Use the version and contributor list from that file —
   never re-derive them.
2. Resolve the parent `release` case with key `proprio-release:vYYYY.MDD.P`.
   If it does not exist and Cases are enabled, create it using the schema in
   `.agents/skills/release-changelog/SKILL.md` before creating child cases.
3. Read the release issue for announcement requirements. Draft the announcement
   using the matching changelog and the format above.
4. Save it as the `discord_announcement` document on the release issue. When
   updating, send the latest `baseRevisionId`.
5. When Cases are enabled, upsert the `tweet_storm` child case with
   `parentCaseId` set to the release case ID, then save the announcement in
   its `body` document.
6. Post a comment on the release issue that includes the announcement in a
   single fenced Markdown code block so the reviewer can copy it into Discord.

## Tweet Storm Case Schema

Use this child case for the Discord/social announcement thread. The key must be
stable so retries update the same child case:

```http
POST /api/companies/:companyId/cases
{
  "caseType": "tweet_storm",
  "key": "proprio-release:vYYYY.MDD.P:tweet-storm",
  "title": "Proprio vYYYY.MDD.P tweet storm",
  "summary": "Social announcement thread for Proprio vYYYY.MDD.P.",
  "status": "in_review",
  "parentCaseId": "<release-case-id>",
  "fields": {
    "schema_version": 1,
    "version": "vYYYY.MDD.P",
    "channel": "x",
    "discord_source": true,
    "post_count": 1,
    "target_audience": ["operators", "contributors", "agent-company builders"],
    "links": {
      "release_notes": "https://github.com/groktopus/proprio/blob/main/releases/vYYYY.MDD.P.md"
    },
    "review": {
      "needs_human_copy_paste": true,
      "approved_by": null
    }
  }
}
```

Then write the body document:

```http
PUT /api/cases/:tweetStormCaseId/documents/body
{
  "title": "Proprio vYYYY.MDD.P tweet storm body",
  "format": "markdown",
  "body": "<announcement body>",
  "changeSummary": "Draft social announcement"
}
```

If updating an existing document, fetch the case and pass the latest
`baseRevisionId`.

Do not publish to Discord. This skill only prepares the artifact.

## Review checklist

1. The version and any date match the changelog.
2. Shipped highlights, upgrade guidance, and contributor credit match the
   changelog. Links point to the intended release.
3. Any roadmap item or community request is backed by the release issue.
4. The release issue has the current `discord_announcement` document and
   copyable comment. If Cases are enabled, the child case has the same draft.
