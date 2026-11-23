# Security

Please don't post credentials, private deployment information, or details that would enable exploitation in a public issue. Use [Proprio’s private vulnerability report form](https://github.com/groktopus/proprio/security/advisories/new) to send a report to the maintainers through GitHub. Keep reports focused on affected versions, impact, and relevant diagnostics, with secrets redacted.

The initial source snapshot is not a supported production release. Security-sensitive fixes should preserve scope and isolation, include a regression check, and not weaken containment to work around a runtime error.

We aim to acknowledge private reports within seven calendar days. Include the
commit SHA if you run from source. The current project has no supported release
branches. Maintainers triage reports against the current public `main` branch.

See [secure engineering](doc/SECURE-ENGINEERING.md) for the contribution security
checks and the [release checklist](doc/RELEASE-CHECKLIST.md) for qualification
requirements.
