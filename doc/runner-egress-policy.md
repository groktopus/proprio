# Runner ACPX child egress policy

`PROPRIO_RUNNER_EGRESS_ALLOWLIST` is a deployment-owned policy for outbound
connections opened by verified ACPX provider child processes. It is a JSON
array of exact DNS names, optionally with a port:

```sh
PROPRIO_RUNNER_EGRESS_ALLOWLIST='["api.example.test", "gateway.example.test:8443"]'
```

Core does not supply provider or Cloud destinations. The deployment selects
the hosts its native providers may contact.

- Unset leaves the existing Runner network behavior unchanged.
- `[]` denies all provider network access.
- Rules match exact hostnames. Wildcards and IP literals are rejected. A rule
  without a port allows HTTPS CONNECT on any port; a rule with a port matches
  only that port.
- When configured, Runner requires Linux and `bwrap`. It starts the verified
  guardian in a network namespace with no external interface, and overlays
  `/run`, `/tmp`, and `/var/tmp` to hide host service sockets and the broker's
  host-side socket path. The nested provider sandbox overlays those paths again,
  so replacing a broker-path entry cannot redirect the guardian's connection.
  A provider-child seccomp
  filter allows only IPv4 and IPv6 sockets, blocking AF_UNIX, AF_VSOCK, other
  local socket families, socketpair, and io_uring socket creation regardless
  of socket path. The guardian retains the broker access. The guardian's
  loopback proxy bridge is the only IP network path available to its provider
  child; the bridge reaches a sidecar-owned Unix socket broker.
- The broker accepts HTTPS CONNECT only. For each connection it checks the
  exact hostname and port, resolves DNS once, rejects the request if any answer
  is loopback, private, link-local, reserved, multicast, or otherwise
  non-global, and connects to the selected numeric address. This pins the
  checked DNS answer to the socket and blocks DNS rebinding and metadata
  address access. A redirect to another hostname requires a new CONNECT and is
  checked against the same policy.
- The deployment policy is copied from runnerd's environment to the verified
  ACPX sidecar through the sidecar's explicit environment allowlist. The policy
  itself and broker socket path are removed from the provider child's
  environment; proxy variables point only to the in-namespace loopback bridge.

The policy is host-level deployment configuration, not agent or task input.
Changing it requires restarting or redeploying Runner processes so their
sidecars inherit the new value. Hosts that cannot create the network namespace
or start the broker fail provider admission rather than launch unconfined. The
supported Linux host must provide `/usr/bin/bwrap` and `/usr/sbin/ip` from
`iproute2`; failure to create the nested namespaces also fails provider launch.
