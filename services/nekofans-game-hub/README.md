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
