import { useAuth } from '../auth.jsx';

// DRAFT legal text. It describes what the code actually does, but it has not been
// reviewed by a lawyer or the college. Replace the contact address before launch.
const CONTACT = 'unveil-support@example.edu';

function Draft() {
  return <p className="muted draft-note">Draft for review. This text has not yet been approved by the college.</p>;
}

export function Terms() {
  const { meta } = useAuth();
  const mins = Math.round((meta?.safePeriodSeconds || 600) / 60);
  return (
    <div className="page narrow legal">
      <h1>Terms of Use</h1>
      <Draft />
      <h2>Who can use Unveil</h2>
      <p>Unveil is for current students of participating colleges. You must sign up with your own college email and keep your password to yourself.</p>
      <h2>Anonymous chats and reveals</h2>
      <ul>
        <li>Chats start anonymously. Your match sees only your interests and personality tags.</li>
        <li>Either person can choose to reveal after about {mins} minutes of chatting. Your name, college and bio are shown only if you both choose to reveal.</li>
        <li>Once revealed, your match has seen your details. Ending the chat or deleting your account cannot take that back.</li>
        <li>Do not share phone numbers, social handles or other contact details before a reveal. Unveil hides many of them automatically.</li>
      </ul>
      <h2>Community rules</h2>
      <ul>
        <li>No harassment, threats, hate, sexual content, spam or attempts to identify someone who has not revealed.</li>
        <li>Messages are checked automatically by a machine learning model. Harmful messages may be blocked, and repeated or serious problems lead to warnings, suspension or a ban.</li>
        <li>You can report or block anyone. Reports are reviewed by moderators, who can read the reported conversation.</li>
        <li>The automatic checks can make mistakes. If you think an action against your account was wrong, contact {CONTACT}.</li>
      </ul>
      <h2>Ending your account</h2>
      <p>You can delete your account at any time from your profile. We may suspend or ban accounts that break these rules.</p>
      <h2>Contact</h2>
      <p>{CONTACT}</p>
    </div>
  );
}

export function Privacy() {
  const { meta } = useAuth();
  const days = meta?.messageRetentionDays || 30;
  return (
    <div className="page narrow legal">
      <h1>Privacy Policy</h1>
      <Draft />
      <h2>What we store</h2>
      <ul>
        <li>Your college email, name, a hashed password, bio, interests and personality tags.</li>
        <li>If you sign in with Microsoft: your name, college email and Microsoft account ID from your college's directory. We do not receive your Microsoft password.</li>
        <li>Your chats, reports, blocks and friends, plus a private trust score based on reports and moderation.</li>
        <li>Security logs (sign-ins, moderation actions) with IP addresses.</li>
      </ul>
      <h2>Who can see it</h2>
      <ul>
        <li>Before a reveal, other students see only your interests and personality tags.</li>
        <li>After a mutual reveal, that match and your friends see your name, college and bio.</li>
        <li>Moderators can see reported conversations and account details when reviewing reports.</li>
        <li>Messages are scored by a model that runs on our own server. They are not sent to any outside service.</li>
      </ul>
      <h2>How long we keep it</h2>
      <ul>
        <li>Chat messages are deleted after {days} days, unless they are part of an open report.</li>
        <li>Security logs are kept for one year.</li>
        <li>If you delete your account, your profile, messages, friends and blocks are removed. Records of reports about you are kept in anonymous form so moderation still works.</li>
      </ul>
      <h2>Your choices</h2>
      <p>You can edit your profile or delete your account from the Profile page. For anything else, contact {CONTACT}.</p>
    </div>
  );
}
