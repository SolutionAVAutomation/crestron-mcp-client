/**
 * TCP/TLS client for the Crestron processor, ported from the proven Python
 * client (PythonMCPClient/crestron_mcp_server.py). Speaks the text protocol in
 * PROTOCOL.md: newline-framed request/response, with mode-1 (password) and
 * mode-2 (HMAC-SHA256 challenge-response over TLS) authentication.
 *
 * Auto-connects (and reconnects) on demand, so the MCP server can start before
 * the processor is reachable and recover if the socket drops.
 */
import * as net from "node:net";
import * as tls from "node:tls";
import * as crypto from "node:crypto";

/** Where customers buy a license, and where the client fetches free trials. Overridable via
 *  env for testing (point at a local mock or the Stripe test-mode portal). The MAC is appended
 *  as ?mac= so the storefront/trial is bound to this processor. */
const PORTAL_URL = process.env.CRESTRON_PORTAL_URL || "https://solutionav.com.au/crestron-mcp/";
const TRIAL_URL = process.env.CRESTRON_TRIAL_URL || "https://license.solutionav.com.au/trial";
/** Host of the trial/licensing server, surfaced in the trial result so the assistant can say
 *  where a trial came from. The fetch happens inside this client, below the tool boundary, so
 *  the model can't otherwise see that an online server was involved. */
const TRIAL_HOST = (() => {
  try {
    return new URL(TRIAL_URL).host;
  } catch {
    return TRIAL_URL;
  }
})();

/** After a control action, read the device's STATE back so the result carries the real outcome.
 *  The model reliably reads tool results but rarely queries on its own, so we push the feedback to
 *  it. CRESTRON_CONFIRM=0 disables the read-back; CRESTRON_SETTLE_MS is how long to let an
 *  immediate set's feedback join settle before reading (ramps/pulses/pending are tracked
 *  server-side and read instantly, so they don't wait). */
const CONFIRM = (process.env.CRESTRON_CONFIRM ?? "1") !== "0";
const SETTLE_MS = Math.max(0, Number(process.env.CRESTRON_SETTLE_MS ?? 350) || 0);

/** Render a millisecond duration as a short human phrase for the LLM ("2 days 4 hours"). */
function humanizeMs(ms: number): string {
  if (ms <= 0) return "expired";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (!d && m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ") || "under a minute";
}

/** Short duration phrase for in-flight actions: ms / seconds for sub-minute, else humanizeMs. */
function humanizeShort(ms: number): string {
  if (ms <= 0) return "now";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  }
  return humanizeMs(ms);
}

/** Loose value compare so an analog set ("50000") matches a numeric feedback (50000). */
function valuesMatch(a: unknown, b: unknown): boolean {
  const sa = String(a).trim();
  const sb = String(b).trim();
  if (sa === sb) return true;
  const na = Number(sa);
  const nb = Number(sb);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return false;
}

/** One-line, LLM-facing summary of a STATE read taken just after an action: in-flight (fading /
 *  pulsing / scheduled) or settled (current value, flagged when it differs from what was set). */
function summarizeState(state: Record<string, unknown>, commanded?: string): string {
  if (!state || typeof state !== "object") return "state unavailable";
  if (state.error) return `could not read back state: ${String(state.error)}`;

  let pendingPart = "";
  const p = state.pending as Record<string, unknown> | undefined;
  if (p && typeof p === "object") {
    const inMs = typeof p.in_ms === "number" ? ` in ~${humanizeShort(p.in_ms)}` : "";
    const action = String(p.action ?? "set").toLowerCase();
    pendingPart = `; scheduled to ${action} ${p.value ?? ""}${inMs}`.replace(/\s+$/, "");
  }

  const value = state.value;
  if (state.state === "ramping") {
    const rem = typeof state.remaining_ms === "number" ? `, ~${humanizeShort(state.remaining_ms)} left` : "";
    return `fading to ${state.target ?? value ?? "?"}${rem}${pendingPart}`;
  }
  if (state.state === "pulsing") {
    const rem = typeof state.remaining_ms === "number" ? `, releases in ~${humanizeShort(state.remaining_ms)}` : "";
    return `pulsing${rem}${pendingPart}`;
  }
  // idle (settled)
  if (value === undefined || value === null) {
    return `set${pendingPart || " (no feedback wired to confirm)"}`;
  }
  if (commanded !== undefined && !valuesMatch(value, commanded)) {
    return `feedback reads ${String(value)} (set ${commanded})${pendingPart}`;
  }
  return `now ${String(value)}${pendingPart}`;
}

