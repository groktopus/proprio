import type { SVGProps } from "react";

interface ProprioLockupProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  decorative?: boolean;
  title?: string;
}

export function ProprioLockup({
  decorative = false,
  title = "Proprio",
  className,
  ...rest
}: ProprioLockupProps) {
  return (
    <svg
      {...rest}
      className={className}
      viewBox="0 0 121 28"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      <rect width="24" height="24" y="2" rx="5" fill="var(--proprio-mark-background)" />
      <path transform="translate(0 2)" d="M7 19V5h6a4.5 4.5 0 0 1 0 9H7m10 4h.01" fill="none" stroke="var(--proprio-mark-foreground)" strokeLinecap="round" strokeWidth="2.25" />
      <text x="32" y="20" fill="currentColor" fontFamily="system-ui,sans-serif" fontSize="18" fontWeight="700">Proprio</text>
    </svg>
  );
}

export function ProprioMark({
  decorative = false,
  title = "Proprio",
  className,
  ...rest
}: ProprioLockupProps) {
  return (
    <svg
      {...rest}
      className={className}
      viewBox="0 0 24 24"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      <rect width="24" height="24" rx="5" fill="var(--proprio-mark-background)" />
      <path d="M7 19V5h6a4.5 4.5 0 0 1 0 9H7m10 4h.01" fill="none" stroke="var(--proprio-mark-foreground)" strokeLinecap="round" strokeWidth="2.25" />
    </svg>
  );
}
