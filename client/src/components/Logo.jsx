export default function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="var(--accent)" />
      <path d="M14 30c0-10 8-18 18-18s18 8 18 18v18c-3-3-6-3-9 0-3-3-6-3-9 0-3-3-6-3-9 0-3-3-6-3-9 0z" fill="var(--accent-ink)" />
      <circle cx="25" cy="30" r="3.5" fill="var(--accent)" />
      <circle cx="39" cy="30" r="3.5" fill="var(--accent)" />
    </svg>
  );
}