/** Serializes async sections (mirrors the Python asyncio.Lock usage). */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

/** Python str.split(sep, maxsplit): at most maxsplit+1 parts, last keeps the rest
 *  (so a value containing ':' survives). */
function splitMax(s: string, sep: string, maxsplit: number): string[] {
  const parts: string[] = [];
  let rest = s;
  for (let i = 0; i < maxsplit; i++) {
    const idx = rest.indexOf(sep);
    if (idx < 0) break;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  parts.push(rest);
  return parts;
}

type Waiter = { resolve: (line: string) => void; reject: (e: Error) => void };

export class CrestronConnection {
  readonly host: string;
  readonly port: number;
  private readonly authCredential: string; // mode 1: shared password
  private readonly authKey: string; // mode 2: shared HMAC key (challenge-response)
  private readonly tls: boolean; // a key implies TLS; can also be set on its own

  processorId?: string;
  private connected = false;
  private socket?: net.Socket;
  private buffer = "";
  private readers: Waiter[] = [];
  private lineBuf: string[] = [];
  private readonly connectLock = new Mutex();
  private readonly ioLock = new Mutex();

  constructor(host: string, port = 50794, authCredential = "", authKey = "", useTls = false) {
    this.host = host;
    this.port = port;
    this.authCredential = authCredential;
    this.authKey = authKey;
    this.tls = useTls || Boolean(authKey);
  }

  /** Human + LLM friendly, step-by-step guidance for an unlicensed processor. Licensing is a
   *  one-time, in-chat activation: the processor reports its activation code (MAC) in `detail`;
   *  the user gets a key for it and the LLM activates the box with activate_crestron_license. */
  private licenseHelp(detail: string): string {
    // Pull the MAC out of the box's message (e.g. "...(MAC 00107ff0ab17)") so the buy link is
    // pre-bound to this processor; fall back to the bare portal URL if it's not present.
    const macMatch = detail.match(/MAC\s+([0-9a-fA-F]{12})/);
    const mac = macMatch ? macMatch[1].toLowerCase() : "";
    const buyUrl = mac ? `${PORTAL_URL}?mac=${mac}` : PORTAL_URL;
    return (
      `This Crestron processor (${this.host}) isn't licensed yet (${detail}).\n` +
      `Two options, both doable right here in chat:\n` +
      `  • Free trial: ask me to start one and I'll call start_crestron_trial. ` +
      `Up to 3 one-week trials per processor; I'll tell you how many remain.\n` +
      `  • Buy a license: get a key at ${buyUrl} (perpetual, AUD $249 inc GST), ` +
      `then paste it here and I'll activate it with activate_crestron_license.\n` +
      `Once licensed, the processor stays licensed for every client and across reboots. ` +
      `Licensing only gates the natural-language layer; the AV system itself keeps running regardless.`
    );
  }

  /** Turn an "ERROR:code:msg" response into a message string, expanding the license codes
   *  (1011 required / 1012 invalid) into the full step-by-step guidance. */
  private formatError(response: string): string {
    const parts = splitMax(response, ":", 2);
    const code = parts[1];
    const msg = parts.length > 2 ? parts[2] : "Unknown error";
    if (code === "1011" || code === "1012") return this.licenseHelp(msg);
    return msg;
  }

  // --- transport ---------------------------------------------------------

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = this.tls
        ? tls.connect({
            host: this.host,
            port: this.port,
            // Option A: trust the processor's built-in self-signed cert on a
            // trusted LAN (no PKI to verify against). Mirror the Python
            // CERT_NONE. Upgrade to verification/pinning if the net is untrusted.
            // No servername/SNI: we don't verify the cert, and the host is an IP
            // (setting SNI to an IP is invalid per RFC 6066).
            rejectUnauthorized: false,
            // Force TLS 1.2: Node's TLS 1.3 completes the handshake with the
            // processor's Mono TLS stack but then never receives a reply (the
            // box stalls). Pinning to 1.2 fixes it, and matches the gold-
            // reference Samsung driver which also forces TLS 1.2. (Raw Python
            // negotiates 1.3 fine; this is Node-specific.)
            maxVersion: "TLSv1.2",
          })
        : net.connect({ host: this.host, port: this.port });
      const readyEvent = this.tls ? "secureConnect" : "connect";
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        sock.removeListener(readyEvent, onReady);
        sock.removeListener("error", onError);
        if (err) {
          try {
            sock.destroy();
          } catch {
            /* ignore */
          }
          reject(err);
        } else {
          this.attach(sock);
          resolve();
        }
      };
      const onReady = () => settle();
      const onError = (e: Error) => settle(e);
      sock.once(readyEvent, onReady);
      sock.once("error", onError);
    });
  }

  private attach(sock: net.Socket): void {
    this.socket = sock;
    this.buffer = "";
    sock.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    sock.on("close", () => this.handleDrop());
    sock.on("error", (e: Error) => this.handleDrop(e));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim(); // mirror Python .strip()
      this.buffer = this.buffer.slice(idx + 1);
      const waiter = this.readers.shift();
      if (waiter) waiter.resolve(line);
      else this.lineBuf.push(line);
    }
  }

  private handleDrop(err?: Error): void {
    this.connected = false;
    this.socket = undefined;
    this.buffer = "";
    const e = new Error(err ? `Connection error: ${err.message}` : "Connection closed by Crestron");
    for (const w of this.readers.splice(0)) w.reject(e);
    this.lineBuf = [];
  }

  private write(s: string): void {
    if (!this.socket) throw new Error("Not connected");
    this.socket.write(s);
  }

  private readLine(): Promise<string> {
    const buffered = this.lineBuf.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (!this.socket || this.socket.destroyed) {
      return Promise.reject(new Error("Connection closed by Crestron"));
    }
    return new Promise<string>((resolve, reject) => {
      this.readers.push({ resolve, reject });
    });
  }

  private async close(): Promise<void> {
    const sock = this.socket;
    this.socket = undefined;
    this.connected = false;
    if (sock) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
    const e = new Error("Connection closed");
    for (const w of this.readers.splice(0)) w.reject(e);
    this.lineBuf = [];
  }

  // --- handshake ---------------------------------------------------------

  async ensureConnected(): Promise<void> {
    if (this.connected) return;
    await this.connectLock.run(async () => {
      if (this.connected) return;
      await this.connect();
    });
  }

  private async connect(): Promise<void> {
    await this.openSocket();
    this.write("HELLO\n");
    const resp = await this.readLine();
    if (!resp.startsWith("OK:MCP-CRESTRON")) {
      await this.close();
      throw new Error(`Unexpected HELLO response from ${this.host}:${this.port}: ${JSON.stringify(resp)}`);
    }
    const parts = resp.split(":");
    this.processorId = parts.length > 3 ? parts[3] : undefined;
    // Licensing is per-processor now (stored on the box, installed via activateLicense), so
    // there's nothing to present on connect. Authenticate before marking connected. A key
    // (mode 2, challenge-response) takes precedence over a password (mode 1).
    if (this.authKey) {
      await this.authenticateKey();
    } else if (this.authCredential) {
      this.write(`AUTH:${this.authCredential}\n`);
      const aresp = await this.readLine();
      if (!aresp.startsWith("OK")) {
        await this.close();
        throw new Error(`Authentication rejected by ${this.host}:${this.port}: ${JSON.stringify(aresp)}`);
      }
    }
    this.connected = true;
  }

  private async authenticateKey(): Promise<void> {
    this.write("AUTH\n");
    const cresp = await this.readLine();
    if (!cresp.startsWith("CHALLENGE:")) {
      await this.close();
      throw new Error(`Expected CHALLENGE from ${this.host}:${this.port}, got ${JSON.stringify(cresp)}`);
    }
    const nonce = cresp.slice("CHALLENGE:".length);
    const digest = crypto
      .createHmac("sha256", Buffer.from(this.authKey, "utf8"))
      .update(Buffer.from(nonce, "utf8"))
      .digest("hex"); // lowercase hex, matches Python hexdigest()
    this.write(`AUTH:${digest}\n`);
    const aresp = await this.readLine();
    if (!aresp.startsWith("OK")) {
      await this.close();
      throw new Error(`Key authentication rejected by ${this.host}:${this.port}: ${JSON.stringify(aresp)}`);
    }
  }

  // --- request/response --------------------------------------------------

  async sendCommand(command: string): Promise<string> {
    await this.ensureConnected();
    return this.ioLock.run(async () => {
      try {
        this.write(`${command}\n`);
        return await this.readLine();
      } catch (e) {
        await this.close();
        throw new Error(`Communication error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  // --- protocol operations (mirror the Python client exactly) ------------

  /**
   * Live state of a device: current value plus whether it is idle / ramping (target +
   * completes_at) / pulsing (releases_at), and any pending scheduled action. Backed by the
   * STATE command; falls back to the flat QUERY on a processor too old to know STATE.
   */
  async queryDevice(deviceId: string): Promise<Record<string, unknown>> {
    const response = await this.sendCommand(`STATE:${deviceId}`);
    if (response.startsWith("DATA:")) return JSON.parse(response.slice(5)) as Record<string, unknown>;
    if (response.startsWith("ERROR")) {
      const parts = splitMax(response, ":", 2);
      if (parts[1] === "1000") return this.queryDeviceFlat(deviceId); // older processor: no STATE
      return { error: this.formatError(response) };
    }
    return { error: "Invalid response" };
  }

  /** Legacy flat read (OK:id:value), used as a fallback when STATE isn't supported. */
  private async queryDeviceFlat(deviceId: string): Promise<Record<string, unknown>> {
    const response = await this.sendCommand(`QUERY:${deviceId}`);
    if (response.startsWith("ERROR")) {
      return { error: this.formatError(response) };
    }
    if (response.startsWith("OK")) {
      const parts = splitMax(response, ":", 2);
      return {
        device_id: parts.length > 1 ? parts[1] : deviceId,
        value: parts.length > 2 ? parts[2] : null,
        state: "idle",
      };
    }
    return { error: "Invalid response" };
  }

  /** The processor's current time, as epoch milliseconds + ISO 8601. */
  async getTime(): Promise<Record<string, unknown>> {
    const response = await this.sendCommand("TIME");
    if (response.startsWith("DATA:")) return JSON.parse(response.slice(5)) as Record<string, unknown>;
    if (response.startsWith("ERROR")) {
      return { error: this.formatError(response) };
    }
    return { error: "Invalid response" };
  }

  /**
   * Activate (license) this processor with a key the user obtained for it. The processor
   * verifies the key against its own MAC and, on success, stores it - so the box stays
   * licensed for every client and across reboots. One-time per processor. Whitespace in the
   * pasted key is stripped so a messy paste still works.
   */
  async activateLicense(licenseKey: string): Promise<Record<string, unknown>> {
    const clean = (licenseKey || "").replace(/\s+/g, "");
    if (!clean) return { success: false, error: "No license key provided." };
    const response = await this.sendCommand(`ACTIVATE:${clean}`);
    if (response.startsWith("OK")) {
      const parts = splitMax(response, ":", 2); // OK:ACTIVATED:<customer>
      return { success: true, activated: true, licensed_to: parts.length > 2 ? parts[2] : "" };
    }
    return { success: false, error: this.formatError(response) };
  }

  /**
   * Report the processor's license/trial state: licensed (now), whether it's a time-limited
   * trial, how long remains (ms + human phrase), the MAC, and a pre-bound buy URL. Lets the LLM
   * detect an unlicensed box, surface trial time-remaining naturally, and offer trial/buy.
   */
  async licenseStatus(): Promise<Record<string, unknown>> {
    const response = await this.sendCommand("LICENSE_STATUS");
    if (response.startsWith("DATA:")) {
      const s = JSON.parse(response.slice(5)) as Record<string, unknown>;
      if (typeof s.remaining_ms === "number") s.remaining_human = humanizeMs(s.remaining_ms as number);
      if (s.mac) s.buy_url = `${PORTAL_URL}?mac=${s.mac}`;
      return s;
    }
    if (response.startsWith("ERROR")) return { error: this.formatError(response) };
    return { error: "Invalid response" };
  }

  /**
   * Start a free 7-day trial on this processor. Reads the box's MAC, fetches a signed trial
   * license bound to it from the licensing server, and activates it on the box. The server caps
   * trials per processor (default 3); when they're used up it returns a buy link instead. The
   * box never needs internet; this client (which always has it) relays the key via ACTIVATE.
   */
  async startTrial(): Promise<Record<string, unknown>> {
    const status = await this.licenseStatus();
    const mac = String(status.mac ?? "");
    if (!mac) return { success: false, error: "Could not read the processor's MAC to start a trial." };
    if (status.licensed === true && status.time_limited !== true) {
      return { success: false, error: "This processor already has a full (perpetual) license; no trial needed." };
    }

    let data: {
      blob?: string;
      expiry?: string;
      trials_remaining?: number;
      trial_seq?: number;
      trial_max?: number;
      error?: string;
      buy_url?: string;
    };
    try {
      const res = await fetch(`${TRIAL_URL}?mac=${encodeURIComponent(mac)}`, { method: "GET" });
      data = (await res.json().catch(() => ({}))) as typeof data;
      if (!res.ok || data.error) {
        const buyUrl = data.buy_url || `${PORTAL_URL}?mac=${mac}`;
        const reason =
          data.error === "trials_exhausted"
            ? `All free trials for this processor have been used. Buy a license at ${buyUrl}.`
            : data.error || `Trial request failed (HTTP ${res.status}).`;
        return { success: false, error: reason };
      }
    } catch (e) {
      return {
        success: false,
        error: `Could not reach the licensing server: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const blob = String(data.blob || "");
    if (!blob) return { success: false, error: "The licensing server returned no trial key." };
    const act = await this.activateLicense(blob);
    if (!act.success) return { success: false, error: `Trial key rejected by the processor: ${act.error}` };
    return {
      success: true,
      trial_started: true,
      expires: data.expiry ?? null,
      trials_remaining: data.trials_remaining ?? null,
      trial_seq: data.trial_seq ?? null,
      trial_max: data.trial_max ?? null,
      licensed_to: act.licensed_to ?? "Trial",
      // Provenance so the assistant answers "how/where did this happen" from data, not by
      // guessing: the HTTPS fetch to the licensing server happens inside this client, which the
      // model can't see, so name it explicitly here.
      issued_by: TRIAL_HOST,
      data_sent: "processor MAC only",
      stored: "on the processor (persists across reboots)",
    };
  }

  /** Read the device's STATE just after an action and summarize it for the LLM. settleMs lets an
   *  immediate set's feedback join settle first; ramps/pulses/pending are server-tracked so they
   *  pass 0. Never throws: a failed read-back is reported in the result, not fatal to the action. */
  private async confirm(
    deviceId: string,
    settleMs: number,
    commanded?: string,
  ): Promise<{ state: Record<string, unknown>; status: string }> {
    try {
      if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      const state = await this.queryDevice(deviceId);
      return { state, status: summarizeState(state, commanded) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { state: { error: msg }, status: `could not read back state: ${msg}` };
    }
  }

  async setDevice(deviceId: string, value: string, delayMs = 0): Promise<Record<string, unknown>> {
    // delayMs > 0 -> SET_AFTER (the processor runs the set after the delay); else plain SET.
    const command = delayMs > 0 ? `SET_AFTER:${deviceId}:${delayMs}:${value}` : `SET:${deviceId}:${value}`;
    const response = await this.sendCommand(command);
    if (response.startsWith("ERROR")) {
      return { success: false, error: this.formatError(response) };
    }
    if (response.startsWith("OK")) {
      const result: Record<string, unknown> = { success: true, device_id: deviceId, value };
      if (delayMs > 0) result.delay_ms = delayMs;
      // Confirm: a delayed set is pending (server-tracked, read now); an immediate set needs a
      // brief settle so the feedback join has moved before we read it back.
      if (CONFIRM) {
        const c = await this.confirm(deviceId, delayMs > 0 ? 0 : SETTLE_MS, delayMs > 0 ? undefined : value);
        result.status = c.status;
        result.confirmed = c.state;
      }
      return result;
    }
    return { success: false, error: "Invalid response" };
  }

  /**
   * Apply a scene: set many devices in one tool call, each optionally fading (duration_ms,
   * analog) and/or starting after a delay (delay_ms). Plain entries are sent together as one
   * BATCH_SET; timed entries map to RAMP / SET_AFTER / delayed-RAMP. Returns per-device results.
   * BATCH_SET (the plain entries) can't carry commas in a value; timed entries are sent
   * individually so they can.
   */
  async setDevices(
    assignments: Array<{ device_id: string; value: string; duration_ms?: number; delay_ms?: number }>,
  ): Promise<Record<string, unknown>> {
    if (!assignments || assignments.length === 0) return { success: false, error: "No devices given" };

    const results: Array<Record<string, unknown>> = [];
    const hasDur = (a: { duration_ms?: number }) => typeof a.duration_ms === "number" && a.duration_ms > 0;
    const hasDel = (a: { delay_ms?: number }) => typeof a.delay_ms === "number" && a.delay_ms > 0;
    const instant = assignments.filter((a) => !hasDur(a) && !hasDel(a));
    const timed = assignments.filter((a) => hasDur(a) || hasDel(a));

    if (instant.length > 0) {
      const pairs = instant.map((a) => `${a.device_id}:${a.value}`).join(",");
      const resp = await this.sendCommand(`BATCH_SET:${pairs}`);
      if (resp.startsWith("DATA:")) {
        for (const r of JSON.parse(resp.slice(5)) as Array<Record<string, unknown>>) results.push(r);
      } else {
        const err = this.formatError(resp);
        for (const a of instant) results.push({ id: a.device_id, success: false, error: err });
      }
    }

    for (const a of timed) {
      const dur = hasDur(a) ? (a.duration_ms as number) : 0;
      const del = hasDel(a) ? (a.delay_ms as number) : 0;
      let command: string;
      if (dur > 0 && del > 0) command = `RAMP:${a.device_id}:${a.value}:${dur}:${del}`;
      else if (dur > 0) command = `RAMP:${a.device_id}:${a.value}:${dur}`;
      else command = `SET_AFTER:${a.device_id}:${del}:${a.value}`;
      const resp = await this.sendCommand(command);
      if (resp.startsWith("OK")) {
        const r: Record<string, unknown> = { id: a.device_id, success: true, value: a.value };
        if (dur > 0) r.duration_ms = dur;
        if (del > 0) r.delay_ms = del;
        results.push(r);
      } else {
        results.push({ id: a.device_id, success: false, error: this.formatError(resp) });
      }
    }

    // Confirm each device that took, folding its live state into that entry. Settle once up front
    // if any instant entries were sent (their feedback joins lag); timed entries read instantly.
    if (CONFIRM && results.length > 0) {
      if (instant.length > 0 && SETTLE_MS > 0) await new Promise((r) => setTimeout(r, SETTLE_MS));
      for (const r of results) {
        if (r.success === false) continue;
        const id = String(r.id ?? "");
        if (!id) continue;
        const c = await this.confirm(id, 0);
        r.status = c.status;
        r.confirmed = c.state;
      }
    }

    return { success: true, results };
  }

  /**
   * Cancel activity on a device: stop a ramp (leaving the level where it is), release a
   * pulse in progress to off, and clear any pending delayed action. Does not otherwise
   * change the device's value (a device simply on/high from a SET stays so).
   */
  async cancelDevice(deviceId: string): Promise<Record<string, unknown>> {
    const response = await this.sendCommand(`CANCEL:${deviceId}`);
    if (response.startsWith("ERROR")) {
      return { success: false, error: this.formatError(response) };
    }
    if (response.startsWith("OK")) {
      return { success: true, device_id: deviceId, cancelled: true };
    }
    return { success: false, error: "Invalid response" };
  }

  /**
   * Momentary pulse on a DIGITAL device: drive it high for pulseMs (after an optional
   * pre-delay), then back low. Digital devices only; analog/serial are rejected.
   */
  async pulseDevice(deviceId: string, pulseMs: number, delayMs = 0): Promise<Record<string, unknown>> {
    const command = delayMs > 0 ? `PULSE:${deviceId}:${pulseMs}:${delayMs}` : `PULSE:${deviceId}:${pulseMs}`;
    const response = await this.sendCommand(command);
    if (response.startsWith("ERROR")) {
      return { success: false, error: this.formatError(response) };
    }
    if (response.startsWith("OK")) {
      const result: Record<string, unknown> = { success: true, device_id: deviceId, pulse_ms: pulseMs };
      if (delayMs > 0) result.delay_ms = delayMs;
      // Pulse (and any pre-delay) is tracked server-side, so STATE reports it instantly: no settle.
      if (CONFIRM) {
        const c = await this.confirm(deviceId, 0);
        result.status = c.status;
        result.confirmed = c.state;
      }
      return result;
    }
    return { success: false, error: "Invalid response" };
  }

  async rampDevice(deviceId: string, value: string, durationMs: number, delayMs = 0): Promise<Record<string, unknown>> {
    // delayMs > 0 -> the processor starts the fade after the delay (scheduled); else immediate.
    const command =
      delayMs > 0 ? `RAMP:${deviceId}:${value}:${durationMs}:${delayMs}` : `RAMP:${deviceId}:${value}:${durationMs}`;
    const response = await this.sendCommand(command);
    if (response.startsWith("ERROR")) {
      return { success: false, error: this.formatError(response) };
    }
    if (response.startsWith("OK")) {
      const result: Record<string, unknown> = { success: true, device_id: deviceId, value, duration_ms: durationMs };
      if (delayMs > 0) result.delay_ms = delayMs;
      // The fade (or its scheduled start) is tracked server-side, so STATE shows "fading to X" /
      // pending right away: no settle, and don't flag a mid-fade value as a mismatch.
      if (CONFIRM) {
        const c = await this.confirm(deviceId, 0);
        result.status = c.status;
        result.confirmed = c.state;
      }
      return result;
    }
    return { success: false, error: "Invalid response" };
  }

  /** Surface a protocol ERROR (e.g. 1009 authentication required, 1011/1012 license)
   *  instead of letting a non-DATA response masquerade as an empty result. License
   *  errors are expanded into step-by-step guidance via formatError. */
  private raiseIfError(response: string): void {
    if (response.startsWith("ERROR")) {
      throw new Error(this.formatError(response));
    }
  }

  async discoverSystem(): Promise<unknown> {
    const response = await this.sendCommand("DISCOVER");
    if (response.startsWith("DATA:")) return JSON.parse(response.slice(5));
    this.raiseIfError(response);
    return { error: "Failed to discover system" };
  }

  async listRooms(): Promise<unknown> {
    const response = await this.sendCommand("LIST_ROOMS");
    if (response.startsWith("DATA:")) return JSON.parse(response.slice(5));
    this.raiseIfError(response);
    return [];
  }

  async listDevices(room?: string, category?: string): Promise<unknown> {
    // Always fetch the full list and filter client-side, case-insensitively, so
    // room/category matching is robust regardless of the processor's filter
    // quirks (its LIST_DEVICES:<room> matches the room NAME case-sensitively and
    // not the room id, so an LLM passing the lowercase id gets nothing). Device
    // counts are small, so fetching all and filtering here is cheap.
    const response = await this.sendCommand("LIST_DEVICES");
    if (!response.startsWith("DATA:")) {
      this.raiseIfError(response);
      return [];
    }
    const parsed: unknown = JSON.parse(response.slice(5));
    if (!Array.isArray(parsed)) return parsed;
    let devices = parsed as Array<Record<string, unknown>>;
    if (room) {
      const r = room.trim().toLowerCase();
      // match the device's room name OR id (discovery exposes both)
      devices = devices.filter((d) => {
        const name = String(d?.room ?? "").toLowerCase();
        const id = String(d?.room_id ?? "").toLowerCase();
        return name === r || id === r;
      });
    }
    if (category) {
      const c = category.trim().toLowerCase();
      devices = devices.filter((d) => String(d?.category ?? "").toLowerCase() === c);
    }
    return devices;
  }
}
