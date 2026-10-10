# Docker SandboxDriver: cloud validation, OpenShell parity, and upstream feedback

Tracking: agencyftw/agents#329  
Parent qualification: agencyftw/agents#102

## Decision

Docker Sandboxes is a peer `SandboxDriver` implementation to OpenShell.

```text
OCC
  owns:
    Namespace
    Agent
    AgentRevision
    workload identity
    authorization
    desired state
    lifecycle / activation
        │
        ▼
SandboxDriver
  owns:
    containment adapter
    sandbox lifecycle integration
    runtime evidence
        │
        ├── OpenShellSandboxDriver
        └── DockerSandboxDriver
```

Do not stack OpenShell and Docker Sandboxes in the default path. Running two independent sandbox/policy/credential layers creates duplicate policy sources, duplicate credential mediation, ambiguous failure ownership, and harder evidence.

The governing rule is:

> **Kit declares. OCC authorizes. Docker enforces. Higher layers verify the Outcome.**

Docker Kit descriptors and Docker policies are never OCC authorization sources.

## Why Docker

Docker Sandboxes now exposes enough of an agent-runtime substrate to justify a first-class OCC adapter:

- local and cloud sandboxes;
- a public cloud Sandboxes API;
- a TypeScript SDK;
- process and file APIs;
- short-lived sandbox endpoint credentials;
- network policies and decision logs;
- local proxy-managed credentials;
- separate cloud secret storage;
- Kit v3 typed capability requests;
- OCI-based packaging;
- snapshots and persistent resources.

The implementation is also strategically useful: Docker states that Sandboxes, the SDK/API, and Kit v3 are experimental and explicitly requests implementation feedback. OCC gives us a real enterprise control-plane workload against which to produce reproducible feedback instead of speculative feature requests.

## Non-goal

This work does not replace OCC policy, IAM, workload identity, AgentRevision, or authorization with Docker constructs.

It also does not require feature-identical behavior across OpenShell and Docker.

The required property is:

> A selected SandboxDriver advertises what it can enforce, OCC admits only workloads whose required controls are satisfied, and unsupported guarantees fail closed.

## Profiles

Treat these as separate profiles until conformance proves otherwise:

```text
openshell
docker-local
docker-cloud
```

Docker local and Docker cloud are not one security profile.

Current Docker documentation explicitly describes separate local/cloud state, credential stores, network policies, and lifecycle controls. Cloud network policy is currently network-only and does not support the local HTTP method/path/protocol governance surface.

A local pass must never be reused as cloud evidence.

## Existing OCC seam

The current `SandboxDriver` contract remains the starting point.

The Docker implementation must fit, or precisely document why a shared-contract change is required:

- `facets`
- `configureAgent`
- `ensureNamespace`
- `provisionHarness`
- `cleanup`
- `harnessResource`
- `harnessEndpoint`
- `harnessStatus`
- `observeHarness`
- `readSandboxLogs`

Existing OpenShell behavior is the regression baseline.

Do not extend the shared interface merely because Docker uses different nouns.

## Target facets

Docker should initially advertise only facets proven by live conformance.

Candidate mapping:

| OCC facet | Docker candidate enforcement |
| --- | --- |
| `networking` | sandbox network policy / cloud network policy |
| `filesystem` | sandbox workspace/filesystem boundary; finer path confinement must be separately proven |
| `process` | microVM/process boundary, endpoint process API, cancellation/signals |

Browser, computer-use, terminal, credential, and policy-mutability capabilities remain richer qualification metadata; do not overload the three coarse OCC facets to claim guarantees they do not express.

## Cloud-first implementation direction

Prefer the public `@docker/sandboxes` TypeScript SDK and Docker Sandboxes API for the cloud path.

Use direct HTTP only when the SDK does not expose a required operation.

Use `sbx --cloud` only for:
- conformance/debug reproduction;
- a feature absent from the SDK/API;
- collecting evidence for an upstream API gap.

