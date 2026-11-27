import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { githubNativeSetupSchema } from "@groktopus/shared";
import { agentsApi } from "@/api/agents";
import { githubNativeGitApi } from "@/api/github-native-git";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ANALYTICS_MASK_CLASS, ANALYTICS_NO_CAPTURE_CLASS } from "@/lib/analytics/privacy";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

export function GitHubNativeGitSetup({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["github-native-git", companyId];
  const agentKey = queryKeys.agents.list(companyId);
  const grants = useQuery({ queryKey, queryFn: () => githubNativeGitApi.list(companyId) });
  const agents = useQuery({ queryKey: agentKey, queryFn: () => agentsApi.list(companyId) });
  const eligible = useQuery({ queryKey: [...agentKey, "github-native-git"], queryFn: () => githubNativeGitApi.eligibleAgents(companyId) });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [privateKey, setPrivateKey] = useState("");
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false);
  const agentNames = useMemo(() => new Map(agents.data?.map(agent => [agent.id, agent.name])), [agents.data]);
  const runners = useMemo(() => {
    const ids = new Set(eligible.data);
    return agents.data?.filter(agent => ids.has(agent.id)) ?? [];
  }, [agents.data, eligible.data]);

  async function change(write: () => Promise<unknown>, success: string) {
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await write();
      setMessage(success);
      await queryClient.invalidateQueries({ queryKey });
    } catch (failure) {
      setError(describeError(failure).body);
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const input = githubNativeSetupSchema.safeParse({
      agentId: fields.get("agent"), repository: fields.get("repository"), appId: fields.get("appId"),
      privateKey, push: fields.has("push"), pullRequests: fields.has("pullRequests"),
    });
    if (!input.success) {
      setError("Enter the agent, repository in owner/repo format, numeric App ID, and private key.");
      return;
    }
    setPrivateKey("");
    setPrivateKeyVisible(false);
    void change(() => githubNativeGitApi.configure(companyId, input.data), "GitHub verified the repository and the selected permissions. The grant is saved.");
  }

  return <section className="mx-auto flex max-w-xl flex-col gap-4">
    <header className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">GitHub App for terminal Git</h1>
      <p className="text-sm text-muted-foreground">
        Install your GitHub App on the repository. Give it Contents access for checkout and branch pushes,
        and Pull requests write access if the agent needs to open PRs. Set the repository as the task workspace source.
      </p>
    </header>
    {grants.isError || agents.isError || eligible.isError
      ? <p role="alert">{describeError(grants.error ?? agents.error ?? eligible.error).body}</p> : null}
    {grants.isPending || agents.isPending || eligible.isPending ? <output>Loading grants and agents…</output> : null}
    {grants.data && agents.data && eligible.data && <form className="flex flex-col gap-4" onSubmit={submit}>
      <label className="flex flex-col gap-2 text-sm font-medium">
        Agent
        <select name="agent" required className={`rounded-md border border-input bg-background p-2 ${ANALYTICS_MASK_CLASS}`}>
          <option value="">Select a Proprio Runner agent</option>
          {runners.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </label>
      {runners.length === 0 && <p className="text-sm text-muted-foreground">No active Proprio Runner agents support terminal Git.</p>}
      <div className="flex flex-col gap-2">
        <Label htmlFor="github-native-repository">Repository</Label>
        <Input id="github-native-repository" name="repository" placeholder="owner/repo" required className={ANALYTICS_MASK_CLASS} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="github-native-app-id">GitHub App ID</Label>
        <Input id="github-native-app-id" inputMode="numeric" name="appId" required className={ANALYTICS_MASK_CLASS} />
      </div>
      <div className={`flex flex-col gap-2 ${ANALYTICS_NO_CAPTURE_CLASS}`}>
        <Label htmlFor="github-native-key">App private key (PEM)</Label>
        <div className="relative">
          {privateKeyVisible ? (
            <Textarea id="github-native-key" required autoComplete="off" spellCheck={false}
              className="min-h-24 pr-11 font-mono text-xs" value={privateKey}
              onChange={event => setPrivateKey(event.target.value)} />
          ) : (
            <Input id="github-native-key" type="password" required autoComplete="off" spellCheck={false}
              className="pr-11 font-mono text-xs" value={privateKey}
              onChange={event => setPrivateKey(event.target.value)}
              onPaste={event => {
                event.preventDefault();
                setPrivateKey(event.clipboardData.getData("text"));
              }} />
          )}
          <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1"
            aria-label={privateKeyVisible ? "Hide private key" : "Show private key"}
            onClick={() => setPrivateKeyVisible(visible => !visible)}>
            {privateKeyVisible ? <EyeOff /> : <Eye />}
          </Button>
        </div>
      </div>
      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="font-medium">Permissions</legend>
        <p className="text-muted-foreground">Checkout and read access are included.</p>
        <label><input type="checkbox" name="push" /> Push branches</label>
        <label><input type="checkbox" name="pullRequests" /> Open pull requests</label>
      </fieldset>
      <div className="flex items-center justify-between gap-2">
        <Button asChild variant="ghost"><Link to="/apps">Back to Connectors</Link></Button>
        <Button type="submit" disabled={pending || !runners.length}>Verify and save grant</Button>
      </div>
    </form>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <output className="text-sm">{message}</output>}
    {!!grants.data?.length && <section className="flex flex-col gap-2">
      <h2 className="font-medium">Saved grants</h2>
      <ul className="flex flex-col gap-2">
        {grants.data.map(grant => <li key={grant.id} className="flex items-center justify-between gap-2">
          <div className={ANALYTICS_MASK_CLASS}>
            <p>{grant.repository} · {agentNames.get(grant.agentId) ?? "Agent"}</p>
            <p className="text-sm text-muted-foreground">{grant.appSlug} · {grant.revokedAt ? "Revoked" :
              ["Read", grant.push && "Push", grant.pullRequests && "Pull requests"].filter(Boolean).join(", ")}</p>
          </div>
          {!grant.revokedAt && <Button variant="outline" disabled={pending}
            onClick={() => void change(() => githubNativeGitApi.revoke(companyId, grant.id), "Grant revoked.")}>Revoke</Button>}
        </li>)}
      </ul>
    </section>}
  </section>;
}
