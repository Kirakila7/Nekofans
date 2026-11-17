import { createCommunitySeatAuthorizer } from '../server/community-seats.mjs';

// Mount after the community's existing bearer authentication middleware.
export function createGameAuthorizationHandler({ issuer, gameOrigin, privateKey, authenticate }) {
  const communityOrigin = new URL(issuer).origin;
  const authorize = createCommunitySeatAuthorizer({ issuer, gameOrigin, privateKey, authenticate });
  return async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, value = {}) => {
      response.writeHead(status);
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, communityOrigin);
      if (url.pathname !== '/api/game-seats/authorize') return send(404);
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return send(405);
      }
      if (request.headers.origin && request.headers.origin !== communityOrigin) return send(403);
      if (!/^Bearer [-A-Za-z0-9._~+/]+=*$/.test(request.headers.authorization || '')) return send(401);
      const query = url.searchParams;
      if ([...query].length !== 3 || !['state', 'operation', 'target'].every(key => query.getAll(key).length === 1)) return send(400);
      const result = await authorize(request, query);
      return send(result.status, result.status === 200 ? { location: result.location } : {});
    } catch {
      return send(503);
    }
  };
}
