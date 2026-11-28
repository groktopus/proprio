// Generated from acpx-profiles.json and cursor-distributions.json. Do not edit.
export const QUALIFIED_ACPX_VERSION = "0.22.0" as const;
export const ACPX_DRIVER_KIND = "acpx_runtime" as const;
export const ACPX_DRIVER_PROTOCOL_VERSION = 1 as const;

export const QUALIFIED_ACPX_PROFILE_DATA = {
  "antigravity": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "antigravity",
    "agentProfileVersion": 1,
    "agentServerPackage": "native:antigravity-acp",
    "agentServerVersion": "1.4.3",
    "agentRuntimePackage": "native:antigravity-localharness",
    "agentRuntimeVersion": "1.4.3",
    "commandDigest": "sha256:0e923c18bc58ce3f519a7683c357d58ff0f906fe5ea5565e64ec52a0d3256672",
    "qualificationStatus": "pending",
    "permissionPolicy": "interactive"
  },
  "grok": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "grok",
    "agentProfileVersion": 20,
    "agentServerPackage": "builtin:grok-acp",
    "agentServerVersion": "1",
    "agentRuntimePackage": "native:grok",
    "agentRuntimeVersion": "1.0.13",
    "commandDigest": "sha256:ebc6c903dd8333c1716fc1580290a990670ec845af0c63b81c9b5f76a1326c81",
    "permissionPolicy": "interactive"
  },
  "pi": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "pi",
    "agentProfileVersion": 37,
    "agentServerPackage": "pi-acp",
    "agentServerVersion": "0.0.33",
    "agentRuntimePackage": "@earendil-works/pi-coding-agent",
    "agentRuntimeVersion": "1.0.0",
    "commandDigest": "sha256:e799aaf706fc971c4a7e3d6ab27185e74d17cfc95ab5f243a3566294d7c539a6",
    "permissionPolicy": "interactive"
  },
  "cursor": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "cursor",
    "agentProfileVersion": 17,
    "agentServerPackage": "cursor-agent",
    "agentServerVersion": "2026.09.26-dd393fe",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:7787d5b975e44cd8a36e41888018c3b0e25140160a4d1a16e4ccb59315f63b40",
    "permissionPolicy": "interactive"
  },
  "copilot": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "copilot",
    "agentProfileVersion": 92,
    "agentServerPackage": "@github/copilot",
    "agentServerVersion": "1.0.88",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:ecea9feee5d939a2a60d562059bd53f53f53b3783350136b1ee704d7d5cc746a",
    "permissionPolicy": "interactive"
  },
  "claude": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "claude",
    "agentProfileVersion": 1,
    "agentServerPackage": "@agentclientprotocol/claude-agent-acp",
    "agentServerVersion": "0.73.0",
    "agentRuntimePackage": "@anthropic-ai/claude-agent-sdk",
    "agentRuntimeVersion": "0.3.328",
    "commandDigest": "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
    "permissionPolicy": "interactive"
  },
  "codex": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "codex",
    "agentProfileVersion": 1,
    "agentServerPackage": "@agentclientprotocol/codex-acp",
    "agentServerVersion": "1.6.2",
    "agentRuntimePackage": "@openai/codex",
    "agentRuntimeVersion": "0.170.0",
    "commandDigest": "sha256:443491f4e814501a5dc47347e4510e84faeec9c9382e2d4e53bfe69386d5aabc",
    "permissionPolicy": "interactive"
  },
  "kimi": {
    "driverKind": "acpx_runtime",
    "protocolVersion": 1,
    "acpxVersion": "0.22.0",
    "agent": "kimi",
    "agentProfileVersion": 17,
    "agentServerPackage": "@moonshot-ai/kimi-code",
    "agentServerVersion": "2.3.3",
    "agentRuntimePackage": null,
    "agentRuntimeVersion": null,
    "commandDigest": "sha256:4b62c46e21b691860895ccc38e429503f320be7d273757a4169884e65fab1a11",
    "permissionPolicy": "interactive"
  }
} as const;

export const CURSOR_DISTRIBUTION_PINS = {
  "darwin-arm64": {
    "closureSha256": "257424bd48e35412091c6adfc61e4648e836757ec1d240d890bba81a24918c30",
    "executable": "node",
    "entrypoint": "index.js"
  },
  "darwin-x64": {
    "closureSha256": "6f28c799c5afdc64fbdff8a2157f565f17ae7615efe014ac389d63bf70cf2be2",
    "executable": "node",
    "entrypoint": "index.js"
  },
  "linux-x64": {
    "closureSha256": "eadb8bb8ffb0450455b15b88c9b230307a9e149958a0c452d16dd157b4633d74",
    "executable": "node",
    "entrypoint": "index.js"
  }
} as const;

export const ANTIGRAVITY_DISTRIBUTION_PINS = {
  "darwin-arm64": {
    "closureSha256": "044792d793e203bc8b4524a418f1816c4d34db67bb41fa4bae5947a050c49b4a",
    "executable": "agy_acp_server.par",
    "args": []
  }
} as const;
