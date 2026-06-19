/**
 * Resolve host/port/auth/key/tls. Precedence (low to high): config.json next to
 * the binary, then environment variables, then CLI args. Mirrors the Python
 * client's load_config().
 *
 *   CRESTRON_HOST / CRESTRON_PORT
 *   CRESTRON_AUTH    - mode-1 shared password
 *   CRESTRON_KEY     - mode-2 HMAC key (implies TLS)
 *   CRESTRON_TLS     - force TLS even without a key
 *
 * Licensing is NOT configured here: it lives on the processor, installed once via the
 * activate_crestron_license tool (the LLM walks the user through it in chat).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface CrestronConfig {
  host: string;
  port: number;
  auth: string;
  key: string;
  tls: boolean;
}

function truthy(v: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

export function loadConfig(argv: string[] = process.argv.slice(2)): CrestronConfig {
  let host = "192.168.1.100";
  let port = 50794;
  let auth = "";
  let key = "";
  let tls = false;

  // config.json next to the build output, or one level up (project root / next
  // to a packaged binary).
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, "config.json"), join(here, "..", "config.json")]) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      const c = cfg.crestron ?? {};
      if (c.host !== undefined) host = String(c.host);
      if (c.port !== undefined) port = Number(c.port);
      if (c.auth !== undefined) auth = String(c.auth);
      if (c.key !== undefined) key = String(c.key);
      if (c.tls !== undefined) tls = Boolean(c.tls);
      break;
    } catch {
      /* not found / unreadable - fall through to env + args */
    }
  }

  const env = process.env;
  // Empty strings are ignored for host/port (a packaged .mcpb may inject blank
  // env vars for unset optional fields; CRESTRON_PORT="" must not become 0).
  if (env.CRESTRON_HOST) host = env.CRESTRON_HOST;
  if (env.CRESTRON_PORT) {
    const n = Number(env.CRESTRON_PORT);
    if (Number.isFinite(n) && n > 0) port = n;
  }
  // Credentials: a defined-but-empty value legitimately means "no credential".
  if (env.CRESTRON_AUTH !== undefined) auth = env.CRESTRON_AUTH;
  if (env.CRESTRON_KEY !== undefined) key = env.CRESTRON_KEY;
  if (env.CRESTRON_TLS !== undefined) tls = truthy(env.CRESTRON_TLS);

  if (argv[0]) host = argv[0];
  if (argv[1]) port = Number(argv[1]);

  return { host, port, auth, key, tls };
}
