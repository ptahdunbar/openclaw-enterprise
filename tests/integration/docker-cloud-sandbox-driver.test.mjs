import assert from "node:assert/strict";
import test from "node:test";
import {
  DockerCloudSandboxDriver,
  dockerCloudSandboxNames,
} from "../../apps/controller/src/drivers/sandbox/docker-cloud.ts";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";

function revision(overrides = {}) {
  return {
    id: "revision-1",
    namespaceId: "namespace-1",
    agentId: "agent-1",
    harness: { id: "openclaw", version: "1", mode: "dedicated" },
    ...overrides,
  };
}

function namespace(overrides = {}) {
  return { id: "namespace-1", name: "tenant-one", ...overrides };
}

function requirements(overrides = {}) {
  return {
    loginMode: "api_key",
    image: "ghcr.io/example/openclaw@sha256:abc",
    command: ["/app/start-harness"],
    workspaceMounts: [],
    environment: [{ name: "MODE", value: "test" }],
    files: [
      {
        name: "runtime.json",
        content: "{\"ok\":true}",
        environmentVariable: "OPENCLAW_RUNTIME_FILE",
      },
    ],
    credentialAttachments: [],
    labels: { "openclaw.dev/revision-id": "revision-1" },
    ...overrides,
  };
}

class FakeDockerCloudClient {
  sandboxes = new Map();
  files = new Map();
  processes = new Map();
  creates = [];
  deletes = [];
  processStarts = [];

  async findByDisplayName(displayName) {
    return [...this.sandboxes.values()].filter((sandbox) => sandbox.displayName === displayName);
  }

  async listByDisplayNamePrefix(prefix) {
    return [...this.sandboxes.values()].filter((sandbox) =>
      sandbox.displayName.startsWith(prefix),
    );
  }

  async create(input, options) {
    this.creates.push({ input, options });
    const sandbox = {
      name: `sandboxes/${this.creates.length}`,
      displayName: input.displayName,
      state: "creating",
    };
    this.sandboxes.set(sandbox.name, sandbox);
    return sandbox;
  }

  async waitUntilRunning(name) {
    const sandbox = this.sandboxes.get(name);
    if (!sandbox) throw new Error("sandbox missing");
    const running = { ...sandbox, state: "running" };
    this.sandboxes.set(name, running);
    return running;
  }

  async workspaceRoot() {
    return "/workspace";
  }

  async writeTextFile(name, path, content) {
    this.files.set(`${name}:${path}`, content);
  }

  async readTextFile(name, path) {
    return this.files.get(`${name}:${path}`);
  }

  async startProcess(name, input, options) {
    this.processStarts.push({ name, input, options });
    const process = {
      name: `processes/${this.processStarts.length}`,
      label: input.label,
      state: "running",
    };
    this.processes.set(`${name}:${input.label}`, process);
    return process;
  }

  async processByLabel(name, label) {
    return this.processes.get(`${name}:${label}`);
  }

