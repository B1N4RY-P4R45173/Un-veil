import { Link } from 'react-router-dom';

const steps = [
  ['Verify', 'Sign up with your college email. Only verified students get in.'],
  ['Talk', 'Get matched by interests, personality, or pure chance. Names and faces stay hidden.'],
  ['Unveil', 'After the safe period, reveal only if you both choose to. Then add each other as friends.'],
];

const features = [
  ['Campus Connect', 'Meet people at your own college you would never have crossed paths with.'],
  ['Cross Campus', 'Talk to students at other colleges and widen your circle.'],
  ['Consent-based reveal', 'Identities stay hidden until both of you opt in after the safe period.'],
  ['Moderated & safe', 'Abuse is filtered in real time, contact details stay masked, and you can report or block anyone.'],
];

export default function Landing() {
  return (
    <div className="landing">
      <section className="hero">
        <div className="veil" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
        <p className="eyebrow">For verified college students</p>
        <h1>Friendships that start with who you are, not how you look.</h1>
        <p className="lede">
          Unveil pairs you with another student for an anonymous one-to-one chat. Talk about anything. If it clicks,
          you can both choose to reveal who you are.
        </p>
        <div className="hero-actions">
          <Link className="btn btn-primary btn-lg" to="/register">Create your account</Link>
          <Link className="btn btn-ghost btn-lg" to="/login">I already have one</Link>
        </div>
      </section>

      <section className="steps">
        {steps.map(([title, text], i) => (
          <div className="step" key={title}>
            <span className="step-n">{i + 1}</span>
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </section>

      <section className="features">
        {features.map(([title, text]) => (
          <div className="card feature" key={title}>
            <h3>{title}</h3>
            <p className="muted">{text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
