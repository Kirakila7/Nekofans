'use strict';
const path = require('node:path');
const {OFFICIAL_AUTH_ORIGIN} = require('./community-config.cjs');
const {createOAuthSession} = require('./community-oauth.cjs');

// Legacy direct OAuth remains for the RTC visit client. The Friends UI uses
// the official community WebContents session and never opens this grant.
function createWorkbenchCommunity({dataDir, safeStorage, openExternal, env = process.env} = {}) {
  const legacy = {
    authorizationUrl: env.NEKO_VISIT_AUTHORIZATION_URL, tokenUrl: env.NEKO_VISIT_TOKEN_URL,
    clientId: env.NEKO_VISIT_OAUTH_CLIENT_ID, redirectUri: env.NEKO_VISIT_REDIRECT_URI,
  };
  const useLegacy = Object.values(legacy).every(value => typeof value === 'string' && value);
  // Same official public desktop registration and callback previously verified for N.E.K.O.
  const options = useLegacy ? legacy : {
    authorizationUrl: OFFICIAL_AUTH_ORIGIN + '/oauth2/auth',
    tokenUrl: OFFICIAL_AUTH_ORIGIN + '/oauth2/token',
    clientId: 'neko-servers-desktop-prod',
    redirectUri: 'http://127.0.0.1:48913/oauth/callback',
  };
  const tokenFile = path.join(dataDir, useLegacy ? 'visits' : 'community', 'oauth.encrypted');
  const oauth = createOAuthSession({...options, safeStorage, openExternal, tokenFile});
  const baseUrl = useLegacy ? env.NEKO_VISIT_COMMUNITY_URL : undefined;
  return Object.freeze({oauth, baseUrl});
}

module.exports = {createWorkbenchCommunity};