Production driver behavior must not depend on scraping CLI output when a typed API exists.

### Important API properties

Preserve the Docker API's trust split:

```text
OCC / management client
    │
    │ management bearer
    ▼
Docker Sandboxes API
    │
    │ short-lived, sandbox-scoped endpoint credential
    ▼
Sandbox endpoint
    ├── process operations
    └── file operations
```

A management credential must not be copied into the Harness.

Use idempotency keys on supported mutation paths and preserve OCC revision identity as the stable source for retry keys.

## Resource identity mapping

A Docker sandbox resource reference must be stable enough for OCC cleanup and observation.

Target adapter-local representation:

```ts
interface DockerSandboxResourceRef {
  readonly profile: "local" | "cloud";
  readonly sandboxName: string;
  readonly sandboxId?: string;
  readonly agentId: string;
  readonly revisionId: string;
}
```

This is adapter-local. The public OCC resource remains `SandboxResourceRef`.

Do not use a mutable display name as the only identity if Docker exposes an immutable resource name/id.

## Workload identity

OCC remains the identity authority.

Docker account identity authenticates OCC to Docker; it is not the Agent's workload identity.

Required chain:

```text
OCC AgentRevision
    ↓
OCC workload identity
    ↓
admitted runtime/credential grants
    ↓
Docker sandbox
    ↓
short-lived endpoint credential for OCC control
```

If Docker cannot natively carry OCC workload identity into the sandbox/runtime evidence path, record that as an explicit parity gap.

Do not silently substitute Docker account identity.

## Kit v3

Kit v3 is requested capability metadata.

Required admission sequence:

```text
Kit descriptor
    ↓
requested typed capabilities
    ↓
OCC admission
    ↓
Authority / Restrictions / workload identity
    ↓
immutable AgentRevision
    ↓
DockerSandboxDriver
    ↓
Docker runtime enforcement
```

Required capabilities fail closed when either:

- OCC cannot authorize them; or
- the selected Docker profile cannot enforce them.

Unknown capability types remain opaque until an OCC adapter explicitly understands and admits them.

Authority changes between Kit versions should surface as a meaningful deployment diff.

## Credential model

### Minimum parity contract

A Docker profile is credential-qualified only when the applicable fixture proves:

- raw material does not enter Harness/model context;
- raw material does not enter OCC revision metadata;
- raw material does not enter ordinary logs/evidence;
- workload receives only a sentinel/opaque reference where proxy management is used;
- injection is destination-bound;
- credential revocation has deterministic behavior;
- credential binding does not imply network authorization;
- network authorization does not imply credential authorization.

### Docker local

Docker local currently documents host-side proxy-managed credentials where the real value remains on the host and the sandbox sees a sentinel.

Qualify:

- API key;
- Bearer;
- Basic/custom-header;
- multiple domains;
- Kit credential declaration;
- external/dynamic secret source;
- OAuth;
- refresh/rotation;
- running-sandbox update/revocation;
- method/path-bound network policy interaction.

### Docker cloud

Cloud credentials are a separate system and must be tested independently.

Qualify:

- account-scoped secret;
- sandbox-scoped secret;
- precedence;
- OAuth scope behavior;
- custom services;
- revocation;
- rotation;
- launch-time binding;
- snapshot/move/template behavior;
- whether any interactive sign-in can persist raw material inside the sandbox.

Current documented limitation: cloud OAuth credentials cannot use sandbox scope. Treat this as a capability difference, not a documentation footnote.

## OpenShell parity matrix

Use `docs/assets/docker-sandbox-parity-matrix.json` as the machine-readable qualification ledger.

The most important OpenShell differentiators to investigate are:

1. **calling-binary/digest-bound egress**
   - OpenShell can constrain network/provider access by executable.
   - Do not claim Docker parity unless an equivalent enforcement primitive is demonstrated.

