import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const matrixUrl = new URL("../../docs/assets/docker-sandbox-parity-matrix.json", import.meta.url);

async function loadMatrix() {
  return JSON.parse(await readFile(matrixUrl, "utf8"));
}

test("Docker sandbox parity ledger keeps local, cloud, and OpenShell profiles distinct", async () => {
  const matrix = await loadMatrix();

  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(matrix.profiles, ["openshell", "docker-local", "docker-cloud"]);

  assert.match(matrix.proofRule, /not OCC-qualified until a live conformance artifact/i);
});

test("every Docker parity control requires live proof", async () => {
  const matrix = await loadMatrix();

  assert.ok(Array.isArray(matrix.controls));
  assert.ok(matrix.controls.length > 0);

  for (const control of matrix.controls) {
    assert.equal(typeof control.id, "string");
    assert.notEqual(control.id.trim(), "");
    assert.equal(typeof control.category, "string");
    assert.equal(control.proofRequired, true, control.id);

    for (const field of ["openshell", "dockerLocal", "dockerCloud"]) {
      assert.ok(
        Object.hasOwn(matrix.statusVocabulary, control[field]),
        `${control.id} uses unknown status ${String(control[field])} for ${field}`,
      );
    }
  }
});

test("cloud limitations cannot be silently promoted to local parity", async () => {
  const matrix = await loadMatrix();

  const byId = new Map(matrix.controls.map((control) => [control.id, control]));

  assert.equal(byId.get("network.http-method-path")?.dockerLocal, "documented");
  assert.equal(
    byId.get("network.http-method-path")?.dockerCloud,
    "documented-limitation",
  );

  assert.equal(byId.get("credential.oauth")?.dockerCloud, "documented");
  assert.equal(
    byId.get("credential.oauth-sandbox-scope")?.dockerCloud,
    "documented-limitation",
  );
});

test("OpenShell-specific guarantees remain explicit gaps until Docker proves equivalents", async () => {
  const matrix = await loadMatrix();

  const byId = new Map(matrix.controls.map((control) => [control.id, control]));

  for (const id of [
    "network.calling-binary-binding",
    "filesystem.path-level-policy",
    "process.reduced-privilege-seccomp",
    "credential.generalized-token-exchange",
    "identity.occ-workload-identity-binding",
  ]) {
    const control = byId.get(id);
    assert.equal(control?.openshell, "reference-supported", id);
    assert.equal(control?.dockerLocal, "unknown", id);
    assert.equal(control?.dockerCloud, "unknown", id);
  }
});

test("upstream Docker feedback requires reproduction first", async () => {
  const matrix = await loadMatrix();

  assert.equal(matrix.upstreamFeedback.repository, "docker/sbx-releases");
  assert.equal(matrix.upstreamFeedback.kitSpecRepository, "docker/sandbox-kit-spec");
  assert.match(matrix.upstreamFeedback.rule, /after a live reproduction exists/i);
});
