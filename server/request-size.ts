/** nginx's "413 Request Entity Too Large" page, Express's "request entity too large", "Payload Too Large", and
 * OpenAI's "Request too large for <model>". */
const TOO_LARGE = /\b(?:request entity|payload|request) too large\b/i;

export function refusesRequestSize(status: number, body: string): boolean {
  return status === 413 || TOO_LARGE.test(body);
}

export function isRequestTooLarge(error: unknown): error is Error & { readonly bytes?: number } {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "request_too_large";
}
