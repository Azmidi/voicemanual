// One error type for everything the proxy can report back to Manuel.
// `code` is what manuel.js looks at to choose what to say to the technician.
export class ProxyError extends Error {
  constructor(code, message, status = 500, extra = {}) {
    super(message);
    this.code = code;     // bad_request | forbidden | too_large | rate_limited | not_configured | busy | quota | upstream
    this.status = status; // HTTP status sent to the browser
    Object.assign(this, extra);
  }
}
