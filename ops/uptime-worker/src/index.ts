import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext';

interface Env {
  SEB: { send(message: EmailMessage): Promise<void> };
  TARGETS: string;
  ALERT_FROM: string;
  ALERT_TO: string;
}

// Cron-only worker (no public route). Every interval: ping each target; on any non-2xx or
// error, email an alert via the Email Routing send binding. Re-alerts each interval until
// recovered (no state store) — fine for a solo backend.
export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const targets = env.TARGETS.split(',').map((s) => s.trim()).filter(Boolean);
    const failures: string[] = [];
    for (const url of targets) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) failures.push(`${url} → HTTP ${res.status}`);
      } catch (e) {
        failures.push(`${url} → ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (failures.length === 0) return;

    const msg = createMimeMessage();
    msg.setSender({ name: 'Kairo Uptime', addr: env.ALERT_FROM });
    msg.setRecipient(env.ALERT_TO);
    msg.setSubject('[Kairo] backend health check FAILED');
    msg.addMessage({
      contentType: 'text/plain',
      data: `The kairo-uptime worker saw failing health checks:\n\n${failures.join('\n')}\n\nCheck the box + container.`,
    });
    await env.SEB.send(new EmailMessage(env.ALERT_FROM, env.ALERT_TO, msg.asRaw()));
  },
};