  async delete(name, options) {
    this.deletes.push({ name, options });
    this.sandboxes.delete(name);
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${name}:`)) this.files.delete(key);
    }
  }
}

function context(client, revisionOverrides = {}, requirementOverrides = {}) {
  const selectedRevision = revision(revisionOverrides);
  return {
    driver: new DockerCloudSandboxDriver("docker-cloud", client, {
      networkPolicyIds: ["policies/default-deny"],
    }),
    context: {
      namespace: namespace(),
      revision: selectedRevision,
      requirements: requirements(requirementOverrides),
      kubernetes: {},
      signal: AbortSignal.timeout(10_000),
    },
    revision: selectedRevision,
  };
}

test("Docker Cloud driver provisions one revision with stable idempotency and ownership evidence", async () => {
  const client = new FakeDockerCloudClient();
  const { driver, context: harnessContext, revision: selectedRevision } = context(client);

  const result = await driver.provisionHarness(harnessContext);

  assert.equal(client.creates.length, 1);
  assert.deepEqual(client.creates[0].input.networkPolicyIds, ["policies/default-deny"]);
  assert.match(client.creates[0].options.idempotencyKey, /^occ-create-/);

  assert.equal(result.namespaceName, "tenant-one");
  assert.equal(result.agentId, "agent-1");
  assert.equal(result.revisionId, "revision-1");
  assert.match(result.resourceName, /^sandboxes\//);

  assert.equal(client.processStarts.length, 1);
  assert.deepEqual(client.processStarts[0].input.args, ["/app/start-harness"]);
  assert.equal(client.processStarts[0].input.environment.MODE, "test");
  assert.equal(
    client.processStarts[0].input.environment.OPENCLAW_RUNTIME_FILE,
    "/workspace/.occ/files/runtime.json",
  );
  assert.match(client.processStarts[0].options.idempotencyKey, /^occ-process-/);

  const displayName = dockerCloudSandboxNames.displayName("occ", selectedRevision);
  const owner = JSON.parse(
    client.files.get(`${result.resourceName}:/workspace/.occ/owner.json`),
  );
  assert.equal(owner.sandboxDisplayName, displayName);
  assert.equal(owner.namespaceId, "namespace-1");
  assert.equal(owner.agentId, "agent-1");
  assert.equal(owner.revisionId, "revision-1");

  assert.deepEqual(await driver.observeHarness({
    namespace: namespace(),
    revision: selectedRevision,
    signal: AbortSignal.timeout(10_000),
  }), { state: "running" });
});

test("Docker Cloud driver reuses an OCC-owned sandbox instead of creating a duplicate", async () => {
  const client = new FakeDockerCloudClient();
  const { driver, context: harnessContext } = context(client);

  const first = await driver.provisionHarness(harnessContext);
  const second = await driver.provisionHarness(harnessContext);

  assert.equal(first.resourceName, second.resourceName);
  assert.equal(client.creates.length, 1);
  assert.equal(client.processStarts.length, 1);
});

test("Docker Cloud driver refuses secret-backed environment until credential parity is qualified", async () => {
  const client = new FakeDockerCloudClient();
  const { driver, context: harnessContext } = context(client, {}, {
    environment: [
      {
        name: "MODEL_KEY",
        valueFrom: { secretKeyRef: { name: "model", key: "token" } },
      },
    ],
  });

  await assert.rejects(
    driver.provisionHarness(harnessContext),
    (error) =>
      error instanceof SandboxRevisionUnsupportedError &&
      error.code === "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
  );
  assert.equal(client.creates.length, 0);
});

test("Docker Cloud driver refuses workload identity until Docker can preserve the exact OCC identity", async () => {
  const client = new FakeDockerCloudClient();
  const { driver, context: harnessContext } = context(client, {}, {
    workloadIdentity: {
      serviceAccountName: "agent-1",
      token: {
        audience: "occ",
        expirationSeconds: 600,
        mountPath: "/var/run/occ",
        path: "token",
        readOnly: true,
      },
    },
  });

  await assert.rejects(
    driver.provisionHarness(harnessContext),
    (error) =>
      error instanceof SandboxRevisionUnsupportedError &&
      error.code === "SANDBOX_HARNESS_UNSUPPORTED" &&
      /workload-identity projection is not yet qualified/.test(error.message),
  );
  assert.equal(client.creates.length, 0);
});

test("Docker Cloud driver refuses OCC credential attachments until a Docker credential gateway is qualified", async () => {
  const client = new FakeDockerCloudClient();
  const { driver, context: harnessContext } = context(client, {}, {
    credentialAttachments: [{ sourceId: "source-1", ref: "opaque-1" }],
  });

  await assert.rejects(
    driver.provisionHarness(harnessContext),
    (error) =>
      error instanceof SandboxRevisionUnsupportedError &&
      /credential-source attachments are not yet qualified/.test(error.message),
  );
  assert.equal(client.creates.length, 0);
});

test("revision cleanup verifies ownership before deleting", async () => {
  const client = new FakeDockerCloudClient();
  const { driver, context: harnessContext, revision: selectedRevision } = context(client);
  const resource = await driver.provisionHarness(harnessContext);

  client.files.set(
    `${resource.resourceName}:/workspace/.occ/owner.json`,
    JSON.stringify({
      schemaVersion: 1,
      namespaceId: "foreign-namespace",
      agentId: "agent-1",
      revisionId: "revision-1",
      sandboxDisplayName: "forged",
      processLabel: "forged",
    }),
  );

  await assert.rejects(
    driver.cleanup({
      namespace: namespace(),
      revision: selectedRevision,
      kubernetes: {},
      signal: AbortSignal.timeout(10_000),
    }),
    /ownership evidence does not match/,
  );
  assert.equal(client.deletes.length, 0);
});

test("Namespace cleanup deletes only sandboxes whose marker proves OCC ownership", async () => {
  const client = new FakeDockerCloudClient();
  const first = context(client);
  const second = context(client, { id: "revision-2", agentId: "agent-2" });
  await first.driver.provisionHarness(first.context);
  await second.driver.provisionHarness(second.context);

  const prefix = dockerCloudSandboxNames.namespacePrefix("occ", "namespace-1");
  const foreign = {
    name: "sandboxes/foreign",
    displayName: `${prefix}foreign`,
    state: "running",
  };
  client.sandboxes.set(foreign.name, foreign);
  client.files.set(
    `${foreign.name}:/workspace/.occ/owner.json`,
    JSON.stringify({
      schemaVersion: 1,
      namespaceId: "another-namespace",
      agentId: "foreign",
      revisionId: "foreign",
      sandboxDisplayName: foreign.displayName,
      processLabel: "foreign",
    }),
  );

  await first.driver.cleanup({
    namespace: namespace(),
    kubernetes: {},
    signal: AbortSignal.timeout(10_000),
  });

  assert.equal(client.sandboxes.size, 1);
  assert.ok(client.sandboxes.has("sandboxes/foreign"));
  assert.equal(client.deletes.length, 2);
});

test("Docker Cloud driver reports stopped and failed runtime states without claiming success", async () => {
  const client = new FakeDockerCloudClient();
  const { driver, context: harnessContext, revision: selectedRevision } = context(client);
  const resource = await driver.provisionHarness(harnessContext);

  client.sandboxes.set(resource.resourceName, {
    ...client.sandboxes.get(resource.resourceName),
    state: "stopped",
  });
  assert.deepEqual(await driver.observeHarness({
    namespace: namespace(),
    revision: selectedRevision,
    signal: AbortSignal.timeout(10_000),
  }), { state: "lost", code: "SANDBOX_STOPPED" });

  client.sandboxes.set(resource.resourceName, {
    ...client.sandboxes.get(resource.resourceName),
    state: "failed",
  });
  assert.deepEqual(await driver.observeHarness({
    namespace: namespace(),
    revision: selectedRevision,
    signal: AbortSignal.timeout(10_000),
  }), { state: "lost", code: "SANDBOX_FAILED" });
});

test("initial Docker Cloud facet claim stays narrow until filesystem conformance exists", () => {
  const driver = new DockerCloudSandboxDriver("docker-cloud", new FakeDockerCloudClient());
  assert.deepEqual(driver.facets, ["networking", "process"]);
});
