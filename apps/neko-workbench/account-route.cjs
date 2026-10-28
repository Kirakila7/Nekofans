'use strict';
// The one model route every workbench channel uses: the signed-in DeepSeek
// Harness account. Channels must fail visibly instead of switching keys.
const ACCOUNT_ROUTE=Object.freeze({provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'high'});
function accountRoute(){return {...ACCOUNT_ROUTE};}
function isAccountRoute(selection){return !!selection&&selection.provider===ACCOUNT_ROUTE.provider&&selection.model===ACCOUNT_ROUTE.model;}
module.exports={ACCOUNT_ROUTE,accountRoute,isAccountRoute};
