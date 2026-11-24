# Focused mobile WebKit checks

Issue #164 uses a separate Playwright configuration for three narrow mobile journeys:

- open and edit the New task dialog;
- keep the task conversation composer inside a reduced visible viewport;
- disclose a nested task from the task side panel.

Run the suite with:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install webkit
pnpm test:e2e:mobile-webkit
```

On Linux, install WebKit system libraries as well:

```sh
pnpm exec playwright install --with-deps webkit
```

The dedicated configuration clears `DATABASE_URL` and
`DATABASE_MIGRATION_URL` and disables checkout `.env` loading before the
throwaway server starts. The suite therefore uses only its embedded test
database.

The suite uses Playwright WebKit with an emulated iPhone 13 viewport. This is
browser-engine and viewport evidence. It does not prove iOS Safari's native
virtual keyboard, safe-area insets, or visual viewport event timing.

For device acceptance, repeat the selected critical journey on a real iPhone
running the supported iOS Safari version. Record the device model, iOS version,
Safari version, viewport/orientation, journey result, and any keyboard or
visual-viewport observations. Do not substitute a simulator or WebKit run for
that device record.
