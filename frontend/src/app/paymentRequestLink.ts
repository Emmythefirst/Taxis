/**
 * The link a payment request's QR encodes. Deliberately an ordinary,
 * same-origin URL rather than a custom scheme — any camera app can open it,
 * and a plain tap (texted, pasted, no scan at all) lands on the exact same
 * review screen. Completing the payment still requires being logged into
 * Taxis, same as any payment link.
 */
export function paymentRequestPayUrl(requestId: string): string {
  return `${window.location.origin}/app/pay/${requestId}`;
}

/** Pulls a requestId back out of a scanned/pasted value — accepts either a
 *  full paymentRequestPayUrl() or a bare requestId, so a scanner that reads
 *  the raw text still works even if the URL got mangled in transit. */
export function parsePaymentRequestId(scanned: string): string | undefined {
  const trimmed = scanned.trim();
  const match = trimmed.match(/\/app\/pay\/([^/?#]+)/);
  if (match) return match[1];
  if (/^preq_/.test(trimmed)) return trimmed;
  return undefined;
}
