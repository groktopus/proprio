import { QueryClient } from "@tanstack/react-query";
import type { BoardBootstrap } from "@groktopus/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardAccessQueryOptions, refreshBoardAccessAfterMembershipChange } from "./board-access-query";
import { queryKeys } from "../lib/queryKeys";

const readAccess = vi.hoisted(() => vi.fn());
vi.mock("./access", () => ({ accessApi: { getCurrentBoardAccess: readAccess } }));
afterEach(() => readAccess.mockReset());

const bootstrap = (userId: string): BoardBootstrap => ({
  userId, companies: [], boardAccess: { userId, isInstanceAdmin: false, companyIds: [`company-${userId}`] },
});

describe("account-scoped board bootstrap", () => {
  it("opens from the session snapshot and uses the ordinary reader after invalidation", async () => {
    const client = new QueryClient();
    const options = boardAccessQueryOptions("one", vi.fn());
    client.setQueryData(options.queryKey, bootstrap("one").boardAccess);
    expect(await client.fetchQuery({ ...options, staleTime: 30_000 })).toEqual(bootstrap("one").boardAccess);
    expect(readAccess).not.toHaveBeenCalled();
    await client.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
    readAccess.mockResolvedValue({ userId: "one", isInstanceAdmin: false, companyIds: [] });
    expect(await client.fetchQuery(options)).toEqual({ userId: "one", isInstanceAdmin: false, companyIds: [] });
    expect(readAccess).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it("cannot reuse another account's bootstrap or cache entry", async () => {
    const client = new QueryClient();
    const first = boardAccessQueryOptions("one", vi.fn());
    client.setQueryData(first.queryKey, bootstrap("one").boardAccess);
    const second = boardAccessQueryOptions("two", vi.fn());
    expect(client.getQueryData(second.queryKey)).toBeUndefined();
    expect(second.queryKey).not.toEqual(first.queryKey);
    readAccess.mockResolvedValue({ userId: "two", isInstanceAdmin: false, companyIds: [] });
    expect(await client.fetchQuery(second)).toMatchObject({ userId: "two", companyIds: [] });
    client.clear();
  });

  it("retires the old bootstrap and access immediately, even if reauthorization fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seed = bootstrap("one");
    const options = boardAccessQueryOptions("one", vi.fn());
    client.setQueryData(queryKeys.auth.session, { user: { id: "one" }, boardBootstrap: seed });
    client.setQueryData(options.queryKey, seed.boardAccess);
    refreshBoardAccessAfterMembershipChange(client);
    expect(client.getQueryData(queryKeys.auth.session)).toMatchObject({ user: { id: "one" }, boardBootstrap: undefined });
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    readAccess.mockRejectedValue(new Error("Temporary access failure"));
    await expect(client.fetchQuery(options)).rejects.toThrow("Temporary access failure");
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    client.clear();
  });

  it("discards an older pending session read and clears the affected account's organizations", async () => {
    const client = new QueryClient();
    const sessionKey = queryKeys.auth.session;
    const restored = { user: { id: "one" } };
    client.setQueryData(sessionKey, restored);
    client.setQueryData(queryKeys.companies.list("one"), { companies: [{ id: "revoked" }] });
    client.setQueryData(queryKeys.companies.list("two"), { companies: [{ id: "unrelated" }] });
    let release!: (value: unknown) => void;
    const pending = client.fetchQuery({ queryKey: sessionKey, queryFn: () => new Promise(resolve => { release = resolve; }) })
      .catch(() => null);
    refreshBoardAccessAfterMembershipChange(client);
    release({ ...restored, boardBootstrap: bootstrap("one") });
    await pending;
    expect(client.getQueryData(sessionKey)).toEqual(restored);
    expect(client.getQueryData(queryKeys.companies.list("one"))).toBeUndefined();
    expect(client.getQueryData(queryKeys.companies.list("two"))).toMatchObject({ companies: [{ id: "unrelated" }] });
    client.clear();
  });

  it("refreshes identity instead of caching a response from a changed account", async () => {
    const changed = vi.fn();
    readAccess.mockResolvedValue({ userId: "two", isInstanceAdmin: true, companyIds: ["foreign"] });
    await expect(boardAccessQueryOptions("one", changed).queryFn()).rejects.toMatchObject({ status: 401 });
    expect(changed).toHaveBeenCalledOnce();
  });
});
