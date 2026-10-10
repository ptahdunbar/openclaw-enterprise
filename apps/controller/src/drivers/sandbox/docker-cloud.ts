import { sha256Hex } from "@openclaw-enterprise/utils";
import { SandboxRevisionUnsupportedError } from "@openclaw-enterprise/occ";
import type {
  AgentRevision,
  HarnessWorkloadRequirements,
  Namespace,
  SandboxDriver,
  SandboxHarnessContext,
  SandboxHarnessObservation,
  SandboxLogContext,
  SandboxNamespaceContext,
  SandboxResourceRef,
} from "@openclaw-enterprise/contracts";

export type DockerCloudSandboxState =
  | "creating"
  | "running"
  | "stopping"
  | "stopped"
  | "deleting"
  | "failed"
  | "unknown";

export type DockerCloudProcessState = "starting" | "running" | "exited" | "failed" | "unknown";

export interface DockerCloudSandboxRecord {
  readonly name: string;
  readonly displayName: string;
  readonly state: DockerCloudSandboxState;
  readonly failureCode?: string;
}

export interface DockerCloudProcessRecord {
  readonly name: string;
  readonly label: string;
  readonly state: DockerCloudProcessState;
  readonly exitCode?: number;
}

export interface DockerCloudSandboxClient {
  findByDisplayName(
    displayName: string,
    signal: AbortSignal,
  ): Promise<readonly DockerCloudSandboxRecord[]>;
  listByDisplayNamePrefix(
    displayNamePrefix: string,
    signal: AbortSignal,
  ): Promise<readonly DockerCloudSandboxRecord[]>;
  create(
    input: {
      readonly displayName: string;
      readonly imageRef: string;
      readonly resources: Readonly<{ cpus: number; memoryMib: number }>;
      readonly networkPolicyIds: readonly string[];
    },
    options: { readonly idempotencyKey: string; readonly signal: AbortSignal },
  ): Promise<DockerCloudSandboxRecord>;
  waitUntilRunning(name: string, signal: AbortSignal): Promise<DockerCloudSandboxRecord>;
  workspaceRoot(name: string, signal: AbortSignal): Promise<string>;
  writeTextFile(name: string, path: string, content: string, signal: AbortSignal): Promise<void>;
  readTextFile(name: string, path: string, signal: AbortSignal): Promise<string | undefined>;
  startProcess(
    name: string,
    input: {
      readonly label: string;
      readonly args: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
      readonly workingDirectory: string;
    },
    options: { readonly idempotencyKey: string; readonly signal: AbortSignal },
  ): Promise<DockerCloudProcessRecord>;
  processByLabel(
    name: string,
    label: string,
    signal: AbortSignal,
  ): Promise<DockerCloudProcessRecord | undefined>;
  delete(
    name: string,
    options: {
      readonly force: boolean;
      readonly idempotencyKey: string;
      readonly signal: AbortSignal;
    },
  ): Promise<void>;
}

export interface DockerCloudSandboxDriverOptions {
  readonly resources?: Readonly<{ cpus: number; memoryMib: number }>;
  readonly networkPolicyIds?: readonly string[];
  readonly displayNamePrefix?: string;
}

interface DockerSandboxOwnership {
  readonly schemaVersion: 1;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly sandboxDisplayName: string;
  readonly processLabel: string;
}

const DEFAULT_RESOURCES = Object.freeze({ cpus: 2, memoryMib: 4096 });
const DEFAULT_PREFIX = "occ";
const OWNER_DIRECTORY = ".occ";
const OWNER_FILE = "owner.json";

function stablePart(value: string, length: number): string {
  return sha256Hex(value).slice(0, length);
}

function sandboxNamespacePrefix(prefix: string, namespaceId: string): string {
  return `${prefix}-${stablePart(namespaceId, 10)}-`;
}

