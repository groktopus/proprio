export function shouldLoadWorkingDirectoryEnv(input: {
  cwdEnvExists: boolean;
  isProprioEnvFile: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = input.env ?? process.env;
  return env.PROPRIO_DISABLE_CWD_ENV_FILE !== "true"
    && input.cwdEnvExists
    && !input.isProprioEnvFile;
}
