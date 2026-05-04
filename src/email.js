// SendGrid email digest — sends top-scored jobs via email
// Requires SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, and ALERT_EMAIL in .env
// If those keys are absent the digest step is silently skipped.

export async function sendDigest(jobs) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from   = process.env.SENDGRID_FROM_EMAIL;
  const to     = process.env.ALERT_EMAIL;

  if (!apiKey || !from || !to) {
    console.log('  SendGrid keys not configured — skipping email digest.');
    return;
  }

  const rows = jobs.map(j => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">
        <strong>${j.title}</strong><br>
        <span style="color:#555">${j.company}</span> · ${j.location}
        ${j.salary ? ` · <span style="color:#2a7d2a">${j.salary}</span>` : ''}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">
        <span style="font-size:20px;font-weight:bold;color:${j.score >= 9 ? '#1a8c3a' : '#0071e3'}">${j.score}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:12px;color:#666">
        ${j.score_reason || ''}
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">
        <a href="${j.external_url || j.url || '#'}" style="color:#0071e3">Apply →</a>
      </td>
    </tr>`).join('');

  const html = `
    <html><body style="font-family:-apple-system,sans-serif;color:#1d1d1f;max-width:800px;margin:0 auto">
      <h2 style="border-bottom:2px solid #eee;padding-bottom:12px">
        Job Discovery — ${jobs.length} top role${jobs.length === 1 ? '' : 's'}
      </h2>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <thead>
          <tr style="background:#f9f9f9">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;text-transform:uppercase">Role</th>
            <th style="padding:8px 12px;text-align:center;font-size:12px;color:#666;text-transform:uppercase">Score</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;text-transform:uppercase">Why</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;text-transform:uppercase">Link</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#999;margin-top:24px">
        Sent by Job Discovery Agent · <a href="http://localhost:3033">View dashboard</a>
      </p>
    </body></html>`;

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: from },
    subject: `Job Discovery — ${jobs.length} top role${jobs.length === 1 ? '' : 's'} today`,
    content: [{ type: 'text/html', value: html }],
  };

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method:  'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`  SendGrid error ${res.status}:`, body);
  } else {
    console.log(`  Email digest sent to ${to} (${jobs.length} jobs)`);
  }
}