function sandboxDisplayName(prefix: string, revision: Readonly<AgentRevision>): string {
  return [
    sandboxNamespacePrefix(prefix, revision.namespaceId),
    stablePart(revision.agentId, 10),
    "-",
    stablePart(revision.id, 16),
  ].join("");
}

function harnessProcessLabel(revision: Readonly<AgentRevision>): string {
  return `occ-harness-${stablePart(revision.id, 24)}`;
}

function operationKey(kind: string, revision: Readonly<AgentRevision>): string {
  return `occ-${kind}-${sha256Hex(`${revision.namespaceId}: ${revision.agentId}: ${revision.id}`).slice(0, 32)}`;
}

function namespaceCleanupKey(namespace: Readonly<Namespace>, sandboxName: string): string {
  return `occ-delete-${sha256Hex(`${namespace.id}: ${sandboxName}`).slice(0, 32)}`;
}

function ownerPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/\/$/, "")}/${OWNER_DIRECTORY}/${OWNER_FILE}`;
}

function workloadFilePath(workspaceRoot: string, name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "Docker Cloud Sandbox workload files require a safe logical file name.",
    );
  }
  return `${workspaceRoot.replace(/\/$/, "")}/${OWNER_DIRECTORY}/files/${name}`;
}

function literalEnvironment(requirements: HarnessWorkloadRequirements): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const variable of requirements.environment) {
    if ("valueFrom" in variable) {
      throw new SandboxRevisionUnsupportedError(
        "SANDBOX_SECRET_ENVIRONMENT_UNSUPPORTED",
        "Docker Cloud SandboxDriver does not copy Kubernetes Secret values into the sandbox.",
      );
    }
    environment[variable.name] = variable.value;
  }
  return environment;
}

function validateRequirements(context: SandboxHarnessContext): void {
  if (context.revision.namespaceId !== context.namespace.id) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "Docker Cloud SandboxDriver refuses a revision outside the selected Namespace.",
    );
  }
  if (context.revision.harness.mode !== "dedicated") {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "Docker Cloud SandboxDriver requires dedicated Harness execution.",
    );
  }
  if (context.requirements.image.trim().length === 0 || context.requirements.command.length === 0) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "Docker Cloud SandboxDriver requires an immutable Harness image and startup command.",
    );
  }
  if (context.requirements.workloadIdentity !== undefined) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "Docker Cloud workload-identity projection is not yet qualified; refusing the revision.",
    );
  }
  if (context.requirements.workspaceMounts.length > 0) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "Docker Cloud does not consume Kubernetes PVC workspace mounts; portable storage mapping is not yet qualified.",
    );
  }
  if (context.requirements.credentialAttachments.length > 0) {
    throw new SandboxRevisionUnsupportedError(
      "SANDBOX_HARNESS_UNSUPPORTED",
      "Docker Cloud credential-source attachments are not yet qualified; refusing the revision.",
    );
  }
}

function parseOwner(content: string | undefined): DockerSandboxOwnership | undefined {
  if (content === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const owner = value as Partial<DockerSandboxOwnership>;
    return owner.schemaVersion === 1 &&
      typeof owner.namespaceId === "string" &&
      typeof owner.agentId === "string" &&
      typeof owner.revisionId === "string" &&
      typeof owner.sandboxDisplayName === "string" &&
      typeof owner.processLabel === "string"
      ? (owner as DockerSandboxOwnership)
      : undefined;
  } catch {
    return undefined;
  }
}

function exactOwner(
  owner: DockerSandboxOwnership | undefined,
  namespaceId: string,
  agentId?: string,
  revisionId?: string,
): boolean {
  return (
    owner !== undefined &&
    owner.namespaceId === namespaceId &&
    (agentId === undefined || owner.agentId === agentId) &&
    (revisionId === undefined || owner.revisionId === revisionId)
  );
}

export class DockerCloudSandboxDriver implements SandboxDriver {
  readonly capability = "sandbox" as const;
  /**
   * The initial cloud slice claims only the controls we can prove through the public API.
   * Filesystem is intentionally withheld until workspace/storage isolation has live evidence.
   */
  readonly facets = Object.freeze(["networking", "process"] as const);
  readonly implementation = "docker/sandboxes-cloud";
  readonly id: string;

  private readonly resources: Readonly<{ cpus: number; memoryMib: number }>;
  private readonly networkPolicyIds: readonly string[];
  private readonly displayNamePrefix: string;

  constructor(
    id: string,
    private readonly client: DockerCloudSandboxClient,
    options: DockerCloudSandboxDriverOptions = {},
  ) {
    this.id = id;
    this.resources = options.resources ?? DEFAULT_RESOURCES;
    this.networkPolicyIds = Object.freeze([...(options.networkPolicyIds ?? [])]);
    this.displayNamePrefix = options.displayNamePrefix ?? DEFAULT_PREFIX;
  }

  private async exactSandbox(
    revision: Readonly<AgentRevision>,
    signal: AbortSignal,
  ): Promise<DockerCloudSandboxRecord | undefined> {
    const displayName = sandboxDisplayName(this.displayNamePrefix, revision);
    const matches = await this.client.findByDisplayName(displayName, signal);
    if (matches.length > 1) {
      throw new Error("Docker Cloud returned multiple sandboxes for one OCC revision display name.");
    }
    return matches[0];
  }

  private async assertOwnership(
    sandbox: DockerCloudSandboxRecord,
    workspaceRoot: string,
    namespaceId: string,
    agentId?: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<DockerSandboxOwnership> {
    const owner = parseOwner(
      await this.client.readTextFile(
        sandbox.name,
        ownerPath(workspaceRoot),
        signal ?? AbortSignal.timeout(10_000),
      ),
    );
    if (!exactOwner(owner, namespaceId, agentId, revisionId)) {
      throw new Error("Docker Cloud sandbox ownership evidence does not match the OCC resource.");
    }
    return owner;
  }

  async provisionHarness(context: SandboxHarnessContext): Promise<SandboxResourceRef> {
    validateRequirements(context);
    const environment = literalEnvironment(context.requirements);
    const displayName = sandboxDisplayName(this.displayNamePrefix, context.revision);
    const processLabel = harnessProcessLabel(context.revision);

    let sandbox = await this.exactSandbox(context.revision, context.signal);
    if (sandbox !== undefined) {
      const workspaceRoot = await this.client.workspaceRoot(sandbox.name, context.signal);
      await this.assertOwnership(
        sandbox,
        workspaceRoot,
        context.namespace.id,
        context.revision.agentId,
        context.revision.id,
        context.signal,
      );
    } else {
      sandbox = await this.client.create(
        {
          displayName,
          imageRef: context.requirements.image,
          resources: this.resources,
          networkPolicyIds: this.networkPolicyIds,
        },
        {
          idempotencyKey: operationKey("create", context.revision),
          signal: context.signal,
        },
      );
    }

    sandbox = await this.client.waitUntilRunning(sandbox.name, context.signal);
    const workspaceRoot = await this.client.workspaceRoot(sandbox.name, context.signal);

    const ownership: DockerSandboxOwnership = {
      schemaVersion: 1,
      namespaceId: context.namespace.id,
      agentId: context.revision.agentId,
      revisionId: context.revision.id,
      sandboxDisplayName: displayName,
      processLabel,
    };
    await this.client.writeTextFile(
      sandbox.name,
      ownerPath(workspaceRoot),
      JSON.stringify(ownership),
      context.signal,
    );

    for (const file of context.requirements.files) {
      const path = workloadFilePath(workspaceRoot, file.name);
      await this.client.writeTextFile(sandbox.name, path, file.content, context.signal);
      environment[file.environmentVariable] = path;
    }

    const existingProcess = await this.client.processByLabel(
      sandbox.name,
      processLabel,
      context.signal,
    );
    if (existingProcess === undefined) {
      await this.client.startProcess(
        sandbox.name,
        {
          label: processLabel,
          args: context.requirements.command,
          environment,
          workingDirectory: workspaceRoot,
        },
        {
          idempotencyKey: operationKey("process", context.revision),
          signal: context.signal,
        },
      );
    } else if (existingProcess.state === "exited" || existingProcess.state === "failed") {
      throw new Error("Docker Cloud Harness process exited before OCC could activate the revision.");
    }

    return Object.freeze({
      namespaceName: context.namespace.name,
      resourceName: sandbox.name,
      agentId: context.revision.agentId,
      revisionId: context.revision.id,
    });
  }

  async cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void> {
    if (context.revision !== undefined) {
      const sandbox = await this.exactSandbox(context.revision, context.signal);
      if (sandbox === undefined) {
        return;
      }
      const workspaceRoot = await this.client.workspaceRoot(sandbox.name, context.signal);
      await this.assertOwnership(
        sandbox,
        workspaceRoot,
        context.namespace.id,
        context.revision.agentId,
        context.revision.id,
        context.signal,
      );
      await this.client.delete(sandbox.name, {
        force: true,
        idempotencyKey: operationKey("delete", context.revision),
        signal: context.signal,
      });
      return;
    }

    const prefix = sandboxNamespacePrefix(this.displayNamePrefix, context.namespace.id);
    const candidates = await this.client.listByDisplayNamePrefix(prefix, context.signal);
    for (const sandbox of candidates) {
      const workspaceRoot = await this.client.workspaceRoot(sandbox.name, context.signal);
      const owner = parseOwner(
        await this.client.readTextFile(
          sandbox.name,
          ownerPath(workspaceRoot),
          context.signal,
        ),
      );
      if (!exactOwner(owner, context.namespace.id)) {
        continue;
      }
      await this.client.delete(sandbox.name, {
        force: true,
        idempotencyKey: namespaceCleanupKey(context.namespace, sandbox.name),
        signal: context.signal,
      });
    }
  }

  async observeHarness(context: SandboxLogContext): Promise<SandboxHarnessObservation> {
    const sandbox = await this.exactSandbox(context.revision, context.signal);
    if (sandbox === undefined) {
      return Object.freeze({ state: "lost", code: "SANDBOX_MISSING" });
    }

    switch (sandbox.state) {
      case "creating":
        return Object.freeze({ state: "starting" });
      case "stopping":
      case "stopped":
        return Object.freeze({ state: "lost", code: "SANDBOX_STOPPED" });
      case "deleting":
        return Object.freeze({ state: "lost", code: "SANDBOX_DELETING" });
      case "failed":
        return Object.freeze({ state: "lost", code: "SANDBOX_FAILED" });
      case "unknown":
        return Object.freeze({ state: "unknown" });
      case "running":
        break;
    }

    const workspaceRoot = await this.client.workspaceRoot(sandbox.name, context.signal);
    const owner = parseOwner(
      await this.client.readTextFile(
        sandbox.name,
        ownerPath(workspaceRoot),
        context.signal,
      ),
    );
    if (
      !exactOwner(
        owner,
        context.namespace.id,
        context.revision.agentId,
        context.revision.id,
      )
    ) {
      return Object.freeze({ state: "unknown" });
    }

    const process = await this.client.processByLabel(
      sandbox.name,
      owner.processLabel,
      context.signal,
    );
    if (process === undefined || process.state === "unknown" || process.state === "starting") {
      return Object.freeze({ state: "starting" });
    }
    if (process.state === "running") {
      return Object.freeze({ state: "running" });
    }
    return Object.freeze({ state: "lost", code: "HARNESS_EXITED" });
  }
}

export const dockerCloudSandboxNames = Object.freeze({
  namespacePrefix: sandboxNamespacePrefix,
  displayName: sandboxDisplayName,
  processLabel: harnessProcessLabel,
});
