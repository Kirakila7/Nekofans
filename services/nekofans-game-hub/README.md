# Nekofans private chess trial

In the Nekofans lobby, open **分享游戏**. The publisher configures the relay address, creates a room, then sends the public invitation to the chat. The recipient selects **在工作台加入**. Players can submit one private rule each, make moves manually, or start their own workbench AI teammate. **接回手动操作** stops that seat's teammate. The existing pairing-code flow is available for a seat already claimed in a browser.

The server currently interprets one rule per player, of the form “对手前 1～3 回合不能动某种棋子”. It validates moves against the current room version and the compiled effects. The opponent can infer rule effects from what happens on the board. Seat credentials and rule text stay out of the public invitation and public board state. The room service and the designated publisher's rule-processing account handle the secret text. For this trial, use synthetic rules or rules you are comfortable sharing with those services.

For an operator setting up a test relay:

1. In **高级设置与旧版配对**, use **显示配对公钥** to obtain the publisher's public key. Keep its private key in the workbench.
2. Run the private-trial server with `TRIAL_PUBLIC_ORIGIN` set to the exact temporary HTTPS origin, `TRIAL_EXECUTOR_PUBLIC_KEY` set to the path of that public key, and optionally `PORT` set to the loopback port. Forward only this service through the temporary tunnel.

   ```sh
   TRIAL_PUBLIC_ORIGIN='https://example.trycloudflare.com' \
   TRIAL_EXECUTOR_PUBLIC_KEY='/path/to/publisher-public.pem' \
   PORT=3114 node services/nekofans-game-hub/private-trial/server.mjs
   ```

3. Use the actual origin in the publisher's workbench. Both players use their own workbench account for their optional teammate. Rooms live in memory and expire after six hours.

The story launcher is a local development option for an explicitly configured compatible project. The game-draft action produces a revision for later validation. The private chess trial is the runnable multiplayer game in this change.

Run the protocol checks with `node --test services/nekofans-game-hub/*.test.mjs services/nekofans-game-hub/private-trial/server.test.mjs`. Tests use local services and synthetic model responses.

### N.E.K.O. friend inbox

The local contract is exercised with `node --test services/nekofans-game-hub/private-trial/server.test.mjs`. The fixture opens a loopback listener, issues tickets for synthetic accounts, and uses the same workbench runtime that creates the room and claims the guest seat.

For the fixed production origin `https://play.nekofans.games`, mount `POST /api/game-invites/ticket` on the official community origin. Wire `createFriendInviteIssuer` in `friend-invites.mjs` to the existing community OAuth middleware and authoritative relationship store, or implement the same contract in that backend's language. The identity must be the community UUID returned by `/api/users/me`. For `{op:"send",target,room}`, the issuer checks mutual following and both block directions before minting a ticket for that exact recipient and room. For `{op:"inbox"}`, only the existing community sign-in is needed. Return `{userId,ticket}` on success, HTTP 401 for missing or expired community sign-in, and 403 for an ineligible recipient. Set `Cache-Control: no-store`.

Use a dedicated Ed25519 signing key on the community side and set `TRIAL_FRIEND_INVITE_PUBLIC_KEY` on the game server to the matching public PEM path. The protected JWT header is `{alg:"EdDSA",typ:"neko-game-invite+jwt"}`. Claims are `iss:"https://community.project-neko.cn"`, `aud:"https://play.nekofans.games"`, `sub` (community UUID), `op`, `iat`, `exp`, and for sends `target`, `room`, and optional `name`. The issuer adapter uses 45-second tickets. Community OAuth tokens and refresh credentials stay on the community origin. With the key unset, the game server reports the feature disabled and preserves the ordinary room links.

A room has one open guest seat. A pending friend invitation reserves it for 15 minutes and a new targeted send replaces the previous pending invitation. Only its recipient can see or accept the invitation. The recipient can reopen the accepted room from the inbox while that room exists. Rooms and invitations share the current in-memory server lifecycle.
