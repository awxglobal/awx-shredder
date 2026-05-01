/**
 * Transactional email via Resend.
 * Requires RESEND_API_KEY env var.
 * Falls back silently if key is not set (dev / test environments).
 */

import { Resend } from 'resend';

const FROM = 'AWX Shredder <onboarding@awxglobal.com>';

// ── Budget blocked email ──────────────────────────────────────────────────────

export async function sendBudgetAlertEmail({
  to,
  agentId,
  savedAmount,
  dailyBudget,
  attemptedCost,
}: {
  to: string;
  agentId: string;
  savedAmount: number;
  dailyBudget: number;
  attemptedCost: number;
}): Promise<void> {
  const resend = client();
  if (!resend) {
    console.log(`[email] RESEND_API_KEY not set — skipping budget alert to ${to}`);
    return;
  }

  const saved = savedAmount.toFixed(2);
  const budget = dailyBudget.toFixed(2);
  const attempted = attemptedCost.toFixed(4);
  const time = new Date().toUTCString();

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#060d18;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:40px 20px">
  <div style="max-width:560px;margin:0 auto">

    <div style="margin-bottom:28px">
      <span style="background:#052e16;border:1px solid #10b981;color:#34d399;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600">AWX SHREDDER</span>
    </div>

    <!-- Big save number -->
    <div style="background:#0a1f14;border:1px solid #10b981;border-radius:16px;padding:32px;text-align:center;margin-bottom:28px">
      <p style="color:#94a3b8;font-size:14px;margin:0 0 8px 0;text-transform:uppercase;letter-spacing:1px">We just saved you</p>
      <p style="color:#34d399;font-size:64px;font-weight:800;margin:0;line-height:1">\$${saved}</p>
      <p style="color:#64748b;font-size:13px;margin:12px 0 0 0">${time}</p>
    </div>

    <h2 style="color:#f1f5f9;font-size:20px;font-weight:600;margin:0 0 12px 0">
      Agent <code style="background:#0f172a;padding:2px 8px;border-radius:6px;font-size:16px;color:#34d399">${agentId}</code> hit its daily limit
    </h2>
    <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 24px 0">
      The agent tried to make a call costing <strong style="color:#f1f5f9">\$${attempted}</strong> but its daily budget of
      <strong style="color:#f1f5f9">\$${budget}</strong> was already reached.
      AWX blocked the call before it reached the API — so you paid nothing.
    </p>

    <!-- What happened -->
    <div style="background:#0a1628;border:1px solid #1e293b;border-radius:12px;padding:20px;margin-bottom:28px">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px">
        <span style="color:#64748b;font-size:13px">Agent</span>
        <span style="color:#f1f5f9;font-size:13px;font-weight:600">${agentId}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px">
        <span style="color:#64748b;font-size:13px">Daily budget</span>
        <span style="color:#f1f5f9;font-size:13px;font-weight:600">\$${budget}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:12px">
        <span style="color:#64748b;font-size:13px">Attempted call cost</span>
        <span style="color:#ef4444;font-size:13px;font-weight:600">\$${attempted}</span>
      </div>
      <div style="height:1px;background:#1e293b;margin:12px 0"></div>
      <div style="display:flex;justify-content:space-between">
        <span style="color:#64748b;font-size:13px">Amount saved</span>
        <span style="color:#34d399;font-size:15px;font-weight:800">\$${saved}</span>
      </div>
    </div>

    <p style="color:#94a3b8;font-size:14px;margin:0 0 24px 0">
      The budget resets at <strong style="color:#f1f5f9">midnight UTC</strong>. To increase this agent's budget, go to your dashboard.
    </p>

    <a href="https://awx-shredder.fly.dev/app" style="background:#10b981;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;margin-bottom:32px">
      View Dashboard →
    </a>

    <hr style="border:none;border-top:1px solid #1e293b;margin:32px 0">
    <p style="color:#475569;font-size:13px;margin:0">
      AWX Shredder · <a href="https://awx-shredder.fly.dev" style="color:#475569">awx-shredder.fly.dev</a>
    </p>

  </div>
</body>
</html>`;

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: `We just saved you $${saved} 🛡️`,
      html,
    });
    console.log(`[email] Budget alert sent to ${to} (saved $${saved})`);
  } catch (err) {
    console.error(`[email] Failed to send budget alert to ${to}:`, err);
  }
}

function client(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

// ── Welcome email sent on first signup (email or GitHub OAuth) ────────────────

export async function sendWelcomeEmail({
  to,
  orgName,
  apiKey,
}: {
  to: string;
  orgName: string;
  apiKey?: string; // only present on first-time signup, not on returning login
}): Promise<void> {
  const resend = client();
  if (!resend) {
    console.log(`[email] RESEND_API_KEY not set — skipping welcome email to ${to}`);
    return;
  }

  const keySection = apiKey
    ? `
<div style="background:#0a1628;border:1px solid #1e293b;border-radius:8px;padding:20px;margin:24px 0;font-family:monospace">
  <p style="color:#94a3b8;font-size:12px;margin:0 0 8px 0">YOUR API KEY (shown once — save it now)</p>
  <p style="color:#34d399;font-size:16px;margin:0;word-break:break-all">${apiKey}</p>
</div>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#060d18;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:40px 20px">
  <div style="max-width:560px;margin:0 auto">

    <div style="margin-bottom:32px">
      <span style="background:#052e16;border:1px solid #10b981;color:#34d399;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600">AWX SHREDDER</span>
    </div>

    <h1 style="color:#f1f5f9;font-size:28px;font-weight:700;margin:0 0 8px 0">
      You're in, ${orgName}. 🛡️
    </h1>
    <p style="color:#94a3b8;font-size:16px;margin:0 0 32px 0">
      Your AI agents now have a budget enforcer. Here's how to activate it in 3 minutes.
    </p>

    ${keySection}

    <h2 style="color:#f1f5f9;font-size:18px;font-weight:600;margin:0 0 16px 0">3-minute setup</h2>

    <p style="color:#94a3b8;font-size:14px;margin:0 0 8px 0"><strong style="color:#f1f5f9">Step 1</strong> — Replace your OpenAI base URL</p>
    <div style="background:#0a1628;border:1px solid #1e293b;border-radius:8px;padding:16px;margin:0 0 16px 0;font-family:monospace;font-size:13px">
      <span style="color:#64748b"># Before</span><br>
      <span style="color:#94a3b8">OPENAI_BASE_URL=https://api.openai.com/v1</span><br><br>
      <span style="color:#64748b"># After</span><br>
      <span style="color:#34d399">OPENAI_BASE_URL=https://awx-shredder.fly.dev/proxy/v1</span>
    </div>

    <p style="color:#94a3b8;font-size:14px;margin:0 0 8px 0"><strong style="color:#f1f5f9">Step 2</strong> — Use your AWX key as the Bearer token</p>
    <div style="background:#0a1628;border:1px solid #1e293b;border-radius:8px;padding:16px;margin:0 0 16px 0;font-family:monospace;font-size:13px">
      <span style="color:#34d399">OPENAI_API_KEY=${apiKey ?? 'awx_live_your_key_here'}</span>
    </div>

    <p style="color:#94a3b8;font-size:14px;margin:0 0 32px 0"><strong style="color:#f1f5f9">Step 3</strong> — Go to your dashboard, create an agent, set a daily budget. Done.</p>

    <a href="https://awx-shredder.fly.dev/app" style="background:#10b981;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;display:inline-block;margin-bottom:32px">
      Open Dashboard →
    </a>

    <hr style="border:none;border-top:1px solid #1e293b;margin:32px 0">

    <p style="color:#475569;font-size:13px;margin:0">
      Questions? Reply to this email.<br>
      AWX Shredder · <a href="https://awx-shredder.fly.dev" style="color:#475569">awx-shredder.fly.dev</a>
    </p>

  </div>
</body>
</html>`;

  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: apiKey
        ? 'Your AWX Shredder API key + 3-minute setup'
        : 'Welcome back to AWX Shredder',
      html,
    });
    console.log(`[email] Welcome email sent to ${to}`);
  } catch (err) {
    // Non-fatal — log but don't crash the signup flow
    console.error(`[email] Failed to send welcome email to ${to}:`, err);
  }
}
