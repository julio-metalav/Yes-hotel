import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GATEWAY_TOKEN_MIN_LENGTH,
  assertGatewayTokenOrThrow,
} from "../src/config.ts";

test("GATEWAY_TOKEN abaixo da política é rejeitado no startup", () => {
  const short = "a".repeat(GATEWAY_TOKEN_MIN_LENGTH - 1);
  assert.equal(short.length, 31);
  assert.throws(
    () => assertGatewayTokenOrThrow(short),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /GATEWAY_TOKEN/);
      assert.equal(err.message.includes(short), false);
      return true;
    },
  );
  assert.throws(() => assertGatewayTokenOrThrow(""), /GATEWAY_TOKEN/);
});

test("GATEWAY_TOKEN com 32+ caracteres é aceito", () => {
  assert.doesNotThrow(() => assertGatewayTokenOrThrow("b".repeat(GATEWAY_TOKEN_MIN_LENGTH)));
  assert.doesNotThrow(() =>
    assertGatewayTokenOrThrow("c".repeat(64)),
  );
});
