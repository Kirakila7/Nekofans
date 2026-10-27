import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountService } from "../../packages/account-adapter/src/index.ts";

test("getBalance throws Not implemented", () => {
  assert.throws(() => AccountService.getBalance(), /Not implemented/);
});

test("getUsage throws Not implemented", () => {
  assert.throws(() => AccountService.getUsage(7), /Not implemented/);
});

test("openTopUpView throws Not implemented", () => {
  assert.throws(() => AccountService.openTopUpView(), /Not implemented/);
});

test("onBalanceChange throws Not implemented", () => {
  assert.throws(() => AccountService.onBalanceChange(() => {}), /Not implemented/);
});
