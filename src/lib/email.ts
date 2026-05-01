/**
 * Transactional email via Resend.
 * Requires RESEND_API_KEY env var.
 * Falls back silently if key is not set (dev / test environments).
 */

import { Resend } from 'resend';

const FROM = 'AWX Shredder <onboarding@awxglobal.com>';

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
