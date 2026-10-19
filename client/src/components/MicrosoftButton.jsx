// Full-page navigation (not fetch): the server redirects to Microsoft and back.
export default function MicrosoftButton({ label = 'Continue with Microsoft' }) {
  return (
    <a className="btn btn-ms btn-block" href="/api/auth/microsoft">
      <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
        <rect x="1" y="1" width="9" height="9" fill="#f25022" />
        <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
        <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
        <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
      </svg>
      {label}
    </a>
  );
}
