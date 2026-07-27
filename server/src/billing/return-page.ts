type CheckoutReturnStatus = 'succeeded' | 'failed' | 'cancelled' | 'processing' | 'unknown';

function checkoutReturnStatus(value: unknown): CheckoutReturnStatus {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'success' || normalized === 'succeeded') return 'succeeded';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'processing' || normalized === 'pending') return 'processing';
  return 'unknown';
}

export function renderBillingReturnPage(rawStatus: unknown): string {
  const status = checkoutReturnStatus(rawStatus);
  const copy = {
    succeeded: {
      eyebrow: 'Payment received',
      title: 'Kairo is confirming your plan.',
      body: 'Your app will refresh as soon as Dodo confirms the subscription.',
      tone: 'success',
    },
    failed: {
      eyebrow: 'Payment incomplete',
      title: 'That payment didn’t go through.',
      body: 'Your plan has not changed. Return to Kairo whenever you’re ready to try again.',
      tone: 'failed',
    },
    cancelled: {
      eyebrow: 'Checkout closed',
      title: 'No changes were made.',
      body: 'You can return to Kairo and upgrade whenever the time feels right.',
      tone: 'neutral',
    },
    processing: {
      eyebrow: 'Almost there',
      title: 'Your payment is still processing.',
      body: 'Kairo will confirm your plan directly with Dodo when it is ready.',
      tone: 'neutral',
    },
    unknown: {
      eyebrow: 'Back to Kairo',
      title: 'We’re checking your plan.',
      body: 'Kairo will use Dodo’s confirmed subscription state when the app opens.',
      tone: 'neutral',
    },
  }[status];
  const deepLink = `kairo://billing-done?status=${encodeURIComponent(status)}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${copy.eyebrow} · Kairo</title>
  <style>
    :root{--ink:#11101a;--muted:#696778;--line:#dedce8;--paper:#fbfaff;--accent:#5c26f1;--lime:#b9ef55;--rose:#ff796f}
    *{box-sizing:border-box}
    html,body{min-height:100%;margin:0}
    body{display:grid;place-items:center;padding:28px;background:
      radial-gradient(circle at 16% 18%,rgba(92,38,241,.11),transparent 28rem),
      linear-gradient(rgba(17,16,26,.035) 1px,transparent 1px),
      linear-gradient(90deg,rgba(17,16,26,.035) 1px,transparent 1px),#f5f4fa;
      background-size:auto,32px 32px,32px 32px;font-family:"Avenir Next","Helvetica Neue",sans-serif;color:var(--ink)}
    .shell{position:relative;width:min(100%,620px)}
    .spark{position:absolute;border:1px solid var(--ink);background:var(--lime);transform:rotate(7deg)}
    .spark.one{width:28px;height:28px;right:-11px;top:44px}
    .spark.two{width:15px;height:15px;left:-7px;bottom:62px;background:var(--accent);transform:rotate(-12deg)}
    main{position:relative;overflow:hidden;padding:34px 38px 36px;border:1px solid var(--ink);border-radius:18px;
      background:rgba(251,250,255,.96);box-shadow:10px 10px 0 rgba(92,38,241,.15)}
    header{display:flex;align-items:center;justify-content:space-between;padding-bottom:26px;border-bottom:1px solid var(--line)}
    .brand{display:flex;align-items:center;gap:9px;font-size:21px;font-weight:750;letter-spacing:-.06em}
    .mark{position:relative;width:27px;height:27px;border-radius:10px 10px 12px 12px;background:var(--accent);transform:rotate(-4deg)}
    .mark:before{content:"";position:absolute;inset:8px 5px 4px;border-radius:8px;background:white}
    .mark:after{content:"••";position:absolute;inset:6px 0 0;text-align:center;font:900 11px/18px ui-monospace;color:var(--ink);letter-spacing:3px}
    .state{display:inline-flex;align-items:center;gap:8px;font:600 11px/1 ui-monospace,SFMono-Regular,monospace;
      letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
    .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px rgba(92,38,241,.1)}
    [data-tone="success"] .dot{background:#6a990f;box-shadow:0 0 0 4px rgba(106,153,15,.13)}
    [data-tone="failed"] .dot{background:#c83c32;box-shadow:0 0 0 4px rgba(200,60,50,.12)}
    .content{padding:52px 0 44px;max-width:500px}
    .kicker{margin:0 0 13px;font:650 11px/1.2 ui-monospace,SFMono-Regular,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
    h1{margin:0;max-width:480px;font-size:clamp(34px,7vw,54px);font-weight:720;line-height:.98;letter-spacing:-.055em}
    p{margin:19px 0 0;max-width:440px;color:var(--muted);font-size:16px;line-height:1.55}
    footer{display:flex;align-items:center;justify-content:space-between;gap:20px}
    a{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 19px;border:1px solid var(--ink);
      border-radius:9px;background:var(--ink);box-shadow:5px 5px 0 rgba(92,38,241,.2);color:white;text-decoration:none;font-weight:650;
      transition:transform .18s ease,box-shadow .18s ease}
    a:hover{transform:translate(2px,2px);box-shadow:3px 3px 0 rgba(92,38,241,.26)}
    .hint{margin:0;font:500 11px/1.45 ui-monospace,SFMono-Regular,monospace;color:var(--muted);text-align:right}
    @media(max-width:560px){main{padding:26px 24px 28px}.content{padding:42px 0 38px}footer{align-items:flex-start;flex-direction:column}.hint{text-align:left}}
    @media(prefers-reduced-motion:no-preference){main{animation:arrive .52s cubic-bezier(.2,.8,.2,1) both}.dot{animation:pulse 1.8s ease-in-out infinite}
      @keyframes arrive{from{opacity:0;transform:translateY(12px) scale(.985)}to{opacity:1;transform:none}}@keyframes pulse{50%{transform:scale(.72)}}}
  </style>
</head>
<body data-tone="${copy.tone}">
  <div class="shell">
    <i class="spark one" aria-hidden="true"></i><i class="spark two" aria-hidden="true"></i>
    <main>
      <header><div class="brand"><span class="mark" aria-hidden="true"></span><span>kairo</span></div>
        <div class="state"><span class="dot"></span>${copy.eyebrow}</div></header>
      <section class="content"><div class="kicker">${copy.eyebrow}</div><h1>${copy.title}</h1><p>${copy.body}</p></section>
      <footer><a href="${deepLink}">Return to Kairo&nbsp; →</a><p class="hint">Kairo verifies your plan<br>directly with Dodo.</p></footer>
    </main>
  </div>
  <script>window.setTimeout(function(){location.replace(${JSON.stringify(deepLink)})},550)</script>
</body>
</html>`;
}
