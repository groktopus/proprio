import { registerHooks } from 'node:module';

const fixture = process.env.PROPRIO_ONBOARDING_CODEX_COMMAND;
if (process.env.NODE_ENV !== 'test' || process.env.PROPRIO_ONBOARDING_CODEX_FIXTURE !== '1' || !fixture) {
  throw new Error('Controlled onboarding Codex fixture requires explicit test opt-in');
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (/\/drivers\/codex\/codex-command\.(?:js|ts)$/.test(new URL(result.url).pathname)) {
      return { ...result, shortCircuit: true, url: new URL('./onboarding-codex-command.mjs', import.meta.url).href };
    }
    return result;
  },
});
