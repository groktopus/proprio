import { useEffect, useRef, useState } from "react";
import type { CloudInstanceHealthStatus } from "@/api/health";
import { cloudStackEntryUrl } from "@/lib/cloudLinks";
import { beginCloudSignIn, clearCloudSignInAttempt } from "@/lib/cloud-sign-in";
import { ProprioLoading } from "@/components/AnimatedProprioIcon";
import { Button } from "@/components/ui/button";

export function CloudSignIn({ cloud, returnTo }: { cloud: CloudInstanceHealthStatus; returnTo: string }) {
  const entryUrl = cloudStackEntryUrl(cloud.cloudBaseUrl, cloud.stackSlug, returnTo);
  const started = useRef(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!entryUrl || started.current) return;
    started.current = true;
    setBlocked(!beginCloudSignIn(entryUrl));
  }, [entryUrl]);

  if (entryUrl && !blocked) return <ProprioLoading />;

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Sign in to Proprio Cloud</h1>
      <p role="alert" className="text-sm text-muted-foreground">
        {entryUrl
          ? "We couldn't restore your session. Continue to Proprio Cloud to try again."
          : "Cloud sign-in is unavailable for this workspace. Please contact your administrator."}
      </p>
      {entryUrl && (
        <Button asChild>
          <a href={entryUrl} onClick={clearCloudSignInAttempt}>Continue to Proprio Cloud</a>
        </Button>
      )}
    </div>
  );
}
