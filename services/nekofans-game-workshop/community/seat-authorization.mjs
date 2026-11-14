// Run this in the community app's /game-seats/authorize route. The caller
// provides the community's existing OAuth store and login UI.
export async function authorizeGameSeat({ getAccessToken, gameOrigin }) {
  const token = await getAccessToken();
  if (!token) return { status: 'sign-in-required' };
  const query = new URLSearchParams(location.search);
  const response = await fetch('/api/game-seats/authorize?' + query, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401) return { status: 'sign-in-required' };
  if (!response.ok) return { status: 'failed' };
  const { location: destination } = await response.json();
  let redirect;
  try { redirect = new URL(destination); } catch { return { status: 'failed' }; }
  if (redirect.origin !== gameOrigin || redirect.pathname !== '/' || redirect.username || redirect.password || !redirect.hash.startsWith('#communitySeat=')) {
    return { status: 'failed' };
  }
  location.replace(redirect.href);
  return { status: 'redirecting' };
}
