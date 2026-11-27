#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const logPath = process.env.PROPRIO_ONBOARDING_CODEX_FIXTURE_LOG;
if (!logPath || process.env.PROPRIO_ONBOARDING_CODEX_FIXTURE !== '1') process.exit(2);
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.115.0 (controlled onboarding fixture)\n');
  process.exit(0);
}
if (!process.argv.includes('exec')) process.exit(2);

let input = '';
for await (const chunk of process.stdin) input += chunk;
const authPath = `${process.env.CODEX_HOME ?? ''}/auth.json`;
let credentialPresent = false;
try {
  const auth = JSON.parse(readFileSync(authPath, 'utf8'));
  credentialPresent = Boolean(auth.OPENAI_API_KEY || auth.tokens?.access_token);
} catch {}
credentialPresent ||= Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.PROPRIO_AI_PROVIDER_KEY?.trim());
const modelFlag = Math.max(process.argv.indexOf('--model'), process.argv.indexOf('-m'));
const model = modelFlag >= 0 ? process.argv[modelFlag + 1] : null;
appendFileSync(logPath, `${JSON.stringify({ event: 'probe', credentialPresent, model, fixture: true })}\n`, { mode: 0o600 });
if (!credentialPresent) {
  process.stderr.write('Authentication required by controlled Codex fixture.\n');
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } })}\n`);
