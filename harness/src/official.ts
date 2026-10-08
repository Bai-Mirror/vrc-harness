/**
 * The Harness project's own server and the release keys this build trusts.
 * - Updates are only checked when the person asks; contributions go there only after they opt in.
 * - Private signing keys never leave the maintainer's offline machine; only public keys ship in the client.
 * - AVH_UPDATE_SERVER points a build at another server (tests, self-hosting).
 */
export const OFFICIAL_SERVER = 'https://harness.nymiro.moe';
export function updateServer(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AVH_UPDATE_SERVER || OFFICIAL_SERVER).replace(/\/+$/, '');
}
export const officialEndpoints = (server = updateServer()) => ({
  contributions: `${server}/v1/contributions`,
  releases: `${server}/v1/releases`,
  knowledge: `${server}/v1/knowledge/releases`,
});
export const TRUSTED_RELEASE_KEYS: Record<string, string> = {
  'harness-dev-1': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAUOjZyKKBhW0gP9wpm5314AOAaQMU7vvPWl7IEj7d6dc=\n-----END PUBLIC KEY-----\n',
  'harness-dev-2': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA2vOrNE4FB+7PEMECYe7k23ooToMaip31k5eJBch3+CE=\n-----END PUBLIC KEY-----\n',
};
