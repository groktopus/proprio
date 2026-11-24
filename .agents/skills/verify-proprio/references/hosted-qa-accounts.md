# Hosted QA accounts and credentials

Use this for authorized Proprio staging or production journeys. Source and
npm verification use their own local instances.

## Resolve the target and actor

Use the target supplied in the task or an approved QA profile named by the
deployment owner. Record:

- The environment and exact Proprio URL. For a tenant check, record the
  intended workspace or company and its identifier.
- The QA account alias, expected permissions and sign-in method.
- Private references for any required credentials and the owner who can
  rotate them. Keep credential values and deployment-specific instructions
  in the deployment's approved store.
- The scope of allowed changes, test data and ownership of cleanup.
- The serving revision or image digest and the expected outcome.

For example, an operator may authorize a staging company at
`https://qa.example.test` and supply a deployment profile for its restricted
QA user. Use that URL and verify the expected company after sign-in. If the
target, account or authority is ambiguous, request the missing information
before entering credentials or modifying state.

## Execute and record the journey

1. Open the approved URL and use the deployment owner's normal login flow.
   Reuse the approved test identity when testing an existing workspace.
2. If the deployment uses an email code, read only the approved test mailbox
   and match the exact recipient and current login attempt. Keep the code
   and mailbox credentials out of reports and screenshots.
3. Verify the authenticated principal, workspace and served revision before
   running the requested checks. A successful portal login does not establish
   access to the intended tenant.
4. Record the target identity, principal alias, authentication method, exact
   serving revision, and observed result in the evidence. Clean up only
   resources created by the attempt and approved for cleanup.

If no approved hosted target is available, record which hosted checks are
blocked. Continue with any requested local checkout or npm checks that have
their own prerequisites.
