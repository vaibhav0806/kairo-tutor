import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext';
import { nextAlertState, type AlertState } from './alert-policy';

interface Env {
  SEB: { send(message: EmailMessage): Promise<void> };
  ALERT_STATE: {
    get(key: string, type: 'json'): Promise<AlertState | null>;
    put(key: string, value: string): Promise<void>;
  };
  TARGETS: string;
  ALERT_FROM: string;
  ALERT_TO: string;
}

// Cron-only worker (no public route). Alert after two failed checks, then at most
// every 12 hours until recovery. KV preserves state across worker invocations.
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
    const previous = await env.ALERT_STATE.get('backend-health', 'json');
    const { state, action } = nextAlertState(previous, failures.length > 0, Date.now());
    if (state) await env.ALERT_STATE.put('backend-health', JSON.stringify(state));
    if (!action) return;

    const msg = createMimeMessage();
    msg.setSender({ name: 'Kairo Uptime', addr: env.ALERT_FROM });
    msg.setRecipient(env.ALERT_TO);
    msg.setSubject(action === 'failure'
      ? '[Kairo] backend health check FAILED'
      : '[Kairo] backend health recovered');
    msg.addMessage({
      contentType: 'text/plain',
      data: action === 'failure'
        ? `The kairo-uptime worker saw failing health checks:\n\n${failures.join('\n')}\n\nCheck the box + container. Further reminders are limited to once every 12 hours.`
        : 'The kairo-uptime worker sees healthy backend checks again.',
    });
    await env.SEB.send(new EmailMessage(env.ALERT_FROM, env.ALERT_TO, msg.asRaw()));
  },
};
