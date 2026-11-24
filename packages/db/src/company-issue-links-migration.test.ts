import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import { applyPendingMigrations } from "./client.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

async function migrationHash(name: string): Promise<string> {
  const contents = await readFile(new URL(`./migrations/${name}`, import.meta.url));
  return createHash("sha256").update(contents).digest("hex");
}

describePostgres("issue company-link migrations", () => {
  it("audits legacy links, enforces same-company writes, and preserves supported deletes", async () => {
    const database = await startEmbeddedPostgresTestDatabase("proprio-issue-company-links-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    try {
      const companyA = randomUUID();
      const companyB = randomUUID();
      const agentA = randomUUID();
      const agentB = randomUUID();
      const projectA = randomUUID();
      const projectB = randomUUID();
      const parentA = randomUUID();
      const parentB = randomUUID();
      const runA = randomUUID();
      const runB = randomUUID();
      const issueA = randomUUID();
      const invalidLegacyIssue = randomUUID();

      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES
        (${companyA}, 'Company A', 'CA'), (${companyB}, 'Company B', 'CB')`;
      await sql`INSERT INTO agents (id, company_id, name) VALUES
        (${agentA}, ${companyA}, 'Agent A'), (${agentB}, ${companyB}, 'Agent B')`;
      await sql`INSERT INTO projects (id, company_id, name) VALUES
        (${projectA}, ${companyA}, 'Project A'), (${projectB}, ${companyB}, 'Project B')`;
      await sql`INSERT INTO issues (id, company_id, title) VALUES
        (${parentA}, ${companyA}, 'Parent A'), (${parentB}, ${companyB}, 'Parent B')`;
      await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status) VALUES
        (${runA}, ${companyA}, ${agentA}, 'succeeded'), (${runB}, ${companyB}, ${agentB}, 'succeeded')`;

      // Simulate a pre-0504 database: retain the old single-column constraints,
      // but remove the new composite constraints so the legacy links can be audited.
      await sql.unsafe(`
        ALTER TABLE issues DROP CONSTRAINT issues_project_company_fk;
        ALTER TABLE issues DROP CONSTRAINT issues_parent_company_fk;
        ALTER TABLE issues DROP CONSTRAINT issues_assignee_agent_company_fk;
        ALTER TABLE issues DROP CONSTRAINT issues_checkout_run_company_fk;
        ALTER TABLE issues DROP CONSTRAINT issues_execution_run_company_fk;
        ALTER TABLE issues ADD CONSTRAINT issues_project_id_projects_id_fk FOREIGN KEY (project_id) REFERENCES projects(id);
        ALTER TABLE issues ADD CONSTRAINT issues_parent_id_issues_id_fk FOREIGN KEY (parent_id) REFERENCES issues(id);
        ALTER TABLE issues ADD CONSTRAINT issues_assignee_agent_id_agents_id_fk FOREIGN KEY (assignee_agent_id) REFERENCES agents(id);
        ALTER TABLE issues ADD CONSTRAINT issues_checkout_run_id_heartbeat_runs_id_fk FOREIGN KEY (checkout_run_id) REFERENCES heartbeat_runs(id) ON DELETE SET NULL;
        ALTER TABLE issues ADD CONSTRAINT issues_execution_run_id_heartbeat_runs_id_fk FOREIGN KEY (execution_run_id) REFERENCES heartbeat_runs(id) ON DELETE SET NULL;
      `);
      await sql`INSERT INTO issues (
        id, company_id, title, project_id, parent_id, assignee_agent_id, checkout_run_id, execution_run_id
      ) VALUES (
        ${invalidLegacyIssue}, ${companyA}, 'Legacy mismatched links',
        ${projectB}, ${parentB}, ${agentB}, ${runB}, ${runB}
      )`;

      const migrationHashes = await Promise.all([
        migrationHash("0504_flawless_alex_power.sql"),
        migrationHash("0505_company_link_validation.sql"),
      ]);
      for (const hash of migrationHashes) {
        await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      }

      // The 0504 fence is committed before 0505 validates historical rows.
      // Validation must fail on the legacy mismatch without rewriting it.
      await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow();
      const conflicts = await sql<{ project: number; parent: number; assignee: number; checkout: number; execution: number }[]>`
        SELECT
          count(*) FILTER (WHERE p.company_id IS DISTINCT FROM i.company_id)::int AS project,
          count(*) FILTER (WHERE parent.company_id IS DISTINCT FROM i.company_id)::int AS parent,
          count(*) FILTER (WHERE a.company_id IS DISTINCT FROM i.company_id)::int AS assignee,
          count(*) FILTER (WHERE checkout.company_id IS DISTINCT FROM i.company_id)::int AS checkout,
          count(*) FILTER (WHERE execution.company_id IS DISTINCT FROM i.company_id)::int AS execution
        FROM issues i
        LEFT JOIN projects p ON p.id = i.project_id
        LEFT JOIN issues parent ON parent.id = i.parent_id
        LEFT JOIN agents a ON a.id = i.assignee_agent_id
        LEFT JOIN heartbeat_runs checkout ON checkout.id = i.checkout_run_id
        LEFT JOIN heartbeat_runs execution ON execution.id = i.execution_run_id
        WHERE i.id = ${invalidLegacyIssue}
      `;
      expect(conflicts).toEqual([{ project: 1, parent: 1, assignee: 1, checkout: 1, execution: 1 }]);
      const preserved = await sql`SELECT project_id, parent_id, assignee_agent_id, checkout_run_id, execution_run_id
        FROM issues WHERE id = ${invalidLegacyIssue}`;
      expect(preserved).toEqual([{
        project_id: projectB,
        parent_id: parentB,
        assignee_agent_id: agentB,
        checkout_run_id: runB,
        execution_run_id: runB,
      }]);

      // No automatic unlinking: an operator-approved repair makes the audit clean,
      // after which the already-installed fence can be validated on retry.
      await sql`UPDATE issues SET project_id = NULL, parent_id = NULL, assignee_agent_id = NULL,
        checkout_run_id = NULL, execution_run_id = NULL WHERE id = ${invalidLegacyIssue}`;
      await applyPendingMigrations(database.connectionString);

      const issue = await sql`INSERT INTO issues (
        id, company_id, title, project_id, parent_id, assignee_agent_id, checkout_run_id, execution_run_id
      ) VALUES (
        ${issueA}, ${companyA}, 'Valid same-company links',
        ${projectA}, ${parentA}, ${agentA}, ${runA}, ${runA}
      ) RETURNING company_id, project_id, parent_id, assignee_agent_id, checkout_run_id, execution_run_id`;
      expect(issue).toEqual([{
        company_id: companyA,
        project_id: projectA,
        parent_id: parentA,
        assignee_agent_id: agentA,
        checkout_run_id: runA,
        execution_run_id: runA,
      }]);

      const invalidWrites = [
        () => sql`INSERT INTO issues (company_id, title, project_id) VALUES (${companyA}, 'Cross-company project', ${projectB})`,
        () => sql`INSERT INTO issues (company_id, title, parent_id) VALUES (${companyA}, 'Cross-company parent', ${parentB})`,
        () => sql`INSERT INTO issues (company_id, title, assignee_agent_id) VALUES (${companyA}, 'Cross-company assignee', ${agentB})`,
        () => sql`INSERT INTO issues (company_id, title, checkout_run_id) VALUES (${companyA}, 'Cross-company checkout', ${runB})`,
        () => sql`INSERT INTO issues (company_id, title, execution_run_id) VALUES (${companyA}, 'Cross-company execution', ${runB})`,
        () => sql`UPDATE issues SET project_id = ${projectB} WHERE id = ${issueA}`,
        () => sql`UPDATE issues SET parent_id = ${parentB} WHERE id = ${issueA}`,
        () => sql`UPDATE issues SET assignee_agent_id = ${agentB} WHERE id = ${issueA}`,
        () => sql`UPDATE issues SET checkout_run_id = ${runB} WHERE id = ${issueA}`,
        () => sql`UPDATE issues SET execution_run_id = ${runB} WHERE id = ${issueA}`,
      ];
      for (const write of invalidWrites) {
        await expect(write()).rejects.toMatchObject({ code: "23503" });
      }

      await expect(sql`DELETE FROM projects WHERE id = ${projectA}`).rejects.toMatchObject({ code: "23503" });
      await expect(sql`DELETE FROM issues WHERE id = ${parentA}`).rejects.toMatchObject({ code: "23503" });
      await expect(sql`DELETE FROM agents WHERE id = ${agentA}`).rejects.toMatchObject({ code: "23503" });
      await sql`DELETE FROM heartbeat_runs WHERE id = ${runA}`;
      const afterRunDelete = await sql`SELECT company_id, checkout_run_id, execution_run_id
        FROM issues WHERE id = ${issueA}`;
      expect(afterRunDelete).toEqual([{ company_id: companyA, checkout_run_id: null, execution_run_id: null }]);

      await sql`UPDATE issues SET project_id = NULL, parent_id = NULL, assignee_agent_id = NULL WHERE id = ${issueA}`;
      await sql`DELETE FROM projects WHERE id = ${projectA}`;
      await sql`DELETE FROM issues WHERE id = ${parentA}`;
      await sql`DELETE FROM agents WHERE id = ${agentA}`;

      const validation = await sql<{ conname: string; convalidated: boolean }[]>`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN (
          'issues_project_company_fk', 'issues_parent_company_fk',
          'issues_assignee_agent_company_fk', 'issues_checkout_run_company_fk',
          'issues_execution_run_company_fk'
        )
        ORDER BY conname
      `;
      expect(validation).toHaveLength(5);
      expect(validation.every((row) => row.convalidated)).toBe(true);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("removes an interrupted invalid 0503 index before retrying the migration", async () => {
    const database = await startEmbeddedPostgresTestDatabase("proprio-issue-company-links-index-retry-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Index retry', 'IR')`;
      await sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Retry agent')`;
      await sql`INSERT INTO heartbeat_runs (company_id, agent_id, status) VALUES
        (${companyId}, ${agentId}, 'succeeded'), (${companyId}, ${agentId}, 'succeeded')`;

      for (const name of ["issues_checkout_run_company_fk", "issues_execution_run_company_fk"]) {
        await sql.unsafe(`ALTER TABLE issues DROP CONSTRAINT ${name}`);
      }
      await sql.unsafe("DROP INDEX CONCURRENTLY public.heartbeat_runs_company_id_uq");
      await expect(sql.unsafe(
        "CREATE UNIQUE INDEX CONCURRENTLY heartbeat_runs_company_id_uq ON heartbeat_runs ((1))",
      )).rejects.toThrow();

      const [interruptedIndex] = await sql<{ indisvalid: boolean }[]>`
        SELECT i.indisvalid FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'heartbeat_runs_company_id_uq'
      `;
      expect(interruptedIndex?.indisvalid).toBe(false);

      const indexMigrationHash = await migrationHash("0503_redundant_radioactive_man.sql");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${indexMigrationHash}`;

      await applyPendingMigrations(database.connectionString);
      const [rebuiltIndex] = await sql<{ indisvalid: boolean; definition: string }[]>`
        SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'heartbeat_runs_company_id_uq'
      `;
      expect(rebuiltIndex).toMatchObject({ indisvalid: true });
      expect(rebuiltIndex?.definition).toContain("(company_id, id)");
      const [history] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${indexMigrationHash}
      `;
      expect(history?.count).toBe(1);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
