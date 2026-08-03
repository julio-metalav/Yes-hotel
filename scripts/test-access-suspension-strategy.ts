/**
 * Testes: access-suspension-strategy (contrato puro, sem I/O).
 */
import assert from "node:assert/strict";
import {
  assertSuspensionContractSafe,
  buildAccessRestoreStrategy,
  buildAccessSuspensionStrategy,
} from "../src/lib/domain/yes-hotel/access-suspension-strategy";

const original = {
  original_valid_from: "2026-08-08T17:00:00.000Z",
  original_valid_until: "2026-08-10T15:00:00.000Z",
};

// 29–31) preserva senha, proíbe delete/freeze
{
  const s = buildAccessSuspensionStrategy({
    ...original,
    suspended_at: "2026-08-08T19:00:00.000Z",
  });
  assert.equal(s.operation, "change_validity");
  assert.equal(s.preserve_passcode, true);
  assert.equal(s.delete_allowed, false);
  assert.equal(s.freeze_lock_allowed, false);
  assert.equal(s.revoke_allowed, false);
  assert.equal(s.new_passcode_allowed, false);
  assert.deepEqual(s.targets, ["apartamento", "portao_externo", "portao_interno"]);
  assert.equal(s.original_valid_from, original.original_valid_from);
  assert.equal(s.original_valid_until, original.original_valid_until);
  assert.equal(s.suspended_valid_until, "2026-08-08T19:00:00.000Z");
  assertSuspensionContractSafe(s);

  const json = JSON.stringify(s);
  // Não pode haver valor de senha; nomes de flags (preserve_passcode) são ok.
  assert.ok(!/"senha"\s*:/i.test(json));
  assert.ok(!/"password"\s*:/i.test(json));
  assert.ok(!/"keyboardPwd"\s*:/i.test(json));
  assert.ok(!/"passcode"\s*:\s*"/i.test(json));
}

// 32) restauração usa validade original exata
{
  const r = buildAccessRestoreStrategy(original);
  assert.equal(r.restore_valid_from, original.original_valid_from);
  assert.equal(r.restore_valid_until, original.original_valid_until);
  assert.equal(r.preserve_passcode, true);
  assert.equal(r.delete_allowed, false);
  assertSuspensionContractSafe(r);
}

// 33) nenhuma estrutura contém senha em texto
{
  const s = buildAccessSuspensionStrategy({
    ...original,
    suspended_at: "2026-08-08T19:05:00.000Z",
  });
  const r = buildAccessRestoreStrategy(original);
  for (const obj of [s, r]) {
    const keys = Object.keys(obj);
    assert.ok(!keys.some((k) => /senha|password|keyboardPwd|passcode_text/i.test(k)));
  }
}

console.log("OK test-access-suspension-strategy");
