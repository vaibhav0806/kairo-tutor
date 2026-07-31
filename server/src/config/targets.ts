export const SERVER_TARGETS = {
  local: {
    publicBaseUrl: 'http://localhost:8787',
    dodoEnvironment: 'test_mode',
    neonEndpointId: 'ep-damp-bar-as9g9rwj',
    neonBranchName: 'dev',
  },
  hosted: {
    publicBaseUrl: 'https://api.meetkairo.xyz',
    dodoEnvironment: 'live_mode',
    neonEndpointId: 'ep-summer-wildflower-asm8likt',
    neonBranchName: 'production',
  },
} as const;

export type ServerTarget = keyof typeof SERVER_TARGETS;

type StaticEnvironment = {
  KAIRO_SERVER_TARGET: ServerTarget;
  KAIRO_DATABASE_TARGET: 'neon' | 'local-postgres';
  PUBLIC_BASE_URL: string;
  DODO_ENV: 'test_mode' | 'live_mode';
};

/** Fail closed when a local/test and hosted/live setting are accidentally mixed. */
export function assertStaticEnvironment(env: StaticEnvironment) {
  const expected = SERVER_TARGETS[env.KAIRO_SERVER_TARGET];
  const actualBaseUrl = new URL(env.PUBLIC_BASE_URL).toString().replace(/\/$/, '');

  if (actualBaseUrl !== expected.publicBaseUrl) {
    throw new Error(
      `KAIRO_SERVER_TARGET=${env.KAIRO_SERVER_TARGET} requires PUBLIC_BASE_URL=${expected.publicBaseUrl}`,
    );
  }
  if (env.DODO_ENV !== expected.dodoEnvironment) {
    throw new Error(
      `KAIRO_SERVER_TARGET=${env.KAIRO_SERVER_TARGET} requires DODO_ENV=${expected.dodoEnvironment}`,
    );
  }
  if (env.KAIRO_SERVER_TARGET === 'hosted' && env.KAIRO_DATABASE_TARGET === 'local-postgres') {
    throw new Error('KAIRO_SERVER_TARGET=hosted cannot use KAIRO_DATABASE_TARGET=local-postgres');
  }

  return expected;
}