2. **provider/token-exchange lifecycle**
   - OpenShell has an explicit provider abstraction and generalized refresh/token-exchange behavior.
   - Docker has credentials, OAuth, secret stores, and proxy injection; test whether the effective guarantee is equivalent for OCC workloads.

3. **workload OIDC**
   - Determine whether a Docker sandbox can receive a short-lived, revision-bound subject identity without copying a reusable control-plane credential.

4. **fine-grained filesystem confinement**
   - OpenShell uses path-level confinement.
   - Docker's microVM boundary is strong outer isolation, but inner path-level parity must be measured separately.

5. **process confinement**
   - OpenShell provides reduced privilege/seccomp-oriented controls.
   - Docker Sandboxes intentionally gives significant freedom inside the microVM.
   - Treat these as different trust models, not automatically equivalent controls.

6. **hot provider attachment**
   - Measure credential/policy changes on a running sandbox and whether restart/recreate is required.

## Network policy

### Local

Qualify:
- deny-by-default;
- host allow/deny;
- policy mutation;
- decision evidence;
- HTTP method/path rules when using network-policy@2;
- interaction with proxy-managed credentials.

### Cloud

Qualify independently:
- account default policy;
- sandbox policy;
- allow/deny precedence;
- mutation after creation;
- policy logs;
- agent/Kit-declared network requirements;
- exact effective-policy inspection.

Current documented limitation: cloud policy does not support HTTP method/path restrictions, `--protocol`, or local governance profiles.

This is an immediate parity difference from the strongest local/OpenShell policy profiles.

## Filesystem

The first cloud slice should prove:

- workspace location is discovered rather than assumed;
- Harness files can be staged without leaking OCC credentials;
- approved workspace writes persist only where intended;
- cleanup removes the revision's owned state;
- snapshots/templates do not accidentally capture credentials;
- another Agent/Namespace cannot read the revision's workspace.

Do not map "microVM" to OCC `filesystem` facet until these invariants have live evidence.

## Process / terminal

Qualify the process API independently of model behavior.

Required scenarios:
- exec command to completion;
- durable process;
- stdout/stderr retention;
- signal/cancel;
- process lost;
- retry after transport failure;
- idempotency behavior;
- sandbox delete while process runs;
- no command can reach host control-plane credentials.

Docker documents that a retry of one-shot exec after transport failure may execute again. OCC must not treat that primitive as inherently exactly-once.

For consequential work, use OCC Action/idempotency semantics above the process API.

## Browser and computer use

These are not synonymous with the `process` facet.

The conformance suite must distinguish:

```text
browser
computer-use
terminal/process
```

For browser workloads, test:
- isolated profile/state;
- authenticated session handling;
- downloads/uploads;
- network policy;
- credential proxy interaction;
- restart/snapshot behavior.

For computer-use workloads, additionally test:
- screen/input control;
- native applications;
- clipboard;
- filesystem spillover;
- credential exposure;
- cancellation and kill behavior.

If Docker does not expose a first-class computer-use primitive, OCC may still run a computer-use tool inside the sandbox, but the driver must not claim a stronger guarantee than the underlying runtime proves.

## Runtime policy mutation

For every policy class, classify the observed behavior as:

- `native`
- `restart-required`
- `recreate-required`
- `unsupported`
- `unknown`

Do not use a single "hot reload" boolean.

At minimum classify:
- network;
- credentials;
- filesystem;
- process/privilege;
- Kit composition;
- ports;
- MCP governance.

## Lifecycle mapping

Target cloud lifecycle:

```text
OCC candidate AgentRevision
    ↓
Docker create/launch
    ↓
wait until running
    ↓
stage Harness/config
    ↓
obtain endpoint-scoped credential
    ↓
start/observe Harness
    ↓
authenticated readiness
    ↓
OCC activation
```

Replacement:

```text
new revision ready
    ↓
OCC activates replacement
    ↓
old revision stop
    ↓
Docker sandbox cleanup
```

Partial failures must leave enough resource identity for deterministic cleanup.

## Evidence

Each conformance run records:

- OCC commit;
- Docker SDK version;
- Docker CLI version where applicable;
- local/cloud profile;
- Kit digest or image digest;
- Agent ID;
- AgentRevision ID;
- Docker sandbox immutable identifier;
- admitted facets/capabilities;
- policy generation/version where available;
- credential source metadata without values;
- endpoint credential lifetime/scope metadata without token;
- operation IDs;
- process IDs;
- policy decisions;
- timestamps;
- cleanup result;
- verification result.

Never record:
- management bearer token;
- endpoint bearer token;
- API keys;
- OAuth refresh/access tokens;
- raw private transcript;
- hidden reasoning.

## Agent Baseline mapping

### Discover
Inventory runtime, version, Kit/image, capability requests, credentials, policy, workload identity, resource identity.

### Constrain
Prove actual filesystem/network/process/credential boundaries.

### Authorize
Prove OCC admitted the exact revision and that Docker receives only admitted intent.

### Observe
Correlate revision → sandbox → process/tool action → policy decision → external side effect.

### Validate
Run deterministic allow/deny/refusal/parity fixtures before promotion.

### Respond
Prove stop, signal, delete, credential revoke, network deny, and recovery behavior.

## Upstream feedback loop

The upstream goal is not to ask Docker to implement OpenShell.

The goal is to find where a real enterprise control plane cannot safely or ergonomically express a requirement using Docker's public contracts.

Every candidate upstream report must contain:

1. Docker product/SDK/CLI version;
2. local/cloud profile;
3. minimal reproduction;
4. expected behavior;
5. observed behavior;
6. why it matters to a real control-plane workload;
7. whether OCC can safely adapt around it;
8. proposed API/spec shape if useful;
9. a conformance test that would prove closure.

Feedback categories:

- docs clarification;
- bug;
- API/SDK gap;
- Kit v3 capability gap;
- Kit runtime/TCK gap;
- local/cloud parity gap;
- security primitive gap.

Do not open upstream issues before reproduction.

## Implementation waves

### Wave 0 — contract and ledger

- parity matrix;
- architecture boundary;
- cloud/local distinction;
- conformance test taxonomy.

### Wave 1 — cloud lifecycle vertical slice

- SDK authentication;
- launch `shell` Kit or pinned image;
- stable resource mapping;
- wait/observe;
- process exec;
- cleanup;
- deterministic test doubles.

Exit: one OCC-owned candidate revision can acquire and clean up a Docker Cloud sandbox without a Harness.

### Wave 2 — Harness

- stage/start OpenClaw Harness;
- endpoint/readiness;
- logs;
- replacement;
- loss detection.

Exit: one real Harness can become OCC-ready through Docker Cloud.

### Wave 3 — policy

- network policy;
- mutation;
- logs;
- failure/refusal;
- local/cloud profile split.

### Wave 4 — credentials

- local proxy-managed flow;
- cloud secret flow;
- OAuth/rotation/revoke;
- leak tests;
- OpenShell parity.

### Wave 5 — browser/computer/terminal

- separate fixtures;
- cancellation;
- snapshot/restart;
- credential and network boundaries.

### Wave 6 — upstream

- package evidence;
- open only reproduced Docker feedback;
- contribute docs/TCK/spec/SDK/runtime fixes where the upstream path accepts them.

## Exit criteria

Docker SandboxDriver may be promoted from experimental only when:

- a real Harness runs under OCC;
- cloud lifecycle and cleanup are reliable;
- required OCC facets are evidence-backed;
- local/cloud capabilities are separately reported;
- credential isolation passes;
- stale/revoked authority fails closed;
- restart/retry behavior cannot create untracked consequential duplicates;
- unsupported OpenShell parity remains explicit;
- Docker SDK/API changes are isolated behind the driver;
- at least one upstream feedback loop has been completed with evidence.
